/**
 * Attribute prompt-cache misses to the provider that served each request.
 *
 * Cache is an endpoint-local resource: a prefix cached by one provider is
 * invisible to another. This report segments a session's `assistant/message`
 * usage records by the provider recorded on the preceding `request/header`, so a
 * hit-rate drop can be attributed either to a provider switch or to something
 * that rewrites the prefix within a single provider (a compaction).
 *
 * Usage: node tools/cache-by-provider.mjs [sessionIdPrefix]
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const SESSIONS = path.join(os.homedir(), '.dsh', 'sessions')
const wanted = process.argv.slice(2).find(arg => !arg.startsWith('--'))

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
        out.push({ id: entry.name.replace(/^session-/, ''), file, mtime: stat.mtimeMs })
      } catch {
        // session without a log
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

const logs = await sessionLogs()
const target = wanted ? logs.find(item => item.id.startsWith(wanted)) : logs[0]
if (!target) throw new Error('no session log found')

const text = zlib.zstdDecompressSync(await fs.readFile(target.file)).toString('utf8')
const events = text
  .split('\n')
  .filter(Boolean)
  .map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  })
  .filter(Boolean)

// Track the provider in force at each point in the log.
let current = 'unknown'
const byProvider = new Map()
const series = []

for (const event of events) {
  if (event.type === 'request/header') {
    const config = event.data?.header?.config
    if (config?.provider) current = config.provider
    continue
  }
  if (event.type === 'model/selection') {
    const provider = event.data?.provider
    if (provider) current = provider
    continue
  }
  if (event.type === 'compaction/summary') {
    series.push({ kind: 'compaction', seq: event.seq, provider: current })
    continue
  }
  if (event.type !== 'assistant/message') continue
  const usage = event.data?.usage
  if (!usage) continue
  const uncached = usage.inputTokens ?? 0
  const cached = usage.cacheReadTokens ?? 0
  const prompt = uncached + cached
  if (prompt <= 0) continue

  const bucket = byProvider.get(current) ?? { provider: current, steps: 0, cached: 0, prompt: 0, zeroSteps: 0, maxPrompt: 0 }
  bucket.steps += 1
  bucket.cached += cached
  bucket.prompt += prompt
  bucket.maxPrompt = Math.max(bucket.maxPrompt, prompt)
  if (cached === 0) bucket.zeroSteps += 1
  byProvider.set(current, bucket)

  series.push({ kind: 'step', seq: event.seq, provider: current, prompt, cached })
}

const providers = [...byProvider.values()]
  .map(bucket => ({
    provider: bucket.provider,
    steps: bucket.steps,
    zeroCacheSteps: bucket.zeroSteps,
    hitPct: Number(((bucket.cached / bucket.prompt) * 100).toFixed(1)),
    promptTokens: bucket.prompt,
    cachedTokens: bucket.cached,
    maxPrompt: bucket.maxPrompt,
  }))
  .sort((a, b) => b.steps - a.steps)

// Contiguous segments: a switch is a boundary, and the first few steps after it
// are the ones that would rebuild cache if the new provider cached at all.
const segments = []
for (const item of series) {
  const last = segments[segments.length - 1]
  if (last && last.provider === item.provider && item.kind === 'step' && last.open) {
    last.endSeq = item.seq
    last.steps += 1
    last.cached += item.cached
    last.prompt += item.prompt
    continue
  }
  if (item.kind === 'step') {
    segments.push({
      provider: item.provider,
      startSeq: item.seq,
      endSeq: item.seq,
      steps: 1,
      cached: item.cached,
      prompt: item.prompt,
      open: true,
    })
  } else {
    if (segments.length) segments[segments.length - 1].open = false
  }
}

const compactSegments = segments.map(segment => ({
  provider: segment.provider,
  seqRange: `${segment.startSeq}-${segment.endSeq}`,
  steps: segment.steps,
  hitPct: segment.prompt > 0 ? Number(((segment.cached / segment.prompt) * 100).toFixed(1)) : 0,
}))

console.log(JSON.stringify({ ok: true, session: target.id, providers, segments: compactSegments }, null, 2))
