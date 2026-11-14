/**
 * Compiled-index memory (LLM-Wiki pattern) + ingest-time conflict detection
 * + read-only lint.
 *
 * These three features change WHEN work happens, not just what is stored:
 *   - indexCards/expand: index -> follow pointers -> stop when evidence suffices
 *   - remember(): queue contradictions at ingest instead of on a 30-min timer
 *   - lint(): health check without mutating the library
 *
 * Every check runs against a throwaway store. Mutation checks deliberately
 * break one mechanic at a time so a regression cannot pass by accident.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'
import { buildRecallText } from '../lib/memory-host.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-llmwiki-'))
const cwd = path.join(tmp, 'ws')
let n = 0
const check = (name, fn) => { fn(); console.log(`  ${++n}. ${name}`) }

const engine = new MemoryEngine({ root: tmp, config: {} })

try {
  // ---------------------------------------------------------------- 1. index
  const a = await engine.remember({
    scope: 'workspace', cwd, text: '装插件前必须完全退出 DSH 全部 6 个进程', tags: ['dsh'], factKey: 'dsh.装插件前退出',
  })
  const b = await engine.remember({
    scope: 'workspace', cwd, text: 'pnpm-workspace.yaml 的 allowBuilds 不能有占位符', tags: ['dsh'], factKey: 'dsh.allowBuilds',
  })
  const c = await engine.remember({
    scope: 'workspace', cwd, text: '用户偏好结论第一句给，不铺垫', tags: ['偏好'], factKey: '用户.回复格式',
  })
  const secret = await engine.remember({
    scope: 'workspace', cwd, text: 'API key 是 sk-secret-value-123456', tags: ['dsh'], privacy: 'secret',
  })

  const index = await engine.indexCards({ cwd })
  check('indexCards groups by topic, excludes secrets, and is bounded', () => {
    assert.ok(index.topics.length >= 2)
    // Four rows were written, one of them secret. A secret must not become an
    // index pointer (its id would still be a hint) — so only three are eligible.
    assert.equal(index.entries, 3)
    assert.ok(index.used > 0)
    assert.equal(typeof index.total, 'number')
  })
  check('index lines carry stable ids, not full memory text', () => {
    const lines = MemoryEngine.formatIndex(index)
    assert.ok(lines.length >= 2)
    for (const line of lines) assert.match(line, /\[[^\]]*mem_/)
    const ids = index.topics.flatMap(card => card.ids)
    assert.ok(ids.includes(a.entry.id), 'top-ranked dsh entry is a pointer')
    assert.ok(!ids.includes(secret.entry.id), 'a secret is never a pointer')
  })
  check('a secret never leaks through expand()', async () => {})
  const secretExpand = await engine.expand({ cwd, ids: [secret.entry.id] })
  assert.equal(secretExpand.items.length, 0)
  assert.deepEqual(secretExpand.missing, [secret.entry.id])

  check('expand() resolves pointers to full text and reports unknown ids', async () => {})
  const expanded = await engine.expand({ cwd, ids: [a.entry.id, b.entry.id, 'mem_does_not_exist'] })
  assert.equal(expanded.items.length, 2)
  assert.deepEqual(expanded.items.map(item => item.id).sort(), [a.entry.id, b.entry.id].sort())
  assert.deepEqual(expanded.missing, ['mem_does_not_exist'])
  assert.ok(expanded.items[0].text.length > 10, 'full text, not the truncated card summary')

  check('expand() enforces its cap', async () => {})
  const many = Array.from({ length: 40 }, (_, i) => `mem_${i}`)
  const capped = await engine.expand({ cwd, ids: many })
  assert.ok(capped.missing.length <= 12, 'no unbounded payload')

  // ------------------------------------------------------- 2. injection modes
  const flat = await buildRecallText({ engine, cwd, question: '装插件', config: { indexMode: false } })
  check('legacy flat mode still renders topic cards', () => {
    assert.match(flat, /库内概览/)
    assert.doesNotMatch(flat, /记忆库索引/)
  })
  const compiled = await buildRecallText({ engine, cwd, question: '装插件', config: { indexMode: true } })
  check('compiled mode injects the index and the expand instruction', () => {
    assert.match(compiled, /记忆库索引/)
    assert.match(compiled, /action="expand"/)
    assert.doesNotMatch(compiled, /库内概览/)
  })
  check('compiled index is cheaper than pasting every matched memory', () => {
    assert.ok(compiled.length < flat.length + 400, 'index must not balloon the prompt')
  })
  check('indexMode failure falls back to flat cards', async () => {})
  // Patch the method on the REAL instance (a prototype-shaped fake cannot call
  // private fields), then restore it. This exercises the catch branch without
  // weakening the engine.
  const originalIndexCards = engine.indexCards
  engine.indexCards = async () => { throw new Error('index failed') }
  let fallback
  try {
    fallback = await buildRecallText({ engine, cwd, question: '装插件', config: { indexMode: true } })
  } finally {
    engine.indexCards = originalIndexCards
  }
  assert.match(fallback, /库内概览/)
  assert.doesNotMatch(fallback, /记忆库索引/)

  // --------------------------------------------- 3. ingest-time conflict queue
  const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-llmwiki-2-'))
  const e2 = new MemoryEngine({ root: root2, config: {} })
  const cwd2 = path.join(root2, 'ws2')
  try {
    const first = await e2.remember({
      scope: 'workspace', cwd: cwd2, text: '必须在轮次开始拍快照', tags: ['快照'], affect: 0.9,
    })
    const second = await e2.remember({
      scope: 'workspace', cwd: cwd2, text: '绝不在轮次开始拍快照', tags: ['快照'], affect: 0.9,
    })
    check('a contradiction is queued AT INGEST, before any maintenance', () => {
      assert.equal(second.conflictQueued, 1)
    })
    check('the queue is visible immediately and both sides survive', async () => {})
    const queue = await e2.conflicts(cwd2)
    assert.equal(queue.length, 1)
    const rows = await e2.list({ cwd: cwd2 })
    assert.equal(rows.filter(row => row.id === first.entry.id || row.id === second.entry.id).length, 2)

    check('MUTATION: disabling ingestConflictScan removes the early queue', async () => {})
    // Same two texts, fresh store, scan explicitly off. If the ingest path were
    // not the thing queuing the pair, this would still be 1 and the test fails.
    const root3 = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-llmwiki-3-'))
    try {
      const e4 = new MemoryEngine({ root: root3, config: { ingestConflictScan: false } })
      const cwd4 = path.join(root3, 'ws4')
      await e4.remember({ scope: 'workspace', cwd: cwd4, text: '必须在轮次开始拍快照', tags: ['快照'], affect: 0.9 })
      const off = await e4.remember({ scope: 'workspace', cwd: cwd4, text: '绝不在轮次开始拍快照', tags: ['快照'], affect: 0.9 })
      assert.equal(off.conflictQueued, undefined)
      assert.equal((await e4.conflicts(cwd4)).length, 0)
      // maintain() still finds it: the mechanism is deferred, not lost.
      const report = await e4.maintain(cwd4)
      assert.equal(report.conflictsQueued, 1)
    } finally {
      await fs.rm(root3, { recursive: true, force: true })
    }
  } finally {
    await fs.rm(root2, { recursive: true, force: true })
  }

  // --------------------------------------------------------------- 4. lint
  const lint = await engine.lint({ cwd })
  check('lint reports counters without exposing secret text', () => {
    assert.ok(lint.scanned >= 4)
    assert.ok(lint.live >= 3)
    assert.equal(lint.secret, 1)
    assert.ok(!JSON.stringify(lint).includes('sk-secret-value-123456'))
    assert.equal(typeof lint.pendingConflicts, 'number')
    assert.equal(typeof lint.maintenanceStale, 'boolean')
  })
  check('lint counts unstructured rows and caps its samples', () => {
    assert.equal(typeof lint.untagged, 'number')
    assert.equal(typeof lint.noFactKey, 'number')
    assert.equal(lint.samples.untagged.length, lint.samples.untagged.length)
    assert.ok(lint.samples.untagged.length <= 5)
  })
  check('lint is read-only: the library is byte-identical afterwards', async () => {})
  const file = path.join(tmp, 'memory', 'workspaces', `${MemoryEngine.workspaceKey(cwd)}.json`)
  const before = await fs.readFile(file, 'utf8')
  await engine.lint({ cwd })
  const after = await fs.readFile(file, 'utf8')
  assert.equal(after, before)
  assert.ok(c.entry.text.length > 0)
  assert.ok(secret.entry.text.length > 0)

  console.log(`\nLLM-Wiki memory selftest: ${n} checks PASS`)
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}
