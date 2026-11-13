/**
 * Run every selftest in one process and report the aggregate.
 *
 * A per-file loop is easy to forget a newly added file in; this discovers them
 * from disk so a new selftest is automatically part of the gate. Usage:
 *   node tools/run-selftests.mjs
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const dir = String.raw`D:\AI sandbox\dsh-sandbox\DSH Optimize\tools`
const files = readdirSync(dir).filter(f => /^selftest-.*\.mjs$/.test(f)).sort()
let pass = 0
const failures = []
for (const file of files) {
  const r = spawnSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8', cwd: path.dirname(dir), timeout: 120000 })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const ok = r.status === 0
  if (ok) pass++
  else failures.push({ file, status: r.status, tail: out.trim().split('\n').slice(-12).join('\n') })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${file}\n`)
}
console.log(`\n${pass}/${files.length} selftests pass`)
if (failures.length) {
  console.log('\n=== FAILURES ===')
  for (const f of failures) console.log(`\n--- ${f.file} (exit ${f.status}) ---\n${f.tail}`)
  process.exitCode = 1
}
