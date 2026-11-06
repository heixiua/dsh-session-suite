/**
 * Incremental, content-addressed workspace checkpoints.
 *
 * Design goals (mirrors Trae's session checkpoints, with the safety net the
 * product discussion asked for):
 *
 * - one JSON manifest per checkpoint records only the *tracked* files and their
 *   content hashes; file bytes live once in a zstd/gzip-compressed blob store,
 *   so N checkpoints of the same tree cost roughly one tree plus the deltas;
 * - captures reuse the previous manifest's `(size, mtimeMs)` fingerprint to skip
 *   re-reading unchanged files;
 * - a session keeps at most `keep` automatic checkpoints; locked checkpoints and
 *   temporary undo bundles live outside that budget;
 * - restore only deletes files that this session's own history created, never a
 *   file the workspace had before the session started.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import {
  DEFAULT_IGNORES,
  createIgnoreMatcher,
  ensureDir,
  formatBytes,
  looksBinary,
  mapLimit,
  readJson,
  removeDir,
  sha256,
  shortId,
  statOrUndefined,
  toPosix,
  writeJson,
} from './util.js'

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

const DEFAULTS = {
  /** Automatic checkpoints retained per session. */
  keep: 10,
  /** Files larger than this are never recorded. */
  maxFileBytes: 2 * 1024 * 1024,
  /** Hard stop so a runaway tree cannot stall a turn. */
  maxFiles: 4000,
  /** Serialize captures per session; readers still see the last finished one. */
  captureConcurrency: 8,
  /** Undo bundles expire after this long. */
  undoTtlMs: 10 * 60 * 1000,
}

export class CheckpointStore {
  /**
   * @param {object} options store options
   * @param {string} options.root suite data directory
   * @param {(message: string, error?: unknown) => void} [options.log] diagnostic sink
   * @param {readonly string[]} [options.ignores] extra ignore patterns
   */
  constructor({ root, log = () => {}, ignores = [] }) {
    this.root = root
    this.log = log
    this.ignores = [...DEFAULT_IGNORES, ...ignores]
    /** @type {Map<string, Promise<unknown>>} one capture at a time per session */
    this.locks = new Map()
  }

  /** @param {string} sessionId session */
  sessionDir(sessionId) {
    return path.join(this.root, 'sessions', sessionId)
  }

  /** @param {string} sessionId session */
  indexPath(sessionId) {
    return path.join(this.sessionDir(sessionId), 'index.json')
  }

  /** @param {string} sessionId session */
  blobDir(sessionId) {
    return path.join(this.sessionDir(sessionId), 'blobs')
  }

  /** @param {string} sessionId session */
  manifestDir(sessionId) {
    return path.join(this.sessionDir(sessionId), 'manifests')
  }

  /** @param {string} sessionId session */
  async readIndex(sessionId) {
    const index = await readJson(this.indexPath(sessionId))
    if (!index || typeof index !== 'object' || !Array.isArray(index.checkpoints)) {
      return { version: 1, cwd: undefined, checkpoints: [] }
    }
    return index
  }

  /** @param {string} sessionId session @param {any} index index */
  async writeIndex(sessionId, index) {
    await writeJson(this.indexPath(sessionId), index)
  }

