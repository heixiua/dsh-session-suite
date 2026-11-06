/**
 * Add the `dsh-plugin` topic to the repository so dsh.so auto-indexes it.
 *
 * dsh.so's submission guide says a repository carrying the `dsh-plugin` (or `dsh-pack`)
 * topic is picked up automatically, which is the cheapest way into the index — no
 * manual submission, no waiting on review.
 *
 * The topic is set through the REST API because the local checkout has no token of its
 * own; the credential is read from git's configured helper and never written to disk.
 */

import { execFileSync } from 'node:child_process'

const OWNER = 'heixiua'
const REPO = 'dsh-session-suite'
const WANTED = ['dsh-plugin', 'dsh', 'cordis', 'session-management', 'long-term-memory']

/** Read the stored credential without persisting it. @returns {string} token */
function token() {
  const raw = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const match = /^password=(.+)$/m.exec(raw)
  if (!match) throw new Error('no GitHub credential available from the git helper')
  return match[1].trim()
}

const AUTH = {
  Authorization: `Bearer ${token()}`,
  'User-Agent': 'dsh-session-suite',
  Accept: 'application/vnd.github+json',
}

/** @param {string} path @param {object} [init] @returns {Promise<any>} */
async function api(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { ...AUTH, ...(init.headers ?? {}) },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}

const before = await api(`/repos/${OWNER}/${REPO}/topics`)
console.log(`current topics: ${before.names.length ? before.names.join(', ') : '(none)'}`)

// PUT replaces the whole set, so the existing names must be carried over.
const next = [...new Set([...before.names, ...WANTED])]
const result = await api(`/repos/${OWNER}/${REPO}/topics`, {
  method: 'PUT',
  body: JSON.stringify({ names: next }),
})
console.log(`topics now   : ${result.names.join(', ')}`)
console.log(`added        : ${next.filter(name => !before.names.includes(name)).join(', ') || '(nothing new)'}`)
