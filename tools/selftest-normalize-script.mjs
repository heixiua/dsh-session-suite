/**
 * The stored-tag normaliser must actually persist its changes.
 *
 * The first version of tools/normalize-stored-tags.mjs edited an in-memory entry
 * and then re-read the file before writing, which discarded the edit: the run
 * reported success and the `DSH` tag was still there afterwards. The unit tests
 * for lib/tags.js could not catch that, because the bug was in the script's
 * file handling, not in the vocabulary. This exercises the script against a
 * throwaway store.
 *
 * Usage: node tools/selftest-normalize-script.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const checks = []

// The script resolves its store from os.homedir(), so point HOME-shaped env at a
// temporary directory. os.homedir() honours USERPROFILE on Windows and HOME
// elsewhere; both are set so the test is platform-independent.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'normalize-'))
const memoryRoot = path.join(sandbox, '.dsh', 'storages', 'dsh-session-suite', 'memory')
const workspaces = path.join(memoryRoot, 'workspaces')
fs.mkdirSync(workspaces, { recursive: true })

const storeFile = path.join(workspaces, 'aaaa0000bbbb1111.json')
const seed = {
  version: 2,
  scope: 'workspace',
  workspaceKey: 'aaaa0000bbbb1111',
  cwd: 'D:\\ws',
  entries: [
    {
      id: 'mem_1',
      text: '一条测试记忆',
      tags: ['DSH', '降级链', 'dsh-llm-fallbacks', '插件'],
      kind: 'fact',
      state: 'active',
      createdAt: 1,
      lastAccessAt: 1,
      accessCount: 1,
    },
    {
      id: 'mem_2',
      text: '另一条测试记忆',
      tags: ['错误教训', '快照'],
      kind: 'fact',
      state: 'active',
      createdAt: 2,
      lastAccessAt: 2,
      accessCount: 1,
    },
  ],
}
fs.writeFileSync(storeFile, JSON.stringify(seed, null, 2), 'utf8')

const env = { ...process.env, USERPROFILE: sandbox, HOME: sandbox }
const run = args => execFileSync(process.execPath, ['tools/normalize-stored-tags.mjs', ...args], {
  encoding: 'utf8',
  env,
  stdio: 'pipe',
})

// 1. A dry run must not modify the file.
{
  const before = fs.readFileSync(storeFile, 'utf8')
  const out = run([])
  assert.equal(out.includes('dry run only'), true, 'a bare run must be a dry run')
  assert.equal(fs.readFileSync(storeFile, 'utf8'), before, 'a dry run must not write')
  checks.push('a dry run leaves the store untouched')
}

// 2. --apply must actually persist the normalised tags. This is the regression.
{
  const out = run(['--apply'])
  assert.equal(out.includes('rewrote'), true, 'apply must report a rewrite')
  const after = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  const first = after.entries.find(entry => entry.id === 'mem_1')
  const second = after.entries.find(entry => entry.id === 'mem_2')
  assert.deepEqual(first.tags, ['dsh', 'dsh-llm-fallbacks'], `mem_1 tags not persisted: ${JSON.stringify(first.tags)}`)
  assert.deepEqual(second.tags, ['错误教训'], `mem_2 tags not persisted: ${JSON.stringify(second.tags)}`)
  checks.push('--apply persists the normalised tags')
}

// 3. No tagged entry may keep a casing collision after the pass.
{
  const after = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  const seen = new Map()
  for (const entry of after.entries) {
    for (const tag of entry.tags ?? []) {
      const key = tag.toLowerCase()
      if (!seen.has(key)) seen.set(key, new Set())
      seen.get(key).add(tag)
    }
  }
  const collisions = [...seen].filter(([, set]) => set.size > 1)
  assert.equal(collisions.length, 0, `casing collisions remain: ${JSON.stringify(collisions.map(([k, v]) => [k, [...v]]))}`)
  checks.push('no casing collision survives the pass')
}

// 4. A second pass is a no-op: normalisation is idempotent end to end, so the
//    tool is safe to run again without churning the library.
{
  const before = fs.readFileSync(storeFile, 'utf8')
  const out = run(['--apply'])
  assert.equal(out.includes('nothing to do'), true, 'a second pass must find nothing to change')
  assert.equal(fs.readFileSync(storeFile, 'utf8'), before, 'a no-op pass must not rewrite the file')
  checks.push('a second pass is a no-op')
}

// 5. A backup is written before the rewrite, so a bad normalisation is
//    recoverable.
{
  const backups = path.join(memoryRoot, 'backups')
  assert.equal(fs.existsSync(backups), true, 'apply must create a backup directory')
  const stamps = fs.readdirSync(backups)
  assert.equal(stamps.length >= 1, true, 'at least one backup stamp must exist')
  const backed = path.join(backups, stamps[0], path.basename(storeFile))
  assert.equal(fs.existsSync(backed), true, 'the store file must be backed up before rewriting')
  checks.push('the store is backed up before rewriting')
}

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
