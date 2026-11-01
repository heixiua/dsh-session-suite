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
import { buildOutline, curateEvents, exportFileName, renderBlockDoc, renderHtmlFromDoc, renderJson, renderMarkdown, renderText, selectEvents } from './share.js'
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
      // Subagent children are not conversations of their own: the sidebar hides
      // them and this panel must not offer them as a session to snapshot.
      if (item.origin === 'subagent' || typeof item.parentSessionId === 'string') continue
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
   * Turn-level outline for the share and segment dialogs.
   *
   * @param {string} sessionId session
   * @returns {Promise<any>} outline
   */
  async outline(sessionId) {
    const inspection = await this.inspect(sessionId)
    const turns = buildOutline(inspection.events)
    return {
      sessionId,
      title: inspection.title,
      turns,
      totalTurns: turns.length,
      totalEvents: inspection.events.length,
    }
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
      // A manual capture describes the last turn that actually finished, so it
      // keeps the same meaning as an automatic one ("the workspace after turn N").
      turn: lastCompletedTurn(inspection.events),
      phase: 'end',
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

    // A snapshot records the state *after* its turn. Rewinding to a reply keeps
    // that turn's work; rewinding to the prompt means "before this turn", i.e.
    // the state after the previous one.
    const targetEvent = inspection.events.find(event => event.seq === targetSeq)
    const targetRole = targetEvent?.type === 'user/message' ? 'user' : 'assistant'
    const restoreTurn = targetRole === 'user' ? (targetTurn ?? 1) - 1 : targetTurn

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
    const checkpoint = await this.store.checkpointAt(sessionId, restoreTurn, targetSeq)
    if (checkpoint) {
      try {
        restore = await this.store.restore({ sessionId, checkpointId: checkpoint.id })
      } catch (error) {
        this.log(`restore of ${checkpoint.id} failed after fork; undo remains available`, error)
        restore = { error: errorMessage(error) }
      }
    }

    // 4. Memory ledger back to the same sequence, and carried into the child so
    //    the continued conversation keeps the facts that survive the rewind.
    const trimmed = await this.memory.trimTo(sessionId, targetSeq).catch(() => ({ removed: 0, kept: 0 }))
    const copied = await this.memory.clone(sessionId, childId, targetSeq).catch(() => ({ copied: 0 }))

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
      memory: { ...trimmed, copied: copied.copied },
      archived,
      expiresInMs: UNDO_TTL_MS,
    }
  }

  /**
   * Cut the conversation at a sequence without touching the workspace.
   *
   * Deleting conversation content is the one operation that must not restore
   * files: the workspace keeps whatever the session produced, and only the log
   * and the memory ledger are trimmed. The append-only log cannot remove events
   * in the middle, so this forks the prefix and retires the original — the same
   * primitive as a rewind, minus the snapshot restore.
   *
   * @param {object} input request
   * @param {string} input.sessionId session
   * @param {number} [input.keepThroughSeq] last sequence to keep; omitted keeps nothing (empty session)
   * @returns {Promise<any>} outcome
   */
  async truncateConversation({ sessionId, keepThroughSeq }) {
    const inspection = await this.inspect(sessionId)
    const controller = this.#require('sessionController')
    let childId
    if (Number.isFinite(keepThroughSeq) && keepThroughSeq >= 0) {
      const forked = await controller.fork({ sessionId, atSeq: keepThroughSeq })
      childId = forked?.sessionId
    } else {
      const created = await controller.create({ cwd: inspection.cwd })
      childId = created?.sessionId
    }
    if (!childId) throw new Error('could not create the trimmed conversation')

    const bound = Number.isFinite(keepThroughSeq) ? keepThroughSeq : -1
    const trimmed = await this.memory.trimTo(sessionId, bound).catch(() => ({ removed: 0, kept: 0 }))
    const copied = await this.memory.clone(sessionId, childId, bound).catch(() => ({ copied: 0 }))
    const archived = await this.#archive(sessionId, true)
    return { childId, sessionId, keepThroughSeq: Number.isFinite(keepThroughSeq) ? keepThroughSeq : null, memory: { ...trimmed, copied: copied.copied }, archived, filesUntouched: true }
  }

  /**
   * Delete one message: the message and everything after it leave the
   * conversation, while the workspace files stay exactly as they are.
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
    // Deleting a message removes its whole turn: the prompt, the reply, and the
    // narration between them. Cutting at the message before the prompt does that
    // in one move, and files are never touched (only a rewind restores files).
    const promptSeq = target.role === 'assistant' ? previousUserSeq(inspection.events, target.seq) : target.seq
    const keep = promptSeq === undefined ? undefined : previousMessageSeq(inspection.events, promptSeq)
    const result = await this.truncateConversation({ sessionId, keepThroughSeq: keep })
    return { deletedSession: false, fromSeq: target.seq, ...result }
  }

  /**
   * Delete a selected run of turns. Files are never touched; memory entries
   * observed inside the removed range are dropped with it.
   *
   * @param {object} input request
   * @param {string} input.sessionId session
   * @param {number} input.startSeq first sequence of the removed range
   * @returns {Promise<any>} outcome
   */
  async deleteSegment({ sessionId, startSeq }) {
    const inspection = await this.inspect(sessionId)
    const seq = Number(startSeq)
    if (!Number.isFinite(seq)) throw new Error('startSeq is required')
    const previous = previousMessageSeq(inspection.events, seq)
    const result = await this.truncateConversation({ sessionId, keepThroughSeq: previous })
    return { deletedSession: false, fromSeq: seq, ...result }
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
    // Tell the live layer the session is gone: without this the sidebar keeps the
    // row until the app restarts, even though the files no longer exist.
    try {
      this.ctx.emit?.('api-session/removed', sessionId)
    } catch (error) {
      this.log('could not announce the deleted session', error)
    }
    const stillListed = await controller
      .list({})
      .then(value => (value?.items ?? []).some(item => item.sessionId === sessionId))
      .catch(() => false)
    return { sessionId, ...removed, stillListed }
  }

  /**
   * @param {object} input request
   * @param {string} input.sessionId session
   * @param {'md' | 'txt' | 'json' | 'html' | 'blocks'} [input.format] export format
   * @param {readonly { startSeq: number, endSeq: number }[]} [input.ranges] selected turns; omitted exports everything
   * @param {'final' | 'all'} [input.mode] curation mode
   * @returns {Promise<{ body: string, contentType: string, fileName: string, messages: number }>} export
   */
  async share({ sessionId, format = 'md', ranges, mode = 'final' }) {
    const inspection = await this.inspect(sessionId)
    const title = inspection.title
    const events = selectEvents(inspection.events, ranges)
    const curation = mode === 'all' ? 'all' : 'final'
    const extension = format === 'json' || format === 'blocks' ? 'json' : format === 'txt' ? 'txt' : format === 'html' ? 'html' : 'md'
    const fileName = exportFileName(title, sessionId, extension)
    const messages = events.filter(event => event.type === 'user/message' || event.type === 'assistant/message').length
    if (format === 'blocks' || format === 'html') {
      // Structured Markdown for the browser's canvas renderer: the Host parses
      // once, so the image and the HTML page always agree.
      const doc = await this.#withImages(renderBlockDoc({ sessionId, title, events, mode: curation }))
      return {
        body: format === 'html' ? renderHtmlFromDoc(doc) : JSON.stringify(doc),
        contentType: format === 'html' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        fileName,
        messages: doc.count ?? messages,
      }
    }
    if (format === 'json') {
      return {
        body: renderJson({ sessionId, title, events: curation === 'final' ? curateEvents(events) : events }),
        contentType: 'application/json; charset=utf-8',
        fileName,
        messages,
      }
    }
    if (format === 'txt') {
      return {
        body: renderText({
          sessionId,
          title,
          events: curation === 'final' ? curateEvents(events) : events,
          options: { toolDetails: false },
        }),
        contentType: 'text/plain; charset=utf-8',
        fileName,
        messages,
      }
    }
    return {
      body: renderMarkdown({
        sessionId,
        title,
        events: curation === 'final' ? curateEvents(events) : events,
        options: { toolDetails: false, toolResults: false },
      }),
      contentType: 'text/markdown; charset=utf-8',
      fileName,
      messages,
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

  /**
   * Inline the screenshots a session carries, so a shared page (and the canvas
   * image built from the same document) shows the pictures instead of a marker.
   *
   * Attachments live outside the session log, which is why the export resolves
   * them here: `attachments.imageHostPath` gives the on-disk file, and a bounded
   * budget keeps a chatty conversation from producing a 50 MB page.
   *
   * @param {any} doc block document
   * @returns {Promise<any>} the same document with data URLs
   */
  async #withImages(doc) {
    const attachments = this.#service('attachments')
    if (!attachments?.imageHostPath) return doc
    const limit = numberOr(this.config.imageBudget, 12)
    let remaining = limit
    let bytes = 0
    const maxBytes = numberOr(this.config.imageMaxBytes, 3 * 1024 * 1024)
    for (const message of doc.messages ?? []) {
      const resolved = []
      for (const image of message.images ?? []) {
        if (remaining <= 0 || bytes >= limit * maxBytes) continue
        try {
          const file = attachments.imageHostPath(image)
          if (!file) continue
          const info = await fs.stat(file)
          if (!info.isFile() || info.size > maxBytes) continue
          const data = await fs.readFile(file)
          const mediaType = image.mediaType ?? 'image/png'
          resolved.push({ ...image, dataUrl: `data:${mediaType};base64,${data.toString('base64')}` })
          remaining -= 1
          bytes += info.size
        } catch (error) {
          this.log(`could not inline ${image.attachmentId ?? 'an image'}`, error)
        }
      }
      message.images = resolved
    }
    return doc
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

/** @param {readonly any[]} events durable events @returns {number | undefined} last finished turn */
function lastCompletedTurn(events) {
  let turn
  for (const event of events) {
    if (event?.type === 'turn/end' && typeof event.data?.turn === 'number') turn = event.data.turn
  }
  return turn ?? lastTurnOf(events)
}

/** @param {readonly any[]} events durable events @param {string} messageId target @returns {{ seq: number, turn?: number, role?: string } | undefined} match */
function findMessage(events, messageId) {
  for (const event of events) {
    if (typeof event?.seq !== 'number') continue
    let id
    if (event.type === 'assistant/message') id = event.data?.message?.id
    else if (event.type === 'user/message') id = event.data?.id
    if (id !== messageId) continue
    const turn = typeof event.data?.turn === 'number' ? event.data.turn : turnOfSeq(events, event.seq)
    return { seq: event.seq, turn, role: event.type === 'assistant/message' ? 'assistant' : 'user' }
  }
  return undefined
}

/**
 * @param {readonly any[]} events durable events
 * @param {number} seq exclusive bound
 * @returns {number | undefined} sequence of the closest earlier user prompt
 */
function previousUserSeq(events, seq) {
  let found
  for (const event of events) {
    if (typeof event?.seq !== 'number' || event.seq >= seq) break
    if (event.type !== 'user/message') continue
    const kind = typeof event.data?.source === 'object' && event.data.source ? event.data.source.kind : undefined
    if (kind !== undefined && kind !== 'user') continue
    found = event.seq
  }
  return found
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

/**
 * @param {unknown} value candidate
 * @param {number} fallback default
 * @returns {number} number
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export { UNDO_TTL_MS, asString }
