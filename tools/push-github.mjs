/**
 * Push the current HEAD to GitHub over the REST Git Data API.
 *
 * `git push` over https://github.com is intermittently unreachable on this
 * network (SNI filtering), but api.github.com stays reachable, so the commit is
 * rebuilt server-side instead: blobs -> tree -> commit -> ref update.
 *
 * The local HEAD tree and the remote tree are compared first; the push refuses
 * unless the remote is exactly the local HEAD's parent tree, which is what makes
 * a force update safe.
 *
 * Usage: node tools/push-github.mjs [--dry-run]
 * Reads the credential from git's configured helper; never writes it to disk.
 */

import { execFileSync } from 'node:child_process'

const API = 'https://api.github.com'
const OWNER = 'heixiua'
const REPO = 'dsh-session-suite'
const BRANCH = 'main'
const dryRun = process.argv.includes('--dry-run')

/** @param {string[]} args git arguments @returns {string} stdout */
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

/**
 * Run git with path quoting disabled.
 *
 * `ls-tree` otherwise wraps non-ASCII and, on some configurations, directory
 * paths in double quotes, which corrupts the path sent to the API.
 *
 * @param {string[]} args git arguments @returns {string} stdout
 */
function gitRaw(...args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { encoding: 'utf8' })
}

/** Read the stored credential without persisting it anywhere. */
function token() {
  const raw = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const match = /^password=(.+)$/m.exec(raw)
  if (!match) throw new Error('no GitHub credential available from the git helper')
  return match[1].trim()
}

const AUTH = { Authorization: `Bearer ${token()}`, 'User-Agent': 'dsh-session-suite', Accept: 'application/vnd.github+json' }

/** @param {string} path @param {object} [init] fetch init @returns {Promise<any>} parsed JSON */
async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...AUTH, ...(init.headers ?? {}) } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}

const head = git('rev-parse', 'HEAD')
const headTree = git('show', '-s', '--format=%T', 'HEAD')
const parent = git('rev-parse', 'HEAD~1')
const parentTree = git('show', '-s', '--format=%T', 'HEAD~1')
const message = git('log', '-1', '--format=%B', 'HEAD')

console.log(JSON.stringify({ head, headTree, parent, parentTree }, null, 2))

const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
const remoteSha = ref.object.sha
const remoteCommit = await api(`/repos/${OWNER}/${REPO}/git/commits/${remoteSha}`)
const remoteTree = remoteCommit.tree.sha
console.log(JSON.stringify({ remoteSha, remoteTree }, null, 2))

if (remoteTree !== parentTree) {
  throw new Error(
    `refusing to push: remote tree ${remoteTree} is not the local parent tree ${parentTree}. ` +
      'The remote has commits this checkout does not contain; reconcile before pushing.',
  )
}

if (dryRun) {
  console.log('dry run: remote matches the local parent, a fast-forward is safe')
  process.exit(0)
}

// Upload every file in the HEAD tree as a blob.
const files = gitRaw('ls-tree', '-r', '-z', '--full-tree', 'HEAD')
  .split('\0')
  .filter(Boolean)
const entries = []
for (const line of files) {
  const tab = line.indexOf('\t')
  const meta = line.slice(0, tab).split(' ')
  const [mode, type, sha] = meta
  const path = line.slice(tab + 1)
  if (type !== 'blob') continue
  const content = execFileSync('git', ['cat-file', '-p', sha], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  })
  entries.push({ path, mode, type: 'blob', sha: blob.sha })
  console.log(`blob ${path} -> ${blob.sha.slice(0, 8)}`)
}

const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ tree: entries }),
})
console.log(`tree ${tree.sha} (${entries.length} files)`)

if (tree.sha !== headTree) {
  throw new Error(`uploaded tree ${tree.sha} does not match local tree ${headTree}`)
}

const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: tree.sha, parents: [remoteSha] }),
})
console.log(`commit ${commit.sha}`)

await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: false }),
})
console.log(`pushed ${BRANCH} -> ${commit.sha}`)

console.log(JSON.stringify({ ok: true, head, remoteSha, commit: commit.sha, files: entries.length }, null, 2))
