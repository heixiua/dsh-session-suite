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
      // Hide subagent children only. They are not conversations of their own —
      // the sidebar hides them and this panel must not offer them as a session
      // to snapshot.
      //
      // A `parentSessionId` is NOT enough to identify one. Every rewind, message
      // delete, and segment delete forks the conversation and retires the
      // original, so the session a user is actually talking in carries a parent
      // too — it is a continuation of the same conversation, not a subagent.
      // Filtering on the parent alone hid the live session from this panel and
      // left it showing whichever unrelated session happened to have snapshots
      // (「只有查询插件开发记录这个会话的快照」).
      //
      // `origin: 'subagent'` is the field that distinguishes them: SessionSummary
      // declares it for exactly this purpose, while `parentSessionId` only
      // describes lineage. The header also carries `delegationDepth`, but the
      // summary does not project it, so it cannot be used here.
      if (item.origin === 'subagent') continue
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

    // 4b. Snapshots up to the rewind point move to the child. The parent is
    //     retired, so its snapshots would otherwise become unreachable from the
    //     conversation the user actually continues.
    const inherited = await this.store
      .inherit({ from: sessionId, to: childId, throughSeq: targetSeq, keep: this.config.keep })
      .catch(error => {
        this.log(`could not inherit checkpoints into ${childId}`, error)
        return { inherited: 0, skipped: 0 }
      })

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
      checkpoints: inherited,
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
    // The child continues the parent's conversation, so it must also continue
    // its snapshot history: without this the panel is empty and rewinding in the
    // continuation has no earlier state to restore.
    const inherited = await this.store
      .inherit({ from: sessionId, to: childId, throughSeq: keepThroughSeq, keep: this.config.keep })
      .catch(error => {
        this.log(`could not inherit checkpoints into ${childId}`, error)
        return { inherited: 0, skipped: 0 }
      })
    const archived = await this.#archive(sessionId, true)
    return { childId, sessionId, keepThroughSeq: Number.isFinite(keepThroughSeq) ? keepThroughSeq : null, memory: { ...trimmed, copied: copied.copied }, checkpoints: inherited, archived, filesUntouched: true }
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
   * Resend a turn's prompt in a fork of the conversation.
   *
   * This is the "retry" a failed or unsatisfactory turn needs: the conversation
   * is forked just before that turn's prompt and the same prompt is sent again
   * in the fork, so the model answers afresh instead of being asked to continue
   * on top of an answer the user rejected. The original session is kept as a
   * branch, the durable log is never rewritten, and — unlike a rewind — **files
   * are not touched**: retrying a reply is a conversation operation, and
   * restoring the workspace would silently discard work done since.
   *
   * `mode: 'stage'` forks and stops there, returning the prompt text so the
   * client can put it in the composer for the user to edit before sending. That
   * is what "edit and resend" needs, and it avoids sending a prompt the user is
   * about to change.
   *
   * @param {object} input request
   * @param {string} input.sessionId session
   * @param {number} input.turn turn whose prompt to resend
   * @param {'retry' | 'stage'} [input.mode] retry sends it; stage only returns it
   * @param {string} [input.text] replacement prompt text (defaults to the original)
   * @returns {Promise<any>} the fork, the prompt that was or will be sent, and whether it was sent
   */
  async resendTurn({ sessionId, turn, messageId, mode = 'retry', text }) {
    const inspection = await this.inspect(sessionId)

    // The chat slots hand the client a message id or a turn location, and the
    // location's shape is not part of a stable contract, so resolve the turn
    // here instead of trusting the caller to have found a number.
    let target = Number(turn)
    if (!Number.isFinite(target) && typeof messageId === 'string') {
      target = findMessage(inspection.events, messageId)?.turn
    }
    if (!Number.isFinite(target)) {
      // No turn named at all: resend the latest turn that a user prompt started.
      // That is what "edit my last question" means, and it keeps the row usable
      // even when the location shape is unknown.
      target = lastUserTurn(inspection.events)
    }
    if (!Number.isFinite(target)) throw new Error('there is no prompt in this session to resend')

    const prompt = promptOfTurn(inspection.events, target)
    if (!prompt) throw new Error(`turn ${target} was not started by a prompt you sent`)
    const payload = typeof text === 'string' && text.trim() ? text.trim() : prompt.text

    // Resend happens in the SAME session: no fork, no new workspace, no new
    // sidebar row. The durable log is append-only, so the previous reply cannot
    // be erased; instead we drop the memories that turn recorded and append the
    // edited question, which starts a fresh turn whose answer stands on its own.
    // Snapshots are deliberately untouched — the user asked for this to be a
    // conversation operation, and restoring files would discard work done since.
    const trimmed = await this.memory.trimTo(sessionId, prompt.seq - 1).catch(() => ({ removed: 0, kept: 0 }))
    if (mode === 'stage') {
      return { sessionId, turn: target, prompt: payload, originalPrompt: prompt.text, sent: false, memory: trimmed, filesUntouched: true }
    }

    await this.#promptInSession(sessionId, payload)
    return {
      sessionId,
      turn: target,
      prompt: payload,
      originalPrompt: prompt.text,
      sent: true,
      memory: trimmed,
      filesUntouched: true,
      // No childId: there is no new session to switch to.
    }
  }

  /**
   * Read the prompt that would be resent, without forking or writing anything.
   *
   * The edit dialog needs the original text to pre-fill its box. Using
   * `mode: 'stage'` for that was wrong: stage still forks, so merely opening the
   * dialog created a branch (and could fail for reasons unrelated to reading a
   * sentence). A preview is a pure read.
   *
   * @param {object} input request
   * @param {string} input.sessionId session
   * @param {number} [input.turn] turn
   * @param {string} [input.messageId] message id
   * @returns {Promise<{ turn: number, prompt: string }>} the prompt to edit
   */
  async previewResend({ sessionId, turn, messageId }) {
    const inspection = await this.inspect(sessionId)
    let target = Number(turn)
    if (!Number.isFinite(target) && typeof messageId === 'string') {
      target = findMessage(inspection.events, messageId)?.turn
    }
    if (!Number.isFinite(target)) target = lastUserTurn(inspection.events)
    if (!Number.isFinite(target)) throw new Error('there is no prompt in this session to resend')
    const prompt = promptOfTurn(inspection.events, target)
    if (!prompt) throw new Error(`turn ${target} was not started by a prompt you sent`)
    return { turn: target, prompt: prompt.text }
  }

  /**
   * Admit one prompt into a session.
   *
   * Kept private and narrow: the only caller is a resend, which has just
   * created the session and therefore knows it is idle.
   *
   * @param {string} sessionId session to prompt
   * @param {string} text prompt text
   */
  async #promptInSession(sessionId, text) {
    const controller = this.#require('sessionController')
    if (typeof controller.prompt !== 'function') {
      throw new Error('this Host build cannot accept a prompt programmatically')
    }
    const requestId = `resend-${shortId(`${sessionId}:${Date.now()}`)}`
    const signal = typeof AbortController === 'function' ? new AbortController().signal : undefined
    const request = {
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }
    // The Remote signature is `prompt(request, signal)`. The Host reads
    // `signal.throwIfAborted()` while admitting the prompt, so omitting the
    // second argument makes it dereference `undefined` — reported as
    // "Cannot read properties of undefined (reading 'throwIfAborted')".
    const result = signal === undefined
      ? await controller.prompt(request)
      : await controller.prompt(request, signal)
    if (result && result.accepted === false) throw new Error('the Host rejected the resent prompt')
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
   * What a delete would remove, without removing anything.
   *
   * A running session is refused rather than killed, so a caller can warn about
   * that — and about the subagents a cascade would take with it — before it
   * commits to the irreversible half.
   *
   * @param {string} sessionId session
   * @returns {Promise<{ sessionId: string, title?: string, running: boolean, subagents: { sessionId: string, title?: string, running: boolean }[], totalSessions: number, willRefuse: boolean, refuseReason: string | null }>} preview
   */
  async previewDelete(sessionId) {
    const controller = this.#require('sessionController')
    const list = await controller.list({}).catch(() => ({ items: [] }))
    const items = Array.isArray(list?.items) ? list.items : []
    const byId = new Map(items.filter(item => item?.sessionId).map(item => [item.sessionId, item]))
    const summary = byId.get(sessionId)
    const subagents = subagentDescendants(items, sessionId).map(id => {
      const item = byId.get(id) ?? { sessionId: id }
      return { sessionId: id, title: titleFromProjections(item.projections) ?? item.cwd ?? id, running: item.running === true }
    })
    // `willRefuse` answers one question only: would deleteSession refuse this
    // because something is still running? That refusal is the whole safety
    // contract, and the reason says whether it is the session itself or one of
    // its subagents that has to stop first.
    let refuseReason = null
    if (summary?.running === true) refuseReason = 'session-running'
    else if (subagents.some(child => child.running)) refuseReason = 'subagent-running'
    return {
      sessionId,
      title: summary ? titleFromProjections(summary.projections) ?? summary.cwd ?? sessionId : undefined,
      running: summary?.running === true,
      subagents,
      totalSessions: 1 + subagents.length,
      willRefuse: refuseReason !== null,
      refuseReason,
    }
  }

  /**
   * Permanently delete a session: sidebar entry, log, projection cache,
   * checkpoints, and memory.
   *
   * By default this also cascades to the session's subagent descendants. A
   * subagent is not a conversation anyone can open, so leaving one behind only
   * strands its snapshots and memory under an id nothing links to any more.
   *
   * Two rules keep the cascade safe:
   *
   * 1. Validate all, then touch: every id is checked before the first byte is
   *    removed, so a single running session — the session itself or any
   *    descendant — refuses the whole operation with `code: 'session-running'`
   *    and nothing at all is deleted. A running session is never killed to make
   *    deletion possible.
   * 2. Descendants first, the session last, so a child never outlives its
   *    parent. A descendant that fails to delete is reported in `refused`
   *    instead of silently truncating the tree.
   *
   * Identity is decided by `origin === 'subagent'` alone. A `parentSessionId`
   * proves nothing: every rewind and delete forks the conversation, so the
   * session a user is actually talking in carries a parent too and must never
   * be swept into a cascade (docs/pitfalls.md #48).
   *
   * @param {string} sessionId session
   * @param {{ cascade?: boolean }} [options] options; `cascade: false` deletes the session alone
   * @returns {Promise<any>} what was removed, plus `removedSubagents` and `refused`
   */
  async deleteSession(sessionId, options = {}) {
    const controller = this.#require('sessionController')
    const cascade = options?.cascade !== false
    const list = await controller.list({}).catch(() => ({ items: [] }))
    const items = Array.isArray(list?.items) ? list.items : []
    const byId = new Map(items.filter(item => item?.sessionId).map(item => [item.sessionId, item]))

    // Deepest descendant first, the session itself last, so this doubles as the
    // delete order.
    const descendants = cascade ? subagentDescendants(items, sessionId) : []

    // 1. Validate every id before touching anything.
    for (const id of [sessionId, ...descendants]) {
      if (byId.get(id)?.running === true) throw sessionRunningError(id)
    }

    // 2. Delete deepest-first. Partial failure is reported, never hidden.
    const removedSubagents = []
    const refused = []
    for (const id of descendants) {
      try {
        const removed = await this.#purgeSession(id)
        if (removed.sessionFiles.length === 0) {
          refused.push({ sessionId: id, reason: 'no stored session files were found to delete' })
        } else {
          removedSubagents.push({ sessionId: id, ...removed })
        }
      } catch (error) {
        this.log(`could not delete subagent ${id}`, error)
        refused.push({ sessionId: id, reason: errorMessage(error) })
      }
    }

    const removed = await this.#purgeSession(sessionId)
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
    return { sessionId, ...removed, removedSubagents, refused, stillListed }
  }

  /**
   * Permanently delete several sessions in one request.
   *
   * The value here is not speed — each session is still removed by the same
   * path as a single delete. It is the *reporting*: with a batch, one running
   * session must not abort the whole cleanup, and the caller has to learn which
   * ids went and which did not. So every id is validated up front, then each is
   * deleted independently, and the result names both sets explicitly.
   *
   * A running session is skipped and reported, never killed (docs/pitfalls.md
   * on why: killing a live turn to satisfy a delete is worse than refusing).
   *
   * @param {readonly string[]} sessionIds sessions to delete
   * @param {{ cascade?: boolean }} [options] passed through to deleteSession
   * @returns {Promise<{ removed: string[], failed: { sessionId: string, reason: string }[], requested: number }>}
   */
  async deleteSessions(sessionIds, options = {}) {
    const requested = Array.isArray(sessionIds) ? [...new Set(sessionIds.filter(id => typeof id === 'string' && id))] : []
    if (requested.length === 0) return { removed: [], failed: [], requested: 0 }

    // Cap the batch. An unbounded list is usually a caller bug, and a partial
    // apply would be far more confusing than a clear refusal.
    const MAX_BATCH = 200
    if (requested.length > MAX_BATCH) {
      throw new Error(`cannot delete more than ${MAX_BATCH} sessions at once (asked for ${requested.length})`)
    }

    const removed = []
    const failed = []
    for (const sessionId of requested) {
      try {
        await this.deleteSession(sessionId, options)
        removed.push(sessionId)
      } catch (error) {
        // One failure never stops the batch: the point of a batch is to clean up
        // what can be cleaned up.
        this.log(`could not delete ${sessionId}`, error)
        failed.push({ sessionId, reason: errorMessage(error) })
      }
    }
    return { removed, failed, requested: requested.length }
  }

  /**
   * Remove every trace of one session from disk and from the suite's stores.
   *
   * Callers validate first: this only reports what it removed, it never decides
   * whether it was allowed to run.
   *
   * @param {string} sessionId session
   * @returns {Promise<{ sessionFiles: string[], projectionCache: string[], checkpoints: boolean, memory: boolean }>} what was removed
   */
  async #purgeSession(sessionId) {
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

    // Finally, drop the archive mark itself.
    //
    // Archiving is the right *first* step — it retires the row while the files
    // go away — but leaving the mark behind means the session id survives in the
    // workspace registry after everything it named is gone. Other plugins read
    // that registry, and one of them (dsh-context) keeps a per-session context
    // cache that is only dropped on `session/disposed`. Nothing here disposes a
    // session — the Host owns that lifecycle — so an id left in the archive set
    // is an id a co-installed plugin can still resolve and redisplay. That is
    // exactly the "deleted session came back" report: the files were gone, but
    // the mark said otherwise.
    //
    // Unarchiving is safe here precisely because the id is a ghost: the files it
    // referred to no longer exist, so removing the mark cannot restore anything.
    await this.#unarchive(sessionId).catch(() => {})
    return removed
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

