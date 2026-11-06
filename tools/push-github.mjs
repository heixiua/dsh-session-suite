/**
 * Push the current HEAD to GitHub over the REST Git Data API.
 *
 * `git push` over https://github.com is intermittently unreachable on this network
 * (SNI filtering), but api.github.com stays reachable, so commits are rebuilt
 * server-side instead: blobs -> tree -> commit -> ref update.
 *
 * The previous version rebuilt only HEAD and required the remote tree to equal the
 * local PARENT tree. That works for a single new commit and breaks for anything else:
 * after one successful run the remote holds a commit object this checkout does not
 * have (same content, different sha), so the next run sees "remote is not the local
 * parent" and refuses forever. It also could not push two commits.
 *
 * This version walks the commits the remote is missing, rebuilds each one in order,
 * and moves the ref once at the end. When the remote and local trees disagree it
 * checks whether the remote's CONTENT is already contained in the local history; if
 * it is, the divergent remote commits are superseded and the update is safe.
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
 * `ls-tree` otherwise wraps non-ASCII and, on some configurations, directory paths in
 * double quotes, which corrupts the path sent to the API.
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

const AUTH = {
  Authorization: `Bearer ${token()}`,
  'User-Agent': 'dsh-session-suite',
  Accept: 'application/vnd.github+json',
}

/** @param {string} path @param {object} [init] fetch init @returns {Promise<any>} parsed JSON */
async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...AUTH, ...(init.headers ?? {}) } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}

const head = git('rev-parse', 'HEAD')

const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
const remoteSha = ref.object.sha

/** @param {string} sha commit @returns {string} tree */
const treeOf = sha => git('show', '-s', '--format=%T', sha)

// Everything the remote is missing, oldest first.
const missing = git('rev-list', '--reverse', `${remoteSha}..HEAD`)
  .split('\n')
  .filter(Boolean)

console.log(`local HEAD  ${head}`)
console.log(`remote      ${remoteSha}`)
console.log(`commits to push: ${missing.length}`)

if (missing.length === 0) {
  console.log('nothing to push: remote already has this history')
  process.exit(0)
}

// Is the remote's content already somewhere in our history? If so its commits are
// duplicates of ours under different shas, and superseding them loses nothing.
const remoteTree = treeOf(remoteSha)
const localTrees = new Set(git('log', '--format=%T', `--max-count=200`).split('\n').filter(Boolean))
if (!localTrees.has(remoteTree)) {
  throw new Error(
    `refusing to push: the remote tree ${remoteTree} appears nowhere in the local history. ` +
      'The remote has content this checkout does not contain; reconcile manually.',
  )
}
console.log(`remote content is already in local history (tree ${remoteTree.slice(0, 8)}) — safe to supersede`)

if (dryRun) {
  console.log(`dry run: would push ${missing.length} commit(s) and move ${BRANCH}`)
  process.exit(0)
}

/**
 * Rebuild one commit on the server.
 *
 * Uploading every blob for every commit would be wasteful, so the tree is built by
 * diffing against the parent: GitHub reuses an existing blob when its sha matches,
 * and uploading the whole tree lets the API do that de-duplication itself.
 *
 * @param {string} sha local commit
 * @param {string} parent server-side parent sha
 * @returns {Promise<string>} server-side commit sha
 */
async function pushCommit(sha, parent) {
  const message = git('log', '-1', '--format=%B', sha)
  const files = gitRaw('ls-tree', '-r', '-z', '--full-tree', sha)
    .split('\0')
    .filter(Boolean)

  const entries = []
  for (const line of files) {
    const tab = line.indexOf('\t')
    const [mode, type, blobSha] = line.slice(0, tab).split(' ')
    const path = line.slice(tab + 1)
    if (type !== 'blob') continue
    const content = execFileSync('git', ['cat-file', '-p', blobSha], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    })
    const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
    })
    entries.push({ path, mode, type: 'blob', sha: blob.sha })
  }

  const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree: entries }),
  })
  const expected = treeOf(sha)
  if (tree.sha !== expected) {
    throw new Error(`uploaded tree ${tree.sha} does not match local tree ${expected} for ${sha}`)
  }

  const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }),
  })
  console.log(`  ${sha.slice(0, 8)} -> ${commit.sha.slice(0, 8)}  (${entries.length} files)`)
  return commit.sha
}

let cursor = remoteSha
for (const sha of missing) {
  cursor = await pushCommit(sha, cursor)
}

await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: cursor, force: true }),
})
console.log(`pushed ${BRANCH} -> ${cursor}`)

// The rebuilt commit has a different sha from the local one (the committer differs),
// so report both rather than implying they match.
console.log(
  JSON.stringify({ ok: true, localHead: head, remoteHead: cursor, commits: missing.length }, null, 2),
)
