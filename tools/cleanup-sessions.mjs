/**
 * Pre-clean the leftover conversations the user asked to remove.
 *
 * It backs every affected session directory up first (a ZIP-free copy under the
 * OS temp directory), then deletes through the plugin's own
 * `SessionSuiteService.deleteSession`, so the cleanup also exercises the shipped
 * deletion path instead of hand-rolled `rm` calls.
 *
 * Run with: node tools/cleanup-sessions.mjs --project test-01 --project text-01
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CheckpointStore } from '../lib/checkpoints.js'
import { MemoryLedger } from '../lib/memory.js'
import { SessionSuiteService } from '../lib/service.js'

const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const args = process.argv.slice(2)
const projects = []
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--project') projects.push(args[index + 1])
}
if (projects.length === 0) {
  console.error('usage: node tools/cleanup-sessions.mjs --project <name> [--project <name>]')
  process.exit(2)
}

const sessionsRoot = path.join(home, 'sessions')
const targets = []
for (const entry of await fs.readdir(sessionsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const decoded = entry.name.replace(/^--|--$/g, '')
  const match = projects.find(name => decoded.endsWith(name.replace(/[\\/:]+/g, '-')))
  if (!match) continue
  for (const session of await fs.readdir(path.join(sessionsRoot, entry.name), { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    targets.push({ project: entry.name, id: session.name, dir: path.join(sessionsRoot, entry.name, session.name) })
  }
}

if (targets.length === 0) {
  console.log(JSON.stringify({ ok: true, deleted: 0, note: 'nothing matched' }))
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = path.join(os.tmpdir(), `dsh-session-backup-${stamp}`)
for (const target of targets) {
  const destination = path.join(backup, target.project, target.id)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.cp(target.dir, destination, { recursive: true })
  const cache = path.join(home, 'storages', 'session_projcache', 'sessions', `${target.id}.json`)
  await fs.cp(cache, path.join(backup, 'projcache', `${target.id}.json`)).catch(() => {})
}

const data = path.join(home, 'storages', 'dsh-session-suite')
const service = new SessionSuiteService({
  ctx: {
    get: name =>
      name === 'sessionController'
        ? {
            list: async () => ({ items: targets.map(target => ({ sessionId: target.id, running: false })) }),
            inspect: async () => {
              throw new Error('not needed for deletion')
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

const results = []
for (const target of targets) {
  try {
    const removed = await service.deleteSession(target.id)
    results.push({ id: target.id, project: target.project, removed: removed.sessionFiles.length > 0 })
  } catch (error) {
    results.push({ id: target.id, project: target.project, error: error.message })
  }
}

console.log(JSON.stringify({ ok: true, backup, deleted: results.filter(item => item.removed).length, results }, null, 2))
