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

import { blocksToHtml, escapeHtml, parseMarkdown, previewText } from './markdown.js'
import { stripStepTags } from './step-tag-filter.js'

const RUNTIME_SOURCES = new Set(['runtime-context', 'system-prompt', 'developer'])

/**
 * Collapse a log to the two things a reader wants: the prompts and the closing
 * reply of each turn. Tool traffic, request headers, and the narration a model
 * emits between tool calls never reach an export in `final` mode.
 *
 * @param {readonly any[]} events durable events
 * @returns {any[]} curated events, in log order
 */
export function curateEvents(events) {
  const out = []
  let lastAssistant = -1
  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'assistant/message') {
      const previous = lastAssistant >= 0 ? out[lastAssistant] : undefined
      const sameTurn = previous && previous.data?.turn === event.data?.turn
      if (sameTurn) out[lastAssistant] = event
      else {
        out.push(event)
        lastAssistant = out.length - 1
      }
      continue
    }
    if (event.type === 'user/message') {
      out.push(event)
      lastAssistant = -1
      continue
    }
    if (event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'assistant/attempt') continue
    out.push(event)
  }
  return out
}

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
      // Only what the person actually typed is conversation. Everything else in
      // a user-role event is harness plumbing: runtime context, the skill
      // catalog, time samples, subagent relays, and settlement notices.
      if (kind !== undefined && kind !== 'user') continue
      const content = Array.isArray(event.data?.content) ? event.data.content : []
      const text = content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
      const images = content
        .filter(block => block?.type === 'image' && block.attachment)
        .map(block => ({
          attachmentId: block.attachment.attachmentId,
          mediaType: block.attachment.mediaType,
          width: block.attachment.width,
          height: block.attachment.height,
          name: block.attachment.name,
        }))
      if (!text.trim() && images.length === 0) continue
      out.push({ role: 'user', text, images, turn: event.data?.turn ?? null })
      continue
    }
    if (event.type === 'assistant/message') {
      const message = event.data?.message
      if (!message || !Array.isArray(message.content)) continue
      const parts = []
      let reasoning = ''
      for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push({ kind: 'text', text: stripStepTags(block.text) })
        else if (block?.type === 'reasoning' && typeof block.text === 'string') reasoning += `${stripStepTags(block.text)}\n`
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
  if (typeof content === 'string') return stripStepTags(content)
  if (!Array.isArray(content)) return ''
  const out = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    else if (block.type === 'image') out.push('［图片］')
    else if (block.type === 'file') out.push(`［文件：${block.attachment?.name ?? 'file'}］`)
  }
  return stripStepTags(out.join('\n'))
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
      if (kind !== undefined && kind !== 'user') continue
      const content = Array.isArray(event.data?.content) ? event.data.content : []
      const text = content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
        .trim()
      const imageCount = content.filter(block => block?.type === 'image').length
      if (!text && imageCount === 0) continue
      entry.userText = entry.userText || text || `［${imageCount} 张图片］`
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
      preview: previewText(entry.userText || entry.assistantText, 110),
      answerPreview: previewText(entry.assistantText, 110),
    }))
}

/**
 * Build the structured document both exports consume: one entry per message,
 * with Markdown already parsed into blocks and inline runs.
 *
 * @param {object} input document input
 * @param {string} input.sessionId session identity
 * @param {string} [input.title] session title
 * @param {readonly any[]} input.events durable events
 * @param {number} [input.exportedAt] timestamp
 * @param {'final' | 'all'} [input.mode] curation: last reply per turn, or every step
 * @returns {any} document
 */
export function renderBlockDoc({ sessionId, title, events, exportedAt = Date.now(), mode = 'final' }) {
  const entries = projectMessages(events, { toolDetails: false, toolResults: false })
  const raw = []
  for (const entry of entries) {
    if (entry.role === 'user') {
      const text = entry.text.trim()
      const images = entry.images ?? []
      if (!text && images.length === 0) continue
      raw.push({ role: 'user', turn: entry.turn ?? null, blocks: text ? parseMarkdown(text) : [], images })
      continue
    }
    if (entry.role === 'assistant') {
      const text = entry.parts
        .filter(part => part.kind === 'text')
        .map(part => part.text)
        .join('\n\n')
        .trim()
      // A step made only of tool calls has no prose: it would render as an
      // empty "Assistant" label, which is exactly the noise this export avoids.
      if (!text) continue
      raw.push({ role: 'assistant', turn: entry.turn ?? null, blocks: parseMarkdown(text), images: [] })
    }
  }
  // Curation: a turn is a question and its answer. With `final`, a run of
  // assistant steps collapses to the last one — the reply — instead of shipping
  // every "let me check…" narration that happened between tool calls.
  const selected = mode === 'all' ? raw : keepFinalReplies(raw)
  // One card per reply: consecutive assistant steps of the same turn merge,
  // so a multi-step answer reads as one block instead of three fragments.
  const messages = []
  for (const entry of selected) {
    const last = messages[messages.length - 1]
    if (entry.role === 'assistant' && last?.role === 'assistant' && last.turn === entry.turn) {
      last.blocks.push(...entry.blocks)
      last.parts = (last.parts ?? 1) + 1
      continue
    }
    messages.push({ role: entry.role, turn: entry.turn, blocks: [...entry.blocks], images: entry.images ?? [], parts: 1 })
  }
  return { sessionId, title: title ?? null, exportedAt, mode, messages, count: selected.length }
}

