/**
 * Build sample export artifacts for visual inspection (development only).
 *
 * It synthesises a small conversation that exercises the Markdown subset, writes
 * `tools/preview/export.html` through the real Host renderer, and writes the
 * pre-parsed block document the browser canvas needs.
 *
 * Run: node tools/preview-export.mjs
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { renderBlockDoc, renderHtmlFromDoc } from '../lib/share.js'

const sessionId = 'session-preview-0000'
const title = 'Plugin market and session suite notes'

const userText = [
  '帮我把插件市场的索引源问题看一下，然后顺便确认会话套件的导出效果。',
  '',
  '要求：',
  '- 支持 **Markdown** 渲染',
  '- 图片也要像 `豆包` 那样',
  '- 不要丢掉列表和引用',
].join('\n')

const answerText = [
  '## 结论',
  '',
  '索引源读取失败是因为 `market.index` 字段被清空了，恢复默认即可。',
  '',
  '### 具体步骤',
  '',
  '1. 打开设置里的 **插件** 页面',
  '2. 在「市场」分组点 **恢复默认索引**',
  '3. 重新进入 Discover 标签页',
  '',
  '> 注意：自定义索引源会覆盖默认值，恢复前先截图备份。',
  '',
  '下面是修复前后的对比代码：',
  '',
  '```js',
  'const sources = config.market?.index ?? []',
  'if (sources.length === 0) await restoreDefaultIndex()',
  '```',
  '',
  '其余细节可以看 [官方文档](https://example.com/docs)，或者直接问我。',
  '',
  '| 项 | 状态 |',
  '| --- | --- |',
  '| 索引源 | 已恢复 |',
].join('\n')

const events = [
  { type: 'turn/start', seq: 1, time: 1793413600000, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 2,
    time: 1793413601000,
    data: { id: 'm-u1', role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } },
  },
  {
    type: 'assistant/message',
    seq: 3,
    time: 1793413602000,
    data: { turn: 1, step: 1, message: { id: 'm-a1', role: 'assistant', content: [{ type: 'text', text: '先看一下配置。' }] } },
  },
  {
    type: 'assistant/message',
    seq: 4,
    time: 1793413603000,
    data: {
      turn: 1,
      step: 2,
      message: {
        id: 'm-a2',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'internal' },
          { type: 'tool-call', id: 'call_1', name: 'grep', arguments: '{"pattern":"market.index"}' },
        ],
      },
    },
  },
  {
    type: 'assistant/message',
    seq: 5,
    time: 1793413604000,
    data: { turn: 1, step: 3, message: { id: 'm-a3', role: 'assistant', content: [{ type: 'text', text: answerText }] } },
  },
  { type: 'turn/end', seq: 6, time: 1793413605000, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 7, time: 1793413700000, data: { turn: 2 } },
  {
    type: 'user/message',
    seq: 8,
    time: 1793413701000,
    data: { id: 'm-u2', role: 'user', content: [{ type: 'text', text: '导出的时候能把**两轮**都带上吗？' }], source: { kind: 'user' } },
  },
  {
    type: 'assistant/message',
    seq: 9,
    time: 1793413702000,
    data: {
      turn: 2,
      step: 1,
      message: {
        id: 'm-a4',
        role: 'assistant',
        content: [{ type: 'text', text: '可以，默认就全选；取消勾选即可排除某一轮。\n\n- 图片：一张 PNG\n- 网页：单文件 HTML\n- 文本：剪贴板' }],
      },
    },
  },
  { type: 'turn/end', seq: 10, time: 1793413703000, data: { turn: 2, reason: { kind: 'completed' } } },
  { type: 'session/title', seq: 11, time: 1793413704000, data: { title } },
]

const outDir = path.join(import.meta.dirname, 'preview')
await fs.mkdir(outDir, { recursive: true })

// Attach a real screenshot from this machine's attachment store, so the preview
// exercises image layout (aspect ratio, cap, rounding) instead of a marker.
const doc = renderBlockDoc({ sessionId, title, events })
const attachments = path.join(os.homedir(), '.dsh', 'attachments', 'v1', 'objects')
let shot
try {
  for (const bucket of await fs.readdir(attachments)) {
    for (const file of await fs.readdir(path.join(attachments, bucket))) {
      const full = path.join(attachments, bucket, file)
      const info = await fs.stat(full)
      if (!info.isFile() || info.size < 20000 || info.size > 400000) continue
      const head = await fs.readFile(full)
      if (head[0] !== 0x89 || head[1] !== 0x50) continue
      shot = `data:image/png;base64,${head.toString('base64')}`
      break
    }
    if (shot) break
  }
} catch {
  shot = undefined
}
if (shot && doc.messages[0]) doc.messages[0].images = [{ dataUrl: shot, name: 'shot.png' }]

const html = renderHtmlFromDoc(doc)
await fs.writeFile(path.join(outDir, 'export.html'), html, 'utf8')
await fs.writeFile(path.join(outDir, 'blocks.json'), JSON.stringify(doc, null, 2), 'utf8')

const clientSource = await fs.readFile(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')
const rendererStart = clientSource.indexOf('async function renderConversationImage(')
const rendererEnd = clientSource.indexOf('function ShareDialog(')
if (rendererStart < 0 || rendererEnd < 0) throw new Error('renderer not found in client.js')
const rendererSource = clientSource.slice(rendererStart, rendererEnd)

const harness = `<!doctype html>
<html><head><meta charset="utf-8"><title>image preview</title>
<style>body{margin:0;background:#888;padding:20px;color:#fff;font:14px sans-serif}canvas{display:block;margin:0 auto;box-shadow:0 8px 30px rgba(0,0,0,.3)}img{display:block;margin:0 auto;width:880px;box-shadow:0 8px 30px rgba(0,0,0,.3)}#log{margin:0 0 16px;white-space:pre-wrap}pre{background:#300;padding:12px;white-space:pre-wrap}</style>
</head><body>
<div id="log">booting…</div>
<script id="blocks" type="application/json">${JSON.stringify(doc).replace(/</g, '\\u003c')}</script>
<script id="renderer" type="text/plain">${rendererSource.replace(/<\/script>/gi, '<\\/script>')}</script>
<script>
(async () => {
  const log = message => { document.getElementById('log').textContent = String(message) }
  try {
    const doc = JSON.parse(document.getElementById('blocks').textContent)
    log('blocks: ' + doc.messages.length + ' messages')
    const source = document.getElementById('renderer').textContent
    const render = new Function(source + '\\n;return renderConversationImage')()
    const blob = await render({
      title: doc.title,
      meta: '2 轮 · 4 条消息 · 导出于 2026-10-31 22:40',
      footer: 'DeepSeek Harness · dsh-session-suite',
      messages: doc.messages,
    })
    log('png bytes: ' + blob.size)
    const img = new Image()
    img.src = URL.createObjectURL(blob)
    await img.decode()
    document.body.appendChild(img)
    log('rendered ' + img.width + '×' + img.height)
  } catch (error) {
    log('ERROR: ' + (error && error.stack ? error.stack : error))
  }
})()
</script>
</body></html>`
await fs.writeFile(path.join(outDir, 'image.html'), harness, 'utf8')

console.log(JSON.stringify({ ok: true, outDir, blocks: doc.messages.length }))
