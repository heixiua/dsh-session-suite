/**
 * The suite's operations, implemented once for both callers (the plugin UI over
 * HTTP and the agent tools that call the same methods).
 *
 * Rollback is the interesting one. DSH's session log is append-only, so
 * "return to this message" cannot delete events: it forks the exact event
 * prefix into a fresh session, restores the workspace snapshot recorded for
 * that turn, trims the memory ledger to the same sequence, and retires the old
 * session. Every step is recorded in an undo bundle first, so one click can put
 * all three back.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { exportFileName, renderJson, renderMarkdown, renderText } from './share.js'
import { asString, ensureDir, formatBytes, readJson, shortId, writeJson } from './util.js'

const UNDO_TTL_MS = 10 * 60 * 1000

export class SessionSuiteService {
  /**
   * @param {object} options service options
   * @param {any} options.ctx Cordis context of the plugin
   * @param {string} options.root suite data directory
   * @param {any} options.store checkpoint store
   * @param {any} options.memory memory ledger
   * @param {(message: string, error?: unknown) => void} options.log logger
   * @param {any} [options.config] plugin config
   */
  constructor({ ctx, root, store, memory, log, config }) {
    this.ctx = ctx
    this.root = root
    this.store = store
    this.memory = memory
    this.log = log
    this.config = config ?? {}
    this.dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
    this.undoDir = path.join(root, 'undo')
  }

  /** @param {string} name Host service name */
  #service(name) {
    return this.ctx.get(name)
  }

  #require(name) {
    const service = this.ctx.get(name)
    if (!service) throw new Error(`the ${name} service is not mounted in this profile`)
    return service
  }

  /**
   * @param {string} sessionId session
   * @returns {Promise<{ meta: any, events: any[], title?: string, cwd?: string }>} inspection
   */
  async inspect(sessionId) {
    const controller = this.#require('sessionController')
    const inspection = await controller.inspect(sessionId)
    if (!inspection) throw new Error(`session ${sessionId} was not found`)
    const events = Array.isArray(inspection.events) ? inspection.events : []
    return { meta: inspection.meta ?? { id: sessionId }, events, title: titleOf(events), cwd: inspection.meta?.cwd }
  }

  /**
   * @returns {Promise<any[]>} visible sessions with suite annotations
   */
  async listSessions() {
    const controller = this.#service('sessionController')
    if (!controller?.list) return []
    const value = await controller.list({})
    const items = Array.isArray(value?.items) ? value.items : []
    const out = []
    for (const item of items) {
      const checkpoints = await this.store.list(item.sessionId).catch(() => [])
      const stats = await this.store.stats(item.sessionId).catch(() => undefined)
      out.push({
        sessionId: item.sessionId,
        cwd: item.cwd,
        running: item.running === true,
        updatedAt: item.updatedAt,
        title: titleFromProjections(item.projections) ?? item.cwd ?? item.sessionId,
        checkpoints: checkpoints.length,
        checkpointBytes: stats?.bytes ?? 0,
        checkpointLabel: formatBytes(stats?.bytes ?? 0),
      })
    }
    return out
  }

  /**
   * Everything the settings panel needs for one session.
   *
   * @param {string} sessionId session
   * @returns {Promise<any>} detail payload
   */
  async detail(sessionId) {
    const checkpoints = await this.store.list(sessionId)
    const stats = await this.store.stats(sessionId)
    const memory = await this.memory.list(sessionId)
    let inspection
    try {
      inspection = await this.inspect(sessionId)
    } catch {
      inspection = undefined
    }
    return {
      sessionId,
      title: inspection?.title ?? undefined,
      cwd: inspection?.cwd,
      checkpoints: checkpoints.map(decorateCheckpoint),
      memory,
      stats: {
        bytes: stats.bytes,
        label: formatBytes(stats.bytes),
        checkpoints: stats.checkpoints,
        budget: this.config.keep ?? 10,
      },
      undos: await this.listUndos(sessionId),
    }
  }

  /**
   * Take a checkpoint on demand.
   *
   * @param {string} sessionId session
   * @param {{ label?: string, kind?: 'auto' | 'manual' }} [options] options
   * @returns {Promise<any>} checkpoint summary
   */
  async capture(sessionId, options = {}) {
    const inspection = await this.inspect(sessionId)
    const cwd = inspection.cwd
    if (!cwd) throw new Error('this session has no workspace directory to snapshot')
    const last = (await this.store.list(sessionId))[0]
    const result = await this.store.capture({
      sessionId,
      cwd,
      seq: lastSeqOf(inspection.events),
      turn: lastTurnOf(inspection.events),
      kind: options.kind ?? 'manual',
      label: options.label,
      limits: limitsFrom(this.config),
    })
    return { ...decorateCheckpoint(result.checkpoint), skipped: result.skipped.slice(0, 20), truncated: result.truncated }
  }

  /**
   * Restore files only — the snapshot half of a rollback, usable on its own.
   *
   * @param {string} sessionId session
   * @param {string} checkpointId checkpoint
   * @returns {Promise<any>} restore outcome
   */
  async restoreCheckpoint(sessionId, checkpointId) {
    const outcome = await this.store.restore({ sessionId, checkpointId })
    return { ...outcome, message: `restored ${outcome.written} files, removed ${outcome.deleted}` }
  }

  /**
   * Full rollback: conversation prefix + workspace files + memory ledger.
   *
   * @param {object} input request
   * @param {string} input.sessionId source session
   * @param {string} [input.messageId] durable message id of the target step
   * @param {number} [input.seq] durable sequence of the target event
   * @param {number} [input.turn] turn of the target message
   * @returns {Promise<any>} rollback outcome including the new session id
   */
  async rollback({ sessionId, messageId, seq, turn }) {
    const inspection = await this.inspect(sessionId)
    const cwd = inspection.cwd
    const controller = this.#require('sessionController')
    let targetSeq = Number.isFinite(seq) ? Number(seq) : undefined
    let targetTurn = Number.isFinite(turn) ? Number(turn) : undefined
    if (targetSeq === undefined && typeof messageId === 'string') {
      const found = findMessage(inspection.events, messageId)
      if (!found) throw new Error('that message is not part of this session')
      targetSeq = found.seq
      targetTurn = found.turn
    }
    if (targetSeq === undefined) targetSeq = lastSeqOf(inspection.events)
    if (targetTurn === undefined) targetTurn = turnOfSeq(inspection.events, targetSeq)

    // 1. Protect the current state before touching anything.
    const undoId = `undo_${shortId(`${sessionId}:${targetSeq}`)}`
    const undo = {
      id: undoId,
      sessionId,
      seq: targetSeq,
      turn: targetTurn ?? null,
      createdAt: Date.now(),
      expiresAt: Date.now() + UNDO_TTL_MS,
      memory: await this.memory.snapshot(sessionId),
      checkpointId: null,
      cwd,
      status: 'pending',
    }
    if (cwd) {
      try {
        const captured = await this.store.capture({
          sessionId,
          cwd,
          seq: targetSeq,
          turn: targetTurn,
          kind: 'pre-rollback',
          label: 'before rollback',
          ttlMs: UNDO_TTL_MS,
          limits: limitsFrom(this.config),
        })
        undo.checkpointId = captured.checkpoint.id
      } catch (error) {
        this.log('pre-rollback snapshot failed; aborting rollback', error)
        throw new Error(`could not snapshot the workspace before rollback: ${errorMessage(error)}`)
      }
    }
    await this.#writeUndo(undo)

    // 2. Fork the exact event prefix — the conversation half of the rollback.
    let childId
    try {
      const forked = await controller.fork({ sessionId, atSeq: targetSeq })
      childId = forked?.sessionId
      if (!childId) throw new Error('fork returned no session id')
    } catch (error) {
      await this.#discardUndo(undoId)
      throw new Error(`could not fork the session at seq ${targetSeq}: ${errorMessage(error)}`)
    }
    undo.childId = childId
    undo.status = 'forked'
    await this.#writeUndo(undo)

    // 3. Workspace files back to the state recorded for that turn.
    let restore = undefined
    const checkpoint = await this.store.checkpointAt(sessionId, targetTurn, targetSeq)
    if (checkpoint) {
      try {
        restore = await this.store.restore({ sessionId, checkpointId: checkpoint.id })
      } catch (error) {
        this.log(`restore of ${checkpoint.id} failed after fork; undo remains available`, error)
        restore = { error: errorMessage(error) }
      }
    }

    // 4. Memory ledger back to the same sequence.
    const trimmed = await this.memory.trimTo(sessionId, targetSeq).catch(() => ({ removed: 0, kept: 0 }))

    // 5. Retire the old session from the sidebar (files stay; the undo bundle owns the revert).
    const archived = await this.#archive(sessionId, true)

    undo.status = 'done'
    undo.restore = restore ?? null
    undo.archived = archived
    await this.#writeUndo(undo)

    return {
      undoId,
      childId,
      sessionId,
      seq: targetSeq,
      turn: targetTurn ?? null,
      checkpoint: checkpoint ? decorateCheckpoint(checkpoint) : null,
      restore: restore ?? null,
      memory: trimmed,
      archived,
      expiresInMs: UNDO_TTL_MS,
    }
  }

  /**
   * Delete one message the way the product expects: rewind to the step before
   * it, so the message and everything after it leave the conversation. When the
   * message is the session's only content, the session itself is deleted.
   *
   * @param {object} input request
   * @param {string} input.sessionId session
   * @param {string} input.messageId durable message id
   * @returns {Promise<any>} outcome
   */
  async deleteMessage({ sessionId, messageId }) {
    const inspection = await this.inspect(sessionId)
    const target = findMessage(inspection.events, messageId)
    if (!target) throw new Error('that message is not part of this session')
    const previous = previousMessageSeq(inspection.events, target.seq)
    if (previous === undefined) {
      await this.deleteSession(sessionId)
      return { deletedSession: true, sessionId }
    }
    const rolled = await this.rollback({ sessionId, seq: previous })
    return { deletedSession: false, ...rolled }
  }

  /**
   * Undo a rollback: bring back the files, the memory entries, and the session.
   *
   * @param {string} undoId undo bundle id
   * @returns {Promise<any>} undo outcome
   */
  async undo(undoId) {
    const undo = await readJson(path.join(this.undoDir, `${undoId}.json`))
    if (!undo) throw new Error('this undo bundle no longer exists')
    if (undo.undoneAt) throw new Error('this rollback was already undone')
    let restore = undefined
    if (undo.checkpointId) {
      restore = await this.store.restore({ sessionId: undo.sessionId, checkpointId: undo.checkpointId })
    }
    if (undo.memory) await this.memory.restore(undo.sessionId, undo.memory)
    await this.#unarchive(undo.sessionId)
    if (undo.childId) await this.#archive(undo.childId, true)
    undo.undoneAt = Date.now()
    await this.#writeUndo(undo)
    return { sessionId: undo.sessionId, childId: undo.childId, restore: restore ?? null }
  }

  /**
   * @param {string} sessionId session
   * @returns {Promise<any[]>} live undo bundles
   */
  async listUndos(sessionId) {
    const dir = this.undoDir
    let names = []
    try {
      names = (await fs.readdir(dir)).filter(name => name.endsWith('.json'))
    } catch {
      return []
    }
    const out = []
    for (const name of names) {
      const undo = await readJson(path.join(dir, name)).catch(() => undefined)
      if (!undo || undo.undoneAt) continue
      if (undo.expiresAt && undo.expiresAt <= Date.now()) continue
      if (sessionId && undo.sessionId === sessionId) out.push(undo)
      else if (!sessionId) out.push(undo)
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Permanently delete a session: sidebar entry, log, projection cache,
   * checkpoints, and memory.
   *
   * @param {string} sessionId session
   * @returns {Promise<any>} what was removed
   */
  async deleteSession(sessionId) {
    const controller = this.#require('sessionController')
    const list = await controller.list({}).catch(() => ({ items: [] }))
    const summary = (list.items ?? []).find(item => item.sessionId === sessionId)
    if (summary?.running) {
      const error = new Error('this session is running; stop it before deleting')
      error.code = 'session-running'
      throw error
    }

    // Retire it first so the sidebar stops offering it while files disappear.
    await this.#archive(sessionId, true)

    const removed = { sessionFiles: [], projectionCache: [], checkpoints: false, memory: false }
    for (const dir of await this.#sessionDirs(sessionId)) {
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        removed.sessionFiles.push(dir)
      } catch (error) {
        this.log(`could not remove ${dir}`, error)
      }
    }
    const cacheFile = path.join(this.dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    try {
      await fs.rm(cacheFile, { force: true, maxRetries: 3, retryDelay: 200 })
      removed.projectionCache.push(cacheFile)
    } catch (error) {
      this.log(`could not remove ${cacheFile}`, error)
    }
    await this.store.purgeSession(sessionId).catch(() => {})
    removed.checkpoints = true
    await this.memory.purge(sessionId).catch(() => {})
    removed.memory = true
    for (const undo of await this.listUndos(sessionId)) await this.#discardUndo(undo.id).catch(() => {})

    if (removed.sessionFiles.length === 0) {
      throw new Error('no stored session files were found to delete (the Session may already be gone)')
    }
    return { sessionId, ...removed }
  }

  /**
   * @param {object} input request
   * @param {string} input.sessionId session
   * @param {'md' | 'txt' | 'json'} [input.format] export format
   * @returns {Promise<{ body: string, contentType: string, fileName: string }>} export
   */
  async share({ sessionId, format = 'md' }) {
    const inspection = await this.inspect(sessionId)
    const title = inspection.title
    const extension = format === 'json' ? 'json' : format === 'txt' ? 'txt' : 'md'
    const fileName = exportFileName(title, sessionId, extension)
    if (format === 'json') {
      return { body: renderJson({ sessionId, title, events: inspection.events }), contentType: 'application/json', fileName }
    }
    if (format === 'txt') {
      return { body: renderText({ sessionId, title, events: inspection.events, options: { toolDetails: false } }), contentType: 'text/plain; charset=utf-8', fileName }
    }
    return {
      body: renderMarkdown({ sessionId, title, events: inspection.events, options: { toolDetails: true, toolResults: true } }),
      contentType: 'text/markdown; charset=utf-8',
      fileName,
    }
  }

  /**
   * Remove expired undo bundles and enforce the per-session checkpoint budget.
   */
  async sweep() {
    const undos = await this.listUndos('')
    const now = Date.now()
    for (const undo of undos) {
      if (!undo.expiresAt || undo.expiresAt > now) continue
      if (undo.checkpointId) {
        await this.store.removeCheckpoint(undo.sessionId, undo.checkpointId).catch(() => {})
      }
      if (undo.childId) await this.#unarchive(undo.childId).catch(() => {})
      await this.#discardUndo(undo.id).catch(() => {})
    }
    await this.store.sweep()
  }

  async #writeUndo(undo) {
    await ensureDir(this.undoDir)
    await writeJson(path.join(this.undoDir, `${undo.id}.json`), undo)
  }

  async #discardUndo(undoId) {
    await fs.rm(path.join(this.undoDir, `${undoId}.json`), { force: true })
  }

  /** @param {string} sessionId session @param {boolean} stop stop its running work */
  async #archive(sessionId, stop) {
    const controllers = [this.#service('workspaceController'), this.#service('workspaceRegistry')]
    for (const controller of controllers) {
      if (!controller?.archiveSession) continue
      try {
        await controller.archiveSession(sessionId, { stopActivity: stop === true })
        return true
      } catch (error) {
        this.log('archiveSession failed', error)
      }
    }
    return false
  }

  /** @param {string} sessionId session */
  async #unarchive(sessionId) {
    const controllers = [this.#service('workspaceController'), this.#service('workspaceRegistry')]
    for (const controller of controllers) {
      if (!controller?.unarchiveSession) continue
      try {
        await controller.unarchiveSession(sessionId)
        return true
      } catch (error) {
        this.log('unarchiveSession failed', error)
      }
    }
    return false
  }

  /**
   * Every on-disk directory that holds this session's log, whatever workspace
   * folder the persistence backend chose.
   *
   * @param {string} sessionId session
   * @returns {Promise<string[]>} directories
   */
  async #sessionDirs(sessionId) {
    const root = path.join(this.dshHome, 'sessions')
    let entries = []
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(root, entry.name, sessionId)
      try {
        const info = await fs.stat(candidate)
        if (info.isDirectory()) out.push(candidate)
      } catch {
        continue
      }
    }
    return out
  }
}

