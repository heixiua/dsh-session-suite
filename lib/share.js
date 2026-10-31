/**
 * Session sharing: turn a session's durable event log into portable text.
 *
 * The log is the source of truth (a plugin must not invent history), so every
 * renderer here is a pure projection of `SessionEvent[]`:
 *
 *   markdown  — human readable transcript for a chat/issue/paste target
 *   text      — the same transcript without markup, for clipboard use
 *   json      — structured messages, for round-tripping into another tool
 */

const RUNTIME_SOURCES = new Set(['runtime-context', 'system-prompt', 'developer'])

/**
 * @param {object} input render input
 * @param {string} input.sessionId session identity
 * @param {string} [input.title] session title
 * @param {number} [input.exportedAt] timestamp
 * @param {readonly any[]} input.events durable events in sequence order
 * @param {{ reasoning?: boolean, toolDetails?: boolean, toolResults?: boolean }} [input.options] render switches
 * @returns {string} markdown document
 */
export function renderMarkdown({ sessionId, title, exportedAt = Date.now(), events, options = {} }) {
  const lines = []
  lines.push(`# ${title?.trim() || 'Session'}`)
  lines.push('')
  lines.push(`- Session: \`${sessionId}\``)
  lines.push(`- Exported: ${new Date(exportedAt).toISOString()}`)
  const stats = summarize(events)
  lines.push(`- Turns: ${stats.turns} · Messages: ${stats.messages} · Tool calls: ${stats.toolCalls}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const entry of projectMessages(events, options)) {
    if (entry.role === 'user') {
      lines.push('### User')
      lines.push('')
      lines.push(entry.text.trim() || '_(no text)_')
      lines.push('')
      continue
    }
    if (entry.role === 'assistant') {
      lines.push(`### Assistant · turn ${entry.turn ?? '?'} · step ${entry.step ?? '?'}`)
      lines.push('')
      if (options.reasoning && entry.reasoning?.trim()) {
        lines.push('<details><summary>Reasoning</summary>')
        lines.push('')
        lines.push(entry.reasoning.trim())
        lines.push('')
        lines.push('</details>')
        lines.push('')
      }
      for (const part of entry.parts) {
        if (part.kind === 'text') {
          lines.push(part.text.trim())
          lines.push('')
        } else if (part.kind === 'tool-call' && options.toolDetails !== false) {
          lines.push(`> **Tool call** \`${part.name}\``)
          lines.push('')
          lines.push('```json')
          lines.push(prettyJson(part.arguments))
          lines.push('```')
          lines.push('')
          if (options.toolResults !== false && part.result !== undefined) {
            lines.push('```text')
            lines.push(clip(part.result, 4000))
            lines.push('```')
            lines.push('')
          }
        }
      }
      continue
    }
    if (entry.role === 'error') {
      lines.push('> **Turn error**')
      lines.push('')
      lines.push('```text')
      lines.push(clip(entry.text, 2000))
      lines.push('```')
      lines.push('')
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/**
 * @param {object} input render input
 * @param {string} input.sessionId session identity
 * @param {string} [input.title] session title
 * @param {readonly any[]} input.events durable events
 * @param {{ reasoning?: boolean, toolDetails?: boolean, toolResults?: boolean }} [input.options] switches
 * @returns {string} plain-text transcript
 */
export function renderText({ sessionId, title, events, options = {} }) {
  const out = []
  const header = title?.trim() || sessionId
  out.push(header)
  out.push('='.repeat(Math.min(72, Math.max(8, header.length))))
  out.push('')
  for (const entry of projectMessages(events, options)) {
    if (entry.role === 'user') {
      out.push('User:')
      out.push(entry.text.trim())
      out.push('')
    } else if (entry.role === 'assistant') {
      out.push(`Assistant (turn ${entry.turn ?? '?'}, step ${entry.step ?? '?'}):`)
      for (const part of entry.parts) {
        if (part.kind === 'text') out.push(part.text.trim())
        else if (part.kind === 'tool-call' && options.toolDetails !== false) {
          out.push(`  [tool:${part.name}] ${clip(prettyJson(part.arguments), 400)}`)
          if (options.toolResults !== false && part.result !== undefined) out.push(`  [result] ${clip(part.result, 800)}`)
        }
      }
      out.push('')
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/**
 * @param {object} input render input
 * @param {string} input.sessionId session identity
 * @param {string} [input.title] session title
 * @param {readonly any[]} input.events durable events
 * @returns {string} JSON document
 */
export function renderJson({ sessionId, title, events }) {
  const messages = []
  for (const entry of projectMessages(events, { toolDetails: true, toolResults: true })) {
    if (entry.role === 'user') messages.push({ role: 'user', text: entry.text, turn: entry.turn ?? null })
    else if (entry.role === 'assistant') {
      messages.push({
        role: 'assistant',
        turn: entry.turn ?? null,
        step: entry.step ?? null,
        text: entry.parts.filter(part => part.kind === 'text').map(part => part.text).join('\n'),
        reasoning: entry.reasoning ?? null,
        toolCalls: entry.parts
          .filter(part => part.kind === 'tool-call')
          .map(part => ({ name: part.name, arguments: safeParse(part.arguments), result: part.result ?? null })),
      })
    }
  }
  return `${JSON.stringify({ sessionId, title: title ?? null, exportedAt: Date.now(), messages }, null, 2)}\n`
}

/**
 * @param {readonly any[]} events durable events
 * @param {{ reasoning?: boolean, toolDetails?: boolean, toolResults?: boolean }} options switches
 * @returns {any[]} projected entries
 */
export function projectMessages(events, options = {}) {
  const out = []
  /** @type {Map<string, string>} */
  const results = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/result') continue
    const callId = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId
    const text = blocksToText(event.data?.message?.content)
    if (typeof callId === 'string') results.set(callId, text)
  }

  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'user/message') {
      const source = event.data?.source
      const kind = typeof source === 'object' && source ? source.kind : undefined
      if (kind && RUNTIME_SOURCES.has(kind)) continue
      const text = blocksToText(event.data?.content)
      if (!text.trim()) continue
      out.push({ role: 'user', text, turn: event.data?.turn ?? null })
      continue
    }
    if (event.type === 'assistant/message') {
      const message = event.data?.message
      if (!message || !Array.isArray(message.content)) continue
      const parts = []
      let reasoning = ''
      for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push({ kind: 'text', text: block.text })
        else if (block?.type === 'reasoning' && typeof block.text === 'string') reasoning += `${block.text}\n`
        else if (block?.type === 'tool-call') {
          const result = typeof block.id === 'string' ? results.get(block.id) : undefined
          parts.push({ kind: 'tool-call', name: block.name, arguments: block.arguments, result })
        } else if (block?.type === 'image') parts.push({ kind: 'image', name: block.attachment?.name ?? 'image' })
        else if (block?.type === 'file') parts.push({ kind: 'file', name: block.attachment?.name ?? 'file' })
      }
      if (parts.length === 0 && !reasoning) continue
      out.push({ role: 'assistant', turn: event.data?.turn ?? null, step: event.data?.step ?? null, parts, reasoning })
      continue
    }
    if (event.type === 'turn-error') {
      out.push({ role: 'error', text: blocksToText(event.data?.message?.content) || JSON.stringify(event.data ?? {}) })
    }
  }
  return out
}

/**
 * @param {readonly any[]} events durable events
 * @returns {{ turns: number, messages: number, toolCalls: number }} counts
 */
export function summarize(events) {
  let turns = 0
  let messages = 0
  let toolCalls = 0
  for (const event of events) {
    if (event?.type === 'turn/start') turns += 1
    else if (event?.type === 'user/message') messages += 1
    else if (event?.type === 'tool/call') toolCalls += 1
  }
  return { turns, messages, toolCalls }
}

/**
 * @param {any} content message content blocks
 * @returns {string} concatenated text
 */
export function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    else if (block.type === 'image') out.push(`[image: ${block.attachment?.name ?? 'image'}]`)
    else if (block.type === 'file') out.push(`[file: ${block.attachment?.name ?? 'file'}]`)
  }
  return out.join('\n')
}

/** @param {string} text value */
function clip(text, limit) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}\n… (${value.length - limit} more characters)` : value
}

/** @param {string} text JSON text */
function prettyJson(text) {
  const parsed = safeParse(text)
  if (parsed === undefined) return String(text ?? '')
  try {
    return JSON.stringify(parsed, null, 2)
  } catch {
    return String(text ?? '')
  }
}

/** @param {string} text JSON text */
function safeParse(text) {
  if (typeof text !== 'string') return text
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Build a download-friendly filename for an export.
 *
 * @param {string} title session title
 * @param {string} sessionId session identity
 * @param {string} extension file extension
 * @returns {string} safe file name
 */
export function exportFileName(title, sessionId, extension) {
  const base = (title ?? '').trim().replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').slice(0, 60)
  return `${base || sessionId}.${extension}`
}
