/**
 * Run one real maintenance pass over the live stores and print the result.
 *
 * This is the manual equivalent of the 30-minute timer, so the effect is
 * verifiable on demand instead of waiting for the interval to elapse.
 *
 * Usage: node tools/maintain-now.mjs [cwd]
 */

import path from 'node:path'
import os from 'node:os'
import { MemoryEngine } from '../lib/memory-engine.js'

// MemoryEngine appends `memory` itself, so the root here is the storage root,
// not the memory directory. Passing the memory directory in double-nests it.
const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const cwd = process.argv[2] ?? process.cwd()

const engine = new MemoryEngine({ root, config: {} })
const report = await engine.maintain(cwd)

const global = await engine.list({ scope: 'global' })
const workspace = await engine.list({ cwd, scope: 'workspace' })

console.log(
  JSON.stringify(
    {
      ok: true,
      cwd,
      workspaceKey: MemoryEngine.workspaceKey(cwd),
      report,
      globalEntries: global.length,
      workspaceEntries: workspace.length,
      sample: workspace.slice(0, 3).map(entry => ({
        kind: entry.kind,
        state: entry.state,
        score: entry.score,
        summary: Boolean(entry.summary),
        text: entry.text.slice(0, 40),
      })),
    },
    null,
    2,
  ),
)
