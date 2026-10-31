import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const archive = args[0]
const outDir = args[1]
const filter = args[2] || ''
const listOnly = args.includes('--list')

const fd = fs.openSync(archive, 'r')
const sizeBuf = Buffer.alloc(8)
fs.readSync(fd, sizeBuf, 0, 8, 0)
const headerPickleSize = sizeBuf.readUInt32LE(4)
const headerBuf = Buffer.alloc(headerPickleSize)
fs.readSync(fd, headerBuf, 0, headerPickleSize, 8)
const strLen = headerBuf.readUInt32LE(4)
const header = JSON.parse(headerBuf.subarray(8, 8 + strLen).toString('utf8'))
const baseOffset = 8 + headerPickleSize

let count = 0
let bytes = 0
const lines = []

function walk(node, rel) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const childRel = rel ? `${rel}/${name}` : name
    if (entry.files) {
      walk(entry, childRel)
      continue
    }
    if (filter && !childRel.includes(filter)) continue
    if (entry.link) { lines.push(`link\t${childRel}\t${entry.link}`); continue }
    if (entry.offset === undefined) { lines.push(`virtual\t${childRel}`); continue }
    const size = Number(entry.size)
    lines.push(`${size}\t${childRel}`)
    if (listOnly) { count++; continue }
    const dest = path.join(outDir, childRel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const start = baseOffset + Number(entry.offset)
    const buf = Buffer.alloc(size)
    if (size > 0) fs.readSync(fd, buf, 0, size, start)
    fs.writeFileSync(dest, buf)
    count++
    bytes += size
  }
}

walk(header, '')
fs.closeSync(fd)

const listingPath = path.join(outDir || '.', 'asar-listing.txt')
if (listOnly) {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(listingPath, lines.join('\n'), 'utf8')
  console.log(JSON.stringify({ mode: 'list', entries: count, listingPath }))
} else {
  console.log(JSON.stringify({ mode: 'extract', files: count, bytes, outDir }))
}
