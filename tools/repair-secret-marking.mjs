/**
 * Repair false-positive `secret` markings in the live memory store.
 *
 * Why this exists: the pre-0.10 classifier treated the WORDS 密钥/token/secret
 * as credentials, so any note *about* credential handling became invisible —
 * never injected, never recalled, masked in lists. The audit (audit-secret-
 * marking.mjs) measured 8/8 false positives on the live library.
 *
 * What it does: for every LIVE entry currently stored as `secret`, re-runs the
 * CURRENT classifier on the text. If the entry was marked secret by the old
 * heuristic — i.e. the new classifier says the text contains no credential
 * material — the entry's privacy is rewritten to that new verdict and stamped
 * with `privacyRepairedAt`. Entries the new classifier still flags (real key
 * shapes, ids, emails) are left untouched. An entry explicitly stored secret
 * by the user (source carries no signal, so we cannot distinguish) is only
 * demoted when the text itself holds no material — which is exactly the
 * over-marking case; a user who truly wants a material-free note invisible can
 * set it again via the panel, and the repair is one command, reversible from
 * the backup.
 *
 * Safety: dry-run by default. --apply writes a full backup of every store file
 * it will touch into _memory-backup/ (git-ignored, private) before changing
 * anything. The engine reads stores from disk on every call, so the running
 * Host sees the change without a restart; the only race is a write landing
 * between our read and write, which the backup covers.
 *
 * Usage:
 *   node tools/repair-secret-marking.mjs            # report
 *   node tools/repair-secret-marking.mjs --apply    # repair
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inferPrivacy } from '../lib/memory-engine.js'

const ROOT = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite', 'memory')
const APPLY = process.argv.includes('--apply')

/** @returns {string[]} every store json file */
function storeFiles() {
  const out = []
  for (const dir of [ROOT, path.join(ROOT, 'workspaces')]) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) if (name.endsWith('.json')) out.push(path.join(dir, name))
  }
  return out
}

const now = Date.now()
let scanned = 0
let demoted = 0
let kept = 0
const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')

for (const file of storeFiles()) {
  const raw = fs.readFileSync(file, 'utf8')
  const store = JSON.parse(raw)
  let dirty = false
  for (const entry of store.entries ?? []) {
    if (entry.archived || entry.state === 'archived') continue
    if ((entry.privacy ?? 'internal') !== 'secret') continue
    scanned += 1
    const verdict = inferPrivacy(entry.text)
    if (verdict === 'secret') {
      kept += 1
      console.log(`KEEP   ${entry.id}  still credential material`)
      continue
    }
    demoted += 1
    console.log(`DEMOTE ${entry.id}  secret → ${verdict}  "${String(entry.text).replace(/\s+/g, ' ').slice(0, 60)}…"`)
    if (APPLY) {
      entry.privacy = verdict
      entry.privacyRepairedAt = now
      entry.privacyRepairedReason = 'pre-0.10 classifier over-marked the WORDS for credentials as secrets'
      dirty = true
    }
  }
  if (dirty && APPLY) {
    const backupDir = path.join(ROOT, '..', '_memory-backup')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(path.join(backupDir, `${path.basename(file)}.bak-${stamp}`), raw, 'utf8')
    fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')
  }
}

console.log(
  `\nlive secrets scanned: ${scanned}   demote: ${demoted}   keep: ${kept}   ${APPLY ? 'APPLIED (backups in _memory-backup/)' : 'dry-run — pass --apply'}`,
)
