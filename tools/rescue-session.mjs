/**
 * Rescue export: render one live session log to standalone files, without going
 * through the Host route.
 *
 * Reads the persisted `.jsonl.zstd`, decodes it, and runs the plugin's own
 * share renderers so the output matches what the Share dialog would produce.
 *
 * Run: node tools/rescue-session.mjs <sessionId>
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { renderBlockDoc, renderHtmlFromDoc, renderMarkdown } from '../lib/share.js'

const unzstd = promisify(zlib.zstdDecompress)
const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const sessionId = process.argv[2] ?? process.env.DSH_SESSION_ID
if (!sessionId) {
  console.error('usage: node tools/rescue-session.mjs <sessionId>')
  process.exit(2)
}

/** Find the session directory anywhere under the sessions root. */
async function findSessionDir(id) {
  const root = path.join(home, 'sessions')
  for (const project of await fs.readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const candidate = path.join(root, project.name, id)
    const stat = await fs.stat(candidate).catch(() => undefined)
    if (stat?.isDirectory()) return candidate
  }
  return undefined
}

const dir = await findSessionDir(sessionId)
if (!dir) {
  console.error(`session ${sessionId} not found under ${path.join(home, 'sessions')}`)
  process.exit(1)
}

const compressed = await fs.readFile(path.join(dir, 'session.v4.jsonl.zstd'))
let text
try {
  text = (await unzstd(compressed)).toString('utf8')
} catch {
  text = compressed.toString('utf8')
}

const events = []
let header
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  if (event.type === 'session' && event.version) {
    header = event
    continue
  }
  events.push(event)
}

// Titles live in their own event; keep the latest one.
let title
for (const event of events) if (event?.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
title = title ?? `session ${sessionId.slice(0, 8)}`

const outDir = path.join(import.meta.dirname, '..', 'docs', 'sessions')
await fs.mkdir(outDir, { recursive: true })
const base = `${title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40)}-${sessionId.slice(-6)}`

const doc = renderBlockDoc({ sessionId, title, events, mode: 'final' })
await fs.writeFile(path.join(outDir, `${base}.html`), renderHtmlFromDoc(doc), 'utf8')
await fs.writeFile(
  path.join(outDir, `${base}.md`),
  renderMarkdown({ sessionId, title, events, options: { toolDetails: false, toolResults: false } }),
  'utf8',
)

console.log(
  JSON.stringify(
    {
      ok: true,
      sessionId,
      title,
      events: events.length,
      messages: doc.messages.length,
      cwd: header?.cwd,
      files: [`docs/sessions/${base}.html`, `docs/sessions/${base}.md`],
    },
    null,
    2,
  ),
)