/**
 * Every subagent descendant of `rootId`, deepest first — a child always before
 * its parent, so the result can be used directly as a delete order.
 *
 * Only `origin === 'subagent'` establishes identity. A `parentSessionId` alone
 * does not: every rewind, message delete, and segment delete forks the
 * conversation and retires the original, so the session the user is actually in
 * carries a parent too and must never be swept into a cascade
 * (docs/pitfalls.md #48).
 *
 * The `seen` set makes the walk cycle-safe. A corrupt or hand-edited list could
 * claim A's parent is B while B's parent is A (or a session its own parent);
 * that must terminate instead of recursing forever.
 *
 * @param {readonly any[]} items SessionSummary list
 * @param {string} rootId session to start from
 * @returns {string[]} descendant session ids, deepest first, without duplicates
 */
function subagentDescendants(items, rootId) {
  const childrenOf = new Map()
  for (const item of items) {
    if (!item || item.origin !== 'subagent' || typeof item.sessionId !== 'string') continue
    const parent = typeof item.parentSessionId === 'string' ? item.parentSessionId : undefined
    if (!parent) continue
    const siblings = childrenOf.get(parent)
    if (siblings) siblings.push(item.sessionId)
    else childrenOf.set(parent, [item.sessionId])
  }
  const out = []
  const seen = new Set([rootId])
  const visit = id => {
    for (const child of childrenOf.get(id) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      visit(child)
      out.push(child)
    }
  }
  visit(rootId)
  return out
}

