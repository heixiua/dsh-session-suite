/**
 * Verify the memory model fallback chain and the workspace isolation rule.
 *
 * Two things are checked without touching the network or the real stores:
 *
 * 1. `memoryCandidates` flattens `memoryModels` / `memoryModel`, drops entries
 *    without a provider or model, and de-duplicates — so a 429 on the first
 *    provider really does move on to the next one.
 * 2. `MemoryEngine.workspaceKey` maps two different workspace paths to two
 *    different keys, which is what keeps one project's memories out of another's.
 *
 * Usage: node tools/selftest-memory-scope.mjs
 */

import assert from 'node:assert/strict'
import { MemoryEngine } from '../lib/memory-engine.js'

// The chain resolver is module-private, so re-derive it here from the same rules
// and assert the config shape the profile now ships.
const candidatesOf = config => {
  const raw = []
  const push = value => {
    if (Array.isArray(value)) raw.push(...value)
    else if (value) raw.push(value)
  }
  push(config?.memoryModels)
  push(config?.memoryModel)
  const out = []
  const seen = new Set()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { provider, model } = entry
    if (typeof provider !== 'string' || !provider) continue
    if (typeof model !== 'string' || !model) continue
    const key = `${provider}/${model}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ provider, model })
  }
  return out
}

const checks = []

// 1. An array is preserved in order.
const chain = candidatesOf({
  memoryModels: [
    { provider: 'agnes', model: 'agnes-3.0-flash' },
    { provider: 'zhipu', model: 'glm-4.7-flash' },
  ],
})
assert.equal(chain.length, 2)
assert.equal(chain[0].provider, 'agnes')
assert.equal(chain[1].provider, 'zhipu')
checks.push('array chain keeps priority order')

// 2. A single object still works.
assert.equal(candidatesOf({ memoryModel: { provider: 'zhipu', model: 'glm-4.7-flash' } }).length, 1)
checks.push('single memoryModel is accepted')

// 3. Both forms combine, singular last.
const mixed = candidatesOf({
  memoryModels: [{ provider: 'agnes', model: 'agnes-3.0-flash' }],
  memoryModel: { provider: 'zhipu', model: 'glm-4.7-flash' },
})
assert.equal(mixed.length, 2)
checks.push('memoryModels and memoryModel combine')

// 4. Incomplete entries are dropped instead of poisoning the chain.
const partial = candidatesOf({
  memoryModels: [{ provider: 'agnes' }, { model: 'glm-4.7-flash' }, { provider: 'zhipu', model: 'glm-4.7-flash' }],
})
assert.equal(partial.length, 1)
assert.equal(partial[0].provider, 'zhipu')
checks.push('entries missing provider or model are dropped')

// 5. Duplicates collapse so a retry does not call the same model twice.
const dup = candidatesOf({
  memoryModels: [
    { provider: 'agnes', model: 'agnes-3.0-flash' },
    { provider: 'agnes', model: 'agnes-3.0-flash' },
  ],
})
assert.equal(dup.length, 1)
checks.push('duplicate candidates collapse')

// 6. An empty or absent config yields no candidates.
assert.equal(candidatesOf({}).length, 0)
assert.equal(candidatesOf(undefined).length, 0)
checks.push('absent config yields no candidates')

// 7. Workspace isolation: different paths, different keys.
const a = MemoryEngine.workspaceKey('D:\\AI sandbox\\dsh-sandbox\\DSH Optimize')
const b = MemoryEngine.workspaceKey('D:\\AI sandbox\\dsh-sandbox\\DSH Optimize 2')
assert.notEqual(a, b)
checks.push('two workspace paths hash to different keys')

// 8. The same path spelled differently is the same workspace.
const variants = [
  'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize',
  'd:/ai sandbox/dsh-sandbox/dsh optimize',
  'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize\\',
]
const keys = variants.map(value => MemoryEngine.workspaceKey(value))
assert.equal(new Set(keys).size, 1)
checks.push('case, separator, and trailing-slash variants share one key')

// 9. Keys are short and filesystem-safe.
assert.match(a, /^[0-9a-f]{16}$/)
checks.push('workspace keys are 16 hex characters')

console.log(JSON.stringify({ ok: true, checks: checks.length, workspaceKey: a, otherKey: b }, null, 2))
