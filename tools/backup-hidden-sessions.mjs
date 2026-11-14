/**
 * Build a restorable backup of exactly the sessions the hidden panel offers.
 *
 * Writes one zip-shaped folder per session under
 *   <out>/<sessionId>/{log, projcache.json, snapshots}
 * plus MANIFEST.json recording scope, sizes and the sha256 of every log, so a
 * restore is a copy-back and a verification, not a guess.
 *
 * Read-only with respect to %USERPROFILE%\.dsh.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { hiddenSessions, registrySessionIds } from '../lib/cleanup.js'

const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const out = process.argv[2] ?? path.join(process.cwd(), 'hidden-session-backup')
const readJson = async f => { try { return JSON.parse(await fs.readFile(f, 'utf8')) } catch { return undefined } }

const registry = (await readJson(path.join(home, 'storages', 'workspace.json'))) ?? {}
const registered = registrySessionIds(registry)
const archived = Array.isArray(registry?.global?.archivedSessionIds) ? registry.global.archivedSessionIds : []
const rows = await hiddenSessions(home, { archivedIds: archived, registeredIds: registered })

await fs.mkdir(out, { recursive: true })
const manifest = { createdAt: new Date().toISOString(), dshHome: home, rows: [] }

async function copyIf(from, to) {
  try {
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.copyFile(from, to)
    return (await fs.stat(to)).size
  } catch { return 0 }
}

for (const row of rows) {
  const target = path.join(out, row.sessionId)
  await fs.mkdir(target, { recursive: true })
  const entry = {
    sessionId: row.sessionId,
    scope: row.scope,
    kind: row.subagent ? 'subagent' : 'blank',
    title: row.title ?? null,
    cwd: row.cwd ?? '',
    bytes: row.bytes,
    log: null,
    sha256: null,
    projCache: 0,
    snapshots: 0,
    memory: 0,
  }

  // 1. the session log
  const scopeDir = path.join(home, 'sessions', row.scope, row.sessionId)
  const files = await fs.readdir(scopeDir).catch(() => [])
  const log = files.find(n => /^session\.v\d+\.jsonl(\.zstd)?$/.test(n))
  if (log) {
    const from = path.join(scopeDir, log)
    const to = path.join(target, log)
    entry.log = log
    const size = await copyIf(from, to)
    entry.logBytes = size
    entry.sha256 = createHash('sha256').update(await fs.readFile(to)).digest('hex')
  }
  // any other files in the session dir (older generations etc.)
  for (const name of files) {
    if (name === log) continue
    await copyIf(path.join(scopeDir, name), path.join(target, 'extras', name))
  }

  // 2. projection cache (the row's title/blank flags live here)
  const cache = path.join(home, 'storages', 'session_projcache', 'sessions', `${row.sessionId}.json`)
  entry.projCache = await copyIf(cache, path.join(target, 'projcache.json'))

  // 3. workspace snapshots taken by this session
  const snapRoot = path.join(home, 'storages', 'dsh-session-suite', 'sessions', row.sessionId)
  const snapFiles = await fs.readdir(snapRoot, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const f of snapFiles) {
    if (!f.isFile()) continue
    const rel = path.relative(snapRoot, path.join(f.parentPath ?? f.path, f.name))
    const size = await copyIf(path.join(snapRoot, rel), path.join(target, 'snapshots', rel))
    entry.snapshots += size
  }

  // 4. memory ledger, when one exists
  const ledger = path.join(home, 'storages', 'dsh-session-suite', 'memory', `${row.sessionId}.json`)
  entry.memory = await copyIf(ledger, path.join(target, 'memory.json'))

  manifest.rows.push(entry)
  console.log(`${row.sessionId}  log=${entry.logBytes ?? 0}B sha=${(entry.sha256 ?? '-').slice(0, 12)} cache=${entry.projCache}B snaps=${entry.snapshots}B mem=${entry.memory}B`)
}

// 5. the registry itself: restoring needs the archive/pin/workspace arrays as they are now
await fs.copyFile(path.join(home, 'storages', 'workspace.json'), path.join(out, 'workspace.json')).catch(() => {})
await fs.writeFile(path.join(out, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))

const totalBytes = manifest.rows.reduce((n, r) => n + (r.logBytes ?? 0) + r.projCache + r.snapshots + r.memory, 0)
console.log(`\nrows backed up: ${manifest.rows.length}`)
console.log(`total: ${(totalBytes / 1048576).toFixed(2)} MB -> ${out}`)
if (manifest.rows.some(r => !r.sha256)) {
  console.log('WARNING: a row has no log hash; inspect before deleting')
  process.exitCode = 2
}