/**
 * Refusal for a session that is still running; the message matches the one the
 * service has always thrown, and `sessionId` names the session that has to stop
 * when it is a subagent rather than the requested one.
 *
 * @param {string} sessionId session that is still running
 * @returns {Error} refusal carrying `code: 'session-running'`
 */
function sessionRunningError(sessionId) {
  const error = new Error('this session is running; stop it before deleting')
  error.code = 'session-running'
  error.sessionId = sessionId
  return error
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
 * The most recent turn that a user prompt started.
 *
 * Used when the caller cannot name a turn — the chat row may hand over a
 * location object whose shape is not a stable contract. Walking the log is
 * cheaper and safer than guessing at that shape, and a turn with no user prompt
 * (goal round, schedule) is skipped because there is nothing to edit.
 *
 * @param {readonly any[]} events durable events
 * @returns {number | undefined} the turn number, when one exists
 */
function lastUserTurn(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const kind = typeof event.data?.source === 'object' && event.data.source ? event.data.source.kind : undefined
    if (kind !== undefined && kind !== 'user') continue
    const turn = typeof event.data?.turn === 'number' ? event.data.turn : turnOfSeq(events, event.seq)
    if (typeof turn === 'number' && Number.isFinite(turn)) return turn
  }
  return undefined
}

