/**
 * Pain-turn distillation: turn a turn that went badly into a lesson that is kept.
 *
 * WHY THIS EXISTS. The library already stores lessons — but only when the model
 * remembers to call `remember` at the moment it learns something. That is exactly
 * the moment it is least likely to happen: a turn that failed is a turn where the
 * model was busy recovering, and the thing worth keeping ("that approach fails
 * because X") is the first thing dropped when the context is under pressure. The
 * result is a library full of what worked and silent about what did not, so the
 * same mistake is available to be made again.
 *
 * WHY NOT A MODEL CALL. A per-turn background model call was tried seven times in
 * this bundle and never once fired; one attempt crashed the Host (see the note in
 * lib/memory-host.js section 3). It is also a recurring cost on every turn,
 * including the ones where nothing went wrong. Everything below is deterministic
 * text processing over the turn's own event log: no model, no network, no tokens.
 * That is what makes it acceptable to run on every turn.
 *
 * WHAT COUNTS AS PAIN. Tool failures alone do not. Measured on this project's own
 * transcript: 179 failed tool results in one session, and most of them are
 * routine — an `edit` refused because the file had not been read yet, a `pwsh`
 * call with a typo'd command name. Promoting those to protected lesson entries
 * would bury the library in noise it can never evict (lesson tags are exempt from
 * capacity eviction). So a turn is painful only when there is evidence a HUMAN
 * had to intervene, or the same tool failed repeatedly in one turn:
 *
 *   • a user message that corrects the assistant ("不对", "应该是", "重来");
 *   • the assistant itself backing out ("抱歉", "我搞错了", "更正");
 *   • one tool failing `repeatThreshold` times within the same turn — a loop.
 *
 * A single failed tool call is recorded in the trace but distils nothing.
 */

/**
 * A user message that corrects rather than requests.
 *
 * Two tiers, because one list conflates them and both directions cost real
 * lessons. Measured on this machine's 302 real user messages: a single loose
 * list matched 29 of them, and nearly every match was an ordinary request —
 * 「应该是废稿吧？」 is a question, 「改一下标题」 is an instruction. Each false
 * match distils a lesson that can never be evicted.
 *
 * STRONG cues are unambiguous complaints about work already done. WEAK cues are
 * only evidence when the message also carries a complaint marker, which is what
 * separates 「为什么还是不行」 (a complaint) from 「为什么这样做」 (a question).
 */
export const CORRECTION_CUES =
  /(不对|不是这样|不应该|你搞错|你弄错|你错了|这错了|搞错了|弄错了|写错了|做错了|算错了|改回来|重做|重来|重新做|还是不行|不是我要的|我要求的是|说错了|你又|别再这样)/

/** Hedges that only count alongside an explicit complaint marker. */
const WEAK_CORRECTION_CUES = /(应该是|为什么还|怎么还是|没用|不对吧)/

/** Markers that turn a hedge into a complaint. */
const COMPLAINT_MARKER = /(为什么|怎么|还是|又|居然|竟然|根本|完全)/

/**
 * Does this user message correct the assistant?
 *
 * A complaint can also be phrased as a question about a DEFECT rather than a
 * correction of a claim — 「为什么可以里面含有图片」, 「怎么还是这样」 — and those
 * are the messages a user writes when the previous turn's work was wrong. The
 * discriminator is a second-person or defect reference plus a complaint marker:
 * 「为什么这样做」 asks for a rationale, 「你为什么没做」 reports a miss.
 *
 * @param {string} text user message
 * @returns {boolean} true when it reads as a correction
 */
export function isUserCorrection(text) {
  const flat = String(text ?? '')
  if (CORRECTION_CUES.test(flat)) return true
  if (WEAK_CORRECTION_CUES.test(flat) && COMPLAINT_MARKER.test(flat)) return true
  // A pointed question about something the assistant was supposed to have done.
  return /(你(?:不是|没|没做|漏|忘了|说过|说好)|不是说过|你不是说)/.test(flat) && COMPLAINT_MARKER.test(flat)
}

