/**
 * Long-term memory engine.
 *
 * Two isolated stores, per the product spec:
 *
 *   global     — cross-workspace,永久, shared by every session
 *   workspace  — private to one working directory
 *
 * Session snapshots are deliberately *not* here: they belong to the rewind
 * feature, and they never participate in scoring, decay, or clustering.
 *
 * A memory entry carries the metadata the four-factor model needs (creation and
 * last-access time, access count, affect, and a duplicate signal), and the
 * lifecycle is:
 *
 *   active      — full text in the recall pool
 *   compressed  — a cluster summary stands in for it; the original is archived
 *   archived    — cold storage, recallable on demand but never auto-injected
 *
 * Nothing is ever hard-deleted by the engine: decay moves entries between those
 * three states, and only an explicit delete removes a record.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, readJson, sha256Text, shortId, writeJson } from './util.js'
import {
  bm25,
  rankIds,
  reciprocalRankFusion,
  tokens,
  unigrams,
  weightedCoverage,
} from './retrieval.js'

export const SCOPES = ['global', 'workspace']
export const STATES = ['active', 'compressed', 'archived']

/** Scoring weights; each factor is normalized to 0..1 before weighting. */
export const DEFAULT_WEIGHTS = { frequency: 0.35, recency: 0.3, affect: 0.15, uniqueness: 0.2 }

/** Lifecycle thresholds on the 0..1 composite score. */
export const DEFAULT_THRESHOLDS = { compress: 0.45, archive: 0.25 }

const DEFAULTS = {
  /** Half-life of the recency factor, in days. */
  decayDays: 60,
  /** Two entries above this similarity are considered near-duplicates. */
  duplicateSimilarity: 0.82,
  /** Two entries above this similarity may join one cluster. */
  clusterSimilarity: 0.5,
  /** A cluster needs at least this many members to be compressed. */
  clusterMinSize: 2,
  /** A tag group needs at least this many entries to become a rule. */
  ruleMinSize: 3,
  /** How many memories one recall may return. */
  recallLimit: 6,
  /** BM25 term-frequency saturation. Lower saturates sooner. */
  bm25K1: 1.5,
  /** BM25 length-normalisation strength, 0 (none) to 1 (full). */
  bm25B: 0.75,
  /** RRF smoothing constant; 60 is the customary default. */
  rrfK: 60,
}

/**
 * Lexical similarity for Chinese and English alike: character bigrams plus
 * lowercase word tokens, scored with the overlap coefficient. It is not an
 * embedding, and it is documented as such, but it is cheap, offline, and works
 * well for the short sentences memories actually hold.
 *
 * @param {string} text input
 * @returns {Set<string>} shingles
 */
export function shingles(text) {
  const normalized = String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ')
  const out = new Set()
  for (const word of normalized.split(' ')) {
    if (!word) continue
    if (/^[\x00-\x7f]+$/.test(word)) {
      out.add(word)
      continue
    }
    const chars = [...word]
    if (chars.length === 1) out.add(chars[0])
    for (let index = 0; index + 1 < chars.length; index += 1) out.add(`${chars[index]}${chars[index + 1]}`)
  }
  return out
}

/**
 * @param {Set<string>} a first set
 * @param {Set<string>} b second set
 * @returns {number} Jaccard similarity 0..1
 */
export function similarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared += 1
  // Jaccard rather than the overlap coefficient: short memories that differ in
  // one meaningful word must not read as near-identical.
  return shared / (a.size + b.size - shared)
}

/**
 * How much of the query a memory accounts for, ignoring its own length.
 *
 * This is deliberately *not* Jaccard. Retrieval and deduplication want opposite
 * things: a query is short and a memory is long, so Jaccard caps out near
 * query.length / memory.length — a perfect match against a 90-shingle memory
 * with a 10-shingle query scores 0.11, indistinguishable from noise. That is
 * fine for duplicate detection (which compares two memories of similar length)
 * and useless for ranking, where a long relevant memory must still be able to
 * win. Coverage answers "did this memory contain what was asked", which is the
 * question recall is actually posing.
 *
 * @param {Set<string>} query query shingles
 * @param {Set<string>} doc document shingles
 * @returns {number} coverage 0..1
 */
export function coverage(query, doc) {
  if (query.size === 0 || doc.size === 0) return 0
  let shared = 0
  for (const item of query) if (doc.has(item)) shared += 1
  return shared / query.size
}

/** @param {number} score 0..1 @param {any} thresholds thresholds @returns {string} state */
export function stateForScore(score, thresholds = DEFAULT_THRESHOLDS) {
  if (score < thresholds.archive) return 'archived'
  if (score < thresholds.compress) return 'compressed'
  return 'active'
}

