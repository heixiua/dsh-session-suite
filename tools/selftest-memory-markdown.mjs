/**
 * Portable memory Markdown export — contract tests.
 *
 * Pure function, no Host/filesystem needed. Run: node tools/selftest-memory-markdown.mjs
 */
import assert from 'node:assert/strict'
import { renderMemoryMarkdown } from '../lib/memory-markdown.js'

const ENTRY = (over = {}) => ({ id: 'x', text: '一条记忆', createdAt: 1794000000000, tags: [], ...over })
const STORE = entries => ({ version: 2, entries })

let n = 0
const check = (name, fn) => { fn(); n++; console.log(`  ok ${n} ${name}`) }

check('renders both sections and a stable header', () => {
  const { body } = renderMemoryMarkdown({ exportedAt: 1794000000000, workspaceLabel: 'D:/proj' })
  assert.match(body, /^# DSH 长期记忆导出/)
  assert.match(body, /## 全局记忆/)
  assert.match(body, /## 工作区：D:\/proj/)
  assert.match(body, /`D:\/proj`/)
  assert.match(body, /2026-11-/)
})

check('includes internal (the default privacy level)', () => {
  const { body, stats } = renderMemoryMarkdown({ global: { live: STORE([ENTRY({ text: '默认 internal 事实', privacy: 'internal' })]) } })
  assert.match(body, /默认 internal 事实/)
  assert.equal(stats.shown, 1)
  assert.equal(stats.withheld, 0)
})

check('never emits a secret: not text, not id, not a named placeholder', () => {
  const { body, stats } = renderMemoryMarkdown({
    global: { live: STORE([
      ENTRY({ id: 'sec_1', text: 'sk-THIS_MUST_NEVER_APPEAR', privacy: 'secret' }),
      ENTRY({ text: '正常事实' }),
    ]) },
  })
  assert.doesNotMatch(body, /THIS_MUST_NEVER_APPEAR/)
  assert.doesNotMatch(body, /sec_1/)
  assert.match(body, /正常事实/)
  assert.equal(stats.shown, 1)
  assert.equal(stats.withheld, 1)
})

check('public entries are kept and marked', () => {
  const { body } = renderMemoryMarkdown({ global: { live: STORE([ENTRY({ text: '公开', privacy: 'public' })]) } })
  assert.match(body, /公开/)
  assert.match(body, /`public`/)
})

check('cold/archived entries travel and are labelled', () => {
  const { body, stats } = renderMemoryMarkdown({
    workspace: { cold: STORE([ENTRY({ text: '冷归档事实' })]) },
  })
  assert.match(body, /冷归档事实/)
  assert.match(body, /`archived`/)
  assert.equal(stats.shown, 1)
})

check('pinned / tags / date are rendered; pipes are escaped', () => {
  const { body } = renderMemoryMarkdown({
    global: { live: STORE([ENTRY({
      text: 'A | B 换行\n第二行',
      frozen: true,
      tags: ['踩坑', 'dsh'],
      createdAt: 1794000000000,
    })]) },
  })
  assert.match(body, /A \| B 换行 第二行/)
  assert.match(body, /`pinned`/)
  assert.match(body, /`踩坑`/)
  assert.match(body, /`dsh`/)
  assert.match(body, /`\d{4}-\d{2}-\d{2}`/)
})

check('skips empty/non-object rows without inflating the count', () => {
  const { stats } = renderMemoryMarkdown({
    global: { live: STORE([null, 42, ENTRY({ text: '  ' }), ENTRY({ text: '有效' })]) },
  })
  assert.equal(stats.shown, 1)
})

check('empty library says so instead of rendering a blank file', () => {
  const { body, stats } = renderMemoryMarkdown({})
  assert.match(body, /_（无）_/)
  assert.equal(stats.shown, 0)
  assert.equal(stats.withheld, 0)
})

check('withheld count aggregates across all four stores', () => {
  const secret = ENTRY({ text: '机密', privacy: 'secret' })
  const { stats } = renderMemoryMarkdown({
    global: { live: STORE([secret]), cold: STORE([secret]) },
    workspace: { live: STORE([secret]), cold: STORE([secret]) },
  })
  assert.equal(stats.withheld, 4)
  assert.equal(stats.shown, 0)
})

check('fileName is date-stamped and .md', () => {
  const { fileName } = renderMemoryMarkdown({ exportedAt: 1794000000000 })
  assert.match(fileName, /^dsh-memory-\d{4}-\d{2}-\d{2}\.md$/)
})

check('full-backup mode: one section per workspace, no cwd needed', () => {
  const { body, stats } = renderMemoryMarkdown({
    global: { live: STORE([ENTRY({ text: '全局事实' })]) },
    workspaces: [
      { label: 'D:/a', live: STORE([ENTRY({ text: 'A 的事实' })]), cold: STORE([ENTRY({ text: 'A 的归档' })]) },
      { label: 'D:/b', live: STORE([ENTRY({ text: 'B 的事实', privacy: 'secret' })]) },
    ],
  })
  assert.match(body, /全部 2 个/)
  assert.match(body, /## 工作区：D:\/a/)
  assert.match(body, /## 工作区：D:\/b/)
  assert.match(body, /A 的事实/)
  assert.match(body, /A 的归档/)
  assert.doesNotMatch(body, /B 的事实/)
  assert.equal(stats.shown, 3)
  assert.equal(stats.withheld, 1)
})

console.log(`\n${n} checks passed`)