/** The assistant admitting a mistake.
 *
 *  Deliberately requires a FIRST-PERSON admission, not a mood word. The first
 *  version matched 「实际上」/「更正」 anywhere in the reply and fired on 15 of 30
 *  painful turns across this machine's real logs — nearly all of them ordinary
 *  prose ("实际上全部生效了"), each distilling a lesson out of an unrelated
 *  paragraph. A lesson is protected from eviction, so that noise is permanent.
 *  Now the cue must name the assistant as the one who was wrong. */
export const SELF_CORRECTION_CUES =
  /(我搞错|我弄错|我错了|我犯了个错|我判断错|我算错|我记错|我说错|我之前的判断是错|我此前.{0,12}错|我上次.{0,12}错|抱歉.{0,6}我|对不起.{0,6}我|更正一下|纠正一下|纠正之前)/

/**
 * Is this assistant message admitting its own mistake?
 *
 * @param {string} text assistant message
 * @returns {boolean} true when the message owns an error
 */
export function isSelfCorrection(text) {
  return SELF_CORRECTION_CUES.test(String(text ?? ''))
}

/**
 * The single sentence that carries the correction cue.
 *
 * A real user message is often four numbered paragraphs covering four subjects.
 * Quoting all of it into a protected lesson buries the one thing that was
 * corrected and makes the theme unstable, so the lesson never recurs. Take the
 * sentence around the cue.
 *
 * @param {string} text message
 * @param {RegExp} pattern cue pattern
 * @returns {string} the sentence around the cue, or the leading text
 */
function cueSentence(text, pattern) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const match = pattern.exec(flat)
  if (!match) return flat.slice(0, 120)
  // Split into segments on sentence punctuation AND numbered-list markers, then
  // take the segment that CONTAINS the cue. A real user message is often four
  // numbered paragraphs covering four subjects; quoting from the start of the
  // message buries the one thing that was corrected. 「1、… 2、…」 is how most
  // long corrections actually arrive, so it has to be a boundary.
  const segments = []
  const boundary = /[。；;！!？?\n]|\d+、/g
  let start = 0
  for (const found of flat.matchAll(boundary)) {
    const end = found.index + found[0].length
    segments.push({ start, end, text: flat.slice(start, end) })
    start = end
  }
  if (start < flat.length) segments.push({ start, end: flat.length, text: flat.slice(start) })
  const hit = segments.find(segment => match.index >= segment.start && match.index < segment.end)
  const chosen = (hit?.text ?? flat.slice(Math.max(0, match.index - 40))).trim()
  return chosen.length > 120 ? chosen.slice(0, 119) + '…' : chosen
}

/**
 * The sentence carrying the assistant's admission of a mistake.
 *
 * @param {string} text assistant message
 * @returns {string} the sentence around the cue
 */
export function correctionSentence(text) {
  return cueSentence(text, SELF_CORRECTION_CUES)
}

/**
 * The sentence carrying a user's correction.
 *
 * @param {string} text user message
 * @returns {string} the sentence around the cue
 */
export function userCorrectionSentence(text) {
  return cueSentence(text, CORRECTION_CUES.test(String(text ?? '')) ? CORRECTION_CUES : WEAK_CORRECTION_CUES)
}

/** Signals that a failure message is noise rather than a diagnosis: a path, a
 *  line number, an id, a duration. Two runs of the same bug must collapse to the
 *  same theme or the dedupe never fires and the library fills with near-copies. */
const NOISE = [
  // Quoted paths first: a Windows path may contain spaces, and a bare
  // `[^\s]+` match would stop at the first one and leave the rest behind —
  // which made two runs of the same bug produce different signatures.
  /"[A-Za-z]:\\[^"]*"/g,
  /'[A-Za-z]:\\[^']*'/g,
  /[A-Za-z]:\\[^\s"'）)，,]+/g, // unquoted Windows paths
  /"\/[^"]*"/g, // quoted POSIX paths
  /\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g, // POSIX paths
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // uuid
  /\b[0-9a-f]{16,}\b/gi, // hashes / ids
  /\b\d+(?:\.\d+)?\s*(?:ms|s|秒|毫秒)\b/gi, // durations
  /\bline\s+\d+\b/gi,
  /第\s*\d+\s*行/g,
  /\b\d+\b/g, // bare numbers
]

