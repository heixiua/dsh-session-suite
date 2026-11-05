/**
 * Streaming sanitizer for the four internal step tags
 * (`<发>` / `<执行>` / `<好>` / `<现在>`, U+003C + word + U+003E).
 *
 * These are prompt-side stepping markers, not user-facing content. Weak or
 * mis-switched models occasionally emit them as a long run inside a normal
 * assistant reply; once streamed they land in the durable assistant message,
 * the live transcript, share exports, and every later request that replays the
 * history. The only layer that can clean all of those at once is the
 * `llm/stream` waterfall: filter the token deltas (live transcript) and the
 * terminal `block-end` block text (what the assembler actually persists).
 *
 * The filter is deliberately conservative:
 * - only the four exact literals are removed, never other angle-bracket text;
 * - a possible partial tag at a delta boundary is held back until it can be
 *   classified, so `<执` + `行>` is removed across two deltas;
 * - every other chunk passes through unchanged (same object), and a filter
 *   failure yields the original chunk instead of breaking the stream.
 *
 * @module dsh-session-suite/step-tag-filter
 */

/** The four internal step tags, built from code points on purpose. */
export const STEP_TAGS = Object.freeze([
  '\u003c发\u003e',
  '\u003c执行\u003e',
  '\u003c好\u003e',
  '\u003c现在\u003e',
])

/** Longest tag length, used to size the boundary carry. */
const MAX_TAG_LENGTH = STEP_TAGS.reduce((max, tag) => Math.max(max, tag.length), 0)

/**
 * Remove every occurrence of the four step tags from a complete string.
 * Other angle-bracket text (for example `\u003c我现在写\u003e`) is preserved.
 *
 * @param {string} text source text
 * @returns {string} text without the four step tags
 */
export function stripStepTags(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (!text.includes('\u003c')) return text
  let out = ''
  let index = 0
  while (index < text.length) {
    if (text.charCodeAt(index) === 0x3c) {
      let matched = false
      for (const tag of STEP_TAGS) {
        if (text.startsWith(tag, index)) {
          index += tag.length
          matched = true
          break
        }
      }
      if (matched) continue
    }
    out += text[index]
    index += 1
  }
  return out
}

/**
 * Per-(block kind, index) carry state for the streaming filter.
 * Holds back the longest suffix that is still a proper prefix of a step tag, so
 * a tag split across two deltas is removed as one unit instead of leaking a
 * fragment.
 */
class StepTagCarry {
  /** @type {Map<string, string>} */
  pending = new Map()

  /**
   * @param {'text'|'reasoning'} kind delta kind
   * @param {number} index content-block index
   * @param {string} text incoming delta
   * @returns {string} text safe to emit now (may be empty)
   */
  push(kind, index, text) {
    const key = `${kind}#${index}`
    const buffer = (this.pending.get(key) ?? '') + text
    const stripped = stripStepTags(buffer)
    let hold = 0
    const limit = Math.min(MAX_TAG_LENGTH - 1, stripped.length)
    for (let length = limit; length > 0; length -= 1) {
      const suffix = stripped.slice(-length)
      let isPartialTag = false
      for (const tag of STEP_TAGS) {
        if (tag.length > length && tag.startsWith(suffix)) {
          isPartialTag = true
          break
        }
      }
      if (isPartialTag) {
        hold = length
        break
      }
    }
    const emit = hold === 0 ? stripped : stripped.slice(0, -hold)
    this.pending.set(key, hold === 0 ? '' : stripped.slice(-hold))
    return emit
  }

  /**
   * Emit everything still carried for one key.
   *
   * @param {'text'|'reasoning'} kind delta kind
   * @param {number} index content-block index
   * @returns {Array<object>} zero or one synthetic delta chunk
   */
  flush(kind, index) {
    const key = `${kind}#${index}`
    const text = this.pending.get(key) ?? ''
    this.pending.delete(key)
    if (text.length === 0) return []
    return [{ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index, text }]
  }

  /** @returns {Array<object>} one synthetic delta chunk per non-empty carry, in arrival order */
  flushAll() {
    const chunks = []
    for (const key of [...this.pending.keys()]) {
      const separator = key.indexOf('#')
      const kind = key.slice(0, separator)
      const index = Number(key.slice(separator + 1))
      chunks.push(...this.flush(kind, index))
    }
    return chunks
  }
}

/**
 * Wrap an LLM chunk stream, removing the four step tags from text/reasoning
 * deltas and from the terminal `block-end` block text.
 *
 * @param {AsyncIterable<object>} stream adapter chunk stream
 * @returns {AsyncGenerator<object>} sanitized chunk stream
 */
export async function* stripStepTagsFromStream(stream) {
  const iterator = stream[Symbol.asyncIterator]()
  const carry = new StepTagCarry()
  let completed = false
  try {
    while (true) {
      const step = await iterator.next()
      if (step.done === true) {
        completed = true
        for (const pending of carry.flushAll()) yield pending
        return
      }
      const chunk = step.value
      try {
        if (
          chunk !== null &&
          typeof chunk === 'object' &&
          (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') &&
          typeof chunk.text === 'string'
        ) {
          const kind = chunk.type === 'text-delta' ? 'text' : 'reasoning'
          const text = carry.push(kind, chunk.index, chunk.text)
          if (text.length > 0) yield { ...chunk, text }
          continue
        }
        if (chunk !== null && typeof chunk === 'object' && chunk.type === 'block-end') {
          for (const pending of carry.flushAll()) yield pending
          const block = chunk.block
          if (
            block !== null &&
            typeof block === 'object' &&
            (block.type === 'text' || block.type === 'reasoning') &&
            typeof block.text === 'string'
          ) {
            const text = stripStepTags(block.text)
            if (text !== block.text) {
              yield { ...chunk, block: { ...block, text } }
              continue
            }
          }
          yield chunk
          continue
        }
        for (const pending of carry.flushAll()) yield pending
        yield chunk
      } catch {
        // A filter bug must never break the model stream: pass the chunk through.
        yield chunk
      }
    }
  } finally {
    if (!completed) {
      try {
        await iterator.return?.()
      } catch {
        // Cleanup is best-effort; the consumer already abandoned the stream.
      }
    }
  }
}
