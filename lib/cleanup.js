/**
 * Cleanup of Host-owned session residue that outlives a deleted session.
 *
 * Two things survive `deleteSession` when the Host does not get to finish:
 *
 *  1. `storages/session_projcache/sessions/<id>.json` — a cold projection
 *     snapshot. The per-session delete already removes its own cache file;
 *     older builds and other delete paths left a pile of orphans behind.
 *  2. `storages/workspace.json` — the workspace registry keeps the id in
 *     `global.archivedSessionIds`, `global.pinnedSessionIds`, and each
 *     workspace's `sessionIds`. `unarchiveSession()` only removes the archive
 *     mark; ids in the other arrays, and marks written back after our delete,
 *     survive as dead references.
 *
 * Nothing here touches a live session: a cache is only removed when NO session
 * log exists for that id anywhere under `sessions/`, and a registry id is only
 * removed when it is explicitly named as deleted. Both rules are deliberately
 * conservative — deleting the wrong cache only loses a title, but resurrecting
 * a wrong assumption about a live session is worse.
 */

import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { readJson, writeJson } from './util.js'

/**
 * Enumerate ids that own a durable session log.
 * Layout: `<home>/sessions/<encoded-project>/<sessionId>/session.v4.jsonl.zstd`
 *
 * @param {string} dshHome DSH home directory
 * @returns {Promise<Set<string>>} live session ids
 */
export async function liveSessionIds(dshHome) {
  const root = path.join(dshHome, 'sessions')
  const ids = new Set()
  let scopes
  try {
    scopes = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return ids
  }
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue
    const scopeDir = path.join(root, scope.name)
    let entries
    try {
      entries = await fs.readdir(scopeDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // Any .jsonl / .jsonl.zstd log marks the id as live; be version-agnostic.
      const dir = path.join(scopeDir, entry.name)
      let files
      try {
        files = await fs.readdir(dir)
      } catch {
        continue
      }
      if (files.some(name => /^session\.v\d+\.jsonl(?:\.zstd)?$/.test(name))) ids.add(entry.name)
    }
  }
  return ids
}

/**
 * Remove projection-cache files whose session no longer has a log.
 *
 * @param {string} dshHome DSH home directory
 * @param {{ apply?: boolean, onlyIds?: Iterable<string> }} [options]
 * @returns {Promise<{ scanned: number, orphans: string[], removed: string[], bytes: number }>}
 */
export async function sweepGhostCaches(dshHome, options = {}) {
  const dir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  const live = await liveSessionIds(dshHome)
  const only = options.onlyIds ? new Set(options.onlyIds) : undefined
  const result = { scanned: 0, orphans: [], removed: [], bytes: 0 }
  let files
  try {
    files = await fs.readdir(dir)
  } catch {
    return result
  }
  for (const name of files) {
    if (!name.endsWith('.json')) continue
    result.scanned += 1
    const id = name.slice(0, -5)
    if (live.has(id)) continue
    // When called for one delete, restrict to that id (plus nothing else):
    // a single delete must never sweep unrelated historical orphans.
    if (only && !only.has(id)) continue
    const file = path.join(dir, name)
    result.orphans.push(id)
    if (options.apply === false) continue
    try {
      const size = (await fs.stat(file)).size
      await fs.rm(file, { force: true })
      result.removed.push(id)
      result.bytes += size
    } catch {
      /* one unreadable cache must not stop the sweep */
    }
  }
  return result
}

/**
 * Strip a deleted id from every array in the workspace registry.
 *
 * Pure over the parsed object: returns `{ registry, removed }` and never
 * writes, so it can be tested without touching DSH state. The caller decides
 * when (and whether) to persist.
 *
 * @param {any} registry parsed workspace.json
 * @param {string} sessionId deleted session id
 * @returns {{ registry: any, removed: { archived: boolean, pinned: boolean, workspaces: string[] } }}
 */
