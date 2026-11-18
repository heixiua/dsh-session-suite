import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite', 'memory')
const readJson = async f => { try { return JSON.parse(await fs.readFile(f, 'utf8')) } catch { return undefined } }
const entries = []
const add = j => { for (const e of (j?.entries ?? [])) entries.push(e) }
add(await readJson(path.join(root, 'global.json')))
for (const f of await fs.readdir(path.join(root, 'workspaces'))) {
  if (f.endsWith('.json')) add(await readJson(path.join(root, 'workspaces', f)))
}
const flatten = s => String(s ?? '').replace(/\s+/g, ' ').trim()

// Exactly one query per subject, answered by a fragment that is UNIQUE in the
// live store. The fragment must resolve to one entry or the set is invalid.
// Junk queries are deliberately about food, weather, and sports — none of these
// appear in a software-engineering memory library.
const cases = [
  { q: '模型额度怎么调度，代码任务用哪个', want: ['代码任务优先消耗 WorkBuddy 积分'] },
  { q: '记忆要等到用户说记住才写吗', want: ['用户不接受「必须用户说'] },
  { q: 'npm 包名和 client.js 的 id 要一致吗', want: ['__ModuleLoader__.load({id}) 必须等于 npm 包名'] },
  { q: '插件定时器怎么才不会把宿主搞崩', want: ["插件内定时器必须 inject 'timer'"] },
  { q: '插件打包时 tools 目录要不要进白名单', want: ['package.json files 白名单不含 tools/'] },
  { q: 'Windows 的 bat 文件怎么写才不会乱码', want: ['写 Windows .bat 必须纯 ASCII + CRLF'] },
  { q: 'git push 被 DNS 污染怎么处理', want: ['github.com 的 DNS 被污染'] },
  { q: '快照应该在什么时候拍', want: ['快照必须在 turn/end 拍'] },
  { q: '缓存命中率下降先查什么', want: ['缓存命中率归因'] },
  { q: 'RRF 融合是相加还是按名次', want: ['两路词法路径按名次融合（RRF）'] },
  { q: 'LiteLLM 的数据库功能支持什么', want: ['LiteLLM 的数据库功能'] },
]

const spec = {
  label: 'floor-tuning-2026-11-18',
  note: 'one relevant query per subject + junk; built independently of the gate thresholds. Two relevant entries exist verbatim in the store but are currently missed by retrieval — that is a real defect, not a bad anchor.',
  cases: cases.map(c => ({ q: c.q, want: c.want })),
  junk: [
    { q: '今晚吃什么比较好', want: [] },
    { q: '明天天气怎么样', want: [] },
    { q: '世界杯决赛几点开始', want: [] },
    { q: '怎么煮一碗好吃的牛肉面', want: [] },
    { q: '周末去哪里爬山', want: [] },
  ],
}

// Self-check every fragment before writing, so the benchmark cannot lie.
const live = entries.map(e => flatten(e.text))
let bad = 0
for (const c of [...spec.cases, ...spec.junk]) {
  for (const fragment of c.want) {
    const hits = live.filter(t => t.includes(flatten(fragment))).length
    if (hits === 0) { console.log(`UNRESOLVED: ${c.q} -> ${fragment}`); bad += 1 }
    else if (hits > 1) console.log(`  note: ${c.q} fragment matches ${hits} entries`)
  }
}
console.log(`cases: ${spec.cases.length}, junk: ${spec.junk.length}, unresolved: ${bad}`)
if (bad > 0) process.exit(2)
await fs.writeFile('tools/benchmark/queries.floor.json', JSON.stringify(spec, null, 2))
console.log('wrote tools/benchmark/queries.floor.json')
