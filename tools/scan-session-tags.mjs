#!/usr/bin/env node
/**
 * scan-session-tags.mjs — read-only scanner for DSH session logs.
 *
 * Iterates every `session.v4.jsonl.zstd` under the DSH sessions root, zstd
 * decompresses it asynchronously, parses the JSONL event stream and counts the
 * occurrences of the four internal step tags (see TAG_SPECS below) per session
 * and per event type. One raw sample event per tag and type is collected too.
 *
 * Hard guarantees:
 *  - READ ONLY. The script never opens a file for writing; every byte it
 *    produces goes to stdout. There is deliberately no write/append/rename or
 *    temp-file call anywhere in this file.
 *  - Async decompression only (`zlib.zstdDecompress` promisified — never the
 *    Sync variant), wrapped in try/catch plus a per-file Promise.race timeout.
 *  - A corrupt / truncated / unreadable archive is reported as `skipped` with a
 *    reason and never aborts the remaining batch.
 *  - Output never contains a bare angle-bracket pseudo tag: tag display labels
 *    are `[TAG:name]`, and every sample escapes all remaining angle brackets to
 *    the literal U+003C / U+003E escape text before printing.
 *
 * Usage:
 *   node tools/scan-session-tags.mjs [options]
 *
 * Options:
 *   --root <dir>           sessions root (default: <home>/.dsh/sessions)
 *   --session <substr>     only scan sessions whose id contains <substr>
 *   --timeout-ms <n>       per-file timeout, includes read+decompress+scan
 *                          (default: 30000)
 *   --concurrency <n>      files processed at the same time (default: 4)
 *   --max-sample-len <n>   sample truncation length in chars (default: 400)
 *   --json                 machine-readable JSON only, no human report
 *   --help                 show this help
 *
 * Exit codes: 0 = scan completed (skips included), 2 = bad usage / root
 * unreadable, 1 = unexpected fatal error.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'

const SESSION_FILE = 'session.v4.jsonl.zstd'
const DEFAULT_ROOT = path.join(os.homedir(), '.dsh', 'sessions')
const TARGET_SESSION_ID = 'session-2e16c8cf-3f17-41f9-aac9-c88fe170c650'

// The four internal step tags are built from code points on purpose: this file
// must not contain a bare control tag in its own source either.
const TAG_SPECS = [
  { name: '发', tag: '\u003c发\u003e' },
  { name: '执行', tag: '\u003c执行\u003e' },
  { name: '好', tag: '\u003c好\u003e' },
  { name: '现在', tag: '\u003c现在\u003e' }
]
const TAG_NAMES = TAG_SPECS.map(spec => spec.name)
const tagLabel = name => `[TAG:${name}]`

class TimeoutError extends Error {}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.log('usage: node tools/scan-session-tags.mjs [--root <dir>] [--session <substr>]')
  console.log('       [--timeout-ms <n>] [--concurrency <n>] [--max-sample-len <n>] [--json]')
}

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    session: null,
    timeoutMs: 30000,
    concurrency: 4,
    maxSampleLen: 400,
    json: false,
    help: false
  }
  const integer = (flag, raw, min) => {
    const value = Number.parseInt(raw, 10)
    if (!Number.isFinite(value) || value < min) throw new Error(`${flag} expects an integer >= ${min}, got "${raw}"`)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null]
    const take = () => {
      if (inline !== null) return inline
      index += 1
      if (index >= argv.length) throw new Error(`${flag} expects a value`)
      return argv[index]
    }
    if (flag === '--root') options.root = path.resolve(take())
    else if (flag === '--session') options.session = take()
    else if (flag === '--timeout-ms') options.timeoutMs = integer(flag, take(), 100)
    else if (flag === '--concurrency') options.concurrency = Math.min(integer(flag, take(), 1), 16)
    else if (flag === '--max-sample-len') options.maxSampleLen = integer(flag, take(), 60)
    else if (flag === '--json') options.json = true
    else if (flag === '--help' || flag === '-h') options.help = true
    else throw new Error(`unknown option "${arg}"`)
  }
  return options
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function withTimeout(promise, ms, label) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} exceeded ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Run `worker` over `items` with a fixed number of concurrent lanes. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let nextIndex = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(lanes)
  return results
}

function isWideCodePoint(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  )
}

function textWidth(text) {
  let width = 0
  for (const char of text) width += isWideCodePoint(char.codePointAt(0)) ? 2 : 1
  return width
}

function padEndWide(text, width) {
  return text + ' '.repeat(Math.max(0, width - textWidth(text)))
}

function renderTable(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(textWidth(header), ...rows.map(row => textWidth(String(row[column] ?? ''))))
  )
  const renderRow = cells => cells.map((cell, column) => padEndWide(String(cell ?? ''), widths[column])).join(' | ')
  return [
    renderRow(headers),
    widths.map(width => '-'.repeat(width)).join('-+-'),
    ...rows.map(renderRow)
  ].join('\n')
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`
}

function emptyTagCounts() {
  return Object.fromEntries(TAG_NAMES.map(name => [name, 0]))
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

async function collectSessionFiles(root) {
  const files = []
  const walk = async dir => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name === SESSION_FILE) files.push(full)
    }
  }
  await walk(root)
  return files.sort()
}

// ---------------------------------------------------------------------------
// Format detection / counting
// ---------------------------------------------------------------------------

/** Counts the four tags inside one string, non-overlapping, exact literals. */
function countTagsInString(text) {
  if (text.indexOf('\u003c') === -1) return null
  let hit = null
  for (const spec of TAG_SPECS) {
    let index = 0
    let count = 0
    while ((index = text.indexOf(spec.tag, index)) !== -1) {
      count += 1
      index += spec.tag.length
    }
    if (count > 0) {
      if (hit === null) hit = Object.create(null)
      hit[spec.name] = count
    }
  }
  return hit
}

