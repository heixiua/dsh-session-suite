#!/usr/bin/env node
/**
 * Run one maintenance pass over the real memory store, then report what it
 * covered. Proves whether every registered workspace is now reached.
 *
 * Usage: node tools/maintain-all-now.mjs
 */

import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const ROOT = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const engine = new MemoryEngine({ root: ROOT })

const before = await engine.status()
console.log('before:')
console.log('  lastMaintainedAt :', before.lastMaintainedAt ? new Date(before.lastMaintainedAt).toISOString() : 'never')
console.log('  lastMaintainedCwd:', before.lastMaintainedCwd)
console.log('  lastReport       :', JSON.stringify(before.lastReport))

console.log('\nrunning maintain() with no cwd argument (all registered workspaces)...')
const report = await engine.maintain()
console.log('report:', JSON.stringify(report))

const after = await engine.status()
console.log('\nafter:')
console.log('  lastMaintainedAt :', new Date(after.lastMaintainedAt).toISOString())
console.log('  lastReport       :', JSON.stringify(after.lastReport))

// What each workspace actually holds now.
const registry = JSON.parse(
  await (await import('node:fs/promises')).readFile(path.join(ROOT, 'memory', 'workspaces.json'), 'utf8'),
)
console.log('\nworkspaces:')
for (const [key, value] of Object.entries(registry.workspaces ?? {})) {
  const rows = await engine.list({ cwd: value.cwd })
  const live = rows.filter(row => !row.archived)
  const scored = live.filter(row => typeof row.score === 'number')
  console.log(`  ${key}  cwd=${value.cwd}`)
  console.log(`     entries=${live.length}  scored=${scored.length}`)
  for (const row of live.slice(0, 4)) {
    console.log(`       [${row.state}] score=${row.score ?? '-'} ${String(row.text).slice(0, 54)}`)
  }
}

// And whether the fingerprint is now clean, i.e. the next tick would skip.
console.log('\nneedsMaintenance after the pass:', await engine.needsMaintenance())