export function stripSessionFromRegistry(registry, sessionId) {
  const removed = { archived: false, pinned: false, workspaces: [] }
  if (!registry || typeof registry !== 'object') return { registry, removed }
  const global = registry.global
  if (global && typeof global === 'object') {
    for (const [key, flag] of [['archivedSessionIds', 'archived'], ['pinnedSessionIds', 'pinned']]) {
      const list = global[key]
      if (!Array.isArray(list)) continue
      const next = list.filter(id => id !== sessionId)
      if (next.length !== list.length) {
        global[key] = next
        removed[flag] = true
      }
    }
  }
  const tables = registry.tables?.workspaces
  if (tables && typeof tables === 'object') {
    for (const [workspaceId, row] of Object.entries(tables)) {
      const list = row?.sessionIds
      if (!Array.isArray(list)) continue
      const next = list.filter(id => id !== sessionId)
      if (next.length !== list.length) {
        row.sessionIds = next
        removed.workspaces.push(workspaceId)
      }
    }
  }
  return { registry, removed }
}

/**
 * Strip every id that has no durable log from all registry arrays.
 *
 * Pure over the parsed object (the caller supplies `deadIds`), so historical
 * residue can be reviewed before anything is written. `liveSessionIds()` is
 * deliberately NOT called here: keeping this pure makes the "what would be
 * removed" report exactly match the apply, with no TOCTOU window.
 *
 * @param {any} registry parsed workspace.json
 * @param {Iterable<string>} deadIds ids with no session log
 * @returns {{ registry: any, removedIds: string[], changes: object }}
 */
export function stripDeadIdsFromRegistry(registry, deadIds) {
  const dead = new Set(deadIds)
  const changes = { archived: 0, pinned: 0, workspaceRows: 0, workspaceIds: 0 }
  if (!registry || typeof registry !== 'object' || dead.size === 0) {
    return { registry, removedIds: [], changes }
  }
  const prune = list => {
    if (!Array.isArray(list)) return list
    const next = list.filter(id => !dead.has(id))
    return next.length === list.length ? list : next
  }
  const global = registry.global
  if (global && typeof global === 'object') {
    if (Array.isArray(global.archivedSessionIds)) {
      const before = global.archivedSessionIds.length
      global.archivedSessionIds = prune(global.archivedSessionIds)
      changes.archived = before - global.archivedSessionIds.length
    }
    if (Array.isArray(global.pinnedSessionIds)) {
      const before = global.pinnedSessionIds.length
      global.pinnedSessionIds = prune(global.pinnedSessionIds)
      changes.pinned = before - global.pinnedSessionIds.length
    }
  }
  const tables = registry.tables?.workspaces
  if (tables && typeof tables === 'object') {
    for (const row of Object.values(tables)) {
      if (!row || !Array.isArray(row.sessionIds)) continue
      const before = row.sessionIds.length
      row.sessionIds = prune(row.sessionIds)
      if (row.sessionIds.length !== before) {
        changes.workspaceRows += 1
        changes.workspaceIds += before - row.sessionIds.length
      }
    }
  }
  // The caller supplies only ids that were actually found in the file, so the
  // removed list is exactly that set. `changes` reports how many entries were
  // dropped from each kind of array.
  return { registry, removedIds: [...dead], changes }
}

/**
 * Read the registry, strip the id, and write it back atomically only when
 * something changed. A missing or corrupt registry is a no-op, never a throw.
 *
 * @param {string} dshHome DSH home directory
 * @param {string} sessionId deleted session id
 * @returns {Promise<{ changed: boolean, removed: object }>}
 */
export async function purgeRegistryId(dshHome, sessionId) {
  const file = path.join(dshHome, 'storages', 'workspace.json')
  const registry = await readJson(file)
  if (!registry || typeof registry !== 'object') return { changed: false, removed: {} }
  const { registry: next, removed } = stripSessionFromRegistry(registry, sessionId)
  const changed = removed.archived || removed.pinned || removed.workspaces.length > 0
  if (changed) await writeJson(file, next)
  return { changed, removed }
}

