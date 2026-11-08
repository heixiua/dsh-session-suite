import fs from 'node:fs'

const file = 'D:/AI agent cache/dsh/profiles/desktop/node_modules/dsh-llm-fallbacks/dist/index.js'
const source = fs.readFileSync(file, 'utf8')

// applyPending decides WHEN a committed fallback is applied. The user's symptom is
// "after a failure the model does not change", which would follow if the pending
// decision is consumed at a turn/step boundary that never comes.
const at = source.indexOf('applyPending')
let i = at
let n = 0
while (i !== -1 && n < 5) {
  console.log(`\n=== applyPending @ ${i} ===`)
  console.log(source.slice(Math.max(0, i - 300), i + 1100))
  i = source.indexOf('applyPending', i + 1)
  n += 1
}
