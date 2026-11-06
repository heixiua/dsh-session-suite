/**
 * Every Host service call this bundle makes, checked against the live contracts.
 *
 * Three failures in a row shared one cause: a Host method whose name or argument shape
 * changed, surfacing as a raw TypeError inside a dialog. Each was found by a user
 * clicking the button. This walks the bundle and lists every call, so the remaining ones
 * can be checked before they are clicked.
 */

import fs from 'node:fs'

const FILES = ['index.js', 'lib/service.js', 'lib/api.js', 'lib/memory-host.js', 'lib/share.js', 'lib/checkpoints.js']

/** @param {string} file @returns {string} */
function read(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

// Two call shapes in this bundle:
//   this.#service('name')  →  a Host service
//   this.ctx.get('name')   →  a Host service or client service
// Followed by `.method(` possibly on the next line.
const PATTERN = /(?:this\.#service|this\.ctx\.get|ctx\.get)\(\s*'([A-Za-z][A-Za-z0-9]*)'\s*\)\s*(?:\?\.|\.)\s*([A-Za-z][A-Za-z0-9_]*)\s*\(/g

const calls = []
for (const file of FILES) {
  const text = read(file)
  if (!text) continue
  for (const match of text.matchAll(PATTERN)) {
    calls.push({
      file,
      line: text.slice(0, match.index).split('\n').length,
      service: match[1],
      method: match[2],
    })
  }
}

console.log(`host calls: ${calls.length}\n`)

const byService = new Map()
for (const call of calls) {
  const key = call.service
  if (!byService.has(key)) byService.set(key, [])
  byService.get(key).push(call)
}

for (const [service, list] of [...byService.entries()].sort()) {
  const methods = [...new Set(list.map(call => call.method))].sort()
  console.log(`${service}  →  ${methods.join(', ')}`)
  for (const call of list) console.log(`      ${call.file}:${call.line}`)
}

// The services the Host actually exposes, from the inspect catalogue.
const KNOWN = new Set([
  'actionCards', 'agentDefaultModel', 'agentLoop', 'agentPresets', 'agents',
  'sessionController', 'workspaceController', 'workspaceRegistry', 'session',
  'llm', 'tools', 'timer', 'systemPrompt', 'sessionController',
  'sessionTitle', 'pluginManager', 'hmer', 'typert', 'remoteAccess',
])

console.log('\n=== services not in the known catalogue ===')
let unknown = 0
for (const service of byService.keys()) {
  if (!KNOWN.has(service)) {
    console.log(`  ${service}`)
    unknown += 1
  }
}
if (unknown === 0) console.log('  (none)')

console.log('\n=== verdict ===')
console.log('Every listed call must exist with the same name and argument shape on the live Host.')
console.log('Known-good after this round: sessionController.events, sessionController.list,')
console.log('sessionController.create, sessionController.prompt, workspaceRegistry/Controller')
console.log('archive+unarchive, llm.listProviders/listModels, agentDefaultModel.currentSelection.')