/**
 * Session ids that a workspace names as one of its rows.
 *
 * ONLY `tables.workspaces[*].sessionIds` counts. `global.archivedSessionIds`
 * and `global.pinnedSessionIds` are FLAGS on an id, not a claim that the id is
 * still a live workspace entry point — folding them in here made every archived
 * blank session look "registered", so `hiddenSessions()` skipped it as a
 * protected placeholder and NO panel could ever show or delete it again. That is
 * how a retired bot session becomes invisible-but-permanent.
 *
 * @param {any} registry parsed workspace.json
 * @returns {string[]} ids, de-duplicated
 */
export function registrySessionIds(registry) {
  const ids = new Set()
  const tables = registry?.tables?.workspaces
  if (tables && typeof tables === 'object') {
    for (const row of Object.values(tables)) {
      const list = row?.sessionIds
      if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') ids.add(id)
    }
  }
  return [...ids]
}

/**
 * Every session id mentioned anywhere in the registry, flags included.
 *
 * This is for GHOST PURGING: it deliberately sweeps up ids that only survive as
 * an archive/pin flag so those can be dropped once the files are gone. Do NOT
 * use it to decide whether an id is a live workspace entry point — that is
 * {@link registrySessionIds}, and conflating the two is what made every archived
 * blank session look "registered" and therefore undeletable.
 *
 * @param {any} registry parsed workspace.json
 * @returns {string[]} ids, de-duplicated
 */