/**
 * @param {any} checkpoint stored record
 * @returns {any} client-facing summary
 */
function decorateCheckpoint(checkpoint) {
  return {
    id: checkpoint.id,
    sessionId: checkpoint.sessionId,
    seq: checkpoint.seq,
    turn: checkpoint.turn,
    kind: checkpoint.kind,
    label: checkpoint.label,
    createdAt: checkpoint.createdAt,
    locked: checkpoint.locked === true,
    files: checkpoint.files,
    bytes: checkpoint.bytes,
    totalBytes: checkpoint.totalBytes,
    size: formatBytes(checkpoint.bytes),
    treeSize: formatBytes(checkpoint.totalBytes),
    temporary: Boolean(checkpoint.expiresAt),
    expiresAt: checkpoint.expiresAt ?? null,
    skipped: checkpoint.skipped ?? 0,
  }
}

/** @param {any} config plugin config @returns {{ keep: number, maxFileBytes?: number, maxFiles?: number }} limits */
function limitsFrom(config) {
  return {
    keep: typeof config?.keep === 'number' ? config.keep : 10,
    maxFileBytes: typeof config?.maxFileBytes === 'number' ? config.maxFileBytes : undefined,
    maxFiles: typeof config?.maxFiles === 'number' ? config.maxFiles : undefined,
  }
}

