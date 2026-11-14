/**
 * Restore a backup produced by backup-hidden-sessions.mjs.
 *
 * Dry run by default. `--apply` copies every file back and re-verifies each log
 * sha256 against the manifest, so a restore either lands byte-identical or says
 * exactly which file did not.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

const backup = process.argv[2]
const apply = process.argv.includes('--apply')
if (!backup) { console.log('usage: node restore-hidden-sessions.mjs <backupDir> [--apply]'); process.exit(1) }
const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

const manifest = JSON.parse(await fs.readFile(path.join(backup, 'MANIFEST.json'), 'utf8'))
console.log(`backup ${manifest.createdAt}, ${manifest.rows.length} rows, mode=${apply ? 'APPLY' : 'dry run'}\n`)

async function put(from, to, bytes) {
  await fs.mkdir(path.dirname(to), { recursive: true })
  if (apply) await fs.copyFile(from, to)
  return bytes
}

let restored = 0
let mismatched = 0
for (const row of manifest.rows) {
  const src = path.join(backup, row.sessionId)
  const scopeDir = path.join(home, 'sessions', row.scope, row.sessionId)
  // 1. log
  if (row.log) {
    const from = path.join(src, row.log)
    const to = path.join(scopeDir, row.log)
    await put(from, to, row.logBytes ?? 0)
    if (apply) {
      const sha = createHash('sha256').update(await fs.readFile(to)).digest('hex')
      if (sha !== row.sha256) { console.log(`MISMATCH ${row.sessionId} log`); mismatched += 1 }
    }
  }
  // 2. extras
  const extras = await fs.readdir(path.join(src, 'extras')).catch(() => [])
  for (const name of extras) await put(path.join(src, 'extras', name), path.join(scopeDir, name), 0)
  // 3. projection cache
  if (row.projCache > 0) {
    await put(path.join(src, 'projcache.json'), path.join(home, 'storages', 'session_projcache', 'sessions', `${row.sessionId}.json`), row.projCache)
  }
  // 4. snapshots
  const snapSrc = path.join(src, 'snapshots')
  const snapFiles = await fs.readdir(snapSrc, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const f of snapFiles) {
    if (!f.isFile()) continue
    const rel = path.relative(snapSrc, path.join(f.parentPath ?? f.path, f.name))
    await put(path.join(snapSrc, rel), path.join(home, 'storages', 'dsh-session-suite', 'sessions', row.sessionId, rel), 0)
  }
  // 5. memory
  if (row.memory > 0) {
    await put(path.join(src, 'memory.json'), path.join(home, 'storages', 'dsh-session-suite', 'memory', `${row.sessionId}.json`), row.memory)
  }
  restored += 1
  console.log(`${apply ? 'restored' : 'would restore'} ${row.sessionId} (${row.kind})`)
}

// 6. registry: put back exactly the file captured with the backup
const regSrc = path.join(backup, 'workspace.json')
const regTo = path.join(home, 'storages', 'workspace.json')
if (apply) {
  const current = await fs.readFile(regTo, 'utf8').catch(() => '')
  const saved = await fs.readFile(regSrc, 'utf8').catch(() => '')
  if (saved && saved !== current) {
    await fs.copyFile(regTo, `${regTo}.before-restore-${Date.now()}`).catch(() => {})
    await fs.copyFile(regSrc, regTo)
    console.log('registry: restored from the backup copy (previous file kept alongside)')
  } else {
    console.log('registry: already identical, left alone')
  }
} else {
  console.log('would reconcile workspace.json with the backup copy')
}

console.log(`\n${apply ? 'restored' : 'would restore'} ${restored} sessions; log sha mismatches: ${mismatched}`)
if (mismatched > 0) process.exitCode = 3