export function allRegistrySessionIds(registry) {
  const ids = new Set()
  const add = list => { if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') ids.add(id) }
  const global = registry?.global
  if (global && typeof global === 'object') {
    add(global.archivedSessionIds)
    add(global.pinnedSessionIds)
  }
  const tables = registry?.tables?.workspaces
  if (tables && typeof tables === 'object') for (const row of Object.values(tables)) add(row?.sessionIds)
  return [...ids]
}

/**
 * Sweep archived sessions in bulk.
 *
 * The archive page used to cost one `list()` and one `stats()` per session —
 * two directory walks each. With the thousand-plus rows left behind by bot
 * plugins that is thousands of syscalls per render, so the page either timed
 * out or showed "0 snapshots" for everything. This walks the two roots ONCE and
 * cross-references them in memory instead.
 *
 * Two independent things can be cleaned, reported separately because they have
 * different consequences:
 *   - `sessions`: the archived conversation itself (log, projection cache,
 *     snapshots, memory). Irreversible.
 *   - `snapshots`: only the snapshot directory of a session that stays. Frees
 *     the blobs while keeping the conversation readable.
 *
 * A live session is never touched: archive membership alone does not prove it
 * is idle, so `runningIds` (from the controller, which knows) vetoes.
 *
 * Selection is explicit: when `selectedIds` is supplied, ONLY those ids are
 * considered — preview and apply walk exactly the same set, so "I selected 50,
 * it previewed 50, it must delete those 50" holds. Ids are additionally
 * intersected with the CURRENT archived set (a server-side whitelist), so a
 * stale, forged, or meanwhile-restored id can never be used to delete a live
 * session. `limit` remains as a secondary cap for the "select all" case.
 *
 * @param {object} input
 * @param {string} input.dshHome DSH home directory
 * @param {string} input.checkpointRoot suite checkpoint root
 * @param {Iterable<string>} input.archivedIds ids marked archived in the registry
 * @param {Iterable<string>} [input.selectedIds] explicit selection; when omitted all archived ids are used
 * @param {Iterable<string>} [input.runningIds] ids with a live turn — never touched
 * @param {'sessions' | 'snapshots'} input.target what to remove
 * @param {boolean} [input.apply] write changes; false is a dry run
 * @param {number} [input.limit] stop after this many sessions (0 = no limit)
 * @param {(row: object) => Promise<void>} [input.removeSession] injected session delete; receives the full candidate row so the caller can distinguish a real log from a stale registry mark
 * @returns {Promise<{scanned: number, selectedCount: number, ignoredIds: string[], candidates: object[], removed: string[], failed: object[], bytes: number, applied: boolean, truncated: boolean}>}
 */
export async function sweepArchived(input) {
  const { dshHome, checkpointRoot } = input
  const archived = new Set(input.archivedIds ?? [])
  const running = new Set(input.runningIds ?? [])
  const target = input.target === 'snapshots' ? 'snapshots' : 'sessions'
  const apply = input.apply === true
  const limit = Number.isFinite(input.limit) && input.limit > 0 ? Number(input.limit) : 0

  const rawSelected = input.selectedIds
  const selection = rawSelected === undefined || rawSelected === null
    ? null
    : [...new Set(rawSelected)].filter(id => typeof id === 'string' && id.length > 0)
  const ignoredIds = selection ? selection.filter(id => !archived.has(id)) : []
  const ordered = selection ? selection.filter(id => archived.has(id)) : [...archived]

  const logSizes = await sessionLogSizes(dshHome)
  const snapshotRows = await snapshotIndex(checkpointRoot)

  const result = {
    scanned: archived.size,
    selectedCount: ordered.length,
    ignoredIds,
    candidates: [], removed: [], failed: [], bytes: 0, applied: apply, truncated: false,
  }

  let considered = 0
  for (const sessionId of ordered) {
    if (running.has(sessionId)) {
      result.candidates.push({ sessionId, skipped: 'running' })
      continue
    }
    // A cap is a hard stop on the WORK set, not on the number of rows shown.
    // Check it before pushing so the preview's byte total and the apply's byte
    // total describe exactly the same sessions — never a sentinel row that is
    // reported but never deleted.
    if (limit > 0 && considered >= limit) { result.truncated = true; break }
    considered += 1
    const log = logSizes.get(sessionId)
    const snap = snapshotRows.get(sessionId) ?? { checkpoints: 0, bytes: 0 }
    // An archived id with neither a log nor snapshots is pure registry residue;
    // it still counts as a candidate so the operator can clear the mark.
    // What the chosen target would actually free. `sessions` removes the log
    // AND the snapshots; `snapshots` keeps the conversation, so its log bytes
    // must not appear in the estimate — a preview that overstates the saving is
    // worse than one that understates it.
    const bytes = target === 'sessions' ? (log?.bytes ?? 0) + snap.bytes : snap.bytes
    result.candidates.push({
      sessionId,
      bytes,
      checkpoints: snap.checkpoints,
      // Physical log existence, not the controller's summary: a cold summary
      // can be missing while the log is still on disk, and deleting the wrong
      // one is worse than leaving a stale mark.
      hasLog: log !== undefined,
      hasSnapshots: snap.checkpoints > 0,
    })
  }

  const work = result.candidates.filter(row => row.skipped === undefined && row.bytes !== undefined)
  if (!apply) {
    result.bytes = work.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
    return result
  }

  const capped = limit > 0 ? work.slice(0, limit) : work
  result.truncated = limit > 0 && work.length > capped.length

  for (const row of capped) {
    try {
      if (target === 'snapshots') {
        await fs.rm(path.join(checkpointRoot, 'sessions', row.sessionId), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        result.bytes += row.bytes ?? 0
      } else {
        if (typeof input.removeSession === 'function') await input.removeSession(row)
        else await removeArchivedSessionFiles(dshHome, checkpointRoot, row.sessionId)
        result.bytes += row.bytes ?? 0
      }
      result.removed.push(row.sessionId)
    } catch (error) {
      result.failed.push({ sessionId: row.sessionId, reason: String(error?.message ?? error) })
    }
  }
  return result
}

/**
 * Session id -> log file size, from ONE walk of `<home>/sessions`.
 *
 * @param {string} dshHome DSH home directory
 * @returns {Promise<Map<string, { bytes: number, files: string[] }>>} sizes by id
 */
export async function sessionLogSizes(dshHome) {
  const root = path.join(dshHome, 'sessions')
  const out = new Map()
  let scopes
  try { scopes = await fs.readdir(root, { withFileTypes: true }) } catch { return out }
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue
    const scopeDir = path.join(root, scope.name)
    let entries
    try { entries = await fs.readdir(scopeDir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(scopeDir, entry.name)
      let files
      try { files = await fs.readdir(dir) } catch { continue }
      let bytes = 0
      const matched = []
      for (const name of files) {
        if (!/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(name)) continue
        matched.push(name)
        try { bytes += (await fs.stat(path.join(dir, name))).size } catch { /* unreadable log still counts as present */ }
      }
      if (matched.length === 0) continue
      const previous = out.get(entry.name)
      out.set(entry.name, { bytes: Math.max(bytes, previous?.bytes ?? 0), files: [...(previous?.files ?? []), ...matched] })
    }
  }
  return out
}

/**
 * Session id -> { checkpoints, bytes }, from ONE walk of the checkpoint root.
 *
 * Reads each `index.json` once and stats the two subdirectories, so a library
 * of a thousand sessions costs a thousand small reads instead of two thousand
 * directory walks plus a re-read per screen.
 *
 * @param {string} checkpointRoot suite checkpoint root
 * @returns {Promise<Map<string, { checkpoints: number, bytes: number }>>} counts by id
 */
export async function snapshotIndex(checkpointRoot) {
  const out = new Map()
  const dir = path.join(checkpointRoot, 'sessions')
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sessionDir = path.join(dir, entry.name)
    let checkpoints = 0
    try {
      const index = await readJson(path.join(sessionDir, 'index.json'))
      if (Array.isArray(index?.checkpoints)) checkpoints = index.checkpoints.length
    } catch { /* a corrupt index reports zero rather than failing the sweep */ }
    let bytes = 0
    for (const sub of ['blobs', 'manifests']) {
      bytes += await dirBytes(path.join(sessionDir, sub))
    }
    out.set(entry.name, { checkpoints, bytes })
  }
  return out
}

/**
 * Recursive size of one directory, ignoring a missing one.
 *
 * @param {string} dir directory
 * @returns {Promise<number>} bytes
 */
async function dirBytes(dir) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return 0 }
  let total = 0
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await dirBytes(full)
    else { try { total += (await fs.stat(full)).size } catch { /* vanished mid-walk */ } }
  }
  return total
}

