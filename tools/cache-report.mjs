/**
 * Prompt-cache hit rate across one session, from its durable log.
 *
 * `assistant/message` carries the authoritative accounting: `inputTokens` is the
 * uncached remainder and `cacheReadTokens` is what the provider served from
 * cache, so the prompt size is their sum and the hit rate is the cached share of
 * that sum.
 *
 * Usage: node tools/cache-report.mjs [sessionIdPrefix] [--tail N]
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const SESSIONS = path.join(os.homedir(), '.dsh', 'sessions')
const args = process.argv.slice(2)
const tailAt = args.indexOf('--tail')
const tail = tailAt >= 0 ? Number(args[tailAt + 1]) : 30
const wanted = args.find((arg, index) => !arg.startsWith('--') && !(tailAt >= 0 && index === tailAt + 1))

/** @returns {Promise<object[]>} session logs, newest first */
async function sessionLogs() {
  const out = []
  for (const group of await fs.readdir(SESSIONS, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupPath = path.join(SESSIONS, group.name)
    for (const entry of await fs.readdir(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(groupPath, entry.name, 'session.v4.jsonl.zstd')
      try {
        const stat = await fs.stat(file)
        out.push({ id: entry.name.replace(/^session-/, ''), file, mtime: stat.mtimeMs, bytes: stat.size })
      } catch {
        // session without a log
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** @param {string} file @returns {Promise<any[]>} decoded events */
async function readEvents(file) {
  const text = zlib.zstdDecompressSync(await fs.readFile(file)).toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // tolerate a torn final line
    }
  }
  return events
}

const logs = await sessionLogs()
const target = wanted ? logs.find(item => item.id.startsWith(wanted)) : logs[0]
if (!target) throw new Error(`no session log found${wanted ? ` matching ${wanted}` : ''}`)

const events = await readEvents(target.file)

// 1. Prompt-cache samples.
const samples = []
for (const event of events) {
  if (event?.type !== 'assistant/message') continue
  const usage = event.data?.usage
  if (!usage) continue
  const uncached = usage.inputTokens ?? 0
  const cached = usage.cacheReadTokens ?? 0
  const prompt = uncached + cached
  if (prompt <= 0) continue
  samples.push({
    seq: event.seq,
    turn: event.data?.turn,
    step: event.data?.step,
    prompt,
    cached,
    uncached,
    hit: cached / prompt,
  })
}

if (samples.length === 0) throw new Error('no assistant/message usage records found')

// 2. What happened to the context between samples: a compaction resets the
//    prefix, and every reset costs the whole cached prefix.
const compactions = []
for (const event of events) {
  if (event?.type === 'compaction/summary') {
    const data = event.data ?? {}
    compactions.push({
      seq: event.seq,
      turn: data.turn,
      shadowedSeqs: data.shadowedSeqs?.length ?? data.shadowedRange ? 'range' : 0,
      shadowedTokens: data.shadowedTokenCount ?? 0,
      trigger: data.trigger ?? data.reason,
    })
  }
}
const prunes = events.filter(event => event?.type === 'compaction/prune').length

const recent = samples.slice(-tail)
const rows = recent.map((sample, index) => ({
  n: samples.length - recent.length + index + 1,
  seq: sample.seq,
  turn: sample.turn,
  step: sample.step,
  prompt: sample.prompt,
  cached: sample.cached,
  uncached: sample.uncached,
  hitPct: Number((sample.hit * 100).toFixed(1)),
}))

// 3. Steps where the cached prefix was lost while the prompt did not shrink:
//    that is the signature of a rewritten prefix, not of growth.
const resets = []
for (let index = 1; index < samples.length; index += 1) {
  const prev = samples[index - 1]
  const now = samples[index]
  const lost = prev.cached - now.cached
  if (lost > 5000 && now.prompt >= prev.prompt * 0.5) {
    resets.push({
      seq: now.seq,
      turn: now.turn,
      step: now.step,
      cachedLost: lost,
      prompt: now.prompt,
      hitFrom: Number((prev.hit * 100).toFixed(1)),
      hitTo: Number((now.hit * 100).toFixed(1)),
    })
  }
}

const first = samples[0]
const last = samples[samples.length - 1]
const peak = samples.reduce((best, sample) => (sample.hit > best.hit ? sample : best), samples[0])
const meanHit = samples.reduce((sum, sample) => sum + sample.hit, 0) / samples.length
const meanHitRecent = recent.reduce((sum, sample) => sum + sample.hit, 0) / recent.length

console.log(
  JSON.stringify(
    {
      ok: true,
      session: target.id,
      attempts: samples.length,
      firstHitPct: Number((first.hit * 100).toFixed(1)),
      peakHitPct: Number((peak.hit * 100).toFixed(1)),
      peakSeq: peak.seq,
      lastHitPct: Number((last.hit * 100).toFixed(1)),
      meanHitPct: Number((meanHit * 100).toFixed(1)),
      meanHitRecentPct: Number((meanHitRecent * 100).toFixed(1)),
      promptNow: last.prompt,
      compactions: compactions.length,
      prunes,
      prefixResets: resets.length,
      resets: resets.slice(-10),
      trend: rows,
    },
    null,
    2,
  ),
)