  /**
   * Snapshot the working tree.
   *
   * @param {object} input capture input
   * @param {string} input.sessionId session that owns the checkpoint
   * @param {string} input.cwd workspace root
   * @param {number} [input.seq] durable session sequence this state belongs to
   * @param {number} [input.turn] turn number the state was observed at
   * @param {'auto' | 'manual' | 'undo' | 'pre-rollback'} [input.kind] checkpoint kind
   * @param {string} [input.label] human label
   * @param {number} [input.ttlMs] expiry for temporary kinds
   * @param {{ keep?: number, maxFileBytes?: number, maxFiles?: number }} [input.limits] overrides
   * @returns {Promise<{ checkpoint: any, skipped: string[], truncated: boolean, newBytes: number }>}
   */
  async capture(input) {
    const sessionId = input.sessionId
    const previous = this.locks.get(sessionId) ?? Promise.resolve()
    const run = previous
      .catch(() => {})
      .then(() => this.#capture(input))
    this.locks.set(sessionId, run)
    try {
      return await run
    } finally {
      if (this.locks.get(sessionId) === run) this.locks.delete(sessionId)
    }
  }

  async #capture(input) {
    const limits = {
      keep: input.limits?.keep ?? DEFAULTS.keep,
      maxFileBytes: input.limits?.maxFileBytes ?? DEFAULTS.maxFileBytes,
      maxFiles: input.limits?.maxFiles ?? DEFAULTS.maxFiles,
    }
    const cwd = path.resolve(input.cwd)
    const kind = input.kind ?? 'auto'
    const index = await this.readIndex(input.sessionId)
    const isTemporary = kind === 'undo' || kind === 'pre-rollback'

    /** @type {Map<string, { size: number, mtimeMs: number }>} */
    const fingerprints = new Map()
    const previousManifest = await this.#latestManifest(input.sessionId, index, kind)
    if (previousManifest) {
      for (const [rel, entry] of Object.entries(previousManifest.entries)) {
        if (typeof entry.s === 'number' && typeof entry.m === 'number') {
          fingerprints.set(rel, { size: entry.s, mtimeMs: entry.m })
        }
      }
    }

    const matcher = createIgnoreMatcher(this.ignores)
    const files = []
    const skipped = []
    let truncated = false
    await walkWorkspace(cwd, cwd, matcher, files, skipped, limits, () => {
      truncated = true
    })

    const blobs = this.blobDir(input.sessionId)
    const safeCwd = cwd
    let newBytes = 0
    /**
     * Files touched this recently may share an mtime tick with a rewrite of the
     * same size (the classic "racily clean" case), so their fingerprint is not
     * trusted and they are always re-read.
     */
    const racyBefore = Date.now() - 2000
    /** @type {Record<string, { h: string, s: number, m: number }>} */
    const entries = {}

    await mapLimit(files, DEFAULTS.captureConcurrency, async file => {
      const rel = toPosix(path.relative(safeCwd, file.abs))
      const known = fingerprints.get(rel)
      const trusted = known && file.mtimeMs < racyBefore
      if (trusted && known.size === file.size && Math.abs(known.mtimeMs - file.mtimeMs) < 1) {
        const hash = await this.#hashFromPrevious(input.sessionId, index, rel)
        if (hash) {
          entries[rel] = { h: hash, s: file.size, m: Math.round(file.mtimeMs) }
          return
        }
      }
      let buffer
      try {
        buffer = await fs.readFile(file.abs)
      } catch (error) {
        skipped.push(`${rel} (unreadable: ${error instanceof Error ? error.message : String(error)})`)
        return
      }
      if (looksBinary(buffer.subarray(0, 8192))) {
        skipped.push(`${rel} (binary)`)
        return
      }
      const hash = sha256(buffer)
      const target = this.#blobPath(blobs, hash)
      const existing = await statOrUndefined(target)
      if (!existing) {
        await ensureDir(path.dirname(target))
        const compressed = await gzip(buffer, { level: 6 })
        await fs.writeFile(target, compressed)
        newBytes += compressed.byteLength
      }
      entries[rel] = { h: hash, s: buffer.byteLength, m: Math.round(file.mtimeMs) }
    })

    const sorted = {}
    for (const key of Object.keys(entries).sort()) sorted[key] = entries[key]

    const id = `cp_${Date.now().toString(36)}_${shortId(`${input.sessionId}:${input.seq ?? ''}`)}`
    const manifestFile = `${id}.json`
    await ensureDir(this.manifestDir(input.sessionId))
    await writeJson(path.join(this.manifestDir(input.sessionId), manifestFile), {
      version: 1,
      cwd,
      createdAt: Date.now(),
      entries: sorted,
    })

    const totalBytes = Object.values(sorted).reduce((sum, entry) => sum + (entry.s ?? 0), 0)
    const record = {
      id,
      sessionId: input.sessionId,
      seq: input.seq ?? null,
      turn: input.turn ?? null,
      /**
       * What the snapshot describes: `end` is the workspace after the turn
       * finished (the default), `start` is the workspace before it began (the
       * older format, kept readable for snapshots taken before this change).
       */
      phase: input.phase ?? 'end',
      kind,
      label: input.label ?? defaultLabel(kind),
      createdAt: Date.now(),
      expiresAt: isTemporary ? Date.now() + (input.ttlMs ?? DEFAULTS.undoTtlMs) : null,
      locked: false,
      cwd,
      manifest: manifestFile,
      files: Object.keys(sorted).length,
      bytes: newBytes,
      totalBytes,
      skipped: skipped.length,
    }

    index.cwd = cwd
    // A temporary bundle never replaces an automatic checkpoint position.
    index.checkpoints = [...index.checkpoints.filter(item => item.id !== id), record]
    await this.#prune(input.sessionId, index, limits.keep)
    await this.writeIndex(input.sessionId, index)

    this.log(
      `captured ${kind} checkpoint ${id} (${record.files} files, +${formatBytes(newBytes)}) for ${input.sessionId}`,
    )
    return { checkpoint: record, skipped, truncated, newBytes }
  }

