/**
 * Integration test for the session operations (rollback, undo, delete, share).
 *
 * The Host services are replaced by small fakes with the same public shape
 * (`sessionController.list/inspect/fork`, `workspaceController.archiveSession/
 * unarchiveSession`), so the orchestration 鈥?fork boundary, snapshot restore,
 * memory trim, undo bundle, on-disk deletion 鈥?runs for real against a
 * throwaway DSH home and workspace.
 *
 * Run with: node tools/selftest-rollback.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CheckpointStore } from '../lib/checkpoints.js'
import { MemoryLedger } from '../lib/memory.js'
import { SessionSuiteService } from '../lib/service.js'
import { renderMarkdown, renderText, renderJson } from '../lib/share.js'
import { blocksToHtml, inlineRuns, parseMarkdown } from '../lib/markdown.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-rollback-'))
const home = path.join(root, 'home')
const data = path.join(root, 'data')
const workspace = path.join(root, 'workspace')
process.env.DSH_HOME = home


const exists = async target => {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}
const sessionId = 'session-1111-2222'
const sessionDir = path.join(home, 'sessions', '--tmp--', sessionId)
await fs.mkdir(sessionDir, { recursive: true })
await fs.writeFile(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'log')
await fs.mkdir(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
await fs.writeFile(path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), '{}')
await fs.mkdir(workspace, { recursive: true })
await fs.writeFile(path.join(workspace, 'a.txt'), 'v1\n')

// A log whose shapes match a real DSH session log, including the harness
// plumbing that must never reach an export.
const pngPath = path.join(root, 'shot.png')
await fs.writeFile(
  pngPath,
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
)
const events = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 2,
    data: {
      id: 'msg-user-1',
      role: 'user',
      content: [
        { type: 'text', text: 'first question with **bold**' },
        { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', width: 1, height: 1, name: 'shot.png' } },
      ],
      source: { kind: 'user' },
    },
  },
  { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { id: 'msg-narration', role: 'assistant', content: [{ type: 'text', text: 'let me check the files first' }] } } },
  { type: 'assistant/message', seq: 4, data: { turn: 1, step: 2, message: { id: 'msg-assistant-1', role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } } },
  { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 6, data: { turn: 2 } },
  { type: 'user/message', seq: 7, data: { id: 'msg-user-2', role: 'user', content: [{ type: 'text', text: 'second question' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 8, data: { turn: 2, step: 1, message: { id: 'msg-assistant-2', role: 'assistant', content: [{ type: 'text', text: 'second answer' }] } } },
  { type: 'session/title', seq: 9, data: { title: 'Demo conversation' } },
  { type: 'turn/end', seq: 10, data: { turn: 2, reason: { kind: 'completed' } } },
  {
    type: 'user/message',
    seq: 11,
    data: {
      id: 'msg-time',
      role: 'user',
      content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-10-31T21:43:02' }],
      source: { kind: 'time-context', form: 'snapshot' },
    },
  },
  { type: 'user/message', seq: 12, data: { id: 'msg-runtime', role: 'user', content: [{ type: 'text', text: 'runtime context' }], source: { kind: 'runtime-context' } } },
  {
    type: 'user/message',
    seq: 13,
    data: {
      id: 'msg-settled',
      role: 'user',
      content: [{ type: 'text', text: 'Background subagent finished' }],
      source: { kind: 'subagent-settled', form: 'notice' },
    },
  },
]

const forked = []
const archived = []
const unarchived = []
const fakeCtx = {
  get(name) {
    if (name === 'sessionController') {
      return {
        list: async () => ({ items: [{ sessionId, running: false, updatedAt: Date.now(), cwd: workspace }] }),
        inspect: async () => ({ meta: { id: sessionId, cwd: workspace }, inheritedEventCount: 0, events }),
        fork: async ({ sessionId: source, atSeq }) => {
          forked.push({ source, atSeq })
          return { sessionId: 'session-child-3333' }
        },
      }
    }
    if (name === 'workspaceController') {
      return {
        archiveSession: async (id, options) => {
          archived.push({ id, options })
        },
        unarchiveSession: async id => {
          unarchived.push(id)
        },
      }
    }
    if (name === 'attachments') {
      return { imageHostPath: () => pngPath }
    }
    return undefined
  },
}

const logs = []
const store = new CheckpointStore({ root: data, log: message => logs.push(message) })
const memory = new MemoryLedger({ root: data })
const service = new SessionSuiteService({ ctx: fakeCtx, root: data, store, memory, log: message => logs.push(message), config: { keep: 10 } })

// A checkpoint representing turn 1, then the workspace moves on to turn 2.
await store.capture({ sessionId, cwd: workspace, seq: 1, turn: 1, kind: 'auto', label: 'before turn 1' })
await fs.writeFile(path.join(workspace, 'a.txt'), 'v2\n')
await fs.writeFile(path.join(workspace, 'b.txt'), 'created in turn 2\n')
await store.capture({ sessionId, cwd: workspace, seq: 5, turn: 2, kind: 'auto', label: 'before turn 2' })

await memory.add(sessionId, { text: 'kept fact', seq: 2 })
await memory.add(sessionId, { text: 'later fact', seq: 7 })

// --- rollback to the first assistant message (turn 1) -----------------------
const result = await service.rollback({ sessionId, messageId: 'msg-assistant-1' })
assert.equal(forked.length, 1)
assert.equal(forked[0].atSeq, 4, 'fork must be inclusive of the target message')
assert.equal(result.childId, 'session-child-3333')
assert.equal(result.turn, 1)
assert.equal(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'v1\n', 'files return to the turn-1 snapshot')
assert.equal(await exists(path.join(workspace, 'b.txt')), false, 'files created later are removed')
assert.deepEqual((await memory.list(sessionId)).map(entry => entry.text), ['kept fact'], 'memory after the rewind point is dropped')
assert.deepEqual(archived.map(entry => entry.id), [sessionId], 'the source session is retired from the sidebar')
assert.ok(result.undoId.startsWith('undo_'))

// --- undo brings all three back --------------------------------------------
const undone = await service.undo(result.undoId)
assert.equal(undone.sessionId, sessionId)
assert.equal(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'v2\n', 'undo restores the pre-rollback files')
assert.deepEqual((await memory.list(sessionId)).map(entry => entry.text), ['kept fact', 'later fact'], 'undo restores memory')
assert.deepEqual(unarchived, [sessionId], 'undo brings the session back')
assert.equal((await service.listUndos(sessionId)).length, 0, 'a consumed undo bundle is not offered again')

// --- deleting one message only trims the conversation, never the files ------
await fs.writeFile(path.join(workspace, 'a.txt'), 'v3 after turn 2\n')
const deleted = await service.deleteMessage({ sessionId, messageId: 'msg-assistant-1' })
assert.equal(deleted.deletedSession, false)
assert.equal(deleted.filesUntouched, true)
assert.equal(forked.at(-1).atSeq, 2, 'deleting an assistant reply cuts at its user message')
assert.equal(
  await fs.readFile(path.join(workspace, 'a.txt'), 'utf8'),
  'v3 after turn 2\n',
  'deleting conversation must not restore workspace files',
)
assert.equal(deleted.memory.copied, 1, 'surviving memory follows the trimmed conversation')

// --- deleting a selected segment cuts at the turn before it -----------------
const segment = await service.deleteSegment({ sessionId, startSeq: 6 })
assert.equal(forked.at(-1).atSeq, 4, 'a segment delete keeps everything before its first turn')
assert.equal(segment.filesUntouched, true)

// --- outline lists turns with previews for the share/delete dialogs ---------
const outline = await service.outline(sessionId)
assert.equal(outline.turns.length, 2)
assert.equal(outline.turns[0].preview, 'first question with bold')
assert.equal(outline.turns[1].answerPreview, 'second answer')
assert.ok(outline.turns[0].startSeq < outline.turns[0].endSeq)

// --- share renders the durable log, skipping harness plumbing --------------
const markdown = renderMarkdown({ sessionId, title: 'Demo conversation', events })
assert.ok(markdown.includes('# Demo conversation'))
assert.ok(markdown.includes('first question') && markdown.includes('second answer'))
assert.ok(markdown.includes('### User') && markdown.includes('### Assistant'))
assert.equal(markdown.includes('runtime context'), false, 'injected runtime context stays out of a share')
assert.equal(markdown.includes('Time sampled'), false, 'a time-context event is not something the user said')
assert.equal(markdown.includes('Background subagent'), false, 'settlement notices stay out of the export')
assert.ok(renderText({ sessionId, events }).includes('Assistant (turn 2, step 1):'))

// Curation: the default export keeps one reply per turn and drops narration.
const curated = JSON.parse((await service.share({ sessionId, format: 'json' })).body)
assert.equal(curated.messages.length, 4, 'default mode exports prompt + closing reply only')
assert.equal(JSON.stringify(curated).includes('let me check the files first'), false, 'narration is not part of the export')
const everything = JSON.parse((await service.share({ sessionId, format: 'json', mode: 'all' })).body)
assert.equal(everything.messages.length, 5, 'mode=all keeps every assistant step')

// --- a selected range exports only those turns ------------------------------
const onlyTurnTwo = await service.share({ sessionId, format: 'md', ranges: [outline.turns[1]] })
assert.ok(onlyTurnTwo.body.includes('second question'))
assert.equal(onlyTurnTwo.body.includes('first question'), false, 'unselected turns stay out of the export')

const html = await service.share({ sessionId, format: 'html' })
assert.ok(html.body.startsWith('<!doctype html>'))
assert.ok(html.body.includes('first question') && html.body.includes('second answer'))
assert.ok(html.body.includes('<style>'), 'the HTML export is self-contained')
assert.equal(html.body.includes('<script'), false, 'no scripts travel with a shared page')

// --- Markdown survives the trip into HTML and into the image blocks --------
const md = parseMarkdown('# Heading\n\nHello **bold** and `code`.\n\n- one\n- two\n\n> quoted\n\n```js\nconst a = 1\n```')
assert.deepEqual(md.map(block => block.type), ['heading', 'paragraph', 'list', 'quote', 'code'])
const rendered = blocksToHtml(md)
assert.ok(rendered.includes('<h2>Heading</h2>'), 'a heading keeps its level (offset below the page h1)')
assert.ok(rendered.includes('<strong>bold</strong>') && rendered.includes('<code>code</code>'))
assert.ok(rendered.includes('<ul>') && rendered.includes('<li'))
assert.ok(rendered.includes('<blockquote>') && rendered.includes('<pre><code>const a = 1</code></pre>'))
assert.deepEqual(inlineRuns('a **b** c'), [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' c' }])

const blocks = await service.share({ sessionId, format: 'blocks' })
const blockDoc = JSON.parse(blocks.body)
assert.equal(blockDoc.messages.length, 4, 'one entry per real message, assistant steps without prose dropped')
assert.equal(blockDoc.messages[0].role, 'user')
assert.ok(Array.isArray(blockDoc.messages[0].blocks[0].runs), 'inline runs are pre-parsed for the canvas renderer')

// --- screenshots travel with the export as inline data URLs ----------------
assert.ok(html.body.includes('data:image/png;base64,'), 'the shared page embeds the screenshot')
assert.ok(blockDoc.messages[0].images[0].dataUrl.startsWith('data:image/png;base64,'), 'the canvas renderer gets the image too')
assert.equal(html.body.includes('［图片］'), false, 'no attachment placeholder survives once the image is inlined')

// --- permanent deletion removes the log, the cache, and the snapshots ------
const removed = await service.deleteSession(sessionId)
assert.equal(await exists(sessionDir), false, 'the session directory is gone')
assert.equal(await exists(path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)), false)
assert.equal(removed.checkpoints, true)
assert.deepEqual(await store.list(sessionId), [])
assert.deepEqual(await memory.list(sessionId), [])

await fs.rm(root, { recursive: true, force: true })
console.log(JSON.stringify({ ok: true, forks: forked.length, logs: logs.length }, null, 2))
