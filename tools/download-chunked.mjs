/**
 * Chunked resumable download.
 *
 * A single 324 MB stream over this network keeps stalling: the first attempt died at
 * 125.8 MB after 1542 s, and a resume via curl sat at the same byte for 33 minutes
 * without erroring. Both tools wait on one long-lived connection, so one bad moment
 * costs the whole transfer.
 *
 * This fetches fixed-size byte ranges with an explicit Range header, one at a time,
 * appending to a `.part` file. A range that fails is retried independently; the
 * progress already written is never lost, and a slow server only slows the current
 * chunk instead of the whole file.
 *
 * Usage: node tools/download-chunked.mjs <url> <output> [--chunk=8388608]
 */

import fs from 'node:fs'

const url = process.argv[2]
const output = process.argv[3]
const chunkArg = process.argv.find(arg => arg.startsWith('--chunk='))
const CHUNK = chunkArg ? Number(chunkArg.slice('--chunk='.length)) : 8 * 1024 * 1024

if (!url || !output) {
  console.error('usage: node tools/download-chunked.mjs <url> <output> [--chunk=bytes]')
  process.exit(1)
}

const partFile = `${output}.part`

/** Total size from a HEAD, following redirects. @returns {Promise<number>} bytes */
async function totalSize() {
  const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`HEAD ${response.status}`)
  const length = Number(response.headers.get('content-length'))
  if (!Number.isFinite(length) || length <= 0) throw new Error('no content-length')
  return length
}

/** @param {number} start @param {number} end @returns {Promise<Buffer>} bytes */
async function fetchRange(start, end) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { Range: `bytes=${start}-${end}` },
    // A stalled socket must fail rather than hang forever; 120 s per chunk is
    // generous for 8 MB even on a slow link.
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

const total = await totalSize()
console.log(`total ${(total / 1048576).toFixed(1)} MB, chunk ${(CHUNK / 1048576).toFixed(0)} MB`)

// Resume from whatever the .part file already holds.
let written = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0
if (written > total) {
  console.log('partial file is larger than the total; starting over')
  fs.rmSync(partFile, { force: true })
  written = 0
}
console.log(`resuming at ${(written / 1048576).toFixed(1)} MB`)

const started = Date.now()
let stalls = 0

while (written < total) {
  const start = written
  const end = Math.min(total - 1, start + CHUNK - 1)
  let bytes
  try {
    bytes = await fetchRange(start, end)
  } catch (error) {
    stalls += 1
    console.log(`  chunk ${(start / 1048576).toFixed(1)} MB failed (${error.name}); retry ${stalls}`)
    if (stalls > 40) throw new Error(`giving up after ${stalls} failed chunks`)
    // Back off a little, then retry the SAME range — nothing is lost.
    await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 2000 * stalls)))
    continue
  }
  if (bytes.length === 0) {
    stalls += 1
    await new Promise(resolve => setTimeout(resolve, 2000))
    continue
  }
  stalls = 0
  fs.appendFileSync(partFile, bytes)
  written += bytes.length
  const pct = ((written / total) * 100).toFixed(1)
  const mbps = written / 1048576 / ((Date.now() - started) / 1000 + 0.001)
  console.log(`  ${(written / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} (${pct}%)  ${mbps.toFixed(2)} MB/s`)
}

fs.renameSync(partFile, output)
console.log(`done: ${output} (${(fs.statSync(output).size / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s)`)
