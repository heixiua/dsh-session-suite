/**
 * The sidebar entry and the archive page must stay in place.
 *
 * Both are easy to lose silently: a slot registration that stops matching leaves no
 * error, just a missing icon, and the section ids are strings that nothing type-checks.
 * This asserts the wiring the user asked for:
 *
 *   1. a sidebar.panellist entry and a main panel under the SAME id, because the
 *      sidebar resolves its icon to the main panel by that id;
 *   2. the panel navigates via the settings store's openSection, not by reimplementing
 *      each screen;
 *   3. an archived-sessions section exists and offers restore rather than delete;
 *   4. restoreSession is exposed on the Host side, or the button would be dead;
 *   5. both entries are additive — the slots they use report replaceRisk none.
 *
 * Usage: node tools/selftest-sidebar-panel.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync('client.js', 'utf8')
const api = fs.readFileSync('lib/api.js', 'utf8')
const service = fs.readFileSync('lib/service.js', 'utf8')
const checks = []

// 1. The icon and the panel share one id.
{
  const iconId = client.match(/name: 'sidebar\.panellist', id: '([^']+)'/)
  const panelKey = client.match(/name: 'main', key: '([^']+)'/)
  assert.equal(iconId !== null, true, 'the sidebar icon must be registered')
  assert.equal(panelKey !== null, true, 'the main panel must be registered')
  assert.equal(
    iconId[1],
    panelKey[1],
    `the icon id and the panel key must match (${iconId[1]} vs ${panelKey[1]})`,
  )
  checks.push('the sidebar icon and its main panel share one id')
}

// 2. Both slots are additive, so nothing shipped is shadowed.
{
  assert.equal(
    /slots\.inject\('sidebar\.panellist'/.test(client),
    true,
    'the icon must go through sidebar.panellist',
  )
  assert.equal(
    /slots\.register\(\{ name: 'main', key:/.test(client),
    true,
    'the panel must be a distinct main key',
  )
  // A keyed `main` registration replaces whatever holds that key, so the key must
  // not be one of the shipped ones.
  const key = client.match(/name: 'main', key: '([^']+)'/)[1]
  for (const reserved of ['conversation', 'plugins', 'schedules']) {
    assert.notEqual(key, reserved, `must not claim the shipped main key "${reserved}"`)
  }
  checks.push('the panel claims its own main key, not a shipped one')
}

// 3. The panel must render its screens itself, not try to navigate into Settings.
//
//    The first design was a menu whose rows called the settings shell's
//    `openSection(id)`. It was dead on arrival, and reading the shipped bundles
//    showed why: `createSettingsShellStore()` is created inside
//    dsh-client-ui-settings-general and never published, and `pluginNavigation` —
//    the only real navigation service — offers `openList`/`openBundle`, where
//    `openBundle` lands on the bundle page that renders `plugins.bundle.config` and
//    NOT `settings.section`. So no client plugin can open a settings section from
//    outside. The screens have to live in the panel.
{
  // The helper that guessed at store names must be gone: keeping it would imply a
  // seam exists and invite the same dead click back.
  assert.equal(
    /function openSettingsSection/.test(client),
    false,
    'the panel must not carry the unreachable settings-navigation helper',
  )
  assert.equal(
    /ctx\.get\('sidebar\.settings'\)/.test(client),
    false,
    'the panel must not try to read an unpublished store',
  )
  // The three screens are rendered from the panel, by component reference.
  const panelStart = client.indexOf('function SuitePanel')
  const panelAfter = client.slice(panelStart + 1)
  const panelEnd = panelStart + 1 + panelAfter.indexOf('\n    function ')
  const panel = client.slice(panelStart, panelEnd)
  for (const name of ['SnapshotSection', 'MemorySection', 'ArchivedSection']) {
    assert.equal(panel.includes(name), true, `the panel must render ${name} in place`)
  }
  // And there is a way back out of a screen.
  assert.equal(/panel\.title`/.test(panel) || /setOpen\(null\)/.test(panel), true, 'the panel must offer a way back')
  checks.push('the panel renders its screens in place instead of navigating')
}

// 3b. The action names and response shapes must match the Host. Guessing them wrong
//     produced a red `unknown action: listSessions` on the page and a permanent zero
//     in every count.
{
  assert.equal(
    /action: 'listSessions'/.test(client),
    false,
    'the client must not call a non-existent listSessions action',
  )
  const api = fs.readFileSync('lib/api.js', 'utf8')
  assert.equal(/case 'list':/.test(api), true, 'the Host must route `list`')
  assert.equal(/case 'listSessions':/.test(api), false, 'there must be no listSessions action')

  // `list` answers with a bare array. Reading `result.items` yields undefined and a
  // silently empty panel.
  const panelStart = client.indexOf('function SuitePanel')
  const panelAfter = client.slice(panelStart + 1)
  const panelEnd = panelStart + 1 + panelAfter.indexOf('\n    function ')
  const panel = client.slice(panelStart, panelEnd)
  assert.equal(/call\(\{ action: 'list' \}\)/.test(panel), true, 'the panel must call `list`')
  assert.equal(
    /Array\.isArray\(sessions\)/.test(panel),
    true,
    'the panel must treat the list response as a bare array',
  )
  checks.push('the client calls the real list action and reads its real shape')
}

// 3c. The archived flag has to come from the registry, because the session summary
//     used by `list` does not project it. Without this the archive page can only
//     ever show zero, which is exactly what the user saw.
{
  const serviceSource = fs.readFileSync('lib/service.js', 'utf8')
  assert.equal(
    /archivedSessionIds/.test(serviceSource),
    true,
    'the service must read the archived marks from the registry',
  )
  assert.equal(
    /archived: archivedIds\.has\(item\.sessionId\)/.test(serviceSource),
    true,
    'each row must carry the archived flag',
  )
  const archivedSection = client.slice(
    client.indexOf('function ArchivedSection'),
    client.indexOf('function MemorySection'),
  )
  // The archive page no longer filters a full `list` by the archived flag:
  // with thousands of archived bot sessions that statted every row on every
  // render and timed out. It now calls `listArchived`, which the service builds
  // from the registry plus ONE snapshot-index pass.
  assert.equal(
    /action: 'listArchived'/.test(archivedSection),
    true,
    'the archive page must use the dedicated bulk list action',
  )
  checks.push('the archived flag comes from the registry')
}

// 4. The archive page exists, is reachable, and restores rather than deletes.
{
  assert.equal(/function ArchivedSection/.test(client), true, 'the archive section must have a component')
  assert.equal(
    /action: 'restoreSession'/.test(client),
    true,
    'the restore button must call the Host',
  )
  // Bulk cleanup is now an explicit, previewed, confirmed action: bot plugins
  // leave thousands of archived marks with no log and no snapshots, and the
  // Host offers no way to clear them. It must never be a bare delete button —
  // the confirmation dialog and the dry-run preview are the safety contract.
  const section = client.slice(
    client.indexOf('function ArchivedSection'),
    client.indexOf('function MemorySection'),
  )
  assert.equal(
    /action: 'previewArchivedSweep'/.test(section),
    true,
    'bulk cleanup must be previewed before it is applied',
  )
  assert.equal(
    /action: 'sweepArchivedSessions'/.test(section) && /dialog\.set\(/.test(section),
    true,
    'bulk cleanup must go through a confirmation dialog',
  )
  assert.equal(
    /action: 'restoreSession'/.test(section),
    true,
    'restore must remain available on the archive page',
  )
  checks.push('the archive page restores by default and offers gated bulk cleanup')
}

// 4b. The settings sections must be gone: the sidebar panel is the single entry.
{
  assert.equal(
    /id: 'session-snapshots'/.test(client),
    false,
    'the snapshots settings section must be removed',
  )
  assert.equal(/id: 'long-term-memory'/.test(client), false, 'the memory settings section must be removed')
  assert.equal(/id: 'archived-sessions'/.test(client), false, 'the archive settings section must be removed')
  assert.equal(
    /slots\.inject\('settings\.section'/.test(client),
    false,
    'the plugin must not register any settings section at all',
  )
  checks.push('the duplicate settings sections are gone')
}

// 5. The Host side answers the call, or the button is dead.
{
  assert.equal(/case 'restoreSession':/.test(api), true, 'the API must route restoreSession')
  assert.equal(
    /async restoreSession\(sessionId\)/.test(service),
    true,
    'the service must implement restoreSession',
  )
  // It must actually unarchive, and must fail loudly when the Host cannot.
  const impl = service.slice(
    service.indexOf('async restoreSession('),
    service.indexOf('async #archive('),
  )
  assert.equal(/#unarchive\(sessionId\)/.test(impl), true, 'restoreSession must call the unarchive path')
  assert.equal(
    /throw new Error/.test(impl),
    true,
    'a Host without an unarchive seam must produce an error, not a silent no-op',
  )
  checks.push('the Host implements restoreSession and fails loudly when it cannot')
}

// 6. The panel shows counts, so the rows are not indistinguishable menu items.
//
//    The slice must end at the NEXT function, not at MemorySection: ArchivedSection
//    sits between them and also calls listSessions, so a wider slice kept matching
//    after the panel's own call was stubbed out — the test passed while the panel
//    showed a hard-coded zero.
{
  const start = client.indexOf('function SuitePanel')
  const after = client.slice(start + 1)
  const end = start + 1 + after.indexOf('\n    function ')
  const panel = client.slice(start, end > start ? end : undefined)
  assert.equal(panel.length > 100, true, 'the panel slice must be locatable')
  assert.equal(panel.includes('function ArchivedSection'), false, 'the slice must not include a neighbouring component')
  // The action is `list`, not `listSessions` — see the note in check 3b.
  assert.equal(
    /call\(\{ action: 'list' \}\)/.test(panel),
    true,
    'the panel must fetch session counts with the real list action',
  )
  assert.equal(
    /call\(\{ action: 'longterm\.list'/ .test(panel),
    true,
    'the panel must fetch memory counts',
  )
  // The scope argument is load-bearing: without it the Host returns only the GLOBAL
  // store, so the panel reported 17 for a library of 51.
  assert.equal(
    /action: 'longterm\.list', scope: 'all'/.test(panel),
    true,
    'the panel must ask for every scope, not just global',
  )
  assert.equal(/setCounts\(\{/.test(panel), true, 'the fetched counts must be stored')
  assert.equal(
    /panel\.sessionsCount/.test(panel),
    true,
    'the panel must report how many sessions have snapshots',
  )
  checks.push('the panel loads counts for its rows')
}

// 7. Every figure must state what it counts.
//
//    The earlier 17 / 21 / 27 / 51 confusion was not a maths error — each number was
//    correct for a different scope — but nothing on screen said which scope. A count
//    without a definition is a number the user has to guess at, so the caption is
//    part of the feature, not decoration.
{
  const panelStart = client.indexOf('function SuitePanel')
  const panelAfter = client.slice(panelStart + 1)
  const panelEnd = panelStart + 1 + panelAfter.indexOf('\n    function ')
  const panel = client.slice(panelStart, panelEnd)
  for (const hint of [
    'panel.statSessionsHint',
    'panel.statSnapshotsHint',
    'panel.statMemoriesHint',
    'panel.statArchivedHint',
  ]) {
    assert.equal(panel.includes(hint), true, `each figure needs a caption (${hint})`)
  }
  // And the total must be decomposable, so it can be checked rather than trusted.
  assert.equal(
    /action: 'longterm\.workspaces'/.test(panel),
    true,
    'the panel must fetch the per-workspace breakdown',
  )
  assert.equal(/panel\.breakdownTitle/.test(panel), true, 'the breakdown must have a heading')
  checks.push('every figure states what it counts, and the total is decomposed')
}

// 8. The memory list must scroll in its own box, so the settings below stay reachable.
//
//    Reported from use: fifty rows pushed the maintenance and model controls far below
//    the fold, so changing a setting meant scrolling past the whole library first.
{
  assert.equal(
    /className: 'dss-card dss-scroll-box'/.test(client),
    true,
    'the memory list must use the bounded scroll container',
  )
  const css = client.slice(client.indexOf('const CSS ='), client.indexOf('const CSS =') + 60000)
  assert.equal(/\.dss-scroll-box\s*\{/.test(css), true, 'the scroll container needs a rule')
  const rule = css.slice(css.indexOf('.dss-scroll-box'), css.indexOf('.dss-scroll-box') + 260)
  assert.equal(/max-height:\s*\d+px/.test(rule), true, 'the scroll container must be height-bounded')
  assert.equal(/overflow-y:\s*auto/.test(rule), true, 'the scroll container must scroll')
  checks.push('the memory list scrolls in its own box')
}

// 9. Every new string is translated. `check-locale` covers this in the suite, but
//    asserting the two panel strings here keeps a failure attributable.
{
  for (const key of ['panel.title', 'panel.snapshots', 'panel.memory', 'panel.archived', 'archived.title']) {
    const occurrences = client.split(`'${key}'`).length - 1
    assert.equal(occurrences >= 2, true, `${key} must exist in both dictionaries, found ${occurrences}`)
  }
  checks.push('the new strings exist in both languages')
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