  /**
   * Restore the working tree to one checkpoint.
   *
   * @param {object} input restore input
   * @param {string} input.sessionId session
   * @param {string} input.checkpointId checkpoint to restore
   * @returns {Promise<{ written: number, deleted: number, unchanged: number, bytes: number, cwd: string }>}
   */
  async restore(input) {
    const index = await this.readIndex(input.sessionId)
    const record = index.checkpoints.find(item => item.id === input.checkpointId)
    if (!record) throw new Error(`checkpoint ${input.checkpointId} no longer exists`)
    const manifest = await readJson(path.join(this.manifestDir(input.sessionId), record.manifest))
    if (!manifest || typeof manifest.entries !== 'object') {
      throw new Error(`checkpoint ${input.checkpointId} is missing its manifest`)
    }

    const cwd = path.resolve(record.cwd ?? index.cwd ?? '')
    const blobs = this.blobDir(input.sessionId)
    const target = manifest.entries
    let written = 0
    let unchanged = 0
    let bytes = 0

    const rels = Object.keys(target)
    await mapLimit(rels, DEFAULTS.captureConcurrency, async rel => {
      const entry = target[rel]
      const abs = path.join(cwd, rel)
      const current = await statOrUndefined(abs)
      if (current && current.isFile() && current.size === entry.s) {
        const currentBytes = await fs.readFile(abs).catch(() => undefined)
        if (currentBytes && sha256(currentBytes) === entry.h) {
          unchanged += 1
          return
        }
      }
      const blob = await this.#readBlob(blobs, entry.h)
      if (!blob) throw new Error(`blob for ${rel} is missing; cannot restore a consistent tree`)
      await ensureDir(path.dirname(abs))
      await fs.writeFile(abs, blob)
      written += 1
      bytes += blob.byteLength
    })

    // Delete files this session created after the target checkpoint, and only
    // those: anything the manifest lists is kept, and unknown files stay.
    const later = new Set()
    for (const item of index.checkpoints) {
      if (item.id === record.id) continue
      if (item.createdAt <= record.createdAt) continue
      const other = await readJson(path.join(this.manifestDir(input.sessionId), item.manifest)).catch(() => undefined)
      if (!other || typeof other.entries !== 'object') continue
      for (const rel of Object.keys(other.entries)) later.add(rel)
    }
    let deleted = 0
    for (const rel of later) {
      if (Object.prototype.hasOwnProperty.call(target, rel)) continue
      const abs = path.join(cwd, rel)
      const info = await statOrUndefined(abs)
      if (!info || !info.isFile()) continue
      await fs.rm(abs, { force: true }).catch(() => {})
      deleted += 1
    }

    return { written, deleted, unchanged, bytes, cwd }
  }