/** @param {readonly any[]} events durable events @returns {string | undefined} title */
function titleOf(events) {
  let title
  for (const event of events) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
  }
  return title
}

/** @param {any} projections projection hints @returns {string | undefined} title */
function titleFromProjections(projections) {
  const values = projections?.values
  if (!values || typeof values !== 'object') return undefined
  const candidate = values.title ?? values['session/title']
  return typeof candidate === 'string' ? candidate : undefined
}

/** @param {readonly any[]} events durable events @returns {number} last seq */
function lastSeqOf(events) {
  let seq = 0
  for (const event of events) if (typeof event?.seq === 'number') seq = Math.max(seq, event.seq)
  return seq
}

/** @param {readonly any[]} events durable events @returns {number | undefined} last turn */
function lastTurnOf(events) {
  let turn
  for (const event of events) if (typeof event?.data?.turn === 'number') turn = event.data.turn
  return turn
}

/** @param {readonly any[]} events durable events @param {string} messageId target @returns {{ seq: number, turn?: number } | undefined} match */
function findMessage(events, messageId) {
  for (const event of events) {
    if (typeof event?.seq !== 'number') continue
    let id
    if (event.type === 'assistant/message') id = event.data?.message?.id
    else if (event.type === 'user/message') id = event.data?.id
    if (id !== messageId) continue
    const turn = typeof event.data?.turn === 'number' ? event.data.turn : turnOfSeq(events, event.seq)
    return { seq: event.seq, turn }
  }
  return undefined
}

/**
 * @param {readonly any[]} events durable events
 * @param {number} seq exclusive bound
 * @returns {number | undefined} sequence of the closest earlier conversation message
 */
function previousMessageSeq(events, seq) {
  let found
  for (const event of events) {
    if (typeof event?.seq !== 'number' || event.seq >= seq) break
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    found = event.seq
  }
  return found
}

/** @param {readonly any[]} events durable events @param {number} seq target @returns {number | undefined} turn */
function turnOfSeq(events, seq) {
  let turn
  for (const event of events) {
    if (typeof event?.seq === 'number' && event.seq > seq) break
    if (typeof event?.data?.turn === 'number') turn = event.data.turn
  }
  return turn
}

/** @param {unknown} error value @returns {string} message */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export { UNDO_TTL_MS, asString }