/**
 * Remove one archived session's files across both roots.
 *
 * The registry mark is left to the caller: `purgeRegistryId` already owns that
 * write, and doing it twice would clobber a concurrent change.
 *
 * @param {string} dshHome DSH home directory
 * @param {string} checkpointRoot suite checkpoint root
 * @param {string} sessionId session
 */
async function removeArchivedSessionFiles(dshHome, checkpointRoot, sessionId) {
  const scopeRoot = path.join(dshHome, 'sessions')
  let scopes = []
  try { scopes = await fs.readdir(scopeRoot, { withFileTypes: true }) } catch { /* no sessions dir */ }
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue
    const dir = path.join(scopeRoot, scope.name, sessionId)
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
  }
  await fs.rm(path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), { force: true }).catch(() => {})
  await fs.rm(path.join(checkpointRoot, 'sessions', sessionId), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
}

/**
 * Scan for sessions the Host hides from the sidebar but `@` still lists.
 *
 * Host rule (dsh-client-ui-workspace `sessionVisible`): a row is hidden when
 * `origin === 'subagent'`, or when `blank === true` and it is not the current
 * session. That filter runs BEFORE the archived filter, so even the
 * "show archived" view cannot display a blank session. `@` candidates come
 * from `sessionPersistence.list()` and ignore both flags entirely.
 *
 * Bot plugins leave thousands of exactly these: a log exists, a projection
 * cache exists, so `@` offers them forever, while no UI surface can delete
 * them. The archive cleanup cannot help because they are not archived.
 *
 * Reads ONE header per log (through a streaming zstd decompressor, so a huge
 * log is not loaded into memory) plus the projection cache. All read-only.
 *
 * A blank row that is still registered in `workspace.json` is the workspace's
 * New Session placeholder — the Host hides it from other views but deleting it
 * would break that workspace's entry point. Only UNREGISTERED blanks (bot
 * debris) are offered for cleanup.
 *
 * @param {string} dshHome DSH home directory
 * @param {{ currentSessionId?: string, archivedIds?: Iterable<string>, registeredIds?: Iterable<string> }} [options]
 * @returns {Promise<object[]>} hidden rows, newest first
 */