  /**
   * Delete one checkpoint (locked checkpoints refuse).
   *
   * @param {string} sessionId session
   * @param {string} checkpointId checkpoint
   * @returns {Promise<{ deleted: boolean, reason?: string }>} outcome
   */
  async removeCheckpoint(sessionId, checkpointId) {
    const index = await this.readIndex(sessionId)
    const record = index.checkpoints.find(item => item.id === checkpointId)
    if (!record) return { deleted: false, reason: 'not-found' }
    if (record.locked) return { deleted: false, reason: 'locked' }
    index.checkpoints = index.checkpoints.filter(item => item.id !== checkpointId)
    await this.writeIndex(sessionId, index)
    await fs.rm(path.join(this.manifestDir(sessionId), record.manifest), { force: true }).catch(() => {})
    const freed = await this.#collectGarbage(sessionId, index)
    return { deleted: true, freed }
  }

  /**
   * @param {string} sessionId session
   * @param {string} checkpointId checkpoint
   * @param {boolean} locked new lock state
   */
  async setLocked(sessionId, checkpointId, locked) {
    const index = await this.readIndex(sessionId)
    const record = index.checkpoints.find(item => item.id === checkpointId)
    if (!record) throw new Error(`checkpoint ${checkpointId} no longer exists`)
    record.locked = locked === true
    await this.writeIndex(sessionId, index)
    return record
  }

