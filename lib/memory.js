/**
 * Session memory ledger.
 *
 * DSH's durable log is the only source of truth for the conversation, so the
 * suite keeps *derived* memory here: short, human-readable facts a session (or
 * its agent) decided to remember. Because every entry records the session
 * sequence it was observed at, a rollback can trim the ledger back to exactly
 * the state the conversation had at that point 鈥?the piece the product design
 * called out as the real differentiator.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, readJson, sha256Text, shortId, writeJson } from './util.js'


export class MemoryLedger {
  /**
   * @param {object} options ledger options
   * @param {string} options.root suite data directory
   */
  constructor({ root }) {
    this.root = path.join(root, 'memory')
  }

  /** @param {string} scope session id or `_global` */
  #file(scope) {
    return path.join(this.root, `${scope}.json`)
  }

  /**
   * @param {string} scope session id or `_global`
   * @returns {Promise<{ version: number, scope: string, entries: any[] }>} ledger
   */
  async read(scope) {
    const data = await readJson(this.#file(scope))
    if (!data || !Array.isArray(data.entries)) return { version: 1, scope, entries: [] }
    return data
  }

  /** @param {string} scope session id or `_global` @param {any} data ledger */
  async write(scope, data) {
    await ensureDir(this.root)
    await writeJson(this.#file(scope), data)
  }

  /**
   * @param {string} sessionId session
   * @param {{ text: string, tags?: string[], seq?: number, turn?: number, source?: string }} input entry
   * @returns {Promise<any>} stored entry
   */
  async add(sessionId, input) {
    const text = String(input.text ?? '').trim()
    if (!text) throw new Error('memory text is empty')
    const data = await this.read(sessionId)
    const entry = {
      id: `mem_${shortId(text)}`,
      text,
      tags: Array.isArray(input.tags) ? input.tags.filter(tag => typeof tag === 'string') : [],
      seq: typeof input.seq === 'number' ? input.seq : null,
      turn: typeof input.turn === 'number' ? input.turn : null,
      source: input.source ?? 'manual',
      pinned: false,
      createdAt: Date.now(),
      digest: sha256Text(text).slice(0, 16),
    }
    data.entries.push(entry)
    await this.write(sessionId, data)
    return entry
  }

  /**
   * @param {string} sessionId session
   * @param {string} id entry id
   * @param {{ text?: string, tags?: string[], pinned?: boolean }} patch changes
   * @returns {Promise<any | undefined>} updated entry
   */
  async update(sessionId, id, patch) {
    const data = await this.read(sessionId)
    const entry = data.entries.find(item => item.id === id)
    if (!entry) return undefined
    if (typeof patch.text === 'string' && patch.text.trim()) {
      entry.text = patch.text.trim()
      entry.digest = sha256Text(entry.text).slice(0, 16)
      entry.editedAt = Date.now()
    }
    if (Array.isArray(patch.tags)) entry.tags = patch.tags.filter(tag => typeof tag === 'string')
    if (typeof patch.pinned === 'boolean') entry.pinned = patch.pinned
    await this.write(sessionId, data)
    return entry
  }

  /**
   * @param {string} sessionId session
   * @param {string} id entry id
   * @returns {Promise<boolean>} removed
   */
  async remove(sessionId, id) {
    const data = await this.read(sessionId)
    const before = data.entries.length
    data.entries = data.entries.filter(item => item.id !== id)
    await this.write(sessionId, data)
    return data.entries.length !== before
  }

  /**
   * Trim entries observed after a session sequence 鈥?the memory half of a
   * checkpoint rollback.
   *
   * @param {string} sessionId session
   * @param {number} seq inclusive bound to keep
   * @returns {Promise<{ removed: number, kept: number }>} outcome
   */
  async trimTo(sessionId, seq) {
    const data = await this.read(sessionId)
    const kept = []
    let removed = 0
    for (const entry of data.entries) {
      if (typeof entry.seq === 'number' && entry.seq > seq && !entry.pinned) removed += 1
      else kept.push(entry)
    }
    if (removed > 0) {
      data.entries = kept
      await this.write(sessionId, data)
    }
    return { removed, kept: kept.length }
  }

  /**
   * @param {string} sessionId session
   * @returns {Promise<any[]>} entries in insertion order
   */
  async list(sessionId) {
    const data = await this.read(sessionId)
    return data.entries
  }

  /**
   * Everything this session contributed to the global long-term store.
   *
   * @param {string} sessionId session
   * @param {{ text: string }} input entry
   * @returns {Promise<any>} stored global entry
   */
  async addGlobal(sessionId, input) {
    const text = String(input.text ?? '').trim()
    if (!text) throw new Error('memory text is empty')
    const data = await this.read('_global')
    const entry = {
      id: `gmem_${shortId(text)}`,
      text,
      sessionId,
      tags: [],
      pinned: false,
      createdAt: Date.now(),
    }
    data.entries.push(entry)
    await this.write('_global', data)
    return entry
  }

  /**
   * @param {string} sessionId session
   * @returns {Promise<any[]>} global entries that mention this session
   */
  async listGlobal(sessionId) {
    const data = await this.read('_global')
    return data.entries.filter(entry => entry.sessionId === sessionId)
  }

  /**
   * @param {string} sessionId session
   */
  async purge(sessionId) {
    await fs.rm(this.#file(sessionId), { force: true }).catch(() => {})
    const data = await this.read('_global')
    const kept = data.entries.filter(entry => entry.sessionId !== sessionId)
    if (kept.length !== data.entries.length) {
      data.entries = kept
      await this.write('_global', data)
    }
  }

  /**
   * Whole-ledger snapshot used by the undo bundle.
   *
   * @param {string} sessionId session
   * @returns {Promise<any>} ledger content
   */
  async snapshot(sessionId) {
    return this.read(sessionId)
  }

  /**
   * @param {string} sessionId session
   * @param {any} data ledger content captured earlier
   */
  async restore(sessionId, data) {
    if (!data || !Array.isArray(data.entries)) return
    await this.write(sessionId, data)
  }
}

export const LEDGER_GLOBAL = '_global'
