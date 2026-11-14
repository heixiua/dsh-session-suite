/**
 * Mutation check for the stream guard in lib/cleanup.js (1.0.1).
 *
 * Reproduces the delete-race failure deterministically: while a hidden-session
 * sweep reads a log, that file can disappear or become unreadable. fs.ReadStream
 * then emits ENOENT / EACCES / EISDIR on the SOURCE side, and `input.pipe()`
 * does not forward source errors to the zstd transform, so readline never sees
 * them. The pre-fix reader attached no 'error' listener to `input`, so the
 * event escaped as an uncaught exception and killed the DSH host (exit 1).
 *
 * A directory named `session.v4.jsonl` produces EISDIR reliably on Windows —
 * same code path as the race's ENOENT/EACCES, but deterministic. The SAME case
 * runs against both:
 *   - d271187 (1.0.0, pre-fix)   -> MUST raise an uncaught exception
 *   - the working tree (1.0.1)   -> MUST stay quiet
 * A passing run therefore proves the regression case really catches the bug
 * and that the guard actually fixes it.
 *
 * Corrupt zstd FRAMES alone do NOT reproduce this, and that is measured, not
 * assumed: a broken magic at offset 0 is forwarded by readline into the
 * iterator's catch (both versions survive), while trailing damage is never
 * reached because the reader destroys the source as soon as it has the header.
 * Verified on Node 22.22.2 and Node 24.21.0. Recorded here so nobody "fixes"
 * this test back into a false negative.
 *
 * Fixed ref, not HEAD, so this keeps working after the fix is committed.
 * Per project rule: real .mjs file, never an inline `node -e` in PowerShell.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REF = process.env.DSS_MUTATION_REF ?? 'd271187'
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const tempModule = path.join(root, 'lib', '_mutation_head_cleanup.js')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-mutation-'))

let uncaught = 0
let tag = ''
const onUncaught = (error) => {
  uncaught += 1
  console.log(`  [${tag}] uncaught: ${error?.code ?? error?.message}`)
}
process.on('uncaughtException', onUncaught)

/** Build a throwaway home with one log path that is a directory, then sweep. */
async function runCase(hiddenSessions, label) {
  tag = label
  uncaught = 0
  const home = path.join(tmp, `home-${label}`)
  const sessionDir = path.join(home, 'sessions', '--proj--', 'race')
  const projDir = path.join(home, 'storages', 'session_projcache', 'sessions')
  await fs.mkdir(sessionDir, { recursive: true })
  await fs.mkdir(projDir, { recursive: true })
  // .zstd suffix matters: it makes readSessionHeader use `input.pipe(zstd)`,
  // and pipe() does not forward the source-side EISDIR to the transform.
  await fs.mkdir(path.join(sessionDir, 'session.v4.jsonl.zstd'), { recursive: true })
  await fs.writeFile(path.join(projDir, 'race.json'), JSON.stringify({
    version: 7,
    record: { rows: { sessionListMetadata: { val: { blank: true, lastPromptAt: null } } } },
  }))

  // The pre-fix reader leaves the readline iterator pending after EISDIR,
  // so never wait on it unbounded.
  await Promise.race([
    hiddenSessions(home, {
      archivedIds: [], registeredIds: [], currentSessionId: 'some-other-session',
    }).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 1500)),
  ])
  await new Promise(resolve => setTimeout(resolve, 200))
  return uncaught
}

let code = 1
try {
  const oldSource = execFileSync('git', ['show', `${REF}:lib/cleanup.js`], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  })
  assert.ok(oldSource.includes("const stream = file.endsWith('.zstd')"),
    `${REF} does not contain readSessionHeader`)
  assert.equal(oldSource.includes('const onError ='), false,
    `${REF} is not the pre-fix implementation`)
  assert.equal(oldSource.includes("input.on('error'"), false,
    `${REF} already guards the source stream`)

  // Same directory as the original so its relative `./util.js` import resolves.
  await fs.writeFile(tempModule, oldSource)
  const old = await import(pathToFileURL(tempModule).href)
  const fresh = await import('../lib/cleanup.js')

  const oldUncaught = await runCase(old.hiddenSessions, REF)
  const freshUncaught = await runCase(fresh.hiddenSessions, 'working-tree')

  assert.ok(oldUncaught > 0,
    `MUTATION FAILED: ${REF} raised no uncaught error, so the regression case cannot prove anything`)
  assert.equal(freshUncaught, 0,
    'GUARD FAILED: the working tree still lets a source-side error escape')
  console.log(`\nmutation OK: ${REF} crashes (${oldUncaught} uncaught), working tree stays quiet; the guard is real`)
  code = 0
} catch (error) {
  console.error(`\nmutation FAILED: ${error?.message ?? error}`)
} finally {
  process.off('uncaughtException', onUncaught)
  try { fsSync.rmSync(tempModule, { force: true }) } catch { /* ignore */ }
  try { await fs.rm(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
}

// The pre-fix implementation may still hold a pending stream; leave explicitly.
process.exit(code)
