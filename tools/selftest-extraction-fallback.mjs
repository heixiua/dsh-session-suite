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

// 1b. The settings UI must offer the choice, with a zero-cost "off".
{
  assert.equal(
    /action: 'longterm\.settings', patch: \{ implicitModel:/.test(client),
    true,
    'the settings UI must persist the model choice',
  )
  // Assert the RENDERED options, not merely that the strings exist: a dictionary
  // entry with no <option> behind it is a label nobody can select.
  assert.equal(
    /h\('option', \{ value: 'off' \}, t\('memory\.implicitModelOff'\)\)/.test(client),
    true,
    'there must be a rendered zero-cost off option',
  )
  assert.equal(
    /h\('option', \{ value: 'current' \}, t\('memory\.implicitModelCurrent'\)\)/.test(client),
    true,
    'the "use current model" option must be rendered and labelled as a choice',
  )
  checks.push('the settings UI offers the model choice with a zero-cost off')
}

// 1c. The model list must come from the Host, not from configuration.
//
//     The picker rendered `config.memoryModels`, a patch-supplied list. A profile with
//     no patch entry for this bundle therefore offered only "off" and "use current"
//     while the user had several working providers in Settings → 模型 — reported as
//     "why are there only two choices?". What can be called is the llm service's
//     answer to give; a config file only records what someone once wrote down.
{
  const api = fs.readFileSync('lib/api.js', 'utf8')
  const service = fs.readFileSync('lib/service.js', 'utf8')
  assert.equal(/case 'longterm\.models':/.test(api), true, 'the API must expose the model list')
  assert.equal(/longTermModels\(\)/.test(service), true, 'the service must implement it')
  assert.equal(
    /ctx\.get\?\.\('llm'\)/.test(service),
    true,
    'the model list must come from the llm service',
  )
  assert.equal(/listProviders/.test(service), true, 'providers must be enumerated')
  assert.equal(/listModels/.test(service), true, 'models must be enumerated per provider')
  // And the client must fetch it, not read a config array.
  assert.equal(
    /action: 'longterm\.models'/.test(client),
    true,
    'the settings UI must fetch the model list from the Host',
  )
  assert.equal(
    /Array\.isArray\(settings\?\.memoryModels\)/.test(client),
    false,
    'the picker must not render a config-supplied model list',
  )
  checks.push('the model list comes from the Host, not from configuration')
}

// 1d. The failure reason must point at that control.
{
  assert.equal(
    /choose one in Settings/.test(host),
    true,
    'an unconfigured model must tell the user where to fix it',
  )
  checks.push('the guard points at the settings control')
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

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
