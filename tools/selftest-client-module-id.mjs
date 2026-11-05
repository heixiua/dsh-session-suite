/**
 * The client module id must equal the package name.
 *
 * This is not a style rule — it is what keeps the app able to boot. Evidence,
 * from two crash logs that produced the identical sequence:
 *
 *   Uncaught Error: client-modules: duplicate factory registration for
 *     "dsh-session-suite" (bundle executed twice without invalidate?)
 *   Error: web boot: 1 entry did not activate
 *   @heixui/dsh-session-suite: import failed (see console for the import error)
 *
 * `dsh-client-modules` derives each manifest entry's id from the resolved
 * package, and the browser loader de-duplicates registrations by that id. With
 * the bare name in client.js and the scoped name in package.json, one bundle had
 * two ids: the combo script registered the factory, the graph row imported it
 * again, and the duplicate registration threw during boot — the app refused to
 * start, which looks nothing like "a plugin has no UI".
 *
 * The shipped plugins that work register under their package name:
 * dsh-connect-trae uses "dsh-connect-trae", whale-pet uses
 * "<package>#<submodule>". Ours must follow.
 *
 * Usage: node tools/selftest-client-module-id.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('client.js', 'utf8')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const checks = []

const idMatch = source.match(/window\.__ModuleLoader__\.load\(\{\s*\n?\s*id:\s*'([^']+)'/)
assert.equal(idMatch !== null, true, 'the loader call must declare an id')
const id = idMatch[1]

// 1. The id is the package name, verbatim. This is the whole contract.
assert.equal(id, pkg.name, `loader id "${id}" must equal package name "${pkg.name}"`)
checks.push('the loader id equals the package name')

// 2. Guard against the specific regression: a bare, unscoped name while the
//    package is scoped. That is the exact configuration that failed to boot.
if (pkg.name.startsWith('@')) {
  const scope = pkg.name.split('/')[0]
  assert.equal(
    id.startsWith(`${scope}/`),
    true,
    `a scoped package must register under its scope (got "${id}")`,
  )
  checks.push('a scoped package registers under its scope')
}

// 3. The id must appear exactly once, or the loader would see two registrations
//    from this one file regardless of what the package is called.
const occurrences = source.split(`id: '${id}'`).length - 1
assert.equal(occurrences, 1, `the id must be declared once, found ${occurrences}`)
const loadCalls = source.split('__ModuleLoader__.load(').length - 1
assert.equal(loadCalls, 1, `the module must register exactly once, found ${loadCalls} calls`)
checks.push('the module registers exactly once under one id')

// 4. Internal namespace strings are deliberately NOT the package name, because
//    they key routes and storage that predate the npm rename. Changing them would
//    orphan the user's data, so this asserts they stayed put while the id moved.
assert.equal(source.includes("const NS = 'session-suite'"), true, 'the locale namespace must stay session-suite')
assert.equal(source.includes("const ROUTE = 'api/session-suite'"), true, 'the HTTP route must stay api/session-suite')
checks.push('internal namespaces and routes keep their pre-rename values')

// 5. The dsh.client declaration must still export a client bundle, or the id is
//    moot — nothing would be served to register.
assert.equal(pkg.exports?.['./client'] !== undefined, true, 'package.json must export ./client')
assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform must be web')
checks.push('the package still exports a web client bundle')

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