/**
 * Four-factor importance.
 *
 * @param {any} entry memory entry
 * @param {{ maxAccess: number, uniqueness: number, now?: number, weights?: any, decayDays?: number }} context scoring context
 * @returns {{ score: number, factors: any }} score and its parts
 */
export function scoreEntry(entry, context) {
  const weights = { ...DEFAULT_WEIGHTS, ...(context.weights ?? {}) }
  const now = context.now ?? Date.now()
  const decayDays = context.decayDays ?? DEFAULTS.decayDays
  const frequency = Math.log1p(entry.accessCount ?? 0) / Math.log1p(Math.max(1, context.maxAccess))
  const days = Math.max(0, (now - (entry.lastAccessAt ?? entry.createdAt)) / 86400000)
  // A freeze pins the recency clock: a frozen memory never decays away.
  const recency = entry.frozen ? 1 : Math.exp(-days / decayDays)
  const affect = clamp01(entry.affect ?? 0.4)
  const uniqueness = clamp01(context.uniqueness ?? 1)
  const score =
    weights.frequency * clamp01(frequency) + weights.recency * recency + weights.affect * affect + weights.uniqueness * uniqueness
  return {
    score: Number(score.toFixed(4)),
    factors: {
      frequency: Number(clamp01(frequency).toFixed(3)),
      recency: Number(recency.toFixed(3)),
      affect: Number(affect.toFixed(3)),
      uniqueness: Number(uniqueness.toFixed(3)),
    },
  }
}

/** @param {number} value input @returns {number} clamped 0..1 */
function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}

/**
 * Memory library: entries, scoring, decay, clustering, and recall.
 */
export class MemoryEngine {
  /**
   * @param {object} options engine options
   * @param {string} options.root suite data directory
   * @param {(message: string, error?: unknown) => void} [options.log] diagnostics
   * @param {any} [options.config] plugin config
   */
  constructor({ root, log = () => {}, config = {} }) {
    this.root = path.join(root, 'memory')
    this.log = log
    this.config = config
  }

