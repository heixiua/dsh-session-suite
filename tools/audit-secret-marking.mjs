// P2a audit: which live entries are marked `secret` today, and WHY (which
// pattern fired)? Prints masked text — never the credential itself — so the
// report is safe to read on screen. Report-only; changes nothing.
//
// Run: node tools/audit-secret-marking.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite', 'memory')

// The OLD classifier, copied verbatim from 0.9.0, so the audit describes the
// rules that are actually in force on the stored entries right now.
const OLD_PATTERNS = [
  ['密码+任意后缀', /(?:密码|口令|password|passwd|pwd)\s*[:=：]?\s*\S+/i],
  ['token形状(sk/ghp…)', /\b(?:sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{12,}/],
  ['18位身份证', /\b\d{17}[\dXx]\b/],
  ['任意15-19位数字', /\b(?:\d{15,19})\b/],
  ['11位手机号', /\b1[3-9]\d{9}\b/],
  ['邮箱', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['纯词命中(token/密钥/密码…)', /(?:身份证|银行卡|信用卡|私钥|密钥|token|secret|api[_-]?key)/i],
]

const files = []
for (const dir of [ROOT, path.join(ROOT, 'workspaces')]) {
  if (!fs.existsSync(dir)) continue
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.json')) files.push(path.join(dir, name))
  }
}

let total = 0
const secretEntries = []
for (const file of files) {
  const store = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const entry of store.entries ?? []) {
    if (entry.archived) continue
    total += 1
    if ((entry.privacy ?? 'internal') !== 'secret') continue
    const text = String(entry.text ?? '').replace(/\s+/g, ' ')
    const fired = OLD_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label)
    // Show at most 90 chars with any long token-ish run masked.
    const shown = text.slice(0, 90).replace(/[A-Za-z0-9+/_-]{16,}/g, '‹masked›')
    secretEntries.push({ id: entry.id, file: path.basename(file), fired, shown })
  }
}

console.log(`live entries: ${total}, marked secret: ${secretEntries.length}\n`)
const tally = new Map()
for (const row of secretEntries) {
  for (const label of row.fired) tally.set(label, (tally.get(label) ?? 0) + 1)
}
console.log('--- which pattern fired (an entry can fire several) ---')
for (const [label, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${label}`)
console.log('\n--- the entries ---')
for (const row of secretEntries) {
  console.log(`\n[${row.id}] (${row.file}) 命中: ${row.fired.join(' + ')}`)
  console.log(`  ${row.shown}`)
}
