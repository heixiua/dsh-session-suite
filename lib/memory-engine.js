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

import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, readJson, sha256Text, shortId, writeJson } from './util.js'
import { applySupersession, isCatchAllKey, normalizeFactKey } from './factkeys.js'
import { isLoaded, loadWordList, wordTokens } from './wordlist.js'
import { DISABLED_PROVIDER, createEmbeddingProvider } from './embeddings.js'
import {
  bm25,
  cosineSimilarity,
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

/**
 * What kind of memory an entry is.
 *
 * Three of these mirror the standard split of long-term memory, and the split is
 * not cosmetic: each kind decays at a different rate and answers a different
 * question.
 *
 *   fact    语义 — a stable truth ("the export inlines images as data URLs")
 *   rule    程序 — how something should be done ("refuse over-long memories")
 *   summary 聚合 — several entries compressed into one
 *   episode 情景 — what happened, when, and how it turned out
 *
 * `episode` is the one the library lacked entirely. Such a memory is not a fact
 * (things can stay true) nor a rule (it prescribes nothing); it records an event
 * with a time and an outcome, e.g. "last week's PPT was rejected for using too many
 * colours". Filing those as `fact` lost the time and the outcome, which are the
 * parts that make them useful later.
 */
export const KINDS = ['fact', 'rule', 'summary', 'episode']

/**
 * How much faster an episode ages than a fact.
 *
 * An event is dated: "the deployment failed on Tuesday" stops being actionable
 * quickly, while "the project uses pnpm" stays true for years. Halving the
 * half-life is a defensible default rather than a tuned constant — there is no
 * held-out set of episodic queries to fit it against, so claiming a precise value
 * would be unfounded.
 */
export const EPISODE_DECAY_FACTOR = 0.5

/**
 * How private a memory is.
 *
 * The library had only a scope (global / workspace), which controls *where* a
 * memory is stored but says nothing about *who may see it*. That gap is a real risk:
 * a password or a medical note filed under `workspace` is still exported by the share
 * feature and still injected into every prompt in that workspace.
 *
 *   public    safe to include in an export someone else may read
 *   internal  stays on this machine; excluded from exports (the default)
 *   secret    never injected, never exported, masked in the list
 *
 * The default is `internal`, not `public`: guessing wrong toward privacy costs a
 * little convenience, guessing wrong the other way leaks something.
 */
export const PRIVACY_LEVELS = ['public', 'internal', 'secret']

/**
 * Patterns that identify a credential or a government id.
 *
 * Deliberately blunt. A false positive only makes a memory harder to read; a false
 * negative puts a secret in an export. Precision matters less than never missing.
 */
const SECRET_PATTERNS = [
  /(?:密码|口令|password|passwd|pwd)\s*[:=：]?\s*\S+/i,
  /\b(?:sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{12,}/,
  /\b\d{17}[\dXx]\b/, // mainland id number
  /\b(?:\d{15,19})\b/, // bank card
  /\b1[3-9]\d{9}\b/, // mainland mobile
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // email
  /(?:身份证|银行卡|信用卡|私钥|密钥|token|secret|api[_-]?key)/i,
]

/** Topics that are personal but not credentials. */
const PRIVATE_TOPICS = /(工资|存款|现金|房租|负债|病历|诊断|吃药|抑郁|焦虑|家庭住址|身份证地址)/

/**
 * Decide a privacy level from the text alone.
 *
 * @param {string} text memory text
 * @param {string} [explicit] a level the caller supplied
 * @returns {'public' | 'internal' | 'secret'} level
 */
export function inferPrivacy(text, explicit) {
  if (typeof explicit === 'string' && PRIVACY_LEVELS.includes(explicit)) return explicit
  const value = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(value)) return 'secret'
  }
  if (PRIVATE_TOPICS.test(value)) return 'internal'
  return 'internal'
}

/**
 * Whether a memory may be shown to someone other than its owner.
 *
 * @param {any} entry memory entry
 * @returns {boolean} true when it may appear in an export
 */
export function isExportable(entry) {
  return (entry?.privacy ?? 'internal') === 'public'
}

/**
 * Whether a memory may be injected into a prompt.
 *
 * `secret` is excluded: a credential is not context, and injecting it would copy it
 * into every provider request.
 *
 * @param {any} entry memory entry
 * @returns {boolean} true when it may be injected
 */
export function isInjectable(entry) {
  return (entry?.privacy ?? 'internal') !== 'secret'
}

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
  /**
   * Longest a single memory may be, in characters.
   *
   * A memory is a fact to recall, not a document to read. Past a few hundred
   * characters it stops being useful as a memory: it is expensive to inject,
   * its shingles swamp any query, and a human scanning the list cannot take it
   * in. The observed failure was a 3250-character entry, which is a report, not
   * a memory. Longer input is refused rather than silently truncated — a
   * truncated fact reads as a complete one and would be wrong.
   */
  maxMemoryChars: 300,
  /** BM25 term-frequency saturation. Lower saturates sooner. */
  bm25K1: 1.5,
  /** BM25 length-normalisation strength, 0 (none) to 1 (full). */
  bm25B: 0.75,
  /** RRF smoothing constant; 60 is the customary default. */
  rrfK: 60,
  /**
   * How many candidates the dense reranker may embed per query.
   *
   * Reranking runs on the prompt path, so its cost has to be bounded: embedding
   * the whole library for one question would turn a 200ms step into a multi-second
   * one. The lexical stage has already narrowed the field, and reranking only
   * needs to reorder the head of that list.
   */
  denseRerankCandidates: 24,
  /**
   * How many topic cards the resident layer may inject, and the character budget
   * for the whole block.
   *
   * The budget is the real constraint: cards exist to give the model a cheap
   * overview, and an overview that costs a thousand tokens per turn defeats the
   * purpose. Five cards of about 120 characters each keeps the block near 600
   * characters, which is roughly what the previous flat layer cost while being far
   * more informative.
   */
  residentCards: 5,
  residentBudget: 600,
  /**
   * How much of a card's lead memory to show.
   *
   * A card is a pointer, not the memory itself: the full text stays reachable
   * through recall. Capping this is what keeps ONE verbose memory from consuming
   * the whole card budget and hiding every other topic — measured at 621
   * characters for a single card before this cap.
   */
  residentCardSummaryChars: 60,
  /**
   * How much the dense similarity may nudge the fused lexical rank.
   *
   * Measured, not guessed. Swept over eight paraphrased queries against the real
   * library and model (tools/probe-dense-rerank.mjs):
   *
   *   off    recall@5 1.000  MRR 0.535
   *   0.15   recall@5 1.000  MRR 0.546   ← the value first shipped, effectively inert
   *   0.5    recall@5 1.000  MRR 0.708
   *   1      recall@5 1.000  MRR 0.760   ← chosen
   *   2      recall@5 1.000  MRR 0.723
   *   8      recall@5 1.000  MRR 0.629   ← over-weighted, drags good results down
   *
   * The curve has a clear maximum and recall never drops, which is what makes this a
   * defensible default rather than a preference. An earlier measurement at 0.15
   * concluded "the dense stage changes nothing" — that was a flaw in the query set
   * (all eight were already ranked correctly by lexical retrieval), not in the stage.
   */
  denseWeight: 1,
}

