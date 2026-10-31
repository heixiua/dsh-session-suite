/**
 * Session sharing: turn a session's durable event log into portable text.
 *
 * The log is the source of truth (a plugin must not invent history), so every
 * renderer here is a pure projection of `SessionEvent[]`:
 *
 *   markdown  — human readable transcript for a chat/issue/paste target
 *   text      — the same transcript without markup, for clipboard use
 *   json      — structured messages, for round-tripping into another tool
 *   html      — one self-contained, printable page (the portable "share" artifact)
 */

const RUNTIME_SOURCES = new Set(['runtime-context', 'system-prompt', 'developer'])

/**
 * Keep the events that fall inside the selected turn ranges.
 *
 * @param {readonly any[]} events durable events
 * @param {readonly { startSeq: number, endSeq: number }[]} [ranges] selected ranges; omitted keeps everything
 * @returns {any[]} filtered events
 */
export function selectEvents(events, ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return [...events]
  return events.filter(event => {
    const seq = event?.seq
    if (typeof seq !== 'number') return false
    return ranges.some(range => seq >= range.startSeq && seq <= range.endSeq)
  })
}

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

/**
 * Turn-level outline used by the share and segment dialogs: one row per turn
 * with the user prompt, the assistant answer, and the durable sequence range.
 *
 * @param {readonly any[]} events durable events
 * @returns {any[]} turns in log order
 */
export function buildOutline(events) {
  /** @type {Map<number, any>} */
  const turns = new Map()
  const entryFor = turn => {
    if (!turns.has(turn)) {
      turns.set(turn, { turn, startSeq: Number.POSITIVE_INFINITY, endSeq: 0, userText: '', assistantText: '', time: 0, messageCount: 0 })
    }
    return turns.get(turn)
  }
  let currentTurn
  for (const event of events) {
    if (event?.type === 'turn/start' && typeof event.data?.turn === 'number') currentTurn = event.data.turn
    // `user/message` events carry no turn of their own; they belong to the turn
    // opened before them, which is what the dialog lists.
    const turn = typeof event?.data?.turn === 'number' ? event.data.turn : currentTurn
    if (turn === undefined || typeof event.seq !== 'number') continue
    const entry = entryFor(turn)
    entry.startSeq = Math.min(entry.startSeq, event.seq)
    entry.endSeq = Math.max(entry.endSeq, event.seq)
    entry.time = entry.time || (typeof event.time === 'number' ? event.time : 0)
    if (event.type === 'user/message') {
      const kind = typeof event.data?.source === 'object' && event.data.source ? event.data.source.kind : undefined
      if (kind && RUNTIME_SOURCES.has(kind)) continue
      const text = blocksToText(event.data?.content).trim()
      if (!text) continue
      entry.userText = entry.userText || text
      entry.messageCount += 1
    } else if (event.type === 'assistant/message') {
      const text = blocksToText(event.data?.message?.content).trim()
      if (!text) continue
      entry.assistantText = entry.assistantText || text
      entry.messageCount += 1
    }
  }
  return [...turns.values()]
    .filter(entry => entry.messageCount > 0)
    .map(entry => ({
      turn: entry.turn,
      startSeq: entry.startSeq,
      endSeq: entry.endSeq,
      time: entry.time,
      preview: clip(entry.userText || entry.assistantText, 160).replace(/\s+/g, ' '),
      answerPreview: clip(entry.assistantText, 160).replace(/\s+/g, ' '),
    }))
}

/**
 * One self-contained HTML page: no external CSS, fonts, or scripts, so the file
 * can be opened, mailed, or printed to PDF anywhere.
 *
 * @param {object} input render input
 * @param {string} input.sessionId session identity
 * @param {string} [input.title] session title
 * @param {readonly any[]} input.events durable events
 * @param {number} [input.exportedAt] timestamp
 * @param {{ reasoning?: boolean }} [input.options] switches
 * @returns {string} HTML document
 */
export function renderHtml({ sessionId, title, events, exportedAt = Date.now(), options = {} }) {
  const heading = escapeHtml(title?.trim() || 'Session')
  const entries = projectMessages(events, { toolDetails: false, toolResults: false, reasoning: options.reasoning })
  const stats = summarize(events)
  const body = []
  for (const entry of entries) {
    if (entry.role === 'user') {
      body.push(`<div class="row user"><div class="bubble"><div class="text">${paragraphs(entry.text)}</div></div></div>`)
    } else if (entry.role === 'assistant') {
      const text = entry.parts.filter(part => part.kind === 'text').map(part => part.text).join('\n')
      if (!text.trim()) continue
      body.push(
        `<div class="row assistant"><div class="who">Assistant · turn ${entry.turn ?? '?'}</div><div class="text">${paragraphs(text)}</div></div>`,
      )
    }
  }
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>
:root { color-scheme: light dark; --bg:#ffffff; --fg:#1b1d21; --muted:#6b7280; --line:#e5e7eb; --bubble:#f3f4f6; --accent:#2563eb; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#111315; --fg:#e8eaed; --muted:#9aa0a6; --line:#2a2d31; --bubble:#1c1f23; --accent:#7aa2ff; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", Roboto, sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 48px 24px 72px; }
header { border-bottom:1px solid var(--line); padding-bottom:16px; margin-bottom:28px; }
h1 { font-size: 22px; line-height:1.35; margin:0 0 6px; }
.meta { color: var(--muted); font-size: 12.5px; }
.row { margin: 0 0 18px; }
.row.user { display:flex; justify-content:flex-end; }
.row.user .bubble { max-width: 86%; background: var(--bubble); border-radius: 12px; padding: 10px 14px; }
.who { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.text p { margin: 0 0 8px; }
.text p:last-child { margin-bottom: 0; }
code { background: var(--bubble); border-radius: 4px; padding: 1px 4px; font-size: 13px; }
footer { margin-top: 40px; border-top:1px solid var(--line); padding-top:14px; color: var(--muted); font-size: 12px; }
@media print { main { padding: 0; } .row { break-inside: avoid; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>${heading}</h1>
    <div class="meta">${stats.turns} turns · ${entries.length} messages · exported ${new Date(exportedAt).toISOString().slice(0, 19).replace('T', ' ')} · ${escapeHtml(sessionId)}</div>
  </header>
  ${body.join('\n')}
  <footer>Exported from DeepSeek Harness · dsh-session-suite</footer>
</main>
</body>
</html>
`
}

/** @param {string} text value @returns {string} HTML */
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

/** @param {string} text value @returns {string} escaped paragraphs */
function paragraphs(text) {
  return escapeHtml(String(text ?? '').trim())
    .split(/\n{2,}/)
    .map(part => `<p>${part.replace(/\n/g, '<br>')}</p>`)
    .join('')
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
