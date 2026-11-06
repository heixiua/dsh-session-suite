/**
 * The orphan sweep must find dead sessions and must not touch live ones.
 *
 * `#prune` runs only when a session takes another snapshot, so a deleted session's
 * directory — index, manifests, blobs — is never revisited. This test pins the two
 * properties that matter:
 *
 *   1. a directory whose session no longer exists is reported (and removed when asked);
 *   2. a directory whose session still exists is left alone.
 *
 * The live set is supplied rather than discovered on purpose: the store must not guess
 * at the Host's layout, and a wrong guess here deletes real data.
 *
 * Usage: node tools/selftest-orphan-sweep.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CheckpointStore } from '../lib/checkpoints.js'

const checks = []

/** @returns {Promise<string>} throwaway root */
async function freshRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'orphan-sweep-'))
}

/** Write a minimal snapshot directory for one session. @param {string} root @param {string} id session */
async function seedSession(root, id) {
  const dir = path.join(root, 'sessions', id)
  await fs.mkdir(path.join(dir, 'manifests'), { recursive: true })
  await fs.mkdir(path.join(dir, 'blobs'), { recursive: true })
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ version: 1, checkpoints: [] }), 'utf8')
  await fs.writeFile(path.join(dir, 'blobs', 'x'), 'payload', 'utf8')
}

// 1. A dead session is reported but not removed on a dry run.
{
  const root = await freshRoot()
  const store = new CheckpointStore({ root, config: {} })
  await seedSession(root, 'live-one')
  await seedSession(root, 'dead-one')

  const live = new Set(['live-one'])
  const result = await store.sweepOrphans({ liveSessionIds: live, apply: false })
  assert.deepEqual(result.orphans, ['dead-one'], `dry run must report only the dead session, got ${result.orphans}`)
  assert.equal(result.removed, 0, 'a dry run must not delete anything')
  assert.equal(result.bytes > 0, true, 'a dry run must still report reclaimable size')
  assert.equal(
    await fs.stat(path.join(root, 'sessions', 'dead-one', 'index.json')).then(() => true).catch(() => false),
    true,
    'a dry run must leave the directory on disk',
  )
  checks.push('a dry run reports orphans without deleting them')
  await fs.rm(root, { recursive: true, force: true })
}

// 2. Apply removes the dead session and keeps the live one.
{
  const root = await freshRoot()
  const store = new CheckpointStore({ root, config: {} })
  await seedSession(root, 'live-one')
  await seedSession(root, 'dead-one')

  const result = await store.sweepOrphans({ liveSessionIds: new Set(['live-one']), apply: true })
  assert.equal(result.removed, 1, `expected one removal, got ${result.removed}`)
  assert.equal(
    await fs.stat(path.join(root, 'sessions', 'dead-one')).then(() => true).catch(() => false),
    false,
    'the dead session directory must be gone',
  )
  assert.equal(
    await fs.stat(path.join(root, 'sessions', 'live-one', 'index.json')).then(() => true).catch(() => false),
    true,
    'the live session must survive',
  )
  checks.push('apply removes only the dead session')
  await fs.rm(root, { recursive: true, force: true })
}

// 3. An empty live set is refused upstream, but the store itself must be honest about
//    what it would do — so a caller that passes an empty set sees every directory as
//    an orphan. This documents the danger and keeps the guard's necessity visible.
{
  const root = await freshRoot()
  const store = new CheckpointStore({ root, config: {} })
  await seedSession(root, 'a')
  await seedSession(root, 'b')
  const result = await store.sweepOrphans({ liveSessionIds: new Set(), apply: false })
  assert.equal(result.orphans.length, 2, 'with no live ids every directory looks like an orphan')
  checks.push('the store treats every directory as an orphan when given no live ids')
  await fs.rm(root, { recursive: true, force: true })
}

// 4. The service must refuse to sweep when it cannot list live sessions.
{
  const service = await fs.readFile('lib/service.js', 'utf8')
  assert.equal(
    /could not list live sessions, so the orphan sweep was refused/.test(service),
    true,
    'the service must refuse rather than delete everything',
  )
  assert.equal(
    /sweepOrphans\(\{ liveSessionIds: live, apply \}\)/.test(service),
    true,
    'the service must pass the live set to the store',
  )
  checks.push('the service refuses to sweep without a trustworthy live set')
}

// 5. The API must default to a dry run.
{
  const api = await fs.readFile('lib/api.js', 'utf8')
  assert.equal(
    /service\.sweepOrphanCheckpoints\(input\.apply === true\)/.test(api),
    true,
    'apply must be opt-in, not the default',
  )
  checks.push('the API defaults to a dry run')
}

// 6. The timer must only report, never delete.
{
  const index = await fs.readFile('index.js', 'utf8')
  assert.equal(
    /sweepOrphanCheckpoints\(false\)/.test(index),
    true,
    'the timer must pass false so it cannot delete unattended',
  )
  checks.push('the timer only reports orphans')
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
