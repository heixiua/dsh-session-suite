/**
 * Guard against untranslated UI text.
 *
 * The bundle once shipped a sidebar row whose label key was missing from the
 * dictionaries, so the raw key `menu.share` rendered in the UI. Every `t('key')`
 * call in `client.js` must exist in BOTH language halves of the in-file `DICTS`
 * table. Exits non-zero on any gap.
 *
 * `locale/*.json` is a different namespace (Cordis locale bindings, keys are
 * dotted paths under `meta`/`menu`/`message`/...), so it is not checked here.
 *
 * Usage: node tools/check-locale.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(repo, 'client.js'), 'utf8')

/** Pull the keys of one `en: {` / `zh: {` block out of the DICTS literal. */
function dictKeys(language) {
  const start = source.indexOf('const DICTS = {')
  if (start === -1) throw new Error('DICTS not found in client.js')
  const at = source.indexOf(`${language}: {`, start)
  if (at === -1) throw new Error(`DICTS has no "${language}" half`)
  const open = source.indexOf('{', at)
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) throw new Error(`unterminated "${language}" block`)
  const body = source.slice(open, end)
  const keys = new Set()
  for (const match of body.matchAll(/'([^']+)'\s*:/g)) keys.add(match[1])
  return keys
}

// Every quoted string that appears inside a `t(...)` call counts as used, which
// also covers ternary and template forms like `t(isDelete ? 'a' : 'b')`.
// A dictionary key always contains a dot, so requiring one filters out values
// that merely sit inside the same call — e.g. the `'capture'` operand of
// `t(busy === 'capture' ? 'settings.capturing' : 'settings.capture')`.
const used = new Set()
for (const call of source.matchAll(/\bt\(([^)]*)\)/g)) {
  for (const literal of call[1].matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)) {
    const key = literal[1] ?? literal[2]
    if (key && /^[a-zA-Z][\w]*\.[\w.]+$/.test(key)) used.add(key)
  }
}

const dicts = { en: dictKeys('en'), zh: dictKeys('zh') }

const report = {
  keysUsed: used.size,
  dictSize: { en: dicts.en.size, zh: dicts.zh.size },
  missing: {},
  unused: {},
}

// A key may also be composed at runtime, e.g. t(`memory.tab.${key}`); every
// dictionary key under that prefix counts as used.
const templatePrefixes = []
for (const call of source.matchAll(/\bt\((`[^)]*`)/g)) {
  const prefix = call[1].split('${')[0].replace(/`/, '')
  if (prefix) templatePrefixes.push(prefix)
}

for (const language of ['en', 'zh']) {
  const gap = [...used].filter(key => !dicts[language].has(key)).sort()
  if (gap.length) report.missing[language] = gap
  const dead = [...dicts[language]]
    .filter(key => !used.has(key))
    .filter(key => !templatePrefixes.some(prefix => key.startsWith(prefix)))
    .sort()
  if (dead.length) report.unused[language] = dead
}

console.log(JSON.stringify(report, null, 2))
process.exit(Object.keys(report.missing).length === 0 ? 0 : 1)