/**
 * @param {any[]} raw projected messages
 * @returns {any[]} only the last assistant message between two user messages
 */
function keepFinalReplies(raw) {
  const out = []
  let pending
  for (const entry of raw) {
    if (entry.role === 'user') {
      if (pending) out.push(pending)
      pending = undefined
      out.push(entry)
      continue
    }
    pending = entry
  }
  if (pending) out.push(pending)
  return out
}

/**
 * One self-contained HTML page: no external CSS, fonts, or scripts, so the file
 * can be opened, mailed, or printed to PDF anywhere. Markdown is rendered, not
 * echoed, so headings, lists, quotes and code keep their shape.
 *
 * @param {object} input render input
 * @param {string} input.sessionId session identity
 * @param {string} [input.title] session title
 * @param {readonly any[]} input.events durable events
 * @param {number} [input.exportedAt] timestamp
 * @param {'final' | 'all'} [input.mode] curation mode
 * @returns {string} HTML document
 */
export function renderHtml({ sessionId, title, events, exportedAt = Date.now(), mode = 'final' }) {
  return renderHtmlFromDoc(renderBlockDoc({ sessionId, title, events, exportedAt, mode }))
}

/**
 * Render an already-built document (the Host resolves image attachments to data
 * URLs before this runs, so the page stays a single file).
 *
 * @param {any} doc block document
 * @returns {string} HTML document
 */
