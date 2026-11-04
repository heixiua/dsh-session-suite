/**
 * Small, dependency-free helpers used by both the snapshot engine and the
 * HTTP surface of dsh-session-suite.
 *
 * Everything here is plain Node: the Host half of a DSH plugin is an ordinary
 * ESM module running in the Electron main process, so `node:` builtins are the
 * only imports allowed (no @deepseek-ai runtime packages are resolved for a
 * profile-installed bundle).
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Directories and files a checkpoint never records. */
export const DEFAULT_IGNORES = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.pnpm-store',
  '.pnpm',
  '.yarn',
  '.cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'out',
  'coverage',
  '.idea',
  '.vscode',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  '*.tmp',
  '*.temp',
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.dsh-ignore',
]

const LOCKFILE_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'])

/**
 * Glob-ish ignore matcher: exact segment, `*` prefix/suffix patterns, and
 * bare `*.ext` suffixes. Matching is applied to every path segment.
 *
 * @param {readonly string[]} patterns ignore patterns
 * @returns {(relPath: string, name: string) => boolean} predicate
 */
export function createIgnoreMatcher(patterns) {
  const segments = new Set()
  const suffixes = []
  for (const raw of patterns) {
    const pattern = raw.trim()
    if (!pattern) continue
    if (pattern.startsWith('*.')) suffixes.push(pattern.slice(1).toLowerCase())
    else if (pattern.startsWith('*')) suffixes.push(pattern.slice(1).toLowerCase())
    else segments.add(pattern)
  }
  return (relPath, name) => {
    if (segments.has(name)) return true
    const lower = name.toLowerCase()
    for (const suffix of suffixes) {
      if (lower.endsWith(suffix)) return true
    }
    if (LOCKFILE_NAMES.has(name)) return true
    // `.git` nested inside an allowed directory is still ignored.
    return relPath.split('/').some(part => part === '.git' || part === 'node_modules')
  }
}

/** @param {Buffer} data content */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** @param {string} text content */
export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Deterministic short id, independent of `crypto.randomUUID` availability.
 *
 * @param {string} seed seed material
 * @returns {string} 12-char id
 */
export function shortId(seed) {
  return sha256Text(`${seed}:${process.hrtime.bigint()}`).slice(0, 12)
}

/** @param {string} dir directory to create */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * @param {string} file target file
 * @returns {Promise<unknown | undefined>} parsed JSON, or undefined when absent/corrupt
 */
export async function readJson(file) {
  try {
    const text = await fs.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Atomic JSON write (temp file + rename) so a crash never truncates state.
 *
 * @param {string} file target file
 * @param {unknown} value JSON-serializable value
 */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, file)
}

/** @param {number} bytes raw size */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

/**
 * Look like a binary blob? A NUL byte within the first 8 KiB is the classic
 * signal, and we also refuse files the design explicitly excludes.
 *
 * @param {Buffer} head first bytes of the file
 * @returns {boolean} true when the file must be skipped
 */
export function looksBinary(head) {
  return head.includes(0)
}

/**
 * Remove a directory tree without throwing when it is already gone.
 *
 * @param {string} dir directory
 */
export async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/**
 * @param {string} file file
 * @returns {Promise<{ size: number, mtimeMs: number } | undefined>} stat or undefined
 */
export async function statOrUndefined(file) {
  try {
    return await fs.stat(file)
  } catch {
    return undefined
  }
}

/** @param {number} ms delay */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Bound concurrency without pulling in a dependency.
 *
 * @template T, R
 * @param {readonly T[]} items inputs
 * @param {number} limit parallelism
 * @param {(item: T, index: number) => Promise<R>} worker per-item work
 * @returns {Promise<R[]>} results in input order
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Normalize a workspace-relative path to forward slashes.
 *
 * @param {string} rel relative path
 * @returns {string} normalized
 */
export function toPosix(rel) {
  return rel.split(path.sep).join('/')
}

/** @param {string} value unknown value */
export function asString(value) {
  return typeof value === 'string' ? value : undefined
}

/**
 * Is this step message something the user actually typed?
 *
 * `role === 'user'` is not enough. The harness injects its own pipeline
 * messages with that role — `runtime-context`, `time-context`, `skill-catalog`,
 * `agent-message` — and compaction adds a synthetic `user/message` with
 * `source.kind === 'compact-checkpoint'`. A plugin that reads instructions out
 * of "user" messages will therefore read its own prompt text back, because
 * whatever it injects is delivered inside a `runtime-context` message.
 *
 * That is not hypothetical: scanning runtime-context messages made this bundle
 * parse the `【记住：…】` example in its own instruction footer as a user command,
 * 154 times, and store a memory whose entire body was the ellipsis placeholder.
 *
 * @param {any} message step message
 * @returns {boolean} whether the message is user-authored
 */
export function isUserAuthored(message) {
  if (message?.role !== 'user') return false
  const source = typeof message.source === 'object' && message.source ? message.source : undefined
  return source?.kind === undefined || source.kind === 'user'
}

/**
 * Is a captured value real content rather than a placeholder?
 *
 * A placeholder is worth rejecting explicitly because the value came out of a
 * regex over text that may include our own examples. `【记住：…】` yields `…`,
 * which is a non-empty string and would otherwise sail straight into the store.
 *
 * @param {unknown} value captured value
 * @returns {boolean} whether it is worth storing
 */
export function isMeaningfulText(value) {
  const text = String(value ?? '').trim()
  // One character carries no recoverable meaning, and punctuation/symbol-only
  // values are placeholders by construction.
  if (text.length < 2) return false
  return /[\p{L}\p{N}]/u.test(text)
}
