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

/**
 * Every action that needs the long-term memory engine.
 *
 * Kept as an explicit set rather than an `action.startsWith('longterm.')` test so that a
 * misspelled action still fails as an unknown action (400) instead of being reported as
 * "memory is disabled" — the second answer would hide a typo.
 */
export const LONGTERM_ACTIONS = new Set([
  'longterm.list',
  'longterm.remember',
  'longterm.update',
  'longterm.remove',
  'longterm.recall',
  'longterm.explain',
  'longterm.pending',
  'longterm.settle',
  'longterm.conflicts',
  'longterm.resolve',
  'longterm.maintain',
  'longterm.status',
  'longterm.workspaces',
  'longterm.models',
  'longterm.stats',
  'longterm.settings',
  'longterm.export',
  'longterm.exportMarkdown',
  'longterm.exportMarkdownFile',
  'longterm.purge',
])

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
    // `await` is load-bearing, not stylistic. `respond` is async, so returning
    // its promise without awaiting lets every rejection escape this try/catch:
    // a service error would surface as an unhandled rejection instead of a 400,
    // and the client would lose `error.code` — which is what it matches on to
    // tell "this session is running" apart from a generic failure.
    if (request.method === 'GET' || request.method === 'HEAD') {
      const url = new URL(request.url)
      const action = url.searchParams.get('action') ?? 'ping'
      return await respond(service, deps, action, paramsOf(url.searchParams))
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)
    const body = await readJsonBody(request)
    const action = typeof body?.action === 'string' ? body.action : 'ping'
    return await respond(service, deps, action, body ?? {})
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
  // The long-term memory engine is OPTIONAL and off by default.
  //
  // It is off because it collides with dsh-fish-memory: both register
  // `systemPrompt.context({ order: 900 })`, so with both installed every request
  // carries two memory blocks — double the tokens and two possibly-contradictory
  // sets of facts. fish-memory's implicit extraction works and ours never did, so
  // the memory half of this bundle is opt-in and the session half is always on.
  //
  // When the engine is absent every longterm.* action must answer cleanly rather
  // than throw. `service.longTerm` is undefined in that case, and `await
  // undefined.list(...)` would surface as an opaque 500 in the panel.
  //
  // The guard checks the action against a KNOWN list first: an action that does
  // not exist is still a 400 (a typo must be loud), and only a real action is
  // reported as disabled. Returning "disabled" for a nonexistent action would
  // silently hide a wrong action name.
  if (!service.longTerm && LONGTERM_ACTIONS.has(action)) {
    return json({
      ok: false,
      error: 'long-term memory is disabled in this profile',
      code: 'LONGTERM_DISABLED',
    })
  }

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
    case 'resendTurn.preview':
      return json({
        ok: true,
        data: await service.previewResend({
          sessionId: requireSession(input),
          turn: numberOrUndefined(input.turn),
          messageId: typeof input.messageId === 'string' ? input.messageId : undefined,
        }),
      })
    case 'resendTurn':
      return json({
        ok: true,
        data: await service.resendTurn({
          sessionId: requireSession(input),
          turn: numberOrUndefined(input.turn),
          messageId: typeof input.messageId === 'string' ? input.messageId : undefined,
          mode: input.mode === 'stage' ? 'stage' : 'retry',
          text: typeof input.text === 'string' ? input.text : undefined,
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
    case 'previewDelete':
      return json({ ok: true, data: await service.previewDelete(requireSession(input)) })
    case 'deleteSessions':
      return json({
        ok: true,
        data: await service.deleteSessions(
          Array.isArray(input.sessionIds) ? input.sessionIds : [],
          { cascade: input.cascade !== false },
        ),
      })
    case 'restoreSession':
      // The inverse of archiving. Kept separate from any delete path on purpose:
      // un-hiding a session and destroying one are different intents and must not
      // share a control.
      return json({ ok: true, data: await service.restoreSession(requireSession(input)) })
    case 'deleteSession':
      return json({
        ok: true,
        data: await service.deleteSession(requireSession(input), { cascade: input.cascade !== false }),
      })
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
        mode: input.mode === 'all' ? 'all' : 'final',
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
        mode: input.mode === 'all' ? 'all' : 'final',
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
    // ------------------------------------------------------- long-term memory
    case 'longterm.list':
      return json({
        ok: true,
        data: await service.longTerm.list({
          cwd: workspaceOf(input),
          scope: scopeOf(input),
          tag: typeof input.tag === 'string' ? input.tag : undefined,
          sinceDays: numberOrUndefined(input.sinceDays),
        }),
      })
    case 'longterm.remember':
      return json({
        ok: true,
        data: await service.longTerm.remember({
          scope: scopeOf(input) === 'global' ? 'global' : 'workspace',
          cwd: workspaceOf(input),
          text: requireText(input, 'text'),
          tags: Array.isArray(input.tags) ? input.tags : undefined,
          affect: typeof input.affect === 'number' ? input.affect : undefined,
          source: 'user',
        }),
      })
    case 'longterm.update':
      return json({
        ok: true,
        data: await service.longTerm.update({
          scope: scopeOf(input),
          cwd: workspaceOf(input),
          id: requireText(input, 'id'),
          patch: {
            frozen: typeof input.frozen === 'boolean' ? input.frozen : undefined,
            touch: input.touch === true,
            text: typeof input.text === 'string' ? input.text : undefined,
          },
        }),
      })
    case 'longterm.remove':
      return json({
        ok: true,
        data: await service.longTerm.remove({
          scope: scopeOf(input),
          cwd: workspaceOf(input),
          id: typeof input.id === 'string' ? input.id : undefined,
        }),
      })
    case 'longterm.recall':
      return json({
        ok: true,
        data: await service.longTerm.recall({
          cwd: workspaceOf(input),
          query: typeof input.query === 'string' ? input.query : '',
          limit: numberOrUndefined(input.limit),
          touch: false,
        }),
      })
    case 'longterm.explain':
      // Answer "which memories would this question pull in, and why were the
      // rest dropped" without touching anything: `touch: false` keeps the access
      // counters and decay clocks exactly as they were.
      return json({
        ok: true,
        data: await service.longTerm.select({
          cwd: workspaceOf(input),
          query: typeof input.query === 'string' ? input.query : '',
          limit: numberOrUndefined(input.limit),
          touch: false,
        }),
      })
    case 'longterm.pending':
      return json({ ok: true, data: await service.longTerm.pending(workspaceOf(input)) })
    case 'longterm.settle':
      return json({
        ok: true,
        data: await service.longTerm.settle(requireText(input, 'id'), input.accept === true),
      })
    case 'longterm.conflicts':
      // Detection is automatic, resolution is not (lib/conflicts.js). This lists
      // the pairs that need a human; the engine prunes any pair whose entries
      // moved on, so the list never shows a contradiction that no longer exists.
      return json({ ok: true, data: await service.longTerm.conflicts(workspaceOf(input)) })
    case 'longterm.resolve':
      // `winnerId` omitted (or null) means "keep both, stop asking". That is a
      // real choice, not a cancel: the pair is dismissed permanently, because a
      // queue that re-asks a settled question is worse than no queue.
      return json({
        ok: true,
        data: await service.longTerm.settleConflict(
          requireText(input, 'id'),
          typeof input.winnerId === 'string' && input.winnerId ? input.winnerId : null,
        ),
      })
    case 'longterm.maintain':
      return json({ ok: true, data: await service.longTerm.maintain(workspaceOf(input)) })
    case 'longterm.purge':
      // DRY RUN by default. Retention deletion is the one irreversible thing the
      // engine does, so a stray call must never delete anything: the user has to
      // send `apply: true` explicitly after reading the candidate list. Mirrors
      // the `sweepOrphans` guard.
      return json({
        ok: true,
        data: await service.longTerm.purge({ cwd: workspaceOf(input), apply: input.apply === true }),
      })
    case 'longterm.status': {
      // The engine's own status plus the registration ledger. Two sources on purpose:
      // the engine cannot report a hook that never installed, because the code that
      // would have written it is the code that failed.
      const status = await service.longTerm.status()
      const install = typeof service.memoryInstallStatus === 'function' ? service.memoryInstallStatus() : []
      // Hook-level diagnostics are attached to the engine at install time
      // (index.js); they cover recall rebuilds and pain-turn distillation, both
      // of which happen outside the engine's own bookkeeping.
      const pain = typeof service.longTerm.painStatus === 'function' ? service.longTerm.painStatus() : null
      const recall = typeof service.longTerm.recallStatus === 'function' ? service.longTerm.recallStatus() : null
      return json({ ok: true, data: { ...status, install, pain, recall } })
    }
    case 'longterm.workspaces':
      return json({ ok: true, data: await service.longTerm.workspaces() })
    case 'longterm.models':
      // The models this Host can actually call, straight from the llm service.
      //
      // The picker used to render `config.memoryModels`, a list that comes from the
      // bundle patch — and a profile with no patch entry for this bundle therefore
      // showed only "off" and "use current", no real models at all. The llm service
      // is the authoritative source: it knows every provider route with a registered
      // adapter and what each one advertises. Reading configuration to answer "what
      // can I call" was the mistake.
      return json({ ok: true, data: await service.longTermModels() })
    case 'longterm.stats':
      // Aggregates for the visual summary. Computed here rather than in the browser
      // because the browser would have to fetch every row to count them, and the
      // counts must match what the list shows — one source, one answer.
      return json({ ok: true, data: await service.longTermStats() })
    case 'sweepOrphans':
      // `apply` must be explicit. A dry run is the default so a stray call can never
      // delete snapshot directories, and the report says how much would be freed.
      return json({ ok: true, data: await service.sweepOrphanCheckpoints(input.apply === true) })
    case 'longterm.settings':
      return json(
        input.patch
          ? { ok: true, data: await service.longTerm.updateSettings(input.patch) }
          : { ok: true, data: await service.longTerm.settings() },
      )
    case 'longterm.export':
      return json({ ok: true, data: await service.longTerm.export({ cwd: workspaceOf(input) }) })
    case 'longterm.exportMarkdown':
      // Portable, owner-readable snapshot. `longterm.export` above is the
      // public-only JSON share bundle; this one includes `internal` (the
      // default privacy level) and never emits `secret`.
      return json({
        ok: true,
        data: await service.longTerm.exportMarkdown({
          cwd: workspaceOf(input),
          workspaceLabel: typeof input.workspaceLabel === 'string' ? input.workspaceLabel : undefined,
        }),
      })
    case 'longterm.exportMarkdownFile': {
      const md = await service.longTerm.exportMarkdown({
        cwd: workspaceOf(input),
        workspaceLabel: typeof input.workspaceLabel === 'string' ? input.workspaceLabel : undefined,
      })
      return new Response(md.body, {
        status: 200,
        headers: {
          'content-type': md.contentType,
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${escapeFileName(md.fileName)}"`,
        },
      })
    }
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

/** @param {any} input payload @returns {string | undefined} workspace directory */
function workspaceOf(input) {
  return typeof input?.cwd === 'string' && input.cwd.length > 0 ? input.cwd : undefined
}

/** @param {any} input payload @returns {'global' | 'workspace' | undefined} memory scope */
function scopeOf(input) {
  if (input?.scope === 'global') return 'global'
  if (input?.scope === 'workspace') return 'workspace'
  return undefined
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
