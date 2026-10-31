/**
 * The HTTP surface of dsh-session-suite.
 *
 * Connection mounts this exact Fetch route behind its Host/Origin and
 * browser-session checks (the same carrier the shipped session-log export
 * uses), so the browser half never needs a bespoke RPC channel: it posts JSON
 * to a document-relative `api/session-suite` URL.
 */

/** Absolute path Connection registers. */
export const API_PATH = '/api/session-suite'

const MAX_BODY_BYTES = 256 * 1024

/**
 * @param {import('./service.js').SessionSuiteService} service suite operations
 * @param {{ log: (message: string, error?: unknown) => void }} deps dependencies
 * @returns {{ path: string, methods: readonly string[], requestBody: string, fetch: (request: Request) => Promise<Response> }} route
 */
export function createRoute(service, deps) {
  return {
    path: API_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: request => handle(service, deps, request),
  }
}

/**
 * @param {import('./service.js').SessionSuiteService} service suite operations
 * @param {{ log: (message: string, error?: unknown) => void }} deps dependencies
 * @param {Request} request inbound request
 * @returns {Promise<Response>} response
 */
async function handle(service, deps, request) {
  try {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const url = new URL(request.url)
      const action = url.searchParams.get('action') ?? 'ping'
      return respond(service, deps, action, paramsOf(url.searchParams))
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)
    const body = await readJsonBody(request)
    const action = typeof body?.action === 'string' ? body.action : 'ping'
    return respond(service, deps, action, body ?? {})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.log(`request failed: ${message}`, error)
    return json({ ok: false, error: message, code: /** @type {any} */ (error)?.code }, 400)
  }
}

/**
 * @param {import('./service.js').SessionSuiteService} service suite operations
 * @param {{ log: (message: string, error?: unknown) => void }} deps dependencies
 * @param {string} action action name
 * @param {any} input request payload
 * @returns {Promise<Response>} response
 */
async function respond(service, deps, action, input) {
  switch (action) {
    case 'ping':
      return json({ ok: true, data: { ready: true, version: 1 } })
    case 'list':
      return json({ ok: true, data: await service.listSessions() })
    case 'detail':
      return json({ ok: true, data: await service.detail(requireSession(input)) })
    case 'capture':
      return json({ ok: true, data: await service.capture(requireSession(input), { label: input.label, kind: 'manual' }) })
    case 'restore':
      return json({ ok: true, data: await service.restoreCheckpoint(requireSession(input), requireCheckpoint(input)) })
    case 'rollback':
      return json({
        ok: true,
        data: await service.rollback({
          sessionId: requireSession(input),
          messageId: typeof input.messageId === 'string' ? input.messageId : undefined,
          seq: numberOrUndefined(input.seq),
          turn: numberOrUndefined(input.turn),
        }),
      })
    case 'deleteMessage':
      return json({
        ok: true,
        data: await service.deleteMessage({
          sessionId: requireSession(input),
          messageId: requireText(input, 'messageId'),
        }),
      })
    case 'deleteSegment':
      return json({
        ok: true,
        data: await service.deleteSegment({
          sessionId: requireSession(input),
          startSeq: Number(input.startSeq),
        }),
      })
    case 'outline':
      return json({ ok: true, data: await service.outline(requireSession(input)) })
    case 'removeCheckpoint':
      return json({
        ok: true,
        data: await service.store.removeCheckpoint(requireSession(input), requireCheckpoint(input)),
      })
    case 'setLocked':
      return json({
        ok: true,
        data: await service.store.setLocked(requireSession(input), requireCheckpoint(input), input.locked === true),
      })
    case 'undo':
      return json({ ok: true, data: await service.undo(requireText(input, 'undoId')) })
    case 'deleteSession':
      return json({ ok: true, data: await service.deleteSession(requireSession(input)) })
    case 'export': {
      const ranges = Array.isArray(input.ranges)
        ? input.ranges
            .map(range => ({ startSeq: Number(range?.startSeq), endSeq: Number(range?.endSeq) }))
            .filter(range => Number.isFinite(range.startSeq) && Number.isFinite(range.endSeq))
        : undefined
      const exported = await service.share({
        sessionId: requireSession(input),
        format:
          input.format === 'json' || input.format === 'txt' || input.format === 'html' || input.format === 'blocks'
            ? input.format
            : 'md',
        ranges: ranges && ranges.length > 0 ? ranges : undefined,
      })
      return json({ ok: true, data: exported })
    }
    case 'share': {
      const ranges = Array.isArray(input.ranges)
        ? input.ranges
            .map(range => ({ startSeq: Number(range?.startSeq), endSeq: Number(range?.endSeq) }))
            .filter(range => Number.isFinite(range.startSeq) && Number.isFinite(range.endSeq))
        : undefined
      const exported = await service.share({
        sessionId: requireSession(input),
        format:
          input.format === 'json' || input.format === 'txt' || input.format === 'html' || input.format === 'blocks'
            ? input.format
            : 'md',
        ranges: ranges && ranges.length > 0 ? ranges : undefined,
      })
      const download = input.download === true || input.download === '1' || input.download === 'true'
      return new Response(exported.body, {
        status: 200,
        headers: {
          'content-type': exported.contentType,
          'cache-control': 'no-store',
          ...(download
            ? { 'content-disposition': `attachment; filename="${escapeFileName(exported.fileName)}"` }
            : {}),
        },
      })
    }
    case 'memory.list':
      return json({ ok: true, data: await service.memory.list(requireSession(input)) })
    case 'memory.add':
      return json({
        ok: true,
        data: await service.memory.add(requireSession(input), {
          text: requireText(input, 'text'),
          tags: input.tags,
          seq: numberOrUndefined(input.seq),
          turn: numberOrUndefined(input.turn),
          source: 'user',
        }),
      })
    case 'memory.update':
      return json({
        ok: true,
        data: await service.memory.update(requireSession(input), requireText(input, 'id'), {
          text: input.text,
          tags: input.tags,
          pinned: input.pinned,
        }),
      })
    case 'memory.remove':
      return json({ ok: true, data: { removed: await service.memory.remove(requireSession(input), requireText(input, 'id')) } })
    case 'sweep':
      await service.sweep()
      return json({ ok: true, data: { swept: true } })
    default:
      deps.log(`unknown action ${action}`)
      return json({ ok: false, error: `unknown action: ${action}` }, 400)
  }
}

/**
 * @param {Request} request inbound request
 * @returns {Promise<any>} parsed JSON body
 */
async function readJsonBody(request) {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new Error('request body is too large')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/** @param {URLSearchParams} search query */
function paramsOf(search) {
  const out = {}
  for (const [key, value] of search.entries()) out[key] = value
  return out
}

/** @param {any} input payload @param {string} field field name @returns {string} value */
function requireText(input, field) {
  const value = input?.[field]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`)
  return value
}

/** @param {any} input payload @returns {string} session id */
function requireSession(input) {
  return requireText(input, 'sessionId')
}

/** @param {any} input payload @returns {string} checkpoint id */
function requireCheckpoint(input) {
  return requireText(input, 'checkpointId')
}

/** @param {any} value candidate @returns {number | undefined} number */
function numberOrUndefined(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/** @param {string} name file name @returns {string} header-safe name */
function escapeFileName(name) {
  return name.replace(/["\r\n]/g, '_')
}

/** @param {unknown} payload response body @param {number} [status] status */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
