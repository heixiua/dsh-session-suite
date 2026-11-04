/**
 * Fact keys and supersession.
 *
 * Lexical similarity cannot see a value change: "拼团还没开" and "拼团开了" are
 * two states of one fact that share almost no vocabulary, while "身高一米七"
 * and "长胖到 55 公斤" share a lot but are two different facts. Keying each
 * memory with `对象.方面` (for example `她.身高`) gives the engine something
 * beyond the wording: entries that share a key describe the same slot, so the
 * newest one wins and the older ones are marked superseded — kept in storage so
 * the decision can be undone, but no longer recalled.
 *
 * This module is pure: no IO, no clock, no imports. The caller supplies the
 * timestamps, and every function leaves its input untouched.
 */

/**
 * Segments generic enough that a key built from them says nothing. A memory
 * keyed `信息.内容` would collide with every other vague note, which is worse
 * than no key at all, because the collision silently buries memories.
 */
export const CATCH_ALL_SEGMENTS = Object.freeze([
  '信息',
  '内容',
  '事情',
  '事项',
  '记忆',
  '其他',
  '杂项',
  'note',
  'info',
  'other',
  'misc',
  'general',
])

/** A catch-all key groups everything, so a key may have at most this many segments. */
const MAX_SEGMENTS = 3

/**
 * Separator characters that all mean "segment boundary". Half-width `.` is the
 * canonical form; the rest are the ones a model actually emits when asked for a
 * dotted key in Chinese — the ideographic full stop and the middle dots.
 */
const SEPARATORS = /[.。·・/／．﹒]/g

/** Every kind of whitespace, including the ideographic space. */
const WHITESPACE = /\s+/g

/** Only these shapes are parsed as a timestamp; anything else is "unknown". */
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}/

/**
 * Normalise a raw key to canonical form.
 *
 * Whitespace is dropped, separators are unified, empty segments collapse, ASCII
 * is lowercased, and the result is trimmed of leading/trailing dots.
 *
 * @param {unknown} raw candidate key
 * @returns {string | null} canonical key, or null when nothing usable remains
 */
export function normalizeFactKey(raw) {
  if (typeof raw !== 'string') return null
  // NFKC folds full-width ASCII (`ＡＢＣ`, `１`, `．`) onto its half-width form,
  // which is what makes `她．身高` and `她.身高` the same key.
  const folded = raw.normalize('NFKC')
  const segments = folded
    .replace(SEPARATORS, '.')
    .replace(WHITESPACE, '')
    .split('.')
    .map(segment => segment.replace(/[A-Z]/g, ch => ch.toLowerCase()))
    .filter(segment => segment.length > 0)
  if (segments.length === 0) return null
  return segments.join('.')
}

/**
 * Is this key too broad to group memories safely?
 *
 * A key is catch-all when it has no usable segment (null, empty, punctuation
 * only), a single segment, more than three segments, or any segment drawn from
 * {@link CATCH_ALL_SEGMENTS}. The raw value is accepted as well as a canonical
 * one, so callers cannot forget to normalise first.
 *
 * @param {unknown} key key to judge
 * @returns {boolean} true when the key must not be used for supersession
 */
export function isCatchAllKey(key) {
  const canonical = normalizeFactKey(key)
  if (!canonical) return true
  const segments = canonical.split('.')
  if (segments.length < 2 || segments.length > MAX_SEGMENTS) return true
  return segments.some(segment => CATCH_ALL_SEGMENTS.includes(segment))
}

/**
 * Read an entry's timestamp as a comparable number.
 *
 * @param {unknown} value `createdAt` in any accepted shape
 * @returns {number | null} epoch milliseconds, or null when it cannot be judged
 */
function comparableTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  if (typeof value === 'string' && ISO_LIKE.test(value)) {
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : null
  }
  return null
}

/**
 * Work out which entries a fact key retires.
 *
 * Rules:
 * - Entries are grouped by canonical key. Entries without a key, with an
 *   unparsable key, or with a catch-all key never participate.
 * - Within a group the greatest `createdAt` survives; every entry strictly
 *   older than it is superseded.
 * - **Exact timestamp ties supersede nothing.** When two entries claim the same
 *   slot at the same instant there is no basis for ordering them, and guessing
 *   would permanently bury a real memory, so both stay live.
 * - Entries whose timestamp cannot be read are likewise kept.
 *
 * Grouping by canonical key also means `她.身高` and `她。身高` compete, and the
 * result does not depend on input order (only `byId` uses the first tied winner
 * when several entries share the greatest timestamp).
 *
 * @param {Array<{id?: string, factKey?: unknown, createdAt?: unknown}>} entries memories
 * @returns {{superseded: Array<{id: unknown, byId: unknown, factKey: string}>, kept: unknown[]}}
 */
export function converge(entries) {
  const list = Array.isArray(entries) ? entries : []
  /** @type {Map<string, number[]>} */
  const groups = new Map()

  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    if (!entry || typeof entry !== 'object') continue
    const key = normalizeFactKey(entry.factKey)
    if (!key || isCatchAllKey(key)) continue
    const bucket = groups.get(key)
    if (bucket) bucket.push(index)
    else groups.set(key, [index])
  }

  const superseded = []
  const retired = new Set()
  const times = list.map(entry => (entry && typeof entry === 'object' ? comparableTime(entry.createdAt) : null))

  for (const [key, indexes] of groups) {
    if (indexes.length < 2) continue
    const timed = indexes.filter(index => times[index] !== null)
    if (timed.length === 0) continue
    let newest = timed[0]
    for (const index of timed) {
      // Strict `>` keeps the first entry of an exact tie as `byId`; the tie
      // itself supersedes nothing, which is enforced by the strict `<` below.
      if (times[index] > times[newest]) newest = index
    }
    for (const index of timed) {
      if (times[index] < times[newest]) {
        retired.add(index)
        superseded.push({ id: list[index].id, byId: list[newest].id, factKey: key })
      }
    }
  }

  const kept = []
  for (let index = 0; index < list.length; index += 1) {
    if (!retired.has(index)) kept.push(list[index]?.id)
  }
  return { superseded, kept }
}

/**
 * Annotate a copy of the entry list with the supersession verdict.
 *
 * Superseded entries gain `supersededBy` (the surviving id) and `supersededAt`
 * (the surviving entry's `createdAt`, so the stamp is deterministic); every
 * other field and every other entry is copied through unchanged. The input
 * objects are never written to — callers can undo a supersession by dropping
 * those two fields again.
 *
 * @param {Array<object>} entries memories
 * @param {{now?: number}} [options] override the recorded `supersededAt`
 * @returns {Array<object>} new array, same length and order as the input
 */
export function applySupersession(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : []
  const { superseded } = converge(list)
  const override = options && typeof options === 'object' ? comparableTime(options.now) : null

  const byId = new Map()
  const entryById = new Map()
  for (const entry of list) {
    if (entry && typeof entry === 'object') entryById.set(entry.id, entry)
  }
  for (const item of superseded) {
    if (!byId.has(item.id)) byId.set(item.id, item.byId)
  }

  return list.map(entry => {
    if (!entry || typeof entry !== 'object') return entry
    if (!byId.has(entry.id)) return { ...entry }
    const survivor = entryById.get(byId.get(entry.id))
    const at = override ?? comparableTime(survivor?.createdAt)
    return { ...entry, supersededBy: byId.get(entry.id), supersededAt: at }
  })
}
