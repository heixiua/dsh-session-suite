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
 * Every session id mentioned anywhere in the registry.
 *
 * @param {any} registry parsed workspace.json
 * @returns {string[]} ids, de-duplicated
 */
export function registrySessionIds(registry) {
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
 * @param {object} input
 * @param {string} input.dshHome DSH home directory
 * @param {string} input.checkpointRoot suite checkpoint root
 * @param {Iterable<string>} input.archivedIds ids marked archived in the registry
 * @param {Iterable<string>} [input.runningIds] ids with a live turn — never touched
 * @param {'sessions' | 'snapshots'} input.target what to remove
 * @param {boolean} [input.apply] write changes; false is a dry run
 * @param {number} [input.limit] stop after this many sessions (0 = no limit)
 * @param {(row: object) => Promise<void>} [input.removeSession] injected session delete; receives the full candidate row so the caller can distinguish a real log from a stale registry mark
 * @returns {Promise<{scanned: number, candidates: object[], removed: string[], failed: object[], bytes: number, applied: boolean, truncated: boolean}>}
 */
export async function sweepArchived(input) {
  const { dshHome, checkpointRoot } = input
  const archived = new Set(input.archivedIds ?? [])
  const running = new Set(input.runningIds ?? [])
  const target = input.target === 'snapshots' ? 'snapshots' : 'sessions'
  const apply = input.apply === true
  const limit = Number.isFinite(input.limit) && input.limit > 0 ? Number(input.limit) : 0

  const logSizes = await sessionLogSizes(dshHome)
  const snapshotRows = await snapshotIndex(checkpointRoot)

  const result = { scanned: archived.size, candidates: [], removed: [], failed: [], bytes: 0, applied: apply, truncated: false }

  let considered = 0
  for (const sessionId of archived) {
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
  const allIds = registrySessionIds(registry)
  const live = await liveSessionIds(dshHome)
  const deadIds = allIds.filter(id => !live.has(id))
  const { registry: next, changes } = stripDeadIdsFromRegistry(registry, deadIds)
  if (options.apply === true && deadIds.length > 0) await writeJson(file, next)
  return { scanned: allIds.length, deadIds, applied: options.apply === true && deadIds.length > 0, changes }
}
