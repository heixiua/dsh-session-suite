/**
 * Portable Markdown rendering for long-term memory.
 *
 * Why this exists: `export()` returns a JSON structure and only includes
 * `public` entries, which is correct for a share bundle that leaves the
 * machine but useless as a readable, migratable memory file. A user who wants
 * to read their own library, move it to another agent, or keep it in git needs
 * a plain-text form. This renderer is a pure function over already-read
 * entries so it can be tested without a Host, a filesystem, or a config.
 *
 * Hard rule: a `secret` entry NEVER reaches the output. Not its text, not its
 * id, not a placeholder naming what was withheld — the count is reported only
 * as an aggregate (`withheld`). Everything else (`public` / `internal`, the
 * default) is included because the person reading this file is its owner.
 */

/** @param {unknown} v @returns {string} */
function text(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
}

/** @param {unknown} v @returns {string[]} */
function tags(v) {
  return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []
}

/** Escape a value so it cannot break out of a Markdown table cell. */
function cell(v) {
  return text(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** @param {unknown} ts @returns {string} ISO date, or '' when unknown */
function day(ts) {
  const n = typeof ts === 'number' ? ts : Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  try { return new Date(n).toISOString().slice(0, 10) } catch { return '' }
}

/**
 * One store -> a Markdown section.
 *
 * @param {object} input
 * @param {string} input.title section heading
 * @param {readonly any[]} [input.live] hot entries
 * @param {readonly any[]} [input.cold] cold/archived entries
 * @param {{ withheld: number }} tally mutated with the number of secret rows
 * @returns {{ lines: string[], shown: number }} lines plus rendered count
 */
function section({ title, live = [], cold = [] }, tally) {
  const lines = [`## ${title}`, '']
  const rows = []
  let shown = 0

  const collect = (entries, state) => {
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue
      const privacy = typeof e.privacy === 'string' ? e.privacy : 'internal'
      if (privacy === 'secret') { tally.withheld += 1; continue }
      const body = text(e.text)
      if (!body) continue
      const when = day(e.createdAt ?? e.updatedAt ?? e.occurredAt)
      const scopeTags = tags(e.tags)
      const meta = [
        when ? `\`${when}\`` : '',
        privacy === 'public' ? '`public`' : '',
        state === 'cold' ? '`archived`' : '',
        e.frozen ? '`pinned`' : '',
        ...scopeTags.map(t => `\`${t.replace(/`/g, '')}\``),
      ].filter(Boolean).join(' ')
      rows.push(`- ${body}${meta ? `  \n  ${meta}` : ''}`)
      shown += 1
    }
  }

  collect(live, 'live')
  collect(cold, 'cold')

  if (shown === 0) {
    lines.push('_（无）_', '')
    return { lines, shown }
  }
  lines.push(...rows, '')
  return { lines, shown }
}

/**
 * Render the whole library as portable Markdown.
 *
 * @param {object} input
 * @param {string} [input.workspaceLabel] human-readable workspace (cwd)
 * @param {object} [input.global] `{ live?: {entries}, cold?: {entries} }`
 * @param {object} [input.workspace] legacy single-workspace shape
 * @param {readonly {label: string, live?: object, cold?: object}[]} [input.workspaces]
 *        one section per registered workspace (full-backup mode)
 * @param {number} [input.exportedAt] epoch ms
 * @returns {{ body: string, fileName: string, stats: { shown: number, withheld: number } }}
 */
export function renderMemoryMarkdown(input = {}) {
  const exportedAt = Number.isFinite(input.exportedAt) ? input.exportedAt : Date.now()
  const iso = new Date(exportedAt).toISOString()
  const tally = { withheld: 0 }
  const entriesOf = store => (Array.isArray(store?.entries) ? store.entries : [])

  const globalLive = entriesOf(input.global?.live)
  const globalCold = entriesOf(input.global?.cold)
  const multi = Array.isArray(input.workspaces) && input.workspaces.length > 0
  const wsList = multi
    ? input.workspaces
    : [{ label: input.workspaceLabel, live: input.workspace?.live, cold: input.workspace?.cold }]

  const lines = [
    '# DSH 长期记忆导出',
    '',
    `- 导出时间：${iso}`,
    `- 来源插件：dsh-session-suite`,
    multi
      ? `- 工作区：全部 ${wsList.length} 个（每个工作区单独一节）`
      : `- 工作区：${input.workspaceLabel ? `\`${input.workspaceLabel}\`` : '（未提供，仅全局库）'}`,
    '',
    '> 这是纯文本快照，可被任意编辑器或其他 Agent 读取。',
    '> `secret` 级记忆永不导出；`archived` 为冷归档条目。',
    '> 格式稳定但**不是回导入格式**：本插件不提供从 Markdown 反向写库。',
    '',
  ]

  let shown = 0
  const g = section({ title: '全局记忆', live: globalLive, cold: globalCold }, tally)
  lines.push(...g.lines)
  shown += g.shown
  for (const ws of wsList) {
    const label = String(ws.label ?? '未命名工作区')
    const s = section({ title: `工作区：${label}`, live: entriesOf(ws.live), cold: entriesOf(ws.cold) }, tally)
    lines.push(...s.lines)
    shown += s.shown
  }
  lines.push('---', '', `- 条目：${shown}`, `- 已隐藏（secret）：${tally.withheld}`, '')

  return {
    body: lines.join('\n'),
    fileName: `dsh-memory-${iso.slice(0, 10)}.md`,
    stats: { shown, withheld: tally.withheld },
  }
}

export default renderMemoryMarkdown