export function renderHtmlFromDoc(doc) {
  const heading = escapeHtml(doc.title?.trim() || 'Session')
  const turns = new Set(doc.messages.map(message => message.turn).filter(turn => typeof turn === 'number'))
  const shots = images =>
    (images ?? []).length === 0
      ? ''
      : `<div class="shots">${images
          .map(
            image =>
              `<button type="button" class="shot-btn" aria-label="Open ${escapeHtml(image.name ?? 'screenshot')} full size"><img class="shot" src="${escapeHtml(image.dataUrl ?? '')}" alt="${escapeHtml(image.name ?? 'screenshot')}" loading="lazy"></button>`,
          )
          .join('')}</div>`
  const body = doc.messages.map(message => {
    const content = blocksToHtml(message.blocks)
    if (message.role === 'user') {
      return `<div class="row user"><div class="stack">${shots(message.images)}<div class="bubble">${content}</div></div></div>`
    }
    return `<div class="row assistant"><div class="who">Assistant${typeof message.turn === 'number' ? ` · turn ${message.turn}` : ''}</div><div class="md">${content}${shots(message.images)}</div></div>`
  })
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>
:root {
  color-scheme: light dark;
  --page:#f4f5f7; --card:#ffffff; --fg:#1b1d21; --muted:#8a8f98; --line:#eceef1;
  --bubble:#2563eb; --bubble-fg:#ffffff; --chip:#eef1f5; --code:#f6f7f9; --quote:#f7f8fa;
  --link:#2563eb; --accent:#2563eb;
}
@media (prefers-color-scheme: dark) {
  :root { --page:#0f1113; --card:#17191c; --fg:#e8eaed; --muted:#9aa0a6; --line:#26292d; --bubble:#3b6fe0; --bubble-fg:#ffffff; --chip:#22262b; --code:#1b1e22; --quote:#1c1f23; --link:#7aa2ff; --accent:#7aa2ff; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--page); color:var(--fg); font:15px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", Roboto, "Helvetica Neue", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 20px 64px; }
header { padding: 0 6px 20px; }
h1 { font-size: 27px; line-height:1.35; margin:0 0 8px; letter-spacing:-.01em; }
.meta { color: var(--muted); font-size: 12.5px; display:flex; gap:14px; flex-wrap:wrap; }
.row { margin: 0 0 22px; }
.row.user { display:flex; justify-content:flex-end; }
.row.user .stack { display:flex; flex-direction:column; align-items:flex-end; gap:8px; max-width: 88%; }
.row.user .bubble {
  max-width: 100%; background: var(--bubble); color: var(--bubble-fg);
  border-radius: 14px; padding: 10px 15px; box-shadow: 0 1px 2px rgba(16,18,20,.06);
}
.shots { display: flex; flex-direction: column; gap: 8px; margin: 10px 0 0; }
.shot { display:block; max-width: 100%; height: auto; border-radius: 12px; border: 1px solid var(--line); }
.row.user .bubble p { margin: 0 0 6px; }
.row.user .bubble p:last-child { margin-bottom: 0; }
.row.user .bubble a { color:#dce8ff; }
.who { color: var(--muted); font-size: 12px; margin: 0 0 8px 2px; }
.md { background: var(--card); border-radius: 14px; padding: 14px 18px; box-shadow: 0 1px 2px rgba(16,18,20,.05); }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 10px; }
.md h2, .md h3, .md h4, .md h5, .md h6 { margin: 18px 0 8px; line-height: 1.4; }
.md h2 { font-size: 19px; }
.md h3 { font-size: 17px; }
.md h4, .md h5, .md h6 { font-size: 15px; }
.md ul, .md ol { margin: 0 0 10px; padding-left: 22px; }
.md li { margin: 3px 0; }
.md li.depth-1 { margin-left: 18px; }
.md li.depth-2 { margin-left: 36px; }
.md li.depth-3 { margin-left: 54px; }
.md blockquote {
  margin: 12px 0; padding: 10px 14px; border-left: 3px solid var(--accent);
  background: var(--quote); border-radius: 0 10px 10px 0; color: var(--fg);
}
.md blockquote p { margin: 0 0 6px; }
.md blockquote p:last-child { margin-bottom: 0; }
.md pre {
  margin: 12px 0; padding: 12px 14px; background: var(--code); border-radius: 10px;
  overflow-x: auto; font: 13px/1.6 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
}
.md code { background: var(--chip); border-radius: 4px; padding: 1px 5px; font: 13px ui-monospace, Consolas, monospace; }
.md pre code { background: transparent; padding: 0; }
.md a { color: var(--link); }
.md hr { border:0; border-top:1px solid var(--line); margin: 18px 0; }
.md .table-wrap { margin: 12px 0; overflow-x: auto; }
.md table { border-collapse: collapse; width: 100%; font-size: 14px; }
.md th, .md td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
.md th { background: var(--quote); font-weight: 600; }
.md strong { font-weight: 650; }
footer { margin-top: 36px; color: var(--muted); font-size: 12px; text-align:center; }
.shot-btn {
  display: block; padding: 0; border: 0; background: transparent; cursor: zoom-in;
  border-radius: 12px; overflow: hidden; max-width: 100%;
}
.shot-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
dialog.viewer {
  border: 0; padding: 0; max-width: 96vw; max-height: 96vh; background: transparent;
  overflow: visible;
}
dialog.viewer::backdrop { background: rgba(10, 12, 14, .82); }
dialog.viewer img {
  display: block; max-width: 96vw; max-height: 92vh; margin: 0 auto;
  border-radius: 8px; background: #fff; cursor: zoom-out;
}
dialog.viewer .hint {
  position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
  color: #e8eaed; font-size: 12px; opacity: .8;
}
@media print { .shot-btn { cursor: auto; } dialog.viewer { display: none; } body { background:#fff; } main { padding: 0; max-width:none; } .row, .md { break-inside: avoid; } .md { box-shadow:none; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>${heading}</h1>
    <div class="meta">
      <span>${turns.size} 轮 · ${doc.count} 条消息</span>
      <span>导出于 ${new Date(doc.exportedAt ?? Date.now()).toISOString().slice(0, 16).replace('T', ' ')}</span>
      <span>${escapeHtml(doc.sessionId ?? '')}</span>
    </div>
  </header>
  ${body.join('\n')}
  <footer>Exported from DeepSeek Harness · dsh-session-suite</footer>
</main>
<dialog class="viewer" id="shot-viewer"><img alt=""><div class="hint">点击图片或按 Esc 关闭</div></dialog>
<script>
(() => {
  const viewer = document.getElementById('shot-viewer')
  const full = viewer.querySelector('img')
  for (const button of document.querySelectorAll('.shot-btn')) {
    button.addEventListener('click', () => {
      const source = button.querySelector('img')
      if (!source) return
      full.src = source.src
      viewer.showModal()
    })
  }
  viewer.addEventListener('click', () => viewer.close())
})()
</script>
</body>
</html>
`
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
