/**
 * Remove one workspace completely: its registry entry, its session logs, and the
 * suite's snapshots and memory for those sessions.
 *
 * Sessions are removed through the plugin's own deleteSession, so the archive
 * set, the projection cache, and the snapshot store are all handled the same way
 * the UI does it. The workspace row is then dropped from the registry.
 *
 * Run: node tools/remove-workspace.mjs --path "D:\AI sandbox\dsh-sandbox\DSH Optimize 2"
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CheckpointStore } from '../lib/checkpoints.js'
import { MemoryLedger } from '../lib/memory.js'
import { SessionSuiteService } from '../lib/service.js'

const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const args = process.argv.slice(2)
const index = args.indexOf('--path')
if (index < 0) {
  console.error('usage: node tools/remove-workspace.mjs --path <workspace path>')
  process.exit(2)
}
const targetPath = args[index + 1]

const registryFile = path.join(home, 'storages', 'workspace.json')
const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'))
const rows = registry.tables?.workspaces ?? {}
const matches = Object.entries(rows).filter(([, row]) => path.resolve(row.path) === path.resolve(targetPath))
if (matches.length === 0) {
  console.log(JSON.stringify({ ok: true, note: 'no workspace with that path', path: targetPath }))
  process.exit(0)
}

const sessions = []
for (const [, row] of matches) for (const id of row.sessionIds ?? []) sessions.push(id)
// Sessions that belong to this workspace but were never listed (archived ones).
const projectDir = path.join(home, 'sessions', encodeProject(targetPath))
for (const entry of await fs.readdir(projectDir, { withFileTypes: true }).catch(() => [])) {
  if (entry.isDirectory() && !sessions.includes(entry.name)) sessions.push(entry.name)
}

const data = path.join(home, 'storages', 'dsh-session-suite')
const service = new SessionSuiteService({
  ctx: {
    get: name =>
      name === 'sessionController'
        ? {
            list: async () => ({ items: sessions.map(sessionId => ({ sessionId, running: false })) }),
            inspect: async () => {
              throw new Error('inspection is not needed to delete')
            },
          }
        : undefined,
  },
  root: data,
  store: new CheckpointStore({ root: data, log: () => {} }),
  memory: new MemoryLedger({ root: data }),
  log: () => {},
  config: {},
})

const removed = []
for (const sessionId of sessions) {
  try {
    const result = await service.deleteSession(sessionId)
    removed.push({ sessionId, ok: true, files: result.sessionFiles.length })
  } catch (error) {
    removed.push({ sessionId, ok: false, error: error.message })
  }
}

// Drop the workspace rows and its ids from the registry.
for (const [id] of matches) delete rows[id]
const global = registry.global ?? {}
global.workspaceIds = (global.workspaceIds ?? []).filter(id => !matches.some(([gone]) => gone === id))
global.archivedSessionIds = (global.archivedSessionIds ?? []).filter(id => !sessions.includes(id))
await fs.writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')

// The directory itself is the user's data, not DSH state: only report it.
const directoryExists = await fs.stat(targetPath).then(() => true).catch(() => false)

console.log(
  JSON.stringify(
    {
      ok: true,
      path: targetPath,
      sessions: removed,
      workspaceIds: matches.map(([id]) => id),
      directoryExists,
    },
    null,
    2,
  ),
)

/** Mirror of the persistence backend's directory naming for one cwd. */
function encodeProject(cwd) {
  const key = path
    .resolve(cwd)
    .replace(/[\\/:]/g, '-')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 251)
  return `--${key}--`
}
