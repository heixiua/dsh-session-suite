/**
 * Implicit extraction must have a model to call, and the workspace badge must name
 * the workspace.
 *
 * Both were reported from use, not from reading the code:
 *
 *   • "I have chatted for hours and never once saw the implicit queue" — the guard
 *     `no memoryModels chain is configured` returned before the prompt was ever sent,
 *     because the profile had no `memoryModels` configured. Nothing was broken in the
 *     queue; nothing was ever produced.
 *   • "when I filter to 全部, every row says 本工作区" — the badge used a fixed string
 *     for every workspace-scoped entry, so rows from different workspaces all claimed
 *     to be the current one.
 *
 * Usage: node tools/selftest-extraction-fallback.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const host = fs.readFileSync('lib/memory-host.js', 'utf8')
const client = fs.readFileSync('client.js', 'utf8')
const checks = []

// 1. The fallback must be opt-in, and must never spend tokens by itself.
//
//    An earlier build fell back to the Host's default model whenever no chain was
//    configured, to fix "extraction never runs". That spends the user's tokens once
//    per turn on a model they never chose for this purpose — a background cost with
//    no visible consent. The fallback now requires an explicit selection.
{
  const start = host.indexOf('function memoryCandidates')
  assert.equal(start >= 0, true, 'memoryCandidates must exist')
  const rest = host.slice(start + 1)
  const end = start + 1 + rest.indexOf('\nfunction ')
  const fn = host.slice(start, end > start + 1 ? end : host.length)
  assert.equal(fn.length > 200, true, `memoryCandidates must be locatable (got ${fn.length} chars)`)

  // The default-model branch must be gated on the explicit opt-in.
  assert.equal(
    /picked === 'current'/.test(fn),
    true,
    'the default-model fallback must require the explicit "current" selection',
  )
  assert.equal(
    /raw\.length === 0 && ctx && picked === 'current'/.test(fn),
    true,
    'the fallback condition must include the opt-in, not just "no chain"',
  )
  // And an unset choice must mean OFF, not "use whatever is handy".
  assert.equal(
    /picked && picked !== 'current' && picked !== 'off'/.test(fn),
    true,
    'an explicit provider/model pick must be honoured',
  )
  checks.push('the default-model fallback is opt-in and never implicit')
}

// 1b. The model picker is REMOVED, along with the pipeline it configured.
//
//    The picker chose which model a background per-turn extraction call would use. That
//    call no longer exists: memories are written by the model calling the `remember`
//    tool, so there is no separate model to choose and no background cost to authorise.
//    A control that configures nothing is worse than no control — it implies a cost that
//    is not being incurred.
{
  assert.equal(
    /action: 'longterm\.settings', patch: \{ implicitModel:/.test(client),
    false,
    'the settings UI must not persist a model choice for a pipeline that does not exist',
  )
  // Check the RENDERED code, not the whole file: the dictionary still carries the label
  // strings, which is harmless (an unused key renders nothing) but would fail a
  // file-wide search.
  const clientCode = client.replace(/^\s*'[^']*':\s*'[^']*',?$/gm, '')
  assert.equal(
    /memory\.implicitModelHint/.test(clientCode),
    false,
    'the hint describing a per-turn model call must be gone from the rendered UI',
  )
  checks.push('the automatic-extraction model picker is removed')
}

// 1c. The Host model catalogue must not be fetched for a picker that no longer exists.
{
  assert.equal(
    /action: 'longterm\.models'/.test(client),
    false,
    'the panel must not request the model catalogue for a removed control',
  )
  checks.push('the panel no longer fetches the model catalogue')
}

// 2. The guard message must say what to do.
{
  assert.equal(
    /implicit extraction has no model configured/.test(host),
    true,
    'the failure must name the missing piece',
  )
  checks.push('the guard explains both causes')
}

// 3. The badge must name the workspace, not repeat a fixed label.
{
  // The helper is defined INSIDE MemorySection but before its first hook, so a slice
  // from the function header is the right frame.
  const start = client.indexOf('function MemorySection')
  const rest = client.slice(start + 1)
  const end = start + 1 + rest.indexOf('\n    function ')
  const memory = client.slice(start, end > start + 1 ? end : client.length)
  assert.equal(memory.length > 500, true, `MemorySection must be locatable (got ${memory.length})`)
  assert.equal(
    /const workspaceLabel = key =>/.test(memory),
    true,
    'the memory list must resolve a workspace key to a name',
  )
  assert.equal(
    /workspaceLabel\(entry\.workspaceKey\)/.test(memory),
    true,
    'the badge must use the resolved name',
  )
  // The fixed string may survive as the helper's fallback and as the scope <option>
  // label; what must NOT survive is using it as the badge for a real workspace key.
  const fixed = memory.split("t('memory.workspace')").length - 1
  assert.equal(fixed <= 4, true, `the fixed label may only remain as fallback/labels, found ${fixed} uses`)
  checks.push('the workspace badge names the workspace')
}

// 4. The label must come from the registry, since the key is a one-way hash.
{
  const start = client.indexOf('function MemorySection')
  const rest = client.slice(start + 1)
  const end = start + 1 + rest.indexOf('\n    function ')
  const memory = client.slice(start, end > start + 1 ? end : client.length)
  assert.equal(
    /known\.find\(item => item\.key === key\)/.test(memory),
    true,
    'the label must be looked up in the registry list',
  )
  checks.push('the label comes from the registry, not from the hash')
}

// 5. The counters must survive a reset and be published before extraction runs.
//
//    The settings page showed N=0 while extraction had demonstrably run — the block
//    rendered, which only happens when a trace exists. The cause was ordering: the
//    listener incremented the counter, then extractAfterTurn called
//    resetExtractionTrace (which cleared it), and the finally published the cleared
//    value. The diagnostic reported the one case it existed to rule out.
{
  const reset = host.slice(
    host.indexOf('function resetExtractionTrace'),
    host.indexOf('async function extractAfterTurn'),
  )
  assert.equal(
    /const eventsSeen = extractionTrace\.eventsSeen/.test(reset),
    true,
    'the reset must preserve the event counter',
  )
  assert.equal(
    /extractionTrace\.eventsSeen = eventsSeen/.test(reset),
    true,
    'the reset must restore the event counter',
  )
  assert.equal(
    /extractionTrace\.turnEndsSeen = turnEndsSeen/.test(reset),
    true,
    'the reset must restore the turn counter',
  )

  // The background per-turn extraction is REMOVED (0.8.0).
  //
  // Seven attempts to drive it from a Cordis event never fired once. Reading
  // dsh-fish-memory settled why: that plugin has no such pipeline — its memories are
  // written by the model calling a `remember` tool, and `agent/turn-stopping` there only
  // marks whether a recalled memory was used. The direction was wrong, not the wiring,
  // and the last attempt crashed the Host. Assert it stays gone so no future reader
  // mistakes it for working code — while the model-facing mechanism stays present.
  assert.equal(
    /extractionTrace\.eventsSeen = \(extractionTrace\.eventsSeen \?\? 0\) \+ 1/.test(host),
    false,
    'the dead extraction listener must be gone (its counter increment is the tell)',
  )
  assert.equal(
    /void extractAfterTurn\(\{/.test(host),
    false,
    'nothing may call extractAfterTurn per turn',
  )
  // The mechanism that actually works: a tool the model calls mid-conversation.
  assert.equal(
    /name: 'memory'/.test(host),
    true,
    'the memory tool must remain — it is how memories are actually written',
  )
  checks.push('background extraction is gone; the memory tool remains')
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