  /**
   * @param {string} sessionId session
   * @returns {Promise<any[]>} checkpoints, newest first
   */
  async list(sessionId) {
    const index = await this.readIndex(sessionId)
    const now = Date.now()
    return index.checkpoints
      .filter(item => !item.expiresAt || item.expiresAt > now)
      .map(item => ({
        ...item,
        effectiveTurn:
          typeof item.turn !== 'number'
            ? item.turn
            : item.phase === 'end'
              ? item.turn
              : item.turn - 1,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Newest checkpoint that describes the tree at (or just after) a turn.
   *
   * @param {string} sessionId session
   * @param {number | null} turn target turn
   * @param {number | null} seq target sequence
   * @returns {Promise<any | undefined>} best checkpoint
   */
  async checkpointAt(sessionId, turn, seq) {
    const list = (await this.list(sessionId)).filter(item => item.kind !== 'undo' && item.kind !== 'pre-rollback')
    if (list.length === 0) return undefined
    if (typeof turn === 'number') {
      // `effectiveTurn` is the turn whose completion this snapshot represents:
      // snapshots taken after a turn map to that turn, and older snapshots taken
      // before one map to the turn that just finished.
      const before = list.filter(item => typeof item.effectiveTurn === 'number' && item.effectiveTurn <= turn)
      if (before.length > 0) {
        return before.sort((a, b) => (b.effectiveTurn ?? 0) - (a.effectiveTurn ?? 0) || b.createdAt - a.createdAt)[0]
      }
    }
    if (typeof seq === 'number') {
      const bySeq = list.filter(item => typeof item.seq === 'number' && item.seq <= seq)
      if (bySeq.length > 0) return bySeq.sort((a, b) => b.createdAt - a.createdAt)[0]
    }
    return list.sort((a, b) => a.createdAt - b.createdAt)[0]
  }

  /**
   * Total disk usage of a session's snapshots.
   *
   * @param {string} sessionId session
   */
  async stats(sessionId) {
    const index = await this.readIndex(sessionId)
    const blobs = await dirSize(this.blobDir(sessionId))
    const manifests = await dirSize(this.manifestDir(sessionId))
    return {
      checkpoints: index.checkpoints.length,
      bytes: blobs + manifests,
      blobBytes: blobs,
      manifestBytes: manifests,
    }
  }

  /**
   * Drop every snapshot of a session (permanent delete).
   *
   * @param {string} sessionId session
   */
  async purgeSession(sessionId) {
    await removeDir(this.sessionDir(sessionId))
  }

  /**
   * Give a forked session the snapshots its parent had.
   *
   * Deleting a turn or rewinding both work by forking the event prefix and
   * retiring the original, so the child inherits the parent's conversation. Its
   * snapshots are stored per session id, though, so without this the child
   * starts with no history at all: the panel is empty, and rewinding inside the
   * continuation has no earlier state to restore. The parent's snapshots still
   * describe the same workspace and the same turns, so they carry over
   * unchanged — only the owning session id differs.
   *
   * Blobs are shared by hard link rather than copied. They are content
   * addressed and immutable, so linking costs no disk; a copy would multiply
   * every snapshot's bytes by the number of forks. Falls back to copying when
   * linking fails (for example across volumes), which is correct if wasteful.
   *
   * @param {object} input inherit input
   * @param {string} input.from parent session
   * @param {string} input.to forked session
   * @param {number} [input.throughSeq] keep only snapshots at or before this seq
   * @param {number} [input.keep] how many of the newest snapshots to carry
   * @returns {Promise<{ inherited: number, skipped: number, linked: number, copied: number }>}
   */
  async inherit({ from, to, throughSeq, keep }) {
    const result = { inherited: 0, skipped: 0, linked: 0, copied: 0 }
    if (!from || !to || from === to) return result
    const source = await this.readIndex(from)
    if (source.checkpoints.length === 0) return result

    const budget = Number.isFinite(keep) ? Math.max(1, keep) : DEFAULTS.keep
    const eligible = source.checkpoints
      .filter(record => {
        if (record.kind === 'undo' || record.kind === 'pre-rollback') return false
        if (Number.isFinite(throughSeq) && typeof record.seq === 'number' && record.seq > throughSeq) return false
        return true
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, budget)
      .reverse()
    result.skipped += source.checkpoints.length - eligible.length

    const target = await this.readIndex(to)
    const sourceManifests = this.manifestDir(from)
    const targetManifests = this.manifestDir(to)
    const sourceBlobs = this.blobDir(from)
    const targetBlobs = this.blobDir(to)
    await ensureDir(targetManifests)

    const carried = []
    for (const record of eligible) {
      // A snapshot taken later than the fork point describes a workspace the
      // child never had; carrying it would let the child restore files from a
      // future it did not inherit.
      if (Number.isFinite(throughSeq) && typeof record.seq === 'number' && record.seq > throughSeq) {
        result.skipped += 1
        continue
      }
      const manifest = await readJson(path.join(sourceManifests, record.manifest)).catch(() => undefined)
      if (!manifest || typeof manifest.entries !== 'object') {
        result.skipped += 1
        continue
      }

      const id = `cp_${Date.now().toString(36)}_${shortId(`${to}:${record.seq ?? ''}:${record.id}`)}`
      const manifestFile = `${id}.json`
      await writeJson(path.join(targetManifests, manifestFile), { ...manifest, sessionId: to })

      for (const entry of Object.values(manifest.entries)) {
        if (!entry || typeof entry.h !== 'string') continue
        const sourceBlob = this.#blobPath(sourceBlobs, entry.h)
        const targetBlob = this.#blobPath(targetBlobs, entry.h)
        const existing = await statOrUndefined(targetBlob)
        if (existing) continue
        await ensureDir(path.dirname(targetBlob))
        try {
          await fs.link(sourceBlob, targetBlob)
          result.linked += 1
        } catch {
          try {
            await fs.copyFile(sourceBlob, targetBlob)
            result.copied += 1
          } catch {
            // A missing blob means this checkpoint cannot be restored; drop the
            // record rather than inherit a snapshot that would fail later.
            await fs.rm(path.join(targetManifests, manifestFile), { force: true }).catch(() => {})
            result.skipped += 1
            break
          }
        }
      }

      const inheritedRecord = {
        ...record,
        id,
        sessionId: to,
        manifest: manifestFile,
        // Shared blobs must not be freed by the child's own garbage collection
        // before the parent is done with them, so inherited snapshots are
        // marked and excluded from pruning.
        inheritedFrom: from,
      }
      carried.push(inheritedRecord)
    }

    if (carried.length > 0) {
      target.cwd = target.cwd ?? source.cwd
      target.checkpoints = [...target.checkpoints, ...carried]
      await this.writeIndex(to, target)
      result.inherited = carried.length
      this.log(`inherited ${carried.length} checkpoint(s) from ${from} into ${to}`)
    }
    return result
  }

  /**
   * Remove expired undo bundles and enforce the per-session budget.
   *
   * @param {string} [sessionId] limit pruning to one session
   */
  async sweep(sessionId) {
    const sessions = sessionId ? [sessionId] : await this.#sessionIds()
    for (const id of sessions) {
      try {
        const index = await this.readIndex(id)
        await this.#prune(id, index, DEFAULTS.keep)
        await this.writeIndex(id, index)
      } catch (error) {
        this.log(`sweep failed for ${id}`, error)
      }
    }
  }

  async #prune(sessionId, index, keep) {
    const now = Date.now()
    let changed = false
    const expired = index.checkpoints.filter(item => item.expiresAt && item.expiresAt <= now)
    if (expired.length > 0) {
      index.checkpoints = index.checkpoints.filter(item => !expired.some(gone => gone.id === item.id))
      for (const item of expired) {
        await fs.rm(path.join(this.manifestDir(sessionId), item.manifest), { force: true }).catch(() => {})
      }
      changed = true
    }
    const budgeted = index.checkpoints
      .filter(item => item.kind === 'auto' || item.kind === 'manual')
      .sort((a, b) => a.createdAt - b.createdAt)
    // Inherited snapshots do not count against the child's own budget. They are
    // a fixed, already-bounded slice of the parent's history (inherit applies
    // the same `keep`), and their blobs are hard links into the parent's store.
    // Counting them here would make a fork with a full inheritance delete every
    // snapshot it takes itself, leaving the conversation unable to snapshot the
    // turns the user is actually writing.
    const own = budgeted.filter(item => !item.inheritedFrom)
    const prunable = own.filter(item => !item.locked && item.kind === 'auto')
    const excess = own.length - Math.max(1, keep)
    if (excess > 0 && prunable.length > 0) {
      const drop = new Set(prunable.slice(0, Math.min(excess, prunable.length)).map(item => item.id))
      index.checkpoints = index.checkpoints.filter(item => !drop.has(item.id))
      for (const id of drop) {
        const record = budgeted.find(item => item.id === id)
        if (record) await fs.rm(path.join(this.manifestDir(sessionId), record.manifest), { force: true }).catch(() => {})
      }
      changed = true
    }
    if (changed) await this.#collectGarbage(sessionId, index)
  }

  async #collectGarbage(sessionId, index) {
    const referenced = new Set()
    for (const item of index.checkpoints) {
      const manifest = await readJson(path.join(this.manifestDir(sessionId), item.manifest)).catch(() => undefined)
      if (!manifest || typeof manifest.entries !== 'object') continue
      for (const entry of Object.values(manifest.entries)) {
        if (entry && typeof entry.h === 'string') referenced.add(entry.h)
      }
    }
    let freed = 0
    const blobs = this.blobDir(sessionId)
    for (const hash of await listFiles(blobs)) {
      if (referenced.has(hash)) continue
      const abs = this.#blobPath(blobs, hash)
      const info = await statOrUndefined(abs)
      if (info) freed += info.size
      await fs.rm(abs, { force: true }).catch(() => {})
    }
    return freed
  }

  async #hashFromPrevious(sessionId, index, rel) {
    const candidates = await this.list(sessionId)
    for (const item of candidates) {
      const manifest = await readJson(path.join(this.manifestDir(sessionId), item.manifest)).catch(() => undefined)
      const entry = manifest?.entries?.[rel]
      if (entry && typeof entry.h === 'string') return entry.h
    }
    return undefined
  }

  async #latestManifest(sessionId, index, kind) {
    const candidates = index.checkpoints
      .filter(item => !item.expiresAt || item.expiresAt > Date.now())
      .sort((a, b) => b.createdAt - a.createdAt)
    for (const item of candidates) {
      if (kind === 'undo' && item.kind !== 'auto' && item.kind !== 'manual') continue
      const manifest = await readJson(path.join(this.manifestDir(sessionId), item.manifest)).catch(() => undefined)
      if (manifest && typeof manifest.entries === 'object') return manifest
    }
    return undefined
  }

  #blobPath(blobs, hash) {
    return path.join(blobs, hash.slice(0, 2), hash)
  }