/**
 * Recursively walks every string in the event (objects, arrays, nested message
 * content, tool inputs/outputs, reasoning blocks, ...) and counts the tags.
 * Returns null when nothing matched.
 */
function countTagsInEvent(value) {
  let hit = null
  const visit = node => {
    if (typeof node === 'string') {
      const local = countTagsInString(node)
      if (local === null) return
      if (hit === null) hit = Object.create(null)
      for (const name of Object.keys(local)) hit[name] = (hit[name] ?? 0) + local[name]
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) visit(node[key])
    }
  }
  visit(value)
  return hit
}

function escapeTags(text) {
  let out = text
  for (const spec of TAG_SPECS) out = out.split(spec.tag).join(tagLabel(spec.name))
  return out
}

/**
 * Escapes every remaining angle bracket as the literal text `\u003c` / `\u003e`.
 * Tag display labels such as `[TAG:发]` contain no angle brackets, so they stay
 * readable; arbitrary pseudo tags (the model's own `<...>` step hints, injected
 * placeholders, HTML fragments) can no longer reach the terminal as tags.
 */
function escapeAngles(text) {
  return text.replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
}

/** Light desensitization applied to samples only. */
function desensitize(text) {
  let out = text
  out = out.replace(/data:[A-Za-z0-9+/=;,._-]{100,}/g, 'data:<masked>')
  out = out.replace(/\b(sk|pk)-[A-Za-z0-9_-]{8,}/g, '$1-<masked>')
  out = out.replace(/\bC:[\\/]+Users[\\/]+[^\\/",\s]+/gi, '<HOME>')
  out = out.replace(/\/(?:home|Users)\/[^/"\s]+/g, '<HOME>')
  return out
}

/**
 * Builds a sanitized sample window around the first occurrence of `tagName`
 * inside the serialized event, so the sample always shows the hit itself
 * instead of the (possibly long) event head. Order matters: tag labels first →
 * desensitize (it injects angle-bracket placeholders) → escape ALL remaining
 * angle brackets → slice the window. The returned sample therefore contains no
 * bare angle bracket except none at all, only `[TAG:x]` markers.
 */
function makeSample(event, tagName, maxSampleLen) {
  const label = tagLabel(tagName)
  const text = escapeAngles(desensitize(escapeTags(JSON.stringify(event))))
  const hitIndex = text.indexOf(label)
  if (hitIndex === -1) return text.slice(0, maxSampleLen)
  const contextBefore = Math.min(120, Math.floor(maxSampleLen / 3))
  const start = Math.max(0, hitIndex - contextBefore)
  const end = Math.min(text.length, start + maxSampleLen)
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`
}

function classifyError(error) {
  if (error instanceof TimeoutError) return `timeout: ${error.message}`
  const code = error?.code
  const message = error?.message ?? String(error)
  if (code === 'ENOENT') return 'read-error: file vanished while scanning'
  if (code === 'EACCES' || code === 'EPERM') return 'read-error: permission denied'
  if (code && String(code).startsWith('ZSTD')) return `zstd-error: ${message}`
  if (/zstd|unknown frame|prefix|corrupt|unexpected end|invalid data/i.test(message)) return `zstd-error: ${message}`
  return `error: ${code ? `${code} ` : ''}${message}`
}

// ---------------------------------------------------------------------------
// Per-file scan
// ---------------------------------------------------------------------------

async function scanSession(file, options) {
  const startedAt = Date.now()
  const sessionId = path.basename(path.dirname(file))
  const workspace = path.basename(path.dirname(path.dirname(file)))
  const result = {
    sessionId,
    workspace,
    file,
    status: 'ok',
    sizeBytes: null,
    decompressedBytes: null,
    events: 0,
    parseErrors: 0,
    elapsedMs: 0,
    error: null,
    tags: emptyTagCounts(),
    byType: []
  }
  try {
    result.sizeBytes = (await stat(file)).size
  } catch {
    // size is cosmetic; keep scanning
  }

  const decompress = promisify(zstdDecompress)
  let raw = null
  let lastError = null
  // One retry: a session that is being appended to right now can produce a
  // transient read/decompress failure. Retrying once costs little and avoids a
  // spurious `skipped` for the active session.
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    try {
      raw = await withTimeout(
        (async () => decompress(await readFile(file)))(),
        options.timeoutMs,
        `read+zstd ${sessionId}`
      )
      lastError = null
      break
    } catch (error) {
      lastError = error
      if (error instanceof TimeoutError) break
      if (attempt === 0) await sleep(150)
    }
  }

  if (lastError !== null) {
    result.status = 'skipped'
    result.error = classifyError(lastError)
    result.elapsedMs = Date.now() - startedAt
    return result
  }

  result.decompressedBytes = raw.length
  const text = raw.toString('utf8')
  const lines = text.split('\n')
  const byType = new Map()

  for (const line of lines) {
    let current = line
    if (current.endsWith('\r')) current = current.slice(0, -1)
    if (current.trim() === '') continue
    let event
    try {
      event = JSON.parse(current)
    } catch {
      result.parseErrors += 1
      continue
    }
    result.events += 1
    const type = event !== null && typeof event === 'object' && typeof event.type === 'string' && event.type !== ''
      ? event.type
      : '(untyped)'
    const hit = countTagsInEvent(event)
    if (hit === null) continue
    let entry = byType.get(type)
    if (entry === undefined) {
      entry = { type, eventsWithHit: 0, tags: emptyTagCounts(), samples: {} }
      byType.set(type, entry)
    }
    entry.eventsWithHit += 1
    for (const name of TAG_NAMES) {
      const count = hit[name] ?? 0
      if (count === 0) continue
      result.tags[name] += count
      entry.tags[name] += count
      if (entry.samples[name] === undefined) entry.samples[name] = makeSample(event, name, options.maxSampleLen)
    }
  }

  result.byType = [...byType.values()].sort((left, right) => {
    const leftTotal = TAG_NAMES.reduce((sum, name) => sum + left.tags[name], 0)
    const rightTotal = TAG_NAMES.reduce((sum, name) => sum + right.tags[name], 0)
    return rightTotal - leftTotal || left.type.localeCompare(right.type)
  })
  result.elapsedMs = Date.now() - startedAt
  return result
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function tagSummaryLine(tags) {
  return TAG_NAMES.map(name => `${tagLabel(name)}=${tags[name]}`).join('  ')
}

function sortTagRows(tags, eventsWithHit) {
  const total = TAG_NAMES.reduce((sum, name) => sum + tags[name], 0)
  return [eventsWithHit, ...TAG_NAMES.map(name => tags[name]), total]
}

function renderSession(session) {
  const lines = []
  lines.push('')
  lines.push(`--- session: ${session.sessionId} ---`)
  lines.push(`workspace  : ${session.workspace}`)
  lines.push(`file       : ${session.file}`)
  if (session.status !== 'ok') {
    lines.push(`status     : SKIPPED (${session.error})`)
    return lines.join('\n')
  }
  lines.push(
    `size       : ${formatBytes(session.sizeBytes)} -> ${formatBytes(session.decompressedBytes)} decompressed` +
    ` | events=${session.events} | parse-errors=${session.parseErrors} | ${session.elapsedMs}ms`
  )
  const hitTotal = TAG_NAMES.reduce((sum, name) => sum + session.tags[name], 0)
  if (hitTotal === 0) {
    lines.push(`tag hits   : none (scanned ${session.events} events, 0 hits)`)
    return lines.join('\n')
  }
  lines.push(`tag hits   : ${tagSummaryLine(session.tags)} | total=${hitTotal}`)
  lines.push('per event type:')
  const header = ['event type', 'events w/ hit', ...TAG_NAMES.map(tagLabel), 'tag occurrences']
  lines.push(renderTable(header, session.byType.map(entry => [entry.type, ...sortTagRows(entry.tags, entry.eventsWithHit)])))
  lines.push('samples (first hit per tag; hit window; [TAG:x] labels kept; all other angle brackets escaped; sanitized; truncated):')
  for (const entry of session.byType) {
    for (const name of TAG_NAMES) {
      if (entry.tags[name] === 0) continue
      lines.push(`  ${tagLabel(name)} @ ${entry.type}: ${entry.samples[name] ?? '(no sample)'}`)
    }
  }
  return lines.join('\n')
}

function findTarget(sessions, discoveredFiles, options) {
  const target = sessions.find(session => session.sessionId === TARGET_SESSION_ID)
  if (target !== undefined) return { found: true, target }
  const onDisk = discoveredFiles.some(file => path.basename(path.dirname(file)) === TARGET_SESSION_ID)
  if (onDisk && options.session !== null) return { found: false, reason: `found on disk but excluded by --session "${options.session}"` }
  if (onDisk) return { found: false, reason: 'found on disk but not reported' }
  return { found: false, reason: 'not present under the scanned root' }
}

function renderTarget(sessions, discoveredFiles, options) {
  const { found, target, reason } = findTarget(sessions, discoveredFiles, options)
  const lines = []
  lines.push('')
  lines.push('=== target session highlight ===')
  lines.push(`session    : ${TARGET_SESSION_ID}`)
  if (!found) {
    lines.push(`found      : no (${reason})`)
    return lines.join('\n')
  }
  if (target.status !== 'ok') {
    lines.push(`found      : yes but SKIPPED (${target.error})`)
    return lines.join('\n')
  }
  const total = TAG_NAMES.reduce((sum, name) => sum + target.tags[name], 0)
  lines.push(`found      : yes (workspace ${target.workspace})`)
  lines.push(`events     : ${target.events} scanned, ${target.parseErrors} parse errors`)
  lines.push(`tag hits   : ${tagSummaryLine(target.tags)} | total=${total}`)
  if (total === 0) {
    lines.push(`note       : scanned ${target.events} events, 0 tag hits`)
  } else {
    lines.push('hit types  :')
    for (const entry of target.byType) {
      lines.push(`  ${entry.type}: events=${entry.eventsWithHit}  ${tagSummaryLine(entry.tags)}`)
    }
  }
  return lines.join('\n')
}

function buildJsonPayload(sessions, skipped, discoveredFiles, options, elapsedMs) {
  const totals = emptyTagCounts()
  let events = 0
  let parseErrors = 0
  for (const session of sessions) {
    events += session.events
    parseErrors += session.parseErrors
    if (session.status === 'ok') for (const name of TAG_NAMES) totals[name] += session.tags[name]
  }
  const target = findTarget(sessions, discoveredFiles, options)
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    node: process.version,
    root: options.root,
    options: {
      session: options.session,
      timeoutMs: options.timeoutMs,
      concurrency: options.concurrency,
      maxSampleLen: options.maxSampleLen
    },
    elapsedMs,
    totals: {
      discovered: discoveredFiles.length,
      scanned: sessions.filter(session => session.status === 'ok').length,
      skipped: skipped.length,
      events,
      parseErrors,
      tags: totals
    },
    sessions: sessions.map(session => ({
      sessionId: session.sessionId,
      workspace: session.workspace,
      file: session.file,
      status: session.status,
      error: session.error,
      sizeBytes: session.sizeBytes,
      decompressedBytes: session.decompressedBytes,
      events: session.events,
      parseErrors: session.parseErrors,
      elapsedMs: session.elapsedMs,
      tags: session.tags,
      byType: session.byType
    })),
    skipped,
    target: target.found
      ? {
          sessionId: TARGET_SESSION_ID,
          found: true,
          status: target.target.status,
          workspace: target.target.workspace,
          events: target.target.events,
          parseErrors: target.target.parseErrors,
          tags: target.target.tags,
          byType: target.target.byType
        }
      : { sessionId: TARGET_SESSION_ID, found: false, reason: target.reason }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.log(`[usage-error] ${error.message}`)
    printUsage()
    return 2
  }
  if (options.help) {
    printUsage()
    return 0
  }

  const startedAt = Date.now()
  let discoveredFiles
  try {
    discoveredFiles = await collectSessionFiles(options.root)
  } catch (error) {
    console.log(`[fatal] cannot read sessions root: ${options.root} (${error.message})`)
    return 2
  }
  if (discoveredFiles.length === 0) {
    console.log(`[warn] no ${SESSION_FILE} files found under ${options.root}`)
    return 0
  }

  const selectedFiles = options.session === null
    ? discoveredFiles
    : discoveredFiles.filter(file => path.basename(path.dirname(file)).includes(options.session))

  const sessions = await mapLimit(selectedFiles, options.concurrency, async file => {
    try {
      return await scanSession(file, options)
    } catch (error) {
      // Defensive: scanSession already catches its own failures, but a bug in
      // parsing must never abort the batch.
      return {
        sessionId: path.basename(path.dirname(file)),
        workspace: path.basename(path.dirname(path.dirname(file))),
        file,
        status: 'skipped',
        sizeBytes: null,
        decompressedBytes: null,
        events: 0,
        parseErrors: 0,
        elapsedMs: 0,
        error: `fatal-scan-error: ${error?.message ?? String(error)}`,
        tags: emptyTagCounts(),
        byType: []
      }
    }
  })

  sessions.sort((left, right) => left.workspace.localeCompare(right.workspace) || left.sessionId.localeCompare(right.sessionId))
  const skipped = sessions
    .filter(session => session.status === 'skipped')
    .map(session => ({ file: session.file, sessionId: session.sessionId, reason: session.error }))
  const elapsedMs = Date.now() - startedAt

  if (options.json) {
    console.log(JSON.stringify(buildJsonPayload(sessions, skipped, discoveredFiles, options, elapsedMs), null, 2))
    return 0
  }

  const okSessions = sessions.filter(session => session.status === 'ok')
  const grandTotals = emptyTagCounts()
  let totalEvents = 0
  let totalParseErrors = 0
  for (const session of okSessions) {
    totalEvents += session.events
    totalParseErrors += session.parseErrors
    for (const name of TAG_NAMES) grandTotals[name] += session.tags[name]
  }

  console.log('=== DSH session tag scan (read-only) ===')
  console.log(`root       : ${options.root}`)
  console.log(`files      : ${discoveredFiles.length} discovered, ${selectedFiles.length} selected, ${okSessions.length} scanned, ${skipped.length} skipped`)
  console.log(`elapsed    : ${elapsedMs}ms`, `| concurrency=${options.concurrency} | timeout=${options.timeoutMs}ms/file`)
  console.log(`node       : ${process.version}`)
  console.log(`tags       : ${TAG_NAMES.map(tagLabel).join(' ')} (display labels; raw tag text is escaped everywhere)`)
  console.log(`events     : ${totalEvents} (parse errors: ${totalParseErrors})`)
  console.log(`tag totals : ${tagSummaryLine(grandTotals)} | total=${TAG_NAMES.reduce((sum, name) => sum + grandTotals[name], 0)}`)

  for (const session of sessions) console.log(renderSession(session))

  if (skipped.length > 0) {
    console.log('')
    console.log('--- skipped files ---')
    for (const session of skipped) console.log(`- ${session.file}\n    reason: ${session.reason}`)
  }

  console.log(renderTarget(sessions, discoveredFiles, options))
  return 0
}

main()
  .then(code => {
    process.exitCode = code
  })
  .catch(error => {
    console.log(`[fatal] ${error?.stack ?? String(error)}`)
    process.exitCode = 1
  })
