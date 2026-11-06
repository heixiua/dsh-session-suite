import fs from 'node:fs'

const source = fs.readFileSync('client.js', 'utf8')
const at = source.indexOf("t('memory.extractionNoTrace')")

// Print the element from its opening `h('div'` to the closing, with brackets
// balanced, so the argument list can be inspected for a missing comma or a stray
// nested element that React would treat as a child.
const openDiv = source.lastIndexOf("h(\n                'div',", at)
const start = openDiv >= 0 ? openDiv : at - 200

let depth = 0
let end = start
for (let i = start; i < source.length; i += 1) {
  const ch = source[i]
  if (ch === '(') depth += 1
  else if (ch === ')') {
    depth -= 1
    if (depth === 0) {
      end = i + 1
      break
    }
  }
}

const block = source.slice(start, end)
console.log(`block length: ${block.length}`)
console.log(block)