  async #readBlob(blobs, hash) {
    const file = this.#blobPath(blobs, hash)
    try {
      const compressed = await fs.readFile(file)
      return await gunzip(compressed)
    } catch {
      return undefined
    }
  }

  /**
   * Find and remove snapshot directories whose session no longer exists.
   *
   * `#prune` only runs when a session takes another snapshot, so a session that is
   * deleted — or removed by another tool — leaves its whole directory behind: index,
   * manifests, and blobs. Nothing ever revisits it. The blobs are content-addressed
   * and can be large, so this is real disk, not just clutter.
   *
   * The test for "orphan" is deliberately conservative: a directory is only removed
   * when the Host has no session log for that id. A session that exists but has no
   * snapshots yet is not an orphan, and a session whose log is temporarily unreadable
   * must not be treated as gone — so the caller supplies the set of live ids rather
   * than this module guessing at the Host's layout.
   *
   * @param {object} input input
   * @param {Set<string>} input.liveSessionIds ids that still exist
   * @param {boolean} [input.apply] delete for real; false only reports
   * @returns {Promise<{ orphans: string[], removed: number, bytes: number }>} result
   */
  async sweepOrphans({ liveSessionIds, apply = false }) {
    const ids = await this.#sessionIds()
    const orphans = ids.filter(id => !liveSessionIds.has(id))

    let bytes = 0
    for (const id of orphans) {
      bytes += await dirSize(this.sessionDir(id)).catch(() => 0)
    }

    let removed = 0
    if (apply) {
      for (const id of orphans) {
        try {
          await removeDir(this.sessionDir(id))
          removed += 1
        } catch {
          /* one failure must not stop the sweep */
        }
      }
    }
    return { orphans, removed, bytes }
  }

  async #sessionIds() {
    try {
      const entries = await fs.readdir(path.join(this.root, 'sessions'), { withFileTypes: true })
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      return []
    }
  }
}