  #file(scope, key) {
    return path.join(this.root, scope === 'global' ? 'global.json' : path.join('workspaces', `${key}.json`))
  }

  #coldFile(scope, key) {
    return path.join(this.root, 'cold', scope === 'global' ? 'global.json' : `${key}.json`)
  }

  /** @param {string} cwd working directory @returns {string} workspace key */
  static workspaceKey(cwd) {
    const normalized = String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    return sha256Text(normalized).slice(0, 16)
  }

  /** @param {string} scope scope @param {string} key workspace key @returns {Promise<any>} store */
  async #readStore(scope, key) {
    const data = await readJson(this.#file(scope, key))
    if (!data || !Array.isArray(data.entries)) return { version: 2, scope, workspaceKey: key, entries: [] }
    return data
  }

  async #writeStore(scope, key, store) {
    await ensureDir(path.dirname(this.#file(scope, key)))
    await writeJson(this.#file(scope, key), store)
    // Remember the human-readable path behind each workspace key. The hash is
    // one-way, so without this the settings page can only show a truncated key
    // and cannot offer a picker for a workspace that has memories.
    if (scope === 'workspace' && typeof store.cwd === 'string' && store.cwd) {
      await this.#recordWorkspace(key, store.cwd)
    }
  }

  /**
   * Record one workspace key to path mapping in the shared registry.
   *
   * @param {string} key workspace hash
   * @param {string} cwd absolute workspace path
   */
  async #recordWorkspace(key, cwd) {
    const file = path.join(this.root, 'workspaces.json')
    const data = (await readJson(file)) ?? { version: 1, workspaces: {} }
    if (!data.workspaces || typeof data.workspaces !== 'object') data.workspaces = {}
    if (data.workspaces[key]?.cwd === cwd) return
    data.workspaces[key] = { cwd, updatedAt: Date.now() }
    await ensureDir(this.root)
    await writeJson(file, data)
  }

  /**
   * Every workspace that has stored memories, newest first.
   *
   * @returns {Promise<{ key: string, cwd: string, entries: number }[]>} known workspaces
   */
  async workspaces() {
    const data = await readJson(path.join(this.root, 'workspaces.json'))
    const known = data?.workspaces && typeof data.workspaces === 'object' ? data.workspaces : {}
    const out = []
    for (const [key, value] of Object.entries(known)) {
      const cwd = typeof value?.cwd === 'string' ? value.cwd : undefined
      if (!cwd) continue
      const store = await this.#readStore('workspace', key)
      out.push({ key, cwd, entries: store.entries.length, updatedAt: value?.updatedAt ?? 0 })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async #readCold(scope, key) {
    const data = await readJson(this.#coldFile(scope, key))
    if (!data || !Array.isArray(data.entries)) return { version: 2, scope, entries: [] }
    return data
  }

  async #writeCold(scope, key, cold) {
    await ensureDir(path.dirname(this.#coldFile(scope, key)))
    await writeJson(this.#coldFile(scope, key), cold)
  }

  /** @returns {Promise<any>} engine settings */
  async settings() {
    const data = await readJson(path.join(this.root, 'settings.json'))
    return {
      implicit: data?.implicit !== false,
      weights: { ...DEFAULT_WEIGHTS, ...(data?.weights ?? {}) },
      thresholds: { ...DEFAULT_THRESHOLDS, ...(data?.thresholds ?? {}) },
      decayDays: typeof data?.decayDays === 'number' ? data.decayDays : DEFAULTS.decayDays,
      ...data,
    }
  }

  /** @param {any} patch settings patch @returns {Promise<any>} saved settings */
  async updateSettings(patch) {
    const current = await this.settings()
    const next = {
      ...current,
      ...patch,
      weights: { ...current.weights, ...(patch.weights ?? {}) },
      thresholds: { ...current.thresholds, ...(patch.thresholds ?? {}) },
    }
    await ensureDir(this.root)
    await writeJson(path.join(this.root, 'settings.json'), next)
    return next
  }

  /**
   * Store one memory.
   *
   * @param {object} input memory input
   * @param {'global' | 'workspace'} input.scope target store
   * @param {string} [input.cwd] working directory (required for workspace scope)
   * @param {string} input.text the memory itself
   * @param {'fact' | 'rule'} [input.kind] entry kind
   * @param {string[]} [input.tags] tags
   * @param {string} [input.source] how it got here: 'explicit' | 'implicit' | 'user' | 'cluster' | 'rule'
   * @param {number} [input.affect] 0..1 emotional/priority intensity
   * @param {boolean} [input.frozen] pin it
   * @param {string} [input.sessionId] originating session
   * @returns {Promise<{ entry: any, duplicateOf?: any }>} stored entry
   */
  async remember(input) {
    const scope = input.scope === 'global' ? 'global' : 'workspace'
    const text = String(input.text ?? '').trim()
    if (!text) throw new Error('memory text is empty')
    if (scope === 'workspace' && !input.cwd) throw new Error('workspace memory needs a working directory')
    const key = scope === 'workspace' ? MemoryEngine.workspaceKey(input.cwd) : 'global'
    const store = await this.#readStore(scope, key)
    // Keep the readable path on the store so the registry can name this workspace.
    if (scope === 'workspace' && typeof input.cwd === 'string' && input.cwd) store.cwd = input.cwd

    const incoming = shingles(text)
    let best
    let bestScore = 0
    for (const entry of store.entries) {
      const score = similarity(incoming, shingles(entry.text))
      if (score > bestScore) {
        bestScore = score
        best = entry
      }
    }
    const duplicateSimilarity = this.config.duplicateSimilarity ?? DEFAULTS.duplicateSimilarity
    if (best && bestScore >= duplicateSimilarity) {
      // Reinforce instead of duplicating: the existing memory gains a hit, and
      // its decay clock restarts because it was clearly used.
      best.accessCount = (best.accessCount ?? 0) + 1
      best.lastAccessAt = Date.now()
      best.affect = Math.max(best.affect ?? 0.4, clamp01(input.affect ?? 0.4))
      // Fold in any tags the caller supplied. A memory stored before a domain
      // taxonomy existed — or stored by a path that did not pass tags — would
      // otherwise stay unfiled forever, because reinforcement never rewrites
      // the record.
      if (Array.isArray(input.tags)) {
        const merged = new Set(best.tags ?? [])
        for (const tag of input.tags) {
          if (typeof tag === 'string' && tag.trim()) merged.add(tag.trim())
        }
        best.tags = [...merged]
      }
      await this.#writeStore(scope, key, store)
      return { entry: best, duplicateOf: best }
    }

    const entry = {
      id: `mem_${shortId(text)}`,
      scope,
      workspaceKey: key,
      text,
      kind: input.kind === 'rule' ? 'rule' : 'fact',
      tags: Array.isArray(input.tags) ? input.tags.filter(tag => typeof tag === 'string') : [],
      affect: clamp01(input.affect ?? 0.4),
      frozen: input.frozen === true,
      state: 'active',
      accessCount: 1,
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
      sessionId: input.sessionId ?? null,
      source: input.source ?? 'user',
      digest: sha256Text(text).slice(0, 16),
      clusterId: null,
      summary: null,
    }
    store.entries.push(entry)
    await this.#writeStore(scope, key, store)
    return { entry }
  }

  /**
   * @param {object} input query input
   * @param {string} [input.cwd] working directory
   * @param {string} [input.query] the current question, used to rank recall
   * @param {number} [input.limit] how many entries to return
   * @param {boolean} [input.includeArchived] also look in cold storage
   * @param {boolean} [input.touch] count this as an access (default true)
   * @returns {Promise<any[]>} ranked memories, workspace entries ahead of global ones
   */
  async recall(input = {}) {
    const settings = await this.settings()
    const limit = typeof input.limit === 'number' ? input.limit : DEFAULTS.recallLimit
    const query = shingles(input.query ?? '')
    const results = []

    const collect = async scope => {
      const key = scope === 'workspace' ? MemoryEngine.workspaceKey(input.cwd) : 'global'
      const store = await this.#readStore(scope, key)
      const live = store.entries.filter(entry => entry.state !== 'archived')
      const maxAccess = Math.max(1, ...live.map(entry => entry.accessCount ?? 0))
      for (const entry of live) {
        const own = shingles(entry.text)
        let uniqueness = 1
        for (const other of live) {
          if (other.id === entry.id) continue
          uniqueness = Math.min(uniqueness, 1 - similarity(own, shingles(other.text)))
        }
        const { score, factors } = scoreEntry(entry, {
          maxAccess,
          uniqueness,
          weights: settings.weights,
          decayDays: settings.decayDays,
        })
        const relevance = query.size === 0 ? 0 : similarity(query, own)
        results.push({
          ...entry,
          scope,
          score,
          factors,
          relevance: Number(relevance.toFixed(3)),
          // Workspace memories outrank global ones on a tie, per the spec.
          rank: relevance * 0.6 + score * 0.35 + (scope === 'workspace' ? 0.05 : 0),
        })
      }
      if (input.includeArchived) {
        const cold = await this.#readCold(scope, key)
        for (const entry of cold.entries) {
          results.push({ ...entry, scope, archived: true, score: 0, factors: {}, relevance: 0, rank: 0 })
        }
      }
    }

    await collect('workspace')
    await collect('global')

    // Rank by two lexical routes fused by rank, not by one coverage score.
    //
    // History: this used Jaccard, which is symmetric and therefore punishes a
    // memory for being longer than the query; it was replaced by query-normalised
    // coverage, which fixed the long-memory penalty but left a single signal with
    // one blind spot. A single route cannot outvote itself, so a paraphrase that
    // shares no bigram with the query scored 0 and the memory became unreachable
    // no matter how relevant it was.
    //
    // The two routes now fail differently on purpose: bigrams are precise and
    // blind to partial word overlap, unigrams are loose and noisy. RRF fuses them
    // by rank because their scores are on incomparable scales.
    //
    // RRF has one failure mode that matters here: it only sees ranks, so a
    // document that matched *nothing* still occupies a rank and collects a share
    // of the fusion. With a short candidate list that is catastrophic — an
    // entirely unrelated memory ranked second of two scored 0.97 while the only
    // real match scored 0.93. Scores of zero are therefore dropped before fusion,
    // so only documents that actually matched compete for rank.
    if (query.size > 0) {
      const live = results.filter(item => !item.archived)
      const documents = live.map(item => tokens(item.text))
      const looseDocuments = live.map(item => unigrams(item.text))
      const ids = live.map(item => item.id)

      const preciseScores = bm25(tokens(input.query ?? ''), documents, {
        k1: this.config.bm25K1 ?? DEFAULTS.bm25K1,
        b: this.config.bm25B ?? DEFAULTS.bm25B,
      })
      const looseScores = live.map((item, index) =>
        weightedCoverage(unigrams(input.query ?? ''), looseDocuments[index], looseDocuments),
      )

      const preciseRanking = rankIds(
        ids.filter((id, index) => preciseScores[index] > 0),
        new Map(ids.map((id, index) => [id, preciseScores[index]])),
      )
      const looseRanking = rankIds(
        ids.filter((id, index) => looseScores[index] > 0),
        new Map(ids.map((id, index) => [id, looseScores[index]])),
      )

      const fused = reciprocalRankFusion([preciseRanking, looseRanking], this.config.rrfK ?? DEFAULTS.rrfK)

      for (let index = 0; index < live.length; index += 1) {
        const item = live[index]
        const bm25Score = preciseScores[index]
        item.bm25 = Number(bm25Score.toFixed(3))
        item.coverage = Number(looseScores[index].toFixed(3))
        item.rank =
          (fused.get(item.id) ?? 0) * 0.75 + item.score * 0.2 + (item.scope === 'workspace' ? 0.05 : 0)
      }
    }

    // With no query every rank is 0, so this only orders the importance-only
    // case; with a query the coverage ranks are already in place.
    results.sort((a, b) => b.rank - a.rank)
    const top = results.slice(0, limit)
    if (input.touch !== false) {
      for (const item of top) {
        if (item.archived) continue
        const key = item.scope === 'workspace' ? MemoryEngine.workspaceKey(input.cwd) : 'global'
        const store = await this.#readStore(item.scope, key)
        const stored = store.entries.find(entry => entry.id === item.id)
        if (!stored) continue
        stored.accessCount = (stored.accessCount ?? 0) + 1
        stored.lastAccessAt = Date.now()
        await this.#writeStore(item.scope, key, store)
      }
    }
    return top
  }

  /**
   * Score, decay, cluster, and abstract one or both stores.
   *
   * @param {string} [cwd] workspace to maintain (global always runs)
   * @returns {Promise<any>} what changed
   */
  async maintain(cwd) {
    const settings = await this.settings()
    const clusterSimilarity =
      this.config.clusterSimilarity ?? settings.clusterSimilarity ?? DEFAULTS.clusterSimilarity
    const clusterMinSize = this.config.clusterMinSize ?? settings.clusterMinSize ?? DEFAULTS.clusterMinSize
    const ruleMinSize = this.config.ruleMinSize ?? settings.ruleMinSize ?? DEFAULTS.ruleMinSize
    const report = { scored: 0, archived: 0, compressed: 0, clusters: 0, rules: 0, promoted: 0 }
    const keys = [['global', 'global']]
    if (cwd) keys.push(['workspace', MemoryEngine.workspaceKey(cwd)])

    for (const [scope, key] of keys) {
      const store = await this.#readStore(scope, key)
      if (store.entries.length === 0) continue
      const maxAccess = Math.max(1, ...store.entries.map(entry => entry.accessCount ?? 0))

      // 1. Score every entry and apply the two thresholds.
      for (const entry of store.entries) {
        if (entry.frozen) {
          entry.score = 1
          continue
        }
        const own = shingles(entry.text)
        let uniqueness = 1
        for (const other of store.entries) {
          if (other.id === entry.id) continue
          uniqueness = Math.min(uniqueness, 1 - similarity(own, shingles(other.text)))
        }
        const { score, factors } = scoreEntry(entry, {
          maxAccess,
          uniqueness,
          weights: settings.weights,
          decayDays: settings.decayDays,
        })
        entry.score = score
        entry.factors = factors
        entry.updatedAt = Date.now()
        report.scored += 1
        const target = stateForScore(score, settings.thresholds)
        if (entry.state === 'archived') continue
        if (target === 'archived' && entry.state !== 'archived') {
          await this.#archive(scope, key, store, entry)
          report.archived += 1
        } else if (target === 'compressed') {
          entry.state = 'compressed'
        } else {
          entry.state = 'active'
        }
      }
      await this.#writeStore(scope, key, store)

      // 2. Cluster near-duplicates and compress them into one summary.
      //
      // A summary is itself an entry, so without the `summary` guard every pass
      // re-clustered the summaries produced by the previous pass. Six passes
      // produced six summaries of one sentence under six different cluster ids,
      // because a summary carried `summaryId` but not `clusterId` and so passed
      // the `!entry.clusterId` test that was meant to exclude it.
      //
      // Orphaned summaries (no live member left) are dropped first. Otherwise a
      // summary outlives the members it summarised and keeps feeding itself
      // back into the next pass.
      // Archived members move to the cold store, so they must be counted too:
      // a summary whose members all aged out is still a legitimate summary.
      const cold = await this.#readCold(scope, key)
      const liveMembers = new Set(
        [...store.entries, ...cold.entries]
          .filter(entry => entry.clusterId && !entry.summary)
          .map(entry => entry.clusterId),
      )
      const orphans = store.entries.filter(entry => entry.summary && !liveMembers.has(entry.clusterId))
      if (orphans.length > 0) {
        store.entries = store.entries.filter(entry => !orphans.includes(entry))
        report.orphans = (report.orphans ?? 0) + orphans.length
      }
      const clusterable = store.entries.filter(
        entry => entry.state !== 'archived' && !entry.frozen && !entry.clusterId && !entry.summary,
      )
      const groups = []
      for (const entry of clusterable) {
        const own = shingles(entry.text)
        const group = groups.find(candidate => candidate.some(member => similarity(own, shingles(member.text)) >= clusterSimilarity))
        if (group) group.push(entry)
        else groups.push([entry])
      }
      for (const group of groups) {
        if (group.length < clusterMinSize) continue
        const clusterId = `cluster_${shortId(group.map(entry => entry.id).join(':'))}`
        const summary = group.map(entry => entry.text).join('；')
        const summaryText = summary.length > 400 ? `${summary.slice(0, 400)}…` : summary
        // The same text under a new cluster id is a duplicate, not a finding.
        // Content decides identity here; the member ids only decide the cluster.
        const existing = store.entries.find(entry => entry.summary && entry.text === summaryText)
        if (existing) {
          for (const entry of group) {
            entry.clusterId = existing.clusterId
            entry.summaryId = existing.id
            await this.#archive(scope, key, store, entry)
          }
          report.compressed += group.length
          continue
        }
        const summaryEntry = {
          id: `sum_${shortId(clusterId)}`,
          scope,
          workspaceKey: key,
          text: summaryText,
          kind: 'fact',
          tags: [...new Set(group.flatMap(entry => entry.tags ?? []))],
          affect: Math.max(...group.map(entry => entry.affect ?? 0.4)),
          frozen: false,
          state: 'active',
          accessCount: group.reduce((sum, entry) => sum + (entry.accessCount ?? 0), 0),
          createdAt: Date.now(),
          lastAccessAt: Date.now(),
          source: 'cluster',
          digest: sha256Text(summary).slice(0, 16),
          clusterId,
          summary: true,
        }
        for (const entry of group) {
          entry.clusterId = clusterId
          entry.summaryId = summaryEntry.id
          await this.#archive(scope, key, store, entry)
        }
        store.entries.push(summaryEntry)
        report.clusters += 1
        report.compressed += group.length
      }
      await this.#writeStore(scope, key, store)

      // 3. Abstract repeated tags into a rule-type memory.
      const byTag = new Map()
      for (const entry of store.entries) {
        if (entry.state === 'archived' || entry.kind === 'rule' || entry.summary) continue
        for (const tag of entry.tags ?? []) {
          if (!byTag.has(tag)) byTag.set(tag, [])
          byTag.get(tag).push(entry)
        }
      }
      for (const [tag, group] of byTag) {
        if (group.length < ruleMinSize) continue
        // The identity of a rule is the set of memories it summarizes, not the
        // group size at the moment it was built. A size-derived id made the same
        // rule reappear under a fresh id every time the group grew or shrank,
        // which filled the live store and the cold archive with duplicates.
        const sourceIds = group
          .map(entry => entry.id)
          .sort()
          .join(',')
        const ruleId = `rule_${shortId(tag + sourceIds)}`
        // The cold archive counts as "already exists". A rule that was clustered
        // into a summary and then archived is gone from the live store, so a
        // live-only check rebuilt it on the next pass; the rebuilt rule was then
        // clustered into a fresh summary, and the pass after that rebuilt it
        // again. That loop is what put one sentence in the library seven times.
        const already = [...store.entries, ...cold.entries].some(
          entry => entry.kind === 'rule' && (entry.id === ruleId || entry.ruleTag === tag),
        )
        if (already) continue
        const rule = {
          id: ruleId,
          scope,
          workspaceKey: key,
          text: `规则（${tag}）：${group.map(entry => entry.text).join('；')}`,
          kind: 'rule',
          tags: [tag],
          affect: Math.max(...group.map(entry => entry.affect ?? 0.4)),
          frozen: false,
          state: 'active',
          accessCount: group.length,
          createdAt: Date.now(),
          lastAccessAt: Date.now(),
          source: 'rule',
          ruleTag: tag,
          digest: sha256Text(tag).slice(0, 16),
          clusterId: null,
          summary: null,
        }
        store.entries.push(rule)
        report.rules += 1
      }
      await this.#writeStore(scope, key, store)
    }
    // Record that a pass actually ran, and what it produced. Without this the
    // settings page cannot distinguish "ran and found nothing to do" from
    // "never ran at all", which is exactly how a silent timer hides a bug.
    //
    // The dirty signal is a fingerprint of the stored content, not a timestamp.
    // A pass writes entries (it scores them and may add rules), so any
    // timestamp it produces is newer than the pass that produced it and would
    // make every subsequent pass look necessary forever.
    const status = await this.status()
    await this.#writeStatus({
      ...status,
      lastMaintainedAt: Date.now(),
      lastMaintainedCwd: cwd ?? null,
      lastReport: report,
      lastFingerprint: await this.#fingerprint(keys),
    })
    return report
  }

  /**
   * A stable fingerprint of what the given stores contain.
   *
   * Only identity and text participate, so rescoring or clustering the same
   * entries does not look like new input.
   *
   * @param {Array<[string, string]>} keys stores to inspect
   * @returns {Promise<string>} digest, or '' when nothing is stored
   */
  async #fingerprint(keys) {
    const parts = []
    for (const [scope, key] of keys) {
      const store = await this.#readStore(scope, key)
      const live = store.entries.filter(entry => entry.state !== 'archived')
      if (live.length === 0) continue
      const rows = live
        .map(entry => `${entry.id}:${entry.text}`)
        .sort()
        .join('\u0000')
      parts.push(`${scope}/${key}/${sha256Text(rows).slice(0, 16)}`)
    }
    return parts.join('|')
  }

  /** @returns {Promise<any>} last maintenance bookkeeping */
  async status() {
    const data = await readJson(path.join(this.root, 'maintenance.json'))
    return {
      lastMaintainedAt: typeof data?.lastMaintainedAt === 'number' ? data.lastMaintainedAt : 0,
      lastMaintainedCwd: typeof data?.lastMaintainedCwd === 'string' ? data.lastMaintainedCwd : null,
      lastReport: data?.lastReport ?? null,
      lastFingerprint: typeof data?.lastFingerprint === 'string' ? data.lastFingerprint : '',
    }
  }

  /** @param {any} next status patch @returns {Promise<any>} saved status */
  async #writeStatus(next) {
    await ensureDir(this.root)
    await writeJson(path.join(this.root, 'maintenance.json'), next)
    return next
  }

  /**
   * Whether a maintenance pass is worth running.
   *
   * An idle Host should not wake up on a timer to rescore unchanged memory, so
   * the caller checks this first. A pass is due when something has changed since
   * the previous one, or when nothing has ever run.
   *
   * @param {string} [cwd] workspace to consider
   * @returns {Promise<boolean>} true when a pass is due
   */
  async needsMaintenance(cwd) {
    const keys = [['global', 'global']]
    if (cwd) keys.push(['workspace', MemoryEngine.workspaceKey(cwd)])
    const fingerprint = await this.#fingerprint(keys)
    // Nothing stored at all means there is nothing to maintain.
    if (fingerprint === '') return false
    const status = await this.status()
    return fingerprint !== status.lastFingerprint
  }

  async #archive(scope, key, store, entry) {
    const cold = await this.#readCold(scope, key)
    const archived = { ...entry, state: 'archived', archivedAt: Date.now() }
    cold.entries = [...cold.entries.filter(item => item.id !== entry.id), archived]
    await this.#writeCold(scope, key, cold)
    store.entries = store.entries.filter(item => item.id !== entry.id)
  }

  /**
   * @param {object} input query input
   * @param {string} [input.cwd] workspace
   * @param {'global' | 'workspace'} [input.scope] limit to one store
   * @returns {Promise<any[]>} every entry with its score
   */
  async list(input = {}) {
    const settings = await this.settings()
    const out = []
    const scopes = input.scope ? [input.scope] : SCOPES
    for (const scope of scopes) {
      const key = scope === 'workspace' ? MemoryEngine.workspaceKey(input.cwd) : 'global'
      const store = await this.#readStore(scope, key)
      const cold = await this.#readCold(scope, key)
      const maxAccess = Math.max(1, ...store.entries.map(entry => entry.accessCount ?? 0))
      for (const entry of store.entries) {
        const own = shingles(entry.text)
        let uniqueness = 1
        for (const other of store.entries) {
          if (other.id === entry.id) continue
          uniqueness = Math.min(uniqueness, 1 - similarity(own, shingles(other.text)))
        }
        const { score, factors } = scoreEntry(entry, {
          maxAccess,
          uniqueness,
          weights: settings.weights,
          decayDays: settings.decayDays,
        })
        out.push({ ...entry, scope, score, factors })
      }
      for (const entry of cold.entries) out.push({ ...entry, scope, score: 0, factors: {}, state: 'archived', archived: true })
    }
    return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  }

  /**
   * @param {object} input patch input
   * @param {string} [input.cwd] workspace
   * @param {'global' | 'workspace'} [input.scope] store
   * @param {string} input.id entry id
   * @param {{ frozen?: boolean, touch?: boolean, text?: string }} [input.patch] changes
   * @returns {Promise<any | undefined>} updated entry
   */
  async update(input) {
    const scope = input.scope === 'global' ? 'global' : 'workspace'
    const key = scope === 'workspace' ? MemoryEngine.workspaceKey(input.cwd) : 'global'
    const store = await this.#readStore(scope, key)
    const entry = store.entries.find(item => item.id === input.id)
    if (!entry) {
      const cold = await this.#readCold(scope, key)
      const archived = cold.entries.find(item => item.id === input.id)
      if (!archived) return undefined
      if (input.patch?.frozen) {
        // Freezing an archived memory restores it to the live pool.
        const restored = { ...archived, state: 'active', frozen: true, lastAccessAt: Date.now() }
        cold.entries = cold.entries.filter(item => item.id !== input.id)
        await this.#writeCold(scope, key, cold)
        store.entries.push(restored)
        await this.#writeStore(scope, key, store)
        return restored
      }
      return archived
    }
    if (typeof input.patch?.frozen === 'boolean') entry.frozen = input.patch.frozen
    if (input.patch?.touch) entry.lastAccessAt = Date.now()
    if (typeof input.patch?.text === 'string' && input.patch.text.trim()) entry.text = input.patch.text.trim()
    await this.#writeStore(scope, key, store)
    return entry
  }

  /**
   * @param {object} input delete input
   * @param {string} [input.cwd] workspace
   * @param {'global' | 'workspace'} [input.scope] store
   * @param {string} [input.id] entry id; omitted clears the cold archive
   * @returns {Promise<{ removed: number }>} outcome
   */
  async remove(input) {
    let removed = 0
    const scopes = input.scope ? [input.scope] : SCOPES
    for (const scope of scopes) {
      const key = scope === 'workspace' ? MemoryEngine.workspaceKey(input.cwd) : 'global'
      if (input.id) {
        const store = await this.#readStore(scope, key)
        const before = store.entries.length
        store.entries = store.entries.filter(item => item.id !== input.id)
        await this.#writeStore(scope, key, store)
        const cold = await this.#readCold(scope, key)
        const coldBefore = cold.entries.length
        cold.entries = cold.entries.filter(item => item.id !== input.id)
        await this.#writeCold(scope, key, cold)
        removed += before - store.entries.length + coldBefore - cold.entries.length
        continue
      }
      const cold = await this.#readCold(scope, key)
      removed += cold.entries.length
      await this.#writeCold(scope, key, { version: 2, scope, entries: [] })
    }
    return { removed }
  }

  /**
   * @param {object} [input] export input
   * @param {string} [input.cwd] workspace
   * @returns {Promise<any>} everything, for a portable backup
   */
  async export(input = {}) {
    const out = { version: 2, exportedAt: Date.now(), global: {}, workspace: {} }
    const read = async (scope, key) => ({
      live: await this.#readStore(scope, key),
      cold: await this.#readCold(scope, key),
    })
    out.global = await read('global', 'global')
    if (input.cwd) out.workspace = await read('workspace', MemoryEngine.workspaceKey(input.cwd))
    return out
  }

  /**
   * Pending implicit suggestions: extracted but not yet confirmed by the user.
   *
   * @param {string} [cwd] workspace filter
   * @returns {Promise<any[]>} suggestions
   */
  async pending(cwd) {
    const data = await readJson(path.join(this.root, 'pending.json'))
    const items = Array.isArray(data?.items) ? data.items : []
    return items.filter(item => !cwd || item.cwd === cwd || item.scope === 'global')
  }

  /**
   * @param {any} suggestion suggestion to queue
   * @returns {Promise<any>} stored suggestion
   */
  async suggest(suggestion) {
    const file = path.join(this.root, 'pending.json')
    const data = (await readJson(file)) ?? { version: 1, items: [] }
    const items = Array.isArray(data.items) ? data.items : []
    const digest = sha256Text(String(suggestion.text ?? '')).slice(0, 16)
    if (items.some(item => item.digest === digest)) return undefined
    const item = {
      id: `sug_${shortId(digest)}`,
      digest,
      text: String(suggestion.text ?? '').trim(),
      scope: suggestion.scope === 'global' ? 'global' : 'workspace',
      cwd: suggestion.cwd ?? null,
      tags: suggestion.tags ?? [],
      affect: clamp01(suggestion.affect ?? 0.5),
      reason: suggestion.reason ?? 'implicit',
      sessionId: suggestion.sessionId ?? null,
      createdAt: Date.now(),
    }
    if (!item.text) return undefined
    items.push(item)
    await ensureDir(this.root)
    await writeJson(file, { version: 1, items })
    return item
  }

  /** @param {string} id suggestion id @param {boolean} accept keep or drop */
  async settle(id, accept) {
    const file = path.join(this.root, 'pending.json')
    const data = (await readJson(file)) ?? { version: 1, items: [] }
    const item = (data.items ?? []).find(entry => entry.id === id)
    data.items = (data.items ?? []).filter(entry => entry.id !== id)
    await writeJson(file, data)
    if (!item || !accept) return { stored: false }
    const { entry } = await this.remember({
      scope: item.scope,
      cwd: item.cwd,
      text: item.text,
      tags: item.tags,
      affect: item.affect,
      source: 'implicit',
      sessionId: item.sessionId,
    })
    return { stored: true, entry }
  }
}

export { DEFAULTS as MEMORY_DEFAULTS }
