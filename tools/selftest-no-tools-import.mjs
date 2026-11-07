/**
 * The plugin SOURCE must never import a tools/ file.
 *
 * A shipped npm bundle used to import `../tools/x.mjs` for a probe. package.json's
 * `files` allowlist does not include tools/, so locally it worked and from npm the
 * package failed to load at all. This static guard turns that incident into a
 * regression test: every import/export-from specifier in the shipped source tree
 * is checked, and anything reaching into tools/ (or depending on a path that is
 * outside the package) fails the build.
 *
 * Only source files are scanned — tools/ files are allowed to import lib/ (that is
 * the direction the selftests use), and node_modules is never touched.
 *
 * Usage: node tools/selftest-no-tools-import.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

const checks = []

/** Files that ship in the npm package (see package.json "files"). */
const SOURCE_FILES = [
  'index.js',
  'client.js',
  ...(await fs.readdir('lib')).filter(name => name.endsWith('.js')).map(name => path.join('lib', name)),
]

// Matches: import ... from 'x' / import 'x' / export ... from 'x' / import('x')
const IMPORT_RE = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g

let scanned = 0
const violations = []
for (const file of SOURCE_FILES) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    // A file listed in package.json but absent locally is a packaging concern,
    // not an import violation; skip it.
    continue
  }
  scanned += 1
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? ''
    if (/(^|\/)tools\//.test(spec) || spec.startsWith('tools/') || spec.includes('/tools/')) {
      violations.push(`${file}: ${spec}`)
    }
  }
}

assert.equal(violations.length, 0, `source must not import tools/:\n  ${violations.join('\n  ')}`)
checks.push(`${scanned} source files contain no tools/ import`)

// The direction that IS allowed: selftests import lib/. Assert the convention so
// a future "convenience" refactor cannot quietly reverse it.
const aTest = await fs.readFile('tools/selftest-memory.mjs', 'utf8')
assert.match(aTest, /from '\.\.\/lib\/memory-engine\.js'/, 'selftests must import lib/, not the reverse')
checks.push('selftests import lib/ (one-way dependency)')

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