export async function hiddenSessions(dshHome, options = {}) {
  const currentId = options.currentSessionId
  const archived = new Set(options.archivedIds ?? [])
  const registered = new Set(options.registeredIds ?? [])
  const root = path.join(dshHome, 'sessions')
  const projDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  const rows = []
  let scopes = []
  try { scopes = await fs.readdir(root, { withFileTypes: true }) } catch { return rows }

  for (const scope of scopes) {
    if (!scope.isDirectory()) continue
    const scopeDir = path.join(root, scope.name)
    let entries = []
    try { entries = await fs.readdir(scopeDir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionId = entry.name
      const dir = path.join(scopeDir, sessionId)
      let files = []
      try { files = await fs.readdir(dir) } catch { continue }
      const logName = files.find(name => /^session\.v\d+\.jsonl(?:\.zstd)?$/.test(name))
      if (!logName) continue
      const logFile = path.join(dir, logName)
      let size = 0
      try { size = (await fs.stat(logFile)).size } catch { /* still a candidate */ }

      const header = await readSessionHeader(logFile)
      let meta = {}
      let title = null
      try {
        const cache = await readJson(path.join(projDir, `${sessionId}.json`))
        meta = cache?.record?.rows?.sessionListMetadata?.val ?? {}
        title = cache?.record?.rows?.title?.val ?? null
      } catch { /* a missing cache is not fatal: header origin still counts */ }

      const blank = meta.blank === true
      const subagent = header?.origin === 'subagent'
      if (!blank && !subagent) continue
      // The current blank session is legitimately visible; never offer to delete it.
      if (blank && sessionId === currentId && !subagent) continue
      // A blank row still named in a workspace's sessionIds is that workspace's
      // New Session placeholder. It looks like debris but is live UI state.
      if (blank && !subagent && registered.has(sessionId)) continue

      rows.push({
        sessionId,
        title: typeof title === 'string' && title ? title : null,
        cwd: header?.cwd ?? '',
        scope: scope.name,
        bytes: size,
        blank,
        subagent,
        archived: archived.has(sessionId),
        createdAt: header?.createdAt ?? 0,
      })
    }
  }
  return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.sessionId.localeCompare(b.sessionId))
}

/**
 * Read only the `session` header from a possibly-compressed log.
 *
 * A hidden-session sweep can race with a delete that rewrites or truncates a
 * log. A half-written zstd frame then makes `ZstdDecompress` emit `error`
 * asynchronously (`ZSTD_error_prefix_unknown` / Unknown frame descriptor),
 * and readline does NOT forward that error into the `for await` iterator. On
 * Node 24 it used to escape as an uncaught exception and kill the whole DSH
 * host (exit 1). A source-side ENOENT/EACCES has the same shape.
 *
 * Both streams are therefore guarded, the first failure is recorded, and the
 * iterator is unblocked so the sweep degrades to "header-less" instead.
 *
 * @param {string} file absolute path
 * @returns {Promise<object|null>} header
 */