/**
 * The CJK word list, loaded once per process.
 *
 * Loading costs about a millisecond of I/O, 23 ms of parsing, and ~14 MB of
 * heap, so re-reading it inside every recall would burn that on every turn for
 * no gain. Failure is cached as an empty list as well: a missing data file must
 * degrade silently to the two lexical routes that already existed, never break
 * recall. `isLoaded()` then tells the caller whether the third route is usable.
 *
 * @returns {any} the shared word list
 */
/**
 * Accept a fact key only if it names one subject-and-aspect pair.
 *
 * The key answers "is this the same fact, restated?" so a key that is too broad
 * destroys memories: `她.身高` is a fact, `身高` alone is a category, and
 * `信息.内容` could absorb half the library. A rejected key means the entry
 * simply opts out of supersession, which is always safe — the dangerous
 * failure is a wrong key, not a missing one.
 *
 * @param {unknown} raw caller-supplied key
 * @returns {string | null} canonical key, or null to opt out
 */
function storedFactKey(raw) {
  const canonical = normalizeFactKey(raw)
  if (!canonical || isCatchAllKey(canonical)) return null
  return canonical
}

let wordListCache
function cjkWordList() {
  if (wordListCache === undefined) {
    try {
      const text = readFileSync(new URL('./data/jieba-dict.txt', import.meta.url), 'utf8')
      wordListCache = loadWordList(text)
    } catch {
      wordListCache = loadWordList('')
    }
  }
  return wordListCache
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
 * How many memories the evidence actually justifies injecting.
 *
 * A fixed budget forces a choice between two bad outcomes: spend the full
 * allowance on a question that matched almost nothing, or cap it low and then
 * pad weak evidence up to the cap anyway. The top score already says how strong
 * the best match is, so it can also say how many matches are worth believing.
 *
 * The thresholds are the ones the recall probes actually produced: a strong
 * match clears 0.6, a usable one 0.5, a marginal one 0.4. Below that the honest
 * answer is one entry, not six.
 *
 * Returning `MAX_SAFE_INTEGER` means "the caller's own budget is the limit" —
 * `select()` takes the minimum, so the configured `recallLimit` still governs.
 *
 * @param {number} topScore best fused rank in this recall
 * @returns {number} an upper bound on how many entries to inject
 */
export function injectionTier(topScore) {
  // `!(x >= 0.4)` rather than `x < 0.4` so NaN, undefined, and null all take the
  // conservative branch instead of slipping through as "strong".
  if (!(topScore >= 0.4)) return 1
  if (topScore >= 0.6) return Number.MAX_SAFE_INTEGER
  if (topScore >= 0.5) return 4
  return 3
}

/** @param {any} item ranked entry @returns {any} the trace-sized shape of it */
function summariseForTrace(item) {
  return {
    id: item.id,
    scope: item.scope,
    text: item.text,
    rank: Number((item.rank ?? 0).toFixed(3)),
  }
}

/**
 * Whether an entry passes the list filters.
 *
 * Both filters are optional and combine as AND, which is what a user means by
 * "my error lessons from this week". Tag matching is exact and case-insensitive
 * rather than substring: a substring match would make `dsh` also select
 * `dsh-foo`, and silently widening a filter is how a short list becomes a long
 * one again.
 *
 * @param {any} entry memory entry
 * @param {{ tag?: string, sinceDays?: number, now?: number }} input filter
 * @returns {boolean} whether it passes
 */
function matchesFilter(entry, input) {
  const tag = typeof input?.tag === 'string' ? input.tag.trim().toLowerCase() : ''
  if (tag) {
    const tags = Array.isArray(entry.tags) ? entry.tags : []
    if (!tags.some(value => String(value).trim().toLowerCase() === tag)) return false
  }
  const sinceDays = Number(input?.sinceDays)
  if (Number.isFinite(sinceDays) && sinceDays > 0) {
    const now = typeof input.now === 'number' ? input.now : Date.now()
    const cutoff = now - sinceDays * 86400000
    // "Recent" means the entry was written or last used inside the window:
    // an old fact that keeps being recalled is still current.
    const when = Math.max(Number(entry.createdAt ?? 0), Number(entry.lastAccessAt ?? 0))
    if (when < cutoff) return false
  }
  const privacy = typeof input?.privacy === 'string' ? input.privacy : ''
  if (privacy) {
    const level = entry.privacy ?? 'internal'
    // One requested level, or 'all' for no filtering.
    if (privacy !== 'all' && level !== privacy) return false
  }
  // Export wants only what may leave this machine. Filtered here rather than in the
  // caller so the share path cannot forget it.
  if (input?.exportable === true && !isExportable(entry)) return false
  return true
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
  // An episode ages faster than a fact: "the deployment failed on Tuesday" stops
  // being actionable in weeks, while "the project uses pnpm" stays true for years.
  // The episode's own occurrence time is the clock, not when it was written — an
  // event recorded late is not a fresh event.
  const isEpisode = entry.kind === 'episode'
  const baseDecay = context.decayDays ?? DEFAULTS.decayDays
  const decayDays = isEpisode ? baseDecay * EPISODE_DECAY_FACTOR : baseDecay
  const frequency = Math.log1p(entry.accessCount ?? 0) / Math.log1p(Math.max(1, context.maxAccess))
  const anchor = isEpisode
    ? (entry.occurredAt ?? entry.lastAccessAt ?? entry.createdAt)
    : (entry.lastAccessAt ?? entry.createdAt)
  const days = Math.max(0, (now - anchor) / 86400000)
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
    // A fact, not a document. Refusing is deliberate: truncating would store a
    // sentence that reads as complete while having lost its end, and a memory
    // that is subtly wrong is worse than one that was never written.
    const maxChars = this.config.maxMemoryChars ?? DEFAULTS.maxMemoryChars
    if (maxChars > 0 && text.length > maxChars) {
      throw new Error(
        `memory text is ${text.length} characters; the limit is ${maxChars}. ` +
          'Split it into separate facts instead of storing one long block.',
      )
    }
    if (scope === 'workspace' && !input.cwd) throw new Error('workspace memory needs a working directory')
    const key = scope === 'workspace' ? MemoryEngine.workspaceKey(input.cwd) : 'global'
    const store = await this.#readStore(scope, key)
    // Keep the readable path on the store so the registry can name this workspace.
    if (scope === 'workspace' && typeof input.cwd === 'string' && input.cwd) store.cwd = input.cwd

    const factKey = storedFactKey(input.factKey)
    const incoming = shingles(text)
    let best
    let bestScore = 0
    for (const entry of store.entries) {
      // Identical text is a duplicate by definition, and the shingle comparison
      // alone cannot see that: a body made only of punctuation shingles to the
      // empty set, so two identical punctuation-only records scored 0 against
      // each other. That is how 154 writes of the same placeholder became 27
      // separate records instead of reinforcing one.
      if (entry.text === text) {
        best = entry
        bestScore = 1
        break
      }
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
      // Restating a fact that had been superseded revives that record rather
      // than inserting a second one: the id is derived from the text, so a fresh
      // insert would collide with the stored record. Reviving also keeps the
      // original creation history instead of pretending the fact is brand new.
      if (best.supersededBy) {
        delete best.supersededBy
        delete best.supersededAt
        best.createdAt = Date.now()
      }
      // An entry stored before the caller supplied keys can still be filed.
      if (!best.factKey && factKey) best.factKey = factKey
      await this.#writeStore(scope, key, store)
      return { entry: best, duplicateOf: best }
    }

    const entry = {
      id: `mem_${shortId(text)}`,
      scope,
      workspaceKey: key,
      text,
      kind: KINDS.includes(input.kind) ? input.kind : 'fact',
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
      // The subject-and-aspect this entry speaks about, when the caller gave
      // one. Same key means same fact, so only the newest survives recall.
      factKey,
      clusterId: null,
      summary: null,
      // Who may see this. Scope says where it lives; privacy says who may read it.
      privacy: inferPrivacy(text, input.privacy),
    }
    // An episode carries the three things that make it an event rather than a
    // truth: when it happened, the situation, and how it turned out. They are
    // optional so a caller that only knows the text can still file one.
    if (entry.kind === 'episode') {
      entry.occurredAt =
        typeof input.occurredAt === 'number' && Number.isFinite(input.occurredAt)
          ? input.occurredAt
          : entry.createdAt
      if (typeof input.context === 'string' && input.context.trim()) {
        entry.context = input.context.trim().slice(0, 200)
      }
      if (typeof input.outcome === 'string' && input.outcome.trim()) {
        entry.outcome = input.outcome.trim().slice(0, 200)
      }
    }
    store.entries.push(entry)
    // Supersede older entries that talk about the same fact. Done in the same
    // pass as the write so the store is never briefly inconsistent — and only
    // when the new entry carries a key, so an unkeyed entry cannot retire
    // anything.
    if (factKey) {
      store.entries = applySupersession(store.entries, { now: entry.createdAt })
    }
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
      // Superseded entries are history, not candidates: a fact whose value moved
      // on must not be recalled alongside its replacement, and leaving them in
      // would also dilute the uniqueness sample below.
      const live = store.entries.filter(entry => entry.state !== 'archived' && !entry.supersededBy)
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
          // Whether this entry shares anything at all with the question. The
          // rerank pass below recomputes it from the lexical routes; without a
          // question every entry trivially "matches".
          matched: true,
          // Workspace memories outrank global ones on a tie, per the spec.
          rank: relevance * 0.6 + score * 0.35 + (scope === 'workspace' ? 0.05 : 0),
        })
      }
      if (input.includeArchived) {
        const cold = await this.#readCold(scope, key)
        for (const entry of cold.entries) {
          // Cold storage is the history view, so superseded entries are kept
          // here — that is where a user goes to see what a fact used to say.
          results.push({ ...entry, scope, archived: true, score: 0, factors: {}, relevance: 0, rank: 0 })
        }
      }
    }

    await collect('workspace')
    await collect('global')

    // Remember the scanned set so the dense reranker can look an entry up by id
    // without re-reading the stores it was just built from.
    this.lastScan = results

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
      // A secret is filtered here, in the engine, rather than trusted to every
      // caller: recall is the one function whose output ends up in a prompt, and a
      // credential is not context. Filtering at the call sites would mean the
      // guarantee holds only where someone remembered to apply it.
      const live = results.filter(item => !item.archived && item.privacy !== 'secret')
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

      // Third route: real word segmentation against a general-purpose Chinese
      // word list. Character bigrams cannot tell 「车」 inside 「车站」 from 「车」
      // standing alone, so they match across word boundaries; a word list fixes
      // exactly that. It is weaker on anything outside the list — personal
      // names, code identifiers, new coinages — which is why it joins the fusion
      // instead of replacing a route. A third opinion only helps when it is
      // wrong in different places.
      const wordList = cjkWordList()
      // `wordRoute: false` runs the two lexical routes alone, which is exactly
      // what the ablation in tools/ablate-word-route.mjs compares against.
      const wordsReady = this.config.wordRoute !== false && isLoaded(wordList)
      const wordScores = wordsReady
        ? bm25(
            wordTokens(input.query ?? '', wordList),
            live.map(item => wordTokens(item.text, wordList)),
            {
              k1: this.config.bm25K1 ?? DEFAULTS.bm25K1,
              b: this.config.bm25B ?? DEFAULTS.bm25B,
            },
          )
        : []
      const wordRanking = wordsReady
        ? rankIds(
            ids.filter((id, index) => wordScores[index] > 0),
            new Map(ids.map((id, index) => [id, wordScores[index]])),
          )
        : []

      const fused = reciprocalRankFusion(
        [preciseRanking, looseRanking, wordRanking],
        this.config.rrfK ?? DEFAULTS.rrfK,
      )

      // Optional second stage: dense reranking of the candidates the lexical
      // routes already found. Lexical retrieval cannot bridge a paraphrase that
      // shares no character (checkpoint vs 快照); a dense model can. It runs only
      // when a provider is configured and a query exists, and every failure path
      // inside the provider returns undefined, so the fused order below is the
      // fallback rather than an exception.
      //
      // Note the interpolation weight is applied against the *fused* ranking, so
      // a strong lexical agreement is not discarded just because the vector is
      // mediocre — the two signals describe different things and both are kept.
      const denseRanking = await this.#denseRerank(input.query, ids, fused).catch(() => undefined)

      for (let index = 0; index < live.length; index += 1) {
        const item = live[index]
        const bm25Score = preciseScores[index]
        const wordScore = wordScores[index] ?? 0
        item.bm25 = Number(bm25Score.toFixed(3))
        item.coverage = Number(looseScores[index].toFixed(3))
        item.words = Number(wordScore.toFixed(3))
        item.matched = bm25Score > 0 || looseScores[index] > 0 || wordScore > 0
        item.rank =
          (fused.get(item.id) ?? 0) * 0.75 + item.score * 0.2 + (item.scope === 'workspace' ? 0.05 : 0)
        // The dense score nudges the order without replacing it. The weight is
        // configurable because the right value is empirical, not obvious: measured on
        // a hold-out of eight paraphrase queries, a weight of 0.15 changed the
        // ordering of NOT ONE result — the three lexical routes had already agreed,
        // and the dense signal was too small to overturn them. A weight that DOES
        // change ordering has to be justified by measurement, so it is exposed here
        // rather than guessed at.
        if (denseRanking?.has(item.id)) {
          item.dense = Number(denseRanking.get(item.id).toFixed(3))
          item.rank += Math.max(0, item.dense) * (this.config.denseWeight ?? DEFAULTS.denseWeight)
        }
      }
    }

    // With no query every rank is 0, so this only orders the importance-only
    // case; with a query the coverage ranks are already in place.
    results.sort((a, b) => b.rank - a.rank)
    // The secret filter must be applied to the FINAL list, not only to the
    // candidate set the lexical routes scored: filtering `live` alone left the
    // unfiltered `results` to be sorted and sliced below, so a credential still
    // came back. This is the last gate before the output leaves the engine.
    const safe = results.filter(item => item.privacy !== 'secret')
    const top = safe.slice(0, limit)
    if (input.touch !== false) await this.#touch(top, input.cwd)
    return top
  }

  /**
   * Decide what actually gets injected into the prompt.
   *
   * `recall()` answers "rank everything", which is what the settings page, the
   * probes, and the export need. Injection needs a different answer: how much of
   * that ranking is worth spending context on. Always filling `recallLimit`
   * slots is how a weak question drags six unrelated memories into the prompt —
   * the count then claims six things are relevant when the evidence says
   * otherwise. It also costs tokens on every single turn.
   *
   * So the injected count is tiered by the top score: strong evidence gets the
   * full budget, weaker evidence gets progressively fewer slots, and a question
   * that barely matches anything gets exactly one. `omitted` then reports, for
   * every candidate left out, which rule left it out.
   *
   * That second half matters as much as the first. A memory system that silently
   * decides not to recall something is indistinguishable from a broken one — the
   * user cannot tell "it forgot" from "it judged this irrelevant". Naming the
   * reason is the difference between a black box and a debuggable feature.
   *
   * @param {object} input same as recall, plus `tiered` (default true)
   * @returns {Promise<{ items: any[], omitted: any[], effectiveLimit: number, topScore: number }>}
   */
  /**
   * Lessons that must be present whether or not the current question resembles them.
   *
   * The gap this closes is real and was measured the hard way. A memory that says "never
   * write a Windows .bat with a BOM" was stored and maintained, but when the agent went to
   * edit a profile manifest the prompt was about installing a plugin — lexically nothing
   * like the lesson. Retrieval scored it far below the cut, so the agent repeated the
   * mistake and crashed the Host. The lesson existed; it simply was not in the room.
   *
   * That is a property of lexical retrieval, not a bug in it: relevance and importance are
   * different axes, and a mistake's cost does not shrink because the current sentence does
   * not mention it. So this returns a small, bounded set of high-value lessons that get
   * injected unconditionally.
   *
   * Selection is by IMPORTANCE, not similarity:
   *   • only active entries (archived ones have been superseded or judged stale),
   *   • never a secret (it is a credential, not context),
   *   • lessons first (tag 错误教训 / 教训 / lesson / pitfall), then anything frozen,
   *   • ranked by score, then recency,
   *   • capped by count AND by characters, because this rides on every request.
   *
   * @param {object} [input] input
   * @param {string} [input.cwd] workspace to read (global store is always included)
   * @param {number} [input.limit] how many lessons, default 3
   * @param {number} [input.budget] total character budget, default 600
   * @returns {Promise<Array<{ text: string, scope: string, tags: string[] }>>} lessons
   */
  async lessonCards(input = {}) {
    const limit = typeof input.limit === 'number' ? input.limit : 3
    const budget = typeof input.budget === 'number' ? input.budget : 600
    if (limit <= 0 || budget <= 0) return []

    const entries = (await this.list({ cwd: input.cwd })).filter(
      entry =>
        !entry.archived &&
        entry.privacy !== 'secret' &&
        String(entry.text ?? '').trim().length > 0,
    )
    if (entries.length === 0) return []

    // What counts as a lesson. Tags are normalised by lib/tags.js, so these are the
    // stored spellings; the English forms are included because a user may write them.
    const LESSON_TAGS = new Set(['错误教训', '教训', 'lesson', 'pitfall', '事故'])
    const isLesson = entry => {
      if (entry.frozen === true) return true
      const tags = Array.isArray(entry.tags) ? entry.tags : []
      return tags.some(tag => LESSON_TAGS.has(String(tag)))
    }

    const lessons = entries.filter(isLesson)
    // No lesson-tagged entries: return nothing rather than promoting arbitrary memories
    // into a block labelled "lessons". An empty block is honest; a mislabelled one is not.
    if (lessons.length === 0) return []

    const ranked = [...lessons].sort(
      (a, b) =>
        Number(Boolean(b.frozen)) - Number(Boolean(a.frozen)) ||
        (b.score ?? 0) - (a.score ?? 0) ||
        (b.lastAccessAt ?? b.createdAt ?? 0) - (a.lastAccessAt ?? a.createdAt ?? 0),
    )

    const kept = []
    let used = 0
    for (const entry of ranked) {
      if (kept.length >= limit) break
      const text = String(entry.text).replace(/\s+/g, ' ').trim()
      // Charge the rendered line, and never split a memory: a truncated lesson can invert
      // its own meaning ("always X" cut to "always" is worse than absent).
      const cost = text.length + 3
      if (kept.length > 0 && used + cost > budget) break
      if (cost > budget) continue
      kept.push({ text, scope: entry.scope === 'global' ? 'global' : 'workspace', tags: entry.tags ?? [] })
      used += cost
    }
    return kept
  }

  /**
   * Group high-value memories into topic cards for the resident layer.
   *
   * Why cards instead of "the N most important entries": the flat version made the
   * injected block unreadable and, worse, misleading. A user who typed a question
   * into the settings probe saw six lines and assumed all six were the recall
   * result, when two of them were the resident layer and had nothing to do with the
   * question. Grouping by topic lets the block state *what* it is summarising
   * ("缓存: 4 条") instead of dumping four unrelated sentences and calling the
   * whole thing "relevant".
   *
   * The shape follows the two-layer architecture described for agent memory: a
   * compact overview of what the library knows, with detail left to on-demand
   * recall. It is deliberately NOT a hierarchical index — one level of grouping is
   * what the injected budget can afford, and a deeper tree would cost more context
   * than it saves.
   *
   * @param {object} input input
   * @param {string} [input.cwd] workspace
   * @param {number} [input.limit] how many cards, default 5
   * @param {number} [input.budget] total character budget for card text, default 600
   * @returns {Promise<Array<{ topic: string, count: number, summary: string, updatedAt: number }>>} cards
   */
  async residentCards(input = {}) {
    const limit = typeof input.limit === 'number' ? input.limit : DEFAULTS.residentCards
    const budget = typeof input.budget === 'number' ? input.budget : DEFAULTS.residentBudget
    const entries = (await this.list({ cwd: input.cwd })).filter(
      // A secret must not appear in the overview either: a card's summary is text
      // that gets injected, so listing one here would leak it just as surely as
      // putting it in the matched half.
      entry => !entry.archived && entry.privacy !== 'secret' && String(entry.text ?? '').trim(),
    )
    if (entries.length === 0) return []

    // Group by the first tag that is not the generic feature tag. A memory usually
    // carries one or two tags; the first is the subject, and grouping by it is
    // what a reader would call "the topic".
    const groups = new Map()
    for (const entry of entries) {
      const tags = Array.isArray(entry.tags) ? entry.tags.filter(tag => typeof tag === 'string' && tag) : []
      const topic = tags[0] ?? '未分类'
      if (!groups.has(topic)) groups.set(topic, [])
      groups.get(topic).push(entry)
    }

    const cards = []
    for (const [topic, members] of groups) {
      // Rank the members so the card's summary line carries the most valuable
      // sentence: frozen first (the user pinned it), then by score, then recency.
      const ranked = [...members].sort(
        (a, b) =>
          Number(Boolean(b.frozen)) - Number(Boolean(a.frozen)) ||
          (b.score ?? 0) - (a.score ?? 0) ||
          (b.lastAccessAt ?? 0) - (a.lastAccessAt ?? 0),
      )
      const head = ranked[0]
      // A card is an overview line, not a memory. The head memory can be up to
      // maxMemoryChars long, and pasting it whole turned one card into 600
      // characters on its own — which then crowded every other topic out of the
      // budget. Truncation is acceptable HERE, unlike at the write path: this is a
      // pointer that says "there is something about X", and the full text is still
      // available through recall.
      const headText = String(head?.text ?? '').replace(/\s+/g, ' ').trim()
      const summary =
        headText.length > DEFAULTS.residentCardSummaryChars
          ? `${headText.slice(0, DEFAULTS.residentCardSummaryChars)}…`
          : headText
      cards.push({
        topic,
        count: members.length,
        summary,
        updatedAt: Math.max(...members.map(entry => entry.lastAccessAt ?? entry.createdAt ?? 0)),
        weight: ranked.reduce((sum, entry) => sum + (entry.score ?? 0), 0) / members.length,
      })
    }

    // Biggest and most valuable topics first; a card for one stray memory is noise.
    cards.sort((a, b) => b.count - a.count || b.weight - a.weight || b.updatedAt - a.updatedAt)

    const kept = []
    let used = 0
    for (const card of cards) {
      if (kept.length >= limit) break
      // Cost is the rendered line, not just the summary: the topic name and count
      // are charged too. The check is BEFORE adding, and the first card is allowed
      // through regardless so the layer is never empty — a 621-character single
      // card against a 600-character budget is exactly the overrun this avoids.
      const line = `${card.topic}（${card.count} 条）：${card.summary}`
      if (kept.length > 0 && used + line.length + 1 > budget) break
      kept.push(card)
      used += line.length + 1
    }
    return kept
  }

  /**
   * Render the resident cards as prompt lines.
   *
   * @param {Array<any>} cards output of residentCards
   * @returns {string[]} one line per card
   */
  static formatCards(cards) {
    return (Array.isArray(cards) ? cards : []).map(
      card => `- ${card.topic}（${card.count} 条）：${card.summary}`,
    )
  }

  async select(input = {}) {
    const limit = typeof input.limit === 'number' ? input.limit : DEFAULTS.recallLimit
    const tiered = input.tiered !== false
    const ranked = await this.recall({ ...input, limit: Number.MAX_SAFE_INTEGER, touch: false })
    const asked = String(input.query ?? '').trim().length > 0

    const eligible = []
    const omitted = []
    for (const item of ranked) {
      // With a question, only entries that share something with it are
      // candidates. Without one, everything is a candidate on importance alone.
      if (asked && item.matched !== true) omitted.push({ ...summariseForTrace(item), reason: 'no-match' })
      else eligible.push(item)
    }

    const topScore = eligible.length > 0 ? Number(eligible[0].rank ?? 0) : 0
    // Tiering only applies when a question was asked. With no question there is
    // no match to be weak or strong — the ranking is importance alone, which
    // never reaches the match thresholds — so gating on it would silently
    // collapse the budget to a single entry for no reason.
    const effectiveLimit = tiered && asked ? Math.min(limit, injectionTier(topScore)) : limit
    const items = eligible.slice(0, effectiveLimit)
    for (const item of eligible.slice(effectiveLimit)) {
      omitted.push({ ...summariseForTrace(item), reason: 'capacity' })
    }

    const selection = {
      items,
      omitted,
      effectiveLimit,
      topScore: Number(topScore.toFixed(3)),
      askedAt: Date.now(),
      query: input.query ?? '',
    }
    // Kept so the settings page can show "what did the last recall pick, and
    // what did it drop" without having to replay the query itself.
    this.lastSelection = selection
    if (input.touch !== false) await this.#touch(items, input.cwd)
    return selection
  }

  /**
   * Count one access per injected entry and refresh its decay clock.
   *
   * @param {any[]} items entries that were actually used
   * @param {string} [cwd] workspace they were recalled for
   */
  async #touch(items, cwd) {
    for (const item of items) {
      if (item.archived) continue
      const key = item.scope === 'workspace' ? MemoryEngine.workspaceKey(cwd) : 'global'
      const store = await this.#readStore(item.scope, key)
      const stored = store.entries.find(entry => entry.id === item.id)
      if (!stored) continue
      stored.accessCount = (stored.accessCount ?? 0) + 1
      stored.lastAccessAt = Date.now()
      await this.#writeStore(item.scope, key, store)
    }
  }

  /**
   * Score, decay, cluster, and abstract every store this engine owns.
   *
   * Every registered workspace is maintained, not just the one named here.
   * Memory is stored per workspace, so maintaining only the most recent one left
   * every other workspace permanently unmaintained — its entries were never
   * scored, decayed, clustered, or summarised. The named `cwd` is still accepted
   * (and included) so a caller that just wrote to a brand-new workspace maintains
   * it before it has been registered.
   *
   * @param {string} [cwd] workspace to maintain in addition to the registered ones
   * @returns {Promise<any>} what changed
   */
  async maintain(cwd) {
    const settings = await this.settings()
    const clusterSimilarity =
      this.config.clusterSimilarity ?? settings.clusterSimilarity ?? DEFAULTS.clusterSimilarity
    const clusterMinSize = this.config.clusterMinSize ?? settings.clusterMinSize ?? DEFAULTS.clusterMinSize
    const ruleMinSize = this.config.ruleMinSize ?? settings.ruleMinSize ?? DEFAULTS.ruleMinSize
    const report = { scored: 0, archived: 0, compressed: 0, clusters: 0, rules: 0, promoted: 0, workspaces: 0 }
    // The same key list `needsMaintenance` checks, so the fingerprint this pass
    // writes is the fingerprint the next check compares against.
    const keys = await this.#maintenanceKeys(cwd)

    for (const [scope, key] of keys) {
      const store = await this.#readStore(scope, key)
      if (store.entries.length === 0) continue
      if (scope === 'workspace') report.workspaces += 1
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
        // Identity is the CONTENT, and the cold archive counts.
        //
        // The live-only, exact-text check was the hole that kept refilling the
        // library. Sequence: a group is clustered → its summary is written and
        // its members are archived → a later pass clusters a DIFFERENT group
        // whose joined text is equivalent but not byte-identical (member order
        // differs, or one member came back as a new fact) → the exact-text probe
        // missed it → another near-identical summary appeared. One sentence ended
        // up in the library seven times.
        //
        // Comparing a normalised digest rather than raw text fixes the ordering
        // half, and searching the cold archive fixes the "it was archived"
        // half — the same reasoning that already protected rule generation.
        const summaryDigest = sha256Text(
          group
            .map(entry => String(entry.text ?? '').trim())
            .sort()
            .join('；'),
        ).slice(0, 16)
        const existing = [...store.entries, ...cold.entries].find(
          entry => entry.summary && (entry.summaryDigest === summaryDigest || entry.text === summaryText),
        )
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
          summaryDigest,
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
        // Cap what a rule may absorb. Joining every member of a tag group turned
        // a rule into a document — the library ended up with entries over three
        // thousand characters, which are unusable as memories and expensive to
        // inject. A rule states the recurring conclusion, so the newest few
        // members are enough to state it; the members themselves stay in the
        // library and remain individually recallable.
        const maxRuleChars = this.config.maxMemoryChars ?? DEFAULTS.maxMemoryChars
        const members = []
        let length = `规则（${tag}）：`.length
        for (const entry of [...group].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))) {
          const addition = (members.length === 0 ? '' : '；') + entry.text
          if (maxRuleChars > 0 && members.length > 0 && length + addition.length > maxRuleChars) break
          members.push(entry)
          length += addition.length
        }
        const rule = {
          id: ruleId,
          scope,
          workspaceKey: key,
          text: `规则（${tag}）：${members.map(entry => entry.text).join('；')}`,
          kind: 'rule',
          tags: [tag],
          affect: Math.max(...members.map(entry => entry.affect ?? 0.4)),
          frozen: false,
          state: 'active',
          accessCount: members.length,
          createdAt: Date.now(),
          lastAccessAt: Date.now(),
          source: 'rule',
          ruleTag: tag,
          // The digest must cover what the rule actually says, not just the tag:
          // two rules from the same tag over different members are different
          // rules, and a tag-only digest made them indistinguishable.
          digest: sha256Text(`规则（${tag}）：${members.map(entry => entry.text).join('；')}`).slice(0, 16),
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
      // The most recent implicit-extraction attempt, set by the host half. It is
      // in-memory on purpose: a restart legitimately forgets it, and the settings
      // page only ever asks "why is the queue empty right now".
      extraction: this.lastExtraction ?? null,
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
   * Every registered workspace is considered, not just the one named here.
   * Checking only the most recent workspace was a real defect: memory is stored
   * per workspace, so a workspace the user had not touched lately never entered
   * the fingerprint and therefore never got scored, decayed, clustered, or
   * summarised. A conversation in that workspace could run for a long time and
   * its memories would stay completely unmaintained — they existed, but nothing
   * ever compressed them or let them fade.
   *
   * @param {string} [cwd] workspace to consider (kept for callers that know one)
   * @returns {Promise<boolean>} true when a pass is due
   */
  async needsMaintenance(cwd) {
    const keys = await this.#maintenanceKeys(cwd)
    const fingerprint = await this.#fingerprint(keys)
    // Nothing stored at all means there is nothing to maintain.
    if (fingerprint === '') return false
    const status = await this.status()
    return fingerprint !== status.lastFingerprint
  }

  /**
   * Score query/candidate pairs with the configured embedding provider.
   *
   * Returns undefined whenever dense ranking is unavailable, which is the normal
   * state: no provider configured, no query, or an embedding failure. The caller
   * treats undefined as "keep the lexical order", so this is an optimisation that
   * cannot break recall.
   *
   * @param {string} query the user's question
   * @param {Array<string | number>} ids candidate ids, aligned with `live`
   * @param {Map<string | number, number>} fused lexical scores, best-first order
   * @returns {Promise<Map<string | number, number> | undefined>} dense cosine per id
   */
  async #denseRerank(query, ids, fused) {
    const text = String(query ?? '').trim()
    if (!text) return undefined
    const provider = await this.#ensureEmbeddingProvider()
    if (!provider?.available) return undefined

    // Only embed candidates the lexical stage actually matched, capped so a huge
    // library cannot turn one prompt step into hundreds of inferences.
    const selected = [...fused.entries()]
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, DEFAULTS.denseRerankCandidates)
      .map(([id]) => id)
    if (selected.length === 0) return undefined

    const queryVector = await provider.embed(text)
    if (!queryVector) return undefined

    const scores = new Map()
    for (const id of selected) {
      const entry = this.#findEntryById(id)
      if (!entry) continue
      const vector = await this.#embeddingFor(provider, entry)
      if (!vector) continue
      scores.set(id, cosineSimilarity(queryVector, vector))
    }
    return scores.size > 0 ? scores : undefined
  }

  /**
   * The embedding provider for this engine, created at most once.
   *
   * Lazy on purpose: constructing a local pipeline is expensive and most users run
   * without a model, so nothing happens until a query actually needs it.
   *
   * @returns {Promise<any>} provider, or the disabled one
   */
  async #ensureEmbeddingProvider() {
    if (this.denseProvider !== undefined) return this.denseProvider
    try {
      this.denseProvider = await createEmbeddingProvider({ ...this.config, root: this.root })
    } catch {
      this.denseProvider = DISABLED_PROVIDER
    }
    return this.denseProvider
  }

  /**
   * Embedding for one entry, memoised in memory.
   *
   * Entries are immutable except for scoring metadata, so a vector stays valid
   * for the process lifetime; recomputing it per query would make reranking far
   * more expensive than the lexical routes it augments.
   *
   * @param {any} provider embedding provider
   * @param {any} entry memory entry
   * @returns {Promise<number[] | undefined>} vector
   */
  async #embeddingFor(provider, entry) {
    if (!this.denseCache) this.denseCache = new Map()
    // Key on the text plus its length: a rewritten memory changes the text, so a
    // stale vector cannot be served for different content.
    const key = `${entry.id}:${String(entry.text ?? '').length}:${entry.text}`
    if (this.denseCache.has(key)) return this.denseCache.get(key)
    const vector = await provider.embed(String(entry.text ?? ''))
    this.denseCache.set(key, vector)
    return vector
  }

  /**
   * Look up an entry by id across the stores this engine has loaded.
   *
   * @param {string | number} id entry id
   * @returns {any | undefined} entry
   */
  #findEntryById(id) {
    const scanned = this.lastScan
    if (!Array.isArray(scanned)) return undefined
    return scanned.find(entry => entry.id === id)
  }

  /**
   * The stores a maintenance pass covers: the global store plus every workspace.
   *
   * Shared by `needsMaintenance` and `maintain` on purpose. When the two
   * computed their own key lists they could disagree — the pass would write a
   * fingerprint for one set of keys while the check computed another, so the
   * library stayed permanently "dirty" and every tick re-ran a full pass.
   *
   * @param {string} [cwd] extra workspace to include
   * @returns {Promise<Array<[string, string]>>} scope/key pairs
   */
  async #maintenanceKeys(cwd) {
    const keys = [['global', 'global']]
    const seen = new Set()
    for (const workspaceCwd of [...(await this.#registeredCwds()), ...(cwd ? [cwd] : [])]) {
      const key = MemoryEngine.workspaceKey(workspaceCwd)
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(['workspace', key])
    }
    return keys
  }

  /**
   * Every workspace directory this engine has ever written to.
   *
   * The registry exists because a workspace key is a one-way hash of the path —
   * the key alone cannot be turned back into a directory. Without this, a
   * maintenance pass can only ever see the workspace the caller happens to
   * name.
   *
   * @returns {Promise<string[]>} readable cwd paths
   */
  async #registeredCwds() {
    const data = await readJson(path.join(this.root, 'workspaces.json')).catch(() => undefined)
    const workspaces = data?.workspaces
    if (!workspaces || typeof workspaces !== 'object') return []
    const out = []
    for (const record of Object.values(workspaces)) {
      if (typeof record?.cwd === 'string' && record.cwd) out.push(record.cwd)
    }
    return out
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
   * @param {string} [input.tag] only entries carrying this tag
   * @param {number} [input.sinceDays] only entries created or touched within N days
   * @returns {Promise<any[]>} every entry with its score
   */
  async list(input = {}) {
    const settings = await this.settings()
    const out = []
    // `'all'` is a legitimate request meaning "every scope". Treating it as a scope
    // NAME selected a store called `all`, which does not exist, so the answer came
    // back as whatever stray rows happened to be there — the settings page showed
    // 「共 5 条」 for a library of 51. Any unrecognised value falls back to every
    // scope for the same reason: an unknown scope must not silently narrow the list.
    const requested = input.scope
    const scopes =
      requested === 'workspace' || requested === 'global'
        ? [requested]
        : SCOPES
    // Which workspace stores to read.
    //
    // A caller without a workspace — the sidebar panel has none — used to get only
    // the global store, because `workspaceKey(undefined)` hashes the empty string and
    // reads a store that never exists. That is why the panel showed 17 for a library
    // of 51 while the settings page showed 51. When no cwd is supplied, read every
    // REGISTERED workspace instead of pretending there is one unnamed store: the
    // registry is the only place that knows which keys exist.
    const workspaceKeys = await (async () => {
      // Only asked for global: no workspace stores at all.
      if (requested === 'global') return []
      // A caller that names its workspace gets exactly that one.
      if (typeof input.cwd === 'string' && input.cwd) return [MemoryEngine.workspaceKey(input.cwd)]
      // A caller with no workspace gets every registered one.
      const registered = await this.workspaces()
      return registered.map(item => item.key).filter(key => typeof key === 'string' && key)
    })()
    for (const scope of scopes) {
      // The workspace scope may cover several keys; global covers exactly one.
      const keys = scope === 'workspace' ? workspaceKeys : ['global']
      for (const key of keys) {
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
    }
    // Filtering happens here rather than in the caller so the settings page and
    // the export both see the same set for the same query. A library that grows
    // past a screenful is unusable without it — the observed complaint was
    // exactly that: too many entries to be worth reading.
    const filtered = out.filter(entry => matchesFilter(entry, input))
    return filtered.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
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
   * Remove every durable fact that came from one session.
   *
   * Deleting a session used to leave its long-term memories behind: the per-session
   * ledger was purged (lib/memory.js) but the durable library was not, because the two
   * are different stores. A fact carries `sessionId` of the conversation that produced
   * it, so those rows survived as orphans — invisible in the session, still injected
   * into later prompts, and impossible to attribute once the session was gone.
   *
   * Scope matters: only entries whose `sessionId` matches are removed. Facts the user
   * promoted to `global` deliberately, and facts with no sessionId at all (imported, or
   * written by the tool outside a session), are left alone.
   *
   * @param {string} sessionId session whose facts should go
   * @returns {Promise<{ removed: number, workspaces: number }>} what was deleted
   */
  async purgeSession(sessionId) {
    const target = String(sessionId ?? '')
    if (!target) return { removed: 0, workspaces: 0 }

    let removed = 0
    let workspaces = 0

    /** @param {string} scope @param {string} key @returns {Promise<number>} rows removed */
    const purgeOne = async (scope, key) => {
      const store = await this.#readStore(scope, key)
      if (!Array.isArray(store.entries) || store.entries.length === 0) return 0
      const kept = store.entries.filter(entry => String(entry.sessionId ?? '') !== target)
      const dropped = store.entries.length - kept.length
      if (dropped === 0) return 0
      store.entries = kept
      await this.#writeStore(scope, key, store)

      // The cold store holds compressed/archived rows; they belong to the same fact and
      // must go too, or the session's content survives in a quieter place.
      const cold = await this.#readCold(scope, key)
      if (Array.isArray(cold.entries) && cold.entries.length > 0) {
        const coldKept = cold.entries.filter(entry => String(entry.sessionId ?? '') !== target)
        if (coldKept.length !== cold.entries.length) {
          await this.#writeCold(scope, key, { version: 2, scope, entries: coldKept })
        }
      }
      return dropped
    }

    // Global store first: a fact written from this session may have been promoted.
    removed += await purgeOne('global', 'global')

    // Then every registered workspace. Enumerating them (rather than purging only the
    // caller's cwd) is deliberate: the session may have written into another workspace.
    const registered = await this.workspaces().catch(() => [])
    for (const workspace of registered) {
      const key = typeof workspace?.key === 'string' ? workspace.key : undefined
      if (!key) continue
      const dropped = await purgeOne('workspace', key)
      if (dropped > 0) {
        removed += dropped
        workspaces += 1
      }
    }

    return { removed, workspaces }
  }

  /**
   * @param {object} [input] export input
   * @param {string} [input.cwd] workspace
   * @returns {Promise<any>} everything, for a portable backup
   */
  async export(input = {}) {
    const out = { version: 2, exportedAt: Date.now(), global: {}, workspace: {}, excluded: 0 }
    // A share export leaves this machine, so only `public` memories may travel.
    // `internal` is the default level, which means the honest behaviour for a library
    // nobody has classified is to export nothing private — and to say how many were
    // withheld, because silently dropping rows looks like data loss.
    const keep = (scope, store) => {
      const entries = Array.isArray(store?.entries) ? store.entries : []
      const kept = entries.filter(isExportable)
      out.excluded += entries.length - kept.length
      return { ...store, entries: kept }
    }
    const read = async (scope, key) => {
      const live = await this.#readStore(scope, key)
      const cold = await this.#readCold(scope, key)
      return { live: keep(scope, live), cold: keep(scope, cold) }
    }
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
      // The kind travels with the suggestion so accepting it later stores the same
      // shape the extractor meant. Without this, an episode would be flattened to a
      // fact at confirmation time and lose its time and outcome.
      kind: KINDS.includes(suggestion.kind) ? suggestion.kind : 'fact',
      cwd: suggestion.cwd ?? null,
      tags: suggestion.tags ?? [],
      affect: clamp01(suggestion.affect ?? 0.5),
      reason: suggestion.reason ?? 'implicit',
      sessionId: suggestion.sessionId ?? null,
      createdAt: Date.now(),
    }
    if (item.kind === 'episode') {
      if (typeof suggestion.context === 'string' && suggestion.context.trim()) {
        item.context = suggestion.context.trim().slice(0, 200)
      }
      if (typeof suggestion.outcome === 'string' && suggestion.outcome.trim()) {
        item.outcome = suggestion.outcome.trim().slice(0, 200)
      }
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
      kind: item.kind,
      ...(item.kind === 'episode' ? { context: item.context, outcome: item.outcome } : {}),
      tags: item.tags,
      affect: item.affect,
      source: 'implicit',
      sessionId: item.sessionId,
    })
    return { stored: true, entry }
  }
}

export { DEFAULTS as MEMORY_DEFAULTS }
