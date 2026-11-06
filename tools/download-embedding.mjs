/**
 * Download the ONNX build of bge-base-zh-v1.5 into the agreed D-drive location.
 *
 * huggingface.co is unreachable from this network, so the mirror is tried first
 * and the official host is kept as a fallback for networks where it works.
 *
 * The user approved: D:\AI agent cache\dsh\models\bge-base-zh-v1.5
 * Nothing is installed into the DSH profile here — only files land on disk.
 */

import fs from 'node:fs'
import path from 'node:path'

const TARGET = 'D:\\AI agent cache\\dsh\\models\\bge-base-zh-v1.5'

// Mirror first: hf-mirror.com serves the same repository layout. The official
// host is kept second so the script still works where it is reachable.
const BASES = [
  'https://hf-mirror.com/Xenova/bge-base-zh-v1.5/resolve/main',
  'https://huggingface.co/Xenova/bge-base-zh-v1.5/resolve/main',
]

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
]

fs.mkdirSync(path.join(TARGET, 'onnx'), { recursive: true })

/**
 * @param {string} name repo-relative file
 * @returns {Promise<boolean>} whether the file is on disk afterwards
 */
async function download(name) {
  const target = path.join(TARGET, name)
  if (fs.existsSync(target) && fs.statSync(target).size > 1024) {
    console.log(`skip ${name} (${(fs.statSync(target).size / 1048576).toFixed(1)} MB present)`)
    return true
  }
  for (const base of BASES) {
    const host = new URL(base).host
    try {
      const response = await fetch(`${base}/${name}?download=true`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) {
        console.log(`  ${host} -> HTTP ${response.status} for ${name}`)
        continue
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length < 64) {
        console.log(`  ${host} -> suspiciously small (${buffer.length} bytes) for ${name}`)
        continue
      }
      fs.writeFileSync(target, buffer)
      console.log(`ok   ${name}  ${(buffer.length / 1048576).toFixed(1)} MB  (from ${host})`)
      return true
    } catch (error) {
      console.log(`  ${host} -> ${error.name}: ${error.message}`)
    }
  }
  console.log(`FAIL ${name}: every mirror failed`)
  return false
}

console.log(`target: ${TARGET}`)
let failures = 0
for (const name of FILES) {
  const ok = await download(name)
  if (!ok) failures += 1
}

console.log('\n=== result ===')
const all = fs.readdirSync(TARGET, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
let total = 0
for (const entry of all) {
  const full = path.join(entry.parentPath ?? entry.path ?? TARGET, entry.name)
  try {
    total += fs.statSync(full).size
  } catch {
    /* ignore */
  }
}
console.log(`files present: ${all.length}/${FILES.length}`)
console.log(`total size   : ${(total / 1048576).toFixed(1)} MB`)
console.log(failures === 0 ? 'DOWNLOAD COMPLETE' : `DOWNLOAD INCOMPLETE — ${failures} file(s) missing`)
