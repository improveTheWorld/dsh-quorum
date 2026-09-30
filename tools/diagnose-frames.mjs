// Diagnose the on-disk framing of a DSH session log.
// Usage: node tools/_explore-frames.mjs <path> [maxOffsets]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { createZstdDecompress } from 'node:zlib'

const [, , file, maxArg] = process.argv
const max = Number(maxArg ?? 8)
const buf = readFileSync(file)
console.log(`size: ${buf.length}`)

// zstd frame magic: 28 B5 2F FD ; skippable frames: 50 2A 4D 18 .. 5F
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
let at = buf.indexOf(magic, 0)
while (at !== -1) {
  offsets.push(at)
  at = buf.indexOf(magic, at + 4)
}
console.log(`frame magic occurrences: ${offsets.length}`)
console.log(`first offsets: ${offsets.slice(0, max).join(', ')}`)
console.log(`last offsets:  ${offsets.slice(-3).join(', ')}`)

console.log('\n--- head hexdump (64 bytes) ---')
console.log(buf.subarray(0, 64).toString('hex').match(/.{1,32}/g).join('\n'))

// A) one-shot on the whole buffer
try {
  console.log(`\nA) zstdDecompressSync(whole) -> ${zstdDecompressSync(buf).length} bytes`)
} catch (e) {
  console.log(`A) zstdDecompressSync(whole) threw: ${e.message}`)
}

// B) one-shot on the first frame only (up to the second magic)
if (offsets.length > 1) {
  try {
    const one = zstdDecompressSync(buf.subarray(offsets[0], offsets[1]))
    console.log(`B) frame[0] -> ${one.length} bytes: ${one.toString('utf8').slice(0, 200)}`)
  } catch (e) {
    console.log(`B) frame[0] threw: ${e.message}`)
  }
}

// C) manual frame-by-frame over detected magics
let okFrames = 0
let bytes = 0
const chunks = []
for (let i = 0; i < offsets.length; i++) {
  const start = offsets[i]
  const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
  try {
    const out = zstdDecompressSync(buf.subarray(start, end))
    okFrames++
    bytes += out.length
    chunks.push(out)
  } catch {
    /* candidate magic that was inside compressed data */
  }
}
console.log(`\nC) frame-split: ${okFrames}/${offsets.length} frames decoded, ${bytes} bytes total`)
const text = Buffer.concat(chunks).toString('utf8')
console.log(`C) newline count: ${(text.match(/\n/g) ?? []).length}`)
console.log(`C) first 300 chars:\n${text.slice(0, 300)}`)

// D) streaming decoder over the whole concatenation
await new Promise((resolve) => {
  const dec = createZstdDecompress()
  const out = []
  dec.on('data', (c) => out.push(c))
  dec.on('end', () => {
    const total = Buffer.concat(out)
    console.log(`\nD) stream decode -> ${total.length} bytes, newlines ${(total.toString('utf8').match(/\n/g) ?? []).length}`)
    resolve()
  })
  dec.on('error', (e) => {
    console.log(`\nD) stream error: ${e.message}`)
    resolve()
  })
  dec.end(buf)
})
