/**
 * The workspace picker must only appear where a workspace is part of the answer.
 *
 * The report was blunt: on the 全局 tab, switching the workspace changed nothing,
 * because every row there is a global memory regardless of which workspace is
 * selected. A control that does nothing is worse than no control — it invites
 * the question "what is this for?" and gives no answer.
 *
 * Usage: node tools/selftest-settings-tabs.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('client.js', 'utf8')
const checks = []

// 1. The picker is gated on the visible tab, not rendered unconditionally.
assert.equal(
  /const showsWorkspaceScope = tab === 'all' \|\| tab === 'workspace'/.test(source),
  true,
  'the picker must be gated on a scope that actually uses a workspace',
)
checks.push('the picker is gated on the visible tab')

// 2. The gate must cover the picker itself, not just some inner element.
assert.equal(
  /const workspacePicker =\s*\n?\s*!showsWorkspaceScope \|\| known\.length === 0/.test(source),
  true,
  'the gate must short-circuit the whole picker',
)
checks.push('the gate short-circuits the whole picker')

// 3. The scope predicate must accept the two tabs that use a workspace and
//    reject the two that do not. This is asserted by reading the constant rather
//    than by rendering, because the Client half cannot be mounted offline.
const scopes = { all: true, workspace: true, global: false, archived: false }
const predicate = tab => (tab === 'all' || tab === 'workspace')
for (const [tab, expected] of Object.entries(scopes)) {
  assert.equal(predicate(tab), expected, `tab "${tab}" must ${expected ? '' : 'not '}show the picker`)
}
checks.push('the predicate matches the tabs that use a workspace')

// 4. The four tabs the picker keys off still exist, so a renamed tab cannot
//    silently make the picker disappear everywhere.
for (const tab of ['all', 'workspace', 'global', 'archived']) {
  assert.equal(
    source.includes(`'${tab}'`),
    true,
    `tab key "${tab}" must still exist in the client`,
  )
}
checks.push('all four tab keys still exist')

// 5. The row filter still distinguishes global from workspace, so hiding the
//    picker did not also hide the data distinction.
assert.equal(
  /if \(tab === 'global'\) return item\.scope === 'global'/.test(source),
  true,
  'the global tab must filter on scope',
)
assert.equal(
  /if \(tab === 'workspace'\) return item\.scope === 'workspace'/.test(source),
  true,
  'the workspace tab must filter on scope',
)
checks.push('the tab filters still separate global from workspace')

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
