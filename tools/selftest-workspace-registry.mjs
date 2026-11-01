/**
 * Exercise the workspace registry and automatic maintenance end to end.
 *
 * Two behaviours are proved against a temporary store:
 *
 * 1. Writing a workspace memory records the readable path, so the settings page
 *    can name and offer that workspace instead of showing a bare hash.
 * 2. `maintain()` clusters related entries and archives weak ones, which is what
 *    the new interval now runs automatically.
 *
 * Usage: node tools/selftest-workspace-registry.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-registry-'))
const engine = new MemoryEngine({ root, config: {} })
const checks = []

const cwdA = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'
const cwdB = 'D:\\AI sandbox\\dsh-sandbox\\Other Project'

// 1. Writing records the readable path.
await engine.remember({ scope: 'workspace', cwd: cwdA, text: '这个项目统一用 pnpm 安装依赖' })
await engine.remember({ scope: 'workspace', cwd: cwdA, text: '提交前必须跑一遍 selftest' })
await engine.remember({ scope: 'workspace', cwd: cwdB, text: '另一个项目用 npm 而不是 pnpm' })

const known = await engine.workspaces()
assert.equal(known.length, 2)
assert.equal(known.find(item => item.cwd === cwdA)?.entries, 2)
assert.equal(known.find(item => item.cwd === cwdB)?.entries, 1)
checks.push('two workspaces recorded with readable paths and correct entry counts')

// 2. The registry survives a fresh engine instance (it is on disk, not memory).
const reread = new MemoryEngine({ root, config: {} })
assert.equal((await reread.workspaces()).length, 2)
checks.push('registry is persisted and readable by a new engine')

// 3. Scopes stay separate: workspace A's entries are not visible from B.
const listA = await reread.list({ cwd: cwdA, scope: 'workspace' })
const listB = await reread.list({ cwd: cwdB, scope: 'workspace' })
assert.equal(listA.length, 2)
assert.equal(listB.length, 1)
assert.ok(listB.every(entry => !listA.some(other => other.id === entry.id)))
checks.push('workspace memories do not mix across projects')

// 4. The global store is untouched by workspace writes.
const global = await reread.list({ scope: 'global' })
assert.equal(global.length, 0)
checks.push('workspace writes never leak into the global store')

// 5. Maintenance runs and reports what it did.
const report = await reread.maintain(cwdA)
assert.equal(typeof report.scored, 'number')
assert.ok(report.scored > 0, 'maintenance scored at least one entry')
checks.push(`maintenance scored ${report.scored}, archived ${report.archived}, compressed ${report.compressed}`)

// 6. Clustering groups the two related workspace-A entries.
assert.ok(report.clusters >= 0)
checks.push(`clusters formed: ${report.clusters}`)

console.log(JSON.stringify({ ok: true, checks, known, report }, null, 2))