export const PAIN_DEFAULTS = {
  /** Same tool failing this many times in one turn is a loop, not an accident. */
  repeatThreshold: 3,
  /** Lessons written per turn, at most. A turn that fails six ways still yields
   *  one or two durable rules; the rest is transcript noise. */
  maxLessonsPerTurn: 2,
  /** Hard cap on a distilled lesson. Lessons are injected on every request. */
  maxTextChars: 220,
  /** How much of a raw error message to quote. */
  maxErrorChars: 120,
}

/**
 * Collapse a failure message to a stable signature.
 *
 * @param {string} text raw error text
 * @returns {string} signature without paths, ids, line numbers or durations
 */
export function errorSignature(text) {
  let out = String(text ?? '')
  for (const pattern of NOISE) out = out.replace(pattern, ' ')
  return out.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, PAIN_DEFAULTS.maxErrorChars)
}

/**
 * @param {string} tool tool name
 * @param {string} signature error signature
 * @returns {string} theme key, stable across runs of the same failure
 */
export function failureTheme(tool, signature) {
  return `${String(tool ?? '?')}::${signature}`
}

/** @param {any} content message content @returns {string} text */
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
 * Read one turn out of a session event log and report what went wrong.
 *
 * TURN ATTRIBUTION. `tool/call` and `tool/result` carry `data.turn`; user and
 * assistant messages do NOT. Filtering on `data.turn` therefore silently found
 * zero user corrections across 302 real user messages — the whole
 * human-intervention half of this detector never fired, and only the
 * tool-failure half did. Messages are attributed by POSITION instead: a message
 * belongs to the turn whose `turn/start` most recently preceded it, which is how
 * the log is actually ordered.
 *
 * @param {readonly any[]} events session log
 * @param {number} turn turn number
 * @param {any} [options] threshold overrides
 * @returns {{turn: number, painful: boolean, reasons: string[], toolFailures: any[], loops: any[], userCorrections: string[], selfCorrections: string[]}} pain report
 */
export function detectPain(events, turn, options = {}) {
  const repeatThreshold = typeof options.repeatThreshold === 'number' ? options.repeatThreshold : PAIN_DEFAULTS.repeatThreshold
  const nameByCall = new Map()
  const failuresByTheme = new Map()
  const userCorrections = []
  const selfCorrections = []
  // Which turn the log is currently inside, for events that do not say.
  let currentTurn

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'turn/start' && typeof event.data?.turn === 'number') {
      currentTurn = event.data.turn
      continue
    }
    if (event.type === 'turn/end') {
      if (typeof event.data?.turn === 'number' && event.data.turn === turn) currentTurn = undefined
      continue
    }
    const eventTurn = typeof event.data?.turn === 'number' ? event.data.turn : currentTurn
    if (eventTurn !== turn) continue

    if (event.type === 'tool/call') {
      if (event.data?.callId) nameByCall.set(event.data.callId, event.data?.name ?? '?')
      continue
    }
    if (event.type === 'tool/result') {
      const message = event.data?.message
      if (message?.isError !== true) continue
      const callId = message?.toolCallId ?? event.data?.toolCallId
      const tool = nameByCall.get(callId) ?? event.data?.name ?? '?'
      const signature = errorSignature(contentText(message?.content))
      const theme = failureTheme(tool, signature)
      const row = failuresByTheme.get(theme) ?? { tool, signature, theme, count: 0, sample: contentText(message?.content) }
      row.count += 1
      failuresByTheme.set(theme, row)
      continue
    }
    if (event.type === 'user/message') {
      const kind = event.data?.source?.kind
      // Only what the human typed. Harness pipeline messages share the role.
      if (kind !== undefined && kind !== 'user') continue
      const text = contentText(event.data?.content)
      if (text && isUserCorrection(text)) userCorrections.push(text)
      continue
    }
    if (event.type === 'assistant/message') {
      const text = contentText(event.data?.message?.content)
      if (text && isSelfCorrection(text)) selfCorrections.push(text)
    }  }

  const toolFailures = [...failuresByTheme.values()]
  const loops = toolFailures.filter(row => row.count >= repeatThreshold)
  const reasons = []
  if (userCorrections.length > 0) reasons.push('user-correction')
  if (selfCorrections.length > 0) reasons.push('self-correction')
  if (loops.length > 0) reasons.push('repeat-failure')

  return {
    turn,
    // A lone failed tool call is routine and must not become a protected lesson.
    painful: reasons.length > 0,
    reasons,
    toolFailures,
    loops,
    userCorrections,
    selfCorrections,
  }
}

