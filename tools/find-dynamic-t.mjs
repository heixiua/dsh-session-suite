/**
 * List `t(...)` calls whose first argument is not a string literal.
 *
 * Those are the places a key could be produced dynamically and therefore escape
 * `tools/check-locale.mjs`. The report is advisory: it prints every such call
 * with its line number so the shape can be judged by eye.
 *
 * Usage: node tools/find-dynamic-t.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(repo, 'client.js'), 'utf8')

const lines = source.split(/\r?\n/)
const findings = []

for (const match of source.matchAll(/\bt\(([^)]*)\)/g)) {
  const arg = match[1].trim()
  if (arg.startsWith("'") || arg.startsWith('`')) continue
  const line = source.slice(0, match.index).split(/\r?\n/).length
  findings.push({ line, arg: arg.replace(/\s+/g, ' ').slice(0, 110) })
}

if (findings.length === 0) {
  console.log('every t() call takes a literal or template key')
} else {
  console.log(`${findings.length} non-literal t() call(s):`)
  for (const item of findings) console.log(`  ${item.line}: ${item.arg}`)
}