async function readSessionHeader(file) {
  const input = createReadStream(file)
  const stream = file.endsWith('.zstd') ? input.pipe(createZstdDecompress()) : input
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let streamError = null
  let header = null
  const onError = (error) => {
    if (streamError === null) streamError = error
    // Neither a source error nor a bad frame reaches readline, so closing the
    // interface is what releases the `for await` loop instead of hanging.
    try { rl.close() } catch { /* ignore */ }
  }
  // fs.ReadStream and ZstdDecompress both emit asynchronously, so attaching
  // after createInterface is safe. Deliberately keep the listeners attached
  // for the stream's whole life: removing them in `finally` would let a late
  // `error` (e.g. one raised by destroy()) become unhandled all over again.
  input.on('error', onError)
  if (stream !== input) stream.on('error', onError)
  try {
    for await (const line of rl) {
      if (!line) continue
      try {
        const ev = JSON.parse(line)
        if (ev?.type === 'session') { header = ev; break }
      } catch { /* first line may be a BOM or a partial write; keep looking */ }
      // A header is always the first event; nothing later can be one.
      break
    }
  } catch {
    /* an unreadable log is reported as header-less, not as a crash */
  } finally {
    try { rl.close() } catch { /* ignore */ }
    try { stream.destroy() } catch { /* ignore */ }
    try { input.destroy() } catch { /* ignore */ }
  }
  return streamError === null ? header : null
}

/**
 * Sweep explicitly selected hidden sessions.
 *
 * Preview and apply walk the SAME set: ids are intersected with the CURRENT
 * hidden list, so a forged id, a session that became visible, or a meanwhile
 * deleted log can never be deleted through this path. The current session is
 * always vetoed. Deletion itself is injected so the service can reuse its
 * single-session delete path (registry marks, caches, memory, undo bundles).
 *
 * @param {object} input
 * @param {string} input.dshHome DSH home directory
 * @param {object[]} input.hidden rows from hiddenSessions()
 * @param {Iterable<string>} input.selectedIds explicit selection
 * @param {boolean} [input.apply] false = dry run
 * @param {(row: object) => Promise<void>} [input.removeSession] deletion hook
 * @returns {Promise<object>} sweep report
 */
export async function sweepHidden(input) {
  const hidden = new Map((input.hidden ?? []).map(row => [row.sessionId, row]))
  const selected = input.selectedIds === undefined || input.selectedIds === null
    ? [...hidden.keys()]
    : [...new Set(input.selectedIds)].filter(id => typeof id === 'string' && id)
  const ignoredIds = selected.filter(id => !hidden.has(id))
  const work = selected.filter(id => hidden.has(id)).map(id => hidden.get(id))
  const applied = input.apply === true
  const result = {
    scanned: hidden.size,
    selectedCount: work.length,
    ignoredIds,
    candidates: work,
    removed: [],
    failed: [],
    bytes: 0,
    applied,
  }
  if (!applied) {
    result.bytes = work.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
    return result
  }
  for (const row of work) {
    try {
      if (typeof input.removeSession === 'function') await input.removeSession(row)
      result.removed.push(row.sessionId)
      result.bytes += row.bytes ?? 0
    } catch (error) {
      result.failed.push({ sessionId: row.sessionId, reason: String(error?.message ?? error) })
    }
  }
  return result
}

/**
 * Remove all registry ids that no longer have a session log.
 *
 * Dry run by default (`apply: false`), matching `sweepOrphanCheckpoints`.
 * A missing or corrupt registry, or no dead ids, is a clean no-op.
 *
 * @param {string} dshHome DSH home directory
 * @param {{ apply?: boolean }} [options]
 * @returns {Promise<{ scanned: number, deadIds: string[], applied: boolean, changes: object }>}
 */
export async function purgeRegistryGhosts(dshHome, options = {}) {
  const file = path.join(dshHome, 'storages', 'workspace.json')
  const registry = await readJson(file)
  if (!registry || typeof registry !== 'object') {
    return { scanned: 0, deadIds: [], applied: false, changes: {} }
  }
  const allIds = allRegistrySessionIds(registry)
  const live = await liveSessionIds(dshHome)
  const deadIds = allIds.filter(id => !live.has(id))
  const { registry: next, changes } = stripDeadIdsFromRegistry(registry, deadIds)
  if (options.apply === true && deadIds.length > 0) await writeJson(file, next)
  return { scanned: allIds.length, deadIds, applied: options.apply === true && deadIds.length > 0, changes }
}
