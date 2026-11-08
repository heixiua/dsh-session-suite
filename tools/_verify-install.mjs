/**
 * Verify the INSTALLED copy, not the repo checkout.
 *
 * An install can "succeed" and still ship the wrong code — the recurring failure
 * on this machine was a package directory that existed but had been emptied. This
 * reads the files under node_modules and checks for the specific strings each new
 * behaviour depends on, so "0.10.0 is installed" cannot be a version string that
 * disagrees with the bytes on disk.
 *
 * Usage: node tools/_verify-install.mjs <package-dir>
 */

import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node tools/_verify-install.mjs <package-dir>')
  process.exit(2)
}

const read = relative => fs.readFileSync(path.join(dir, relative), 'utf8')
const pkg = JSON.parse(read('package.json'))
// The expected version comes from the checkout, so this check cannot go stale
// the moment a release is bumped — the previous hard-coded '0.10.0' failed the
// first install of 0.10.1 and reported a packaging problem that did not exist.
const EXPECTED = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version

const checks = []
const check = (name, ok) => checks.push({ name, ok })

check(`version is ${EXPECTED}`, pkg.version === EXPECTED)
check('main entry declared', typeof pkg.main === 'string')
check('client entry exported', Boolean(pkg.exports?.['./client']))
check('bundle patch declared', Boolean(pkg.dsh?.bundle?.patch))

const conflicts = read('lib/conflicts.js')
check('conflicts: band ceiling raised to 0.99', /max:\s*0\.99/.test(conflicts))
check('conflicts: clause-level comparison exists', conflicts.includes('export function clauseConflict'))
check('conflicts: positional polarity exists', conflicts.includes('firstNegation.index < originalAssertion.index'))
check('conflicts: pairKey order-insensitive', conflicts.includes('export function pairKey'))

const pain = read('lib/pain.js')
check('pain: detectPain exported', pain.includes('export function detectPain'))
check('pain: distillLessons exported', pain.includes('export function distillLessons'))
check('pain: turn attributed by position', pain.includes('currentTurn'))
check('pain: self-correction requires first person', pain.includes('我搞错'))
check('pain: user correction is two-tier', pain.includes('isUserCorrection'))

const engine = read('lib/memory-engine.js')
check('engine: correction-swallow guard', engine.includes('const contradicting = hasNegation'))
check('engine: lessonTheme identity', engine.includes('entry.lessonTheme === input.lessonTheme'))
check('engine: recurrence counter', engine.includes('sameTheme.recurrences'))
check('engine: distilled lesson ceiling', engine.includes('maxDistilledLessons'))
check('engine: lessons never clustered', engine.includes('!isLessonEntry(entry)'))
check('engine: conflicts() and settleConflict()', engine.includes('async conflicts(cwd)') && engine.includes('async settleConflict(id, winnerId)'))
check('engine: secret patterns require material', engine.includes('export function secretPatterns'))

const host = read('lib/memory-host.js')
check('host: pain hook installed', host.includes('config.painDistill !== false'))
check('host: conflicts tool action', host.includes("args.action === 'conflicts'"))
check('host: resolve tool action', host.includes("args.action === 'resolve'"))
check('host: winnerId in schema', host.includes('winnerId:'))

const api = read('lib/api.js')
check('api: longterm.conflicts route', api.includes("case 'longterm.conflicts'"))
check('api: longterm.resolve route', api.includes("case 'longterm.resolve'"))
check('api: actions registered', api.includes("'longterm.conflicts'") && api.includes("'longterm.resolve'"))

const client = read('client.js')
check('client: fetches conflict queue', client.includes("action: 'longterm.conflicts'"))
check('client: resolve with winner', client.includes('winnerId: side.id'))
check('client: locale keys for both features', client.includes('memory.conflictsTitle') && client.includes('memory.painDistilled'))

const patch = read('cordis.patch.yml')
check('patch: conflictScan switch', /conflictScan:\s*true/.test(patch))
check('patch: painDistill switch', /painDistill:\s*true/.test(patch))
check('patch: maxDistilledLessons cap', /maxDistilledLessons:\s*12/.test(patch))

const failures = checks.filter(row => !row.ok)
for (const row of checks) console.log(`  ${row.ok ? 'ok  ' : 'FAIL'} ${row.name}`)
console.log('')
console.log(`${checks.length - failures.length}/${checks.length} checks passed`)
if (failures.length > 0) {
  console.log(`\nFAILED: ${failures.map(row => row.name).join(', ')}`)
  process.exit(1)
}
