import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const files = [
  'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize\\client.js',
  'D:\\AI agent cache\\dsh\\profiles\\desktop\\node_modules\\@heixui\\dsh-session-suite\\client.js',
]

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
  const stat = fs.statSync(file)
  console.log(`${hash}  ${(stat.size / 1024).toFixed(0)} KB  ${stat.mtime.toISOString().slice(11, 19)}  ${file}`)
  console.log(`  has extractionNoTrace: ${text.includes('extractionNoTrace')}`)
  console.log(`  has extractionRegistered: ${text.includes('extractionRegistered')}`)
}

// Are they identical?
const a = fs.readFileSync(files[0], 'utf8')
const b = fs.readFileSync(files[1], 'utf8')
console.log(`\nidentical: ${a === b}`)

// And does the profile copy have the render site (not just the dictionary)?
const renderSite = "h('span', null, t('memory.extractionNoTrace'))"
console.log(`profile copy has render site: ${b.includes(renderSite)}`)
console.log(`repo copy has render site   : ${a.includes(renderSite)}`)
