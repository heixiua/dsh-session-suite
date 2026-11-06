/**
 * Contract test: every Host service call this bundle makes must exist, and every paged
 * read must be able to walk to the end.
 *
 * Five defects in a row shared one cause — calling a Host method whose name or argument
 * shape had changed, with the failure surfacing only when a user clicked the button:
 *
 *   1. archive/unarchive: two services with different argument shapes
 *   2. memory stats: read the wrong object
 *   3. share + segment delete: `sessionController.inspect` does not exist
 *   4. implicit extraction: the same missing method, hidden behind `?.`
 *   5. share + segment delete: `events()` returns ONE PAGE, not the whole session
 *
 * This test pins the shape of those calls so the next Host change fails here, in a test,
 * instead of in a dialog. It asserts on the source (the calls are what must stay
 * correct), plus one live check that the paging loop can terminate.
 *
 * Usage: node tools/selftest-host-contract.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const service = fs.readFileSync('lib/service.js', 'utf8')
const host = fs.readFileSync('lib/memory-host.js', 'utf8')
const index = fs.readFileSync('index.js', 'utf8')
const checks = []

// 1. Session reads must not rely on `inspect` alone.
//
//    The current Host exposes `events(request, signal)`; `inspect` is gone. A call
//    guarded only by `?.inspect?.()` returns undefined with no error, so every consumer
//    silently sees an empty session. Both shapes must be handled, and a Host offering
//    neither must throw rather than pretend the session is empty.
{
  assert.equal(
    /typeof controller\.events === 'function'/.test(service),
    true,
    'service.js must handle the paged events() API',
  )
  assert.equal(
    /typeof controller\.inspect === 'function'/.test(service),
    true,
    'service.js must keep the older inspect() path',
  )
  assert.equal(
    /exposes neither sessionController\.events nor sessionController\.inspect/.test(service),
    true,
    'a Host with neither API must throw, not return an empty session',
  )
  // The same defect existed in the extraction path, hidden behind an optional chain.
  assert.equal(
    /sessionController\?\.inspect\?\./.test(host),
    false,
    'the extraction path must not call inspect through an optional chain',
  )
  assert.equal(
    /readSessionEvents\(/.test(host),
    true,
    'the extraction path must use the shared session reader',
  )
  assert.equal(
    /exposes neither sessionController\.events nor sessionController\.inspect/.test(host),
    true,
    'the shared reader must throw when no API exists',
  )
  checks.push('session reads handle both APIs and refuse to fake an empty session')
}

// 2. Every Remote that takes a signal must be given one.
//
//    `events(request, signal)` and `prompt(request, signal)` both dereference
//    `signal.throwIfAborted()`. Omitting the argument throws a TypeError, and a branch
//    like `signal === undefined ? prompt(request) : prompt(request, signal)` still passes
//    undefined in the case that crashes.
{
  assert.equal(
    /new AbortController\(\)\.signal/.test(service),
    true,
    'service.js must construct a real AbortSignal for events()',
  )
  assert.equal(
    /controller\.events\(request, signal\)/.test(service),
    true,
    'events() must receive the signal',
  )
  // Strip comments first: the comment EXPLAINS the removed branch and therefore still
  // contains the string, which made a naive assertion fail on correct code.
  const serviceCode = service.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.equal(
    /signal === undefined/.test(serviceCode),
    false,
    'prompt() must not branch on a missing signal — that branch is the crashing case',
  )
  assert.equal(
    /controller\.prompt\(request, effective\)/.test(service),
    true,
    'prompt() must always be given a signal',
  )
  checks.push('every signal-taking Remote is given a real signal')
}

// 3. Paged reads must walk to the end.
//
//    `events()` returns one page. Reading only the first page made the share dialog offer
//    "3 of 3 turns" for a session with 129 — the data was not lost, it was never read.
{
  assert.equal(
    /page\?\.hasMore|page\.hasMore/.test(service),
    true,
    'the reader must check hasMore',
  )
  assert.equal(
    /page\?\.cursor/.test(service) || /page\.cursor/.test(service),
    true,
    'the reader must follow the cursor',
  )
  // A loop is what distinguishes "walk to the end" from "read one page". Look for the
  // guard counter and the break-on-exhaustion inside the same reader.
  // A loop is what distinguishes "walk to the end" from "read one page". Assert on the
  // whole file: the reader's helpers are defined before it, so a slice from `inspect`
  // to the next declaration can come out empty.
  assert.equal(/while \(guard/.test(service), true, 'the reader must loop, not read a single page')
  assert.equal(/page\?\.hasMore/.test(service), true, 'the loop must consult hasMore')
  // And it must de-duplicate across page boundaries, or a boundary row appears twice.
  assert.equal(/new Map\(\)/.test(service), true, 'the reader must de-duplicate by seq')
  checks.push('paged reads walk to the end and de-duplicate')
}

// 4. No polling loop may be reintroduced without its guardrails.
//
//    0.6.1 added a 500ms `agents.list()` poll to mount `agent/turn-stopping`. Its tick
//    body called `ctx.interval`/`ctx.get('timer')` on a context that had not injected
//    `timer`, so it threw `cannot get property "timer" without inject` on EVERY tick
//    until the Host process died. The WorkBuddy transcript showed the stack:
//    `at mount, _onTimeout, listOnTimeout` from our bundle.
//
//    A recurring timer that can throw on every tick is not acceptable in a plugin that
//    runs inside a shared Host. This pins the safe state: no poll, no agents/timer
//    injection. If a poll is ever brought back, the test must be changed to require
//    (1) `timer` in inject, (2) a try/catch around the whole tick body, and (3) a
//    disposer that clears the timer.
{
  const injectLine = /export const inject = \[([^\]]*)\]/.exec(index)?.[1] ?? ''
  assert.equal(
    injectLine.includes("'agents'"),
    false,
    'agents must not be injected: it was only used by the crash-causing poll',
  )
  assert.equal(
    injectLine.includes("'timer'"),
    false,
    'timer must not be injected: its absence was the exact crash',
  )
  assert.equal(
    /ctx\.interval\(tick, 500\)/.test(host),
    false,
    'no 500ms polling loop',
  )
  assert.equal(
    /agent\/turn-stopping/.test(host),
    false,
    'no agent/turn-stopping listener (the trigger that never fired)',
  )
  assert.equal(
    /ctx\.get\?\.\('agents'\)/.test(host),
    false,
    'no agents lookup outside an injected service',
  )
  checks.push('the crash-causing agent poll is gone and cannot silently return')
}

// 5. The model choice must be read from settings, not only from the patch config.
//
//    The UI persists `implicitModel` to memory/settings.json; the patch declares nothing.
//    A guard reading `config.implicitModel` is therefore always false — the picker worked,
//    the file had the value, and extraction still never ran.
{
  assert.equal(
    /engine\.settings\(\)/.test(host),
    true,
    'the guard must read engine settings',
  )
  // Both places must prefer settings: the pre-step guard and memoryCandidates. The
  // guard uses `(await engine.settings())?.implicitModel`, memoryCandidates uses
  // `settings?.implicitModel`; count both spellings rather than one literal string.
  const settingsReads =
    (host.match(/settings\?\.implicitModel/g) ?? []).length +
    (host.match(/engine\.settings\(\)[^;]*\?\.implicitModel/g) ?? []).length
  assert.equal(
    settingsReads >= 2,
    true,
    `both the guard and memoryCandidates must read settings, found ${settingsReads} use(s)`,
  )
  checks.push('the implicit-model choice is read from settings')
}

// 6. Archive/unarchive must tolerate both argument shapes.
//
//    `workspaceRegistry.unarchiveSession(sessionId)` takes the id directly;
//    `workspaceController.unarchiveSession({ sessionId })` is a Remote taking a request
//    object. Passing the wrong shape threw, the throw was caught, and the caller saw only
//    `false` — so Restore did nothing and reported success.
{
  assert.equal(
    /async #sessionFlag\(/.test(service),
    true,
    'archive/unarchive must go through the shape-tolerant helper',
  )
  assert.equal(
    /\[sessionId, extra\]\.filter\(Boolean\)/.test(service),
    true,
    'the helper must try the plain-argument shape',
  )
  assert.equal(
    /\[\{ sessionId, \.\.\.\(extra/.test(service),
    true,
    'the helper must try the request-object shape',
  )
  checks.push('archive and unarchive tolerate both argument shapes')
}

// 7. Every Host service this bundle touches must be one the Host actually publishes.
//
//    A list of the services used, cross-checked against the inspect catalogue by name.
//    This is the cheap half of the contract check: a renamed service fails here.
{
  const used = new Set()
  const PATTERN = /(?:this\.#service|this\.ctx\.get|ctx\.get)\(\s*'([A-Za-z][A-Za-z0-9]*)'\s*\)/g
  for (const text of [service, host, index]) {
    for (const match of text.matchAll(PATTERN)) used.add(match[1])
  }
  const known = new Set([
    'actionCards', 'agentDefaultModel', 'agentLoop', 'agentPresets', 'agents',
    'sessionController', 'workspaceController', 'workspaceRegistry', 'sessions',
    'llm', 'tools', 'timer', 'systemPrompt', 'sessionTitle', 'attachments',
    'pluginManager', 'remoteAccess', 'connection',
    // Optional probes: looked up behind a `?.method` guard, so a Host that does not
    // publish them degrades instead of failing. `workingDirectory` is one of these —
    // resolveCwd tries it first and falls back to the session header.
    'workingDirectory',
  ])
  const unknown = [...used].filter(name => !known.has(name))
  assert.deepEqual(unknown, [], `services not in the known catalogue: ${unknown.join(', ')}`)
  checks.push(`every Host service used is a known one (${used.size} services)`)
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