/**
 * @param {string} kind checkpoint kind
 * @returns {string} default label
 */
function defaultLabel(kind) {
  switch (kind) {
    case 'manual':
      return 'manual checkpoint'
    case 'undo':
      return 'undo bundle'
    case 'pre-rollback':
      return 'before rollback'
    default:
      return 'turn checkpoint'
  }
}

/**
 * @param {string} root workspace root
 * @param {string} dir directory being walked
 * @param {(rel: string, name: string) => boolean} matcher ignore matcher
 * @param {{ abs: string, size: number, mtimeMs: number }[]} files collected files
 * @param {string[]} skipped skipped files
 * @param {{ maxFileBytes: number, maxFiles: number }} limits limits
 * @param {() => void} onTruncate truncation signal
 */
async function walkWorkspace(root, dir, matcher, files, skipped, limits, onTruncate) {
  if (files.length >= limits.maxFiles) {
    onTruncate()
    return
  }
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    const rel = toPosix(path.relative(root, abs))
    if (matcher(rel, entry.name)) continue
    if (entry.isDirectory()) {
      await walkWorkspace(root, abs, matcher, files, skipped, limits, onTruncate)
      if (files.length >= limits.maxFiles) {
        onTruncate()
        return
      }
      continue
    }
    if (!entry.isFile()) continue
    let info
    try {
      info = await fs.stat(abs)
    } catch {
      continue
    }
    if (info.size > limits.maxFileBytes) {
      skipped.push(`${rel} (too large: ${formatBytes(info.size)})`)
      continue
    }
    files.push({ abs, size: info.size, mtimeMs: info.mtimeMs })
    if (files.length >= limits.maxFiles) {
      onTruncate()
      return
    }
  }
}

/** @param {string} dir directory @returns {Promise<number>} total bytes */
async function dirSize(dir) {
  let total = 0
  for (const rel of await listFilesRecursive(dir)) {
    const info = await statOrUndefined(path.join(dir, rel)).catch(() => undefined)
    if (info) total += info.size
  }
  return total
}

/** @param {string} dir directory @returns {Promise<string[]>} file names */
async function listFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter(entry => entry.isFile()).map(entry => entry.name)
  } catch {
    return []
  }
}

/** @param {string} dir directory @returns {Promise<string[]>} recursive relative paths */
async function listFilesRecursive(dir) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const child of await listFilesRecursive(path.join(dir, entry.name))) {
        out.push(`${entry.name}/${child}`)
      }
    } else if (entry.isFile()) {
      out.push(entry.name)
    }
  }
  return out
}

export { DEFAULTS as CHECKPOINT_DEFAULTS }