/**
 * Find the prompt that started a turn, with its text.
 *
 * Only a user-authored message counts. A turn can also be started by a goal
 * round, a schedule, or a subagent notice, and those have no prompt to resend —
 * returning undefined lets the caller say so instead of sending the wrong text.
 *
 * @param {readonly any[]} events durable events
 * @param {number} turn turn number
 * @returns {{ seq: number, text: string } | undefined} the prompt, or undefined
 */
function promptOfTurn(events, turn) {
  let started = false
  for (const event of events) {
    if (typeof event?.seq !== 'number') continue
    if (event.type === 'turn/start') {
      started = typeof event.data?.turn === 'number' && event.data.turn === turn
      continue
    }
    // The prompt is the first user-authored message inside the turn; anything
    // else in the turn means this turn was not started by the user.
    if (!started) continue
    if (event.type === 'step/end' || event.type === 'turn/end' || event.type === 'turn/start') return undefined
    if (event.type !== 'user/message') continue
    const kind = typeof event.data?.source === 'object' && event.data.source ? event.data.source.kind : undefined
    if (kind !== undefined && kind !== 'user') continue
    return { seq: event.seq, text: contentText(event.data?.content) }
  }
  return undefined
}

/**
 * @param {unknown} content message content blocks
 * @returns {string} the plain text of a message
 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
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
    if (!isConversationMessage(event)) continue
    found = event.seq
  }
  return found
}

/**
 * Is this event a real turn message rather than harness plumbing?
 *
 * Compaction is append-only, so the log keeps the summarized events and then
 * adds a synthetic `user/message` carrying `source.kind === 'compact-checkpoint'`
 * plus a `surfaceOp` that replaces the summarized range. Treating that node as
 * a conversation message puts a cut point in the wrong place, so it — and any
 * other non-user source — is excluded here.
 *
 * @param {any} event durable event
 * @returns {boolean} whether the event is a user prompt or an assistant reply
 */
function isConversationMessage(event) {
  if (event?.type === 'assistant/message') return true
  if (event?.type !== 'user/message') return false
  const source = typeof event.data?.source === 'object' && event.data.source ? event.data.source : undefined
  if (source?.kind !== undefined && source.kind !== 'user') return false
  return true
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