/** @param {string} text @param {number} max @returns {string} shortened */
function shorten(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Turn a pain report into lesson texts.
 *
 * One lesson per distinct failure theme, plus one for the correction itself when
 * the human's complaint is the only evidence. Every lesson carries the concrete
 * nouns — tool name, what the error said, what the user said — because a lesson
 * that cannot be found by lexical search is a lesson that will not be read.
 *
 * @param {ReturnType<typeof detectPain>} pain pain report
 * @param {any} [options] caps
 * @returns {{text: string, tags: string[], affect: number, theme: string}[]} lessons
 */
export function distillLessons(pain, options = {}) {
  const maxLessons = typeof options.maxLessonsPerTurn === 'number' ? options.maxLessonsPerTurn : PAIN_DEFAULTS.maxLessonsPerTurn
  const maxChars = typeof options.maxTextChars === 'number' ? options.maxTextChars : PAIN_DEFAULTS.maxTextChars
  const correction = pain.userCorrections.at(-1) ?? ''
  const correctionQuote = correction ? userCorrectionSentence(correction) : ''
  const lessons = []

  // Repeated failure first: it is the strongest evidence and the most specific
  // text. Ordered by count so a six-times loop beats a three-times one.
  for (const row of [...pain.loops].sort((a, b) => b.count - a.count)) {
    const parts = [`错误教训（${row.tool} 连续失败 ${row.count} 次）`]
    if (row.signature) parts.push(`报错：${shorten(row.signature, 90)}`)
    if (correctionQuote) parts.push(`用户纠正：${shorten(correctionQuote, 70)}`)
    parts.push('同一条路走不通时先换手段，不要重试同一个调用')
    lessons.push({
      text: shorten(parts.join('；'), maxChars),
      tags: ['错误教训'],
      affect: 0.85,
      theme: row.theme,
    })
    if (lessons.length >= maxLessons) return lessons
  }

  // A human correction is pain on its own, even when every tool call succeeded:
  // the work was wrong in a way the tools could not detect. Name the failure the
  // correction is most plausibly about — the biggest failure theme of the turn —
  // or, if the turn had none, record the correction alone.
  if (correctionQuote) {
    const worst = [...pain.toolFailures].sort((a, b) => b.count - a.count)[0]
    const parts = ['错误教训（被用户纠正）']
    if (worst) parts.push(`当时的失败：${worst.tool} ${shorten(worst.signature, 70)}`)
    parts.push(`用户说：${shorten(correctionQuote, 90)}`)
    lessons.push({
      text: shorten(parts.join('；'), maxChars),
      tags: ['错误教训'],
      affect: 0.8,
      theme: `correction::${errorSignature(correctionQuote).slice(0, 60)}`,
    })
    if (lessons.length >= maxLessons) return lessons
  }

  // Self-correction without a user complaint: the assistant noticed its own
  // mistake. Weaker, but still a repeat worth preventing. Quote the sentence
  // that carries the admission, not the whole paragraph it sat in.
  if (lessons.length === 0 && pain.selfCorrections.length > 0) {
    const worst = [...pain.toolFailures].sort((a, b) => b.count - a.count)[0]
    const parts = ['错误教训（自查纠错）']
    if (worst) parts.push(`失败：${worst.tool} ${shorten(worst.signature, 70)}`)
    parts.push(shorten(correctionSentence(pain.selfCorrections.at(-1)), 110))
    lessons.push({
      text: shorten(parts.join('；'), maxChars),
      tags: ['错误教训'],
      affect: 0.7,
      theme: `self::${errorSignature(correctionSentence(pain.selfCorrections.at(-1))).slice(0, 60)}`,
    })
  }

  return lessons.slice(0, maxLessons)
}
