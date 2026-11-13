/**
 * Dark-mode contract for the client stylesheet.
 *
 * The panel once "did not support dark mode": five `var(--dsw-*)` names did not
 * exist, so every one fell back to a hardcoded #fff while the text tokens DID
 * adapt — white cards with near-white text on a dark background. This checks
 * the failure mode directly against the shipped theme plugin, not against a
 * hand-maintained list of guesses.
 *
 * Usage: node tools/selftest-dark-mode.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync('client.js', 'utf8')
const themeSrc = fs.readFileSync(
  String.raw`D:\AI app\DSH\resources\app\dsh\node_modules\@deepseek-ai\dsh-client-ui-theme\lib\client.js`,
  'utf8',
)

const checks = []
const used = [...new Set([...client.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map(m => m[1]))]
assert.ok(used.length > 10, 'the client must actually use theme tokens')

// Every referenced token must exist in the theme plugin.
const defined = new Set([...themeSrc.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)].map(m => m[1]))
for (const token of used) {
  assert.ok(defined.has(token), `${token} does not exist in the shipped theme — its fallback would hardcode a light colour`)
}
checks.push(`all ${used.length} referenced tokens exist in the shipped theme`)

// Every colour token must be defined in BOTH palettes (light + dark).
// Radius tokens are global constants and legitimately have one definition.
for (const token of used) {
  if (token.startsWith('--dsw-radius-')) continue
  const count = [...themeSrc.matchAll(new RegExp(`${token.replace(/[-]/g, '\\-')}\\s*:`, 'g'))].length
  assert.ok(count >= 2, `${token} has ${count} definition(s); it cannot adapt to the dark palette`)
}
checks.push('every colour token has both light and dark definitions')

// The old broken names must never come back.
for (const old of ['--dsw-alias-bg-l2', '--dsw-alias-bg-l3', '--dsw-alias-brand',
  '--dsw-alias-bg-overlay', '--dsw-alias-state-warning-primary', '--dsw-alias-bg-layer-4']) {
  assert.equal(client.includes(`var(${old},`), false, `legacy token ${old} reintroduced`)
}
checks.push('the six legacy/invented token names are absent')

// Structural safety: no hard-coded white surfaces outside var() fallbacks.
const badSurfaces = []
client.split('\n').forEach((line, i) => {
  if (/var\(/.test(line)) return
  if (/background\s*:\s*(#fff|#ffffff|white)\b/i.test(line)) badSurfaces.push(i + 1)
})
assert.deepEqual(badSurfaces, [], `hardcoded white backgrounds at lines ${badSurfaces.join(', ')}`)
checks.push('no hardcoded white surfaces outside token fallbacks')

console.log('')
for (const check of checks) console.log(`  ✓ ${check}`)
console.log(`\n${checks.length} dark-mode checks passed`)
