// Reconnaissance: enumerate the record types and their shapes in a session log.
// Usage: node tools/_explore-events.mjs <session-id | path-to-session-dir> [samplesPerKind]
import { readSessionDir, listSessionDirs } from './session-log.mjs'

const [, , target, sampleArg] = process.argv
const samples = Number(sampleArg ?? 1)
if (!target) {
  console.error('usage: node tools/_explore-events.mjs <session-id | session-dir> [samplesPerKind]')
  process.exit(2)
}

let dir = target
if (!target.includes('session.v4') && !target.includes('\\')) {
  const found = listSessionDirs().find((d) => d.id === target)
  if (!found) {
    console.error(`no session directory named ${target} under the sessions root`)
    process.exit(2)
  }
  dir = found.dir
}

const log = readSessionDir(dir)
console.log(`dir: ${log.dir}`)
console.log(`frames: ${log.frames}  records: ${log.records.length}  bytes: ${log.bytes}  skipped: ${log.skipped}`)

const counts = new Map()
for (const r of log.records) {
  const kind = r?.type ?? '<no type>'
  counts.set(kind, (counts.get(kind) ?? 0) + 1)
}
console.log(`\n--- ${counts.size} distinct record types ---`)
for (const [kind, count] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(count).padStart(5)}  ${kind}`)
}

const seen = new Map()
console.log('\n--- up to N samples per type (key shape only, values truncated) ---')
for (const r of log.records) {
  const kind = r?.type ?? '<no type>'
  const n = seen.get(kind) ?? 0
  if (n >= samples) continue
  seen.set(kind, n + 1)
  console.log(`\n[${kind}] keys=${Object.keys(r).join(',')}`)
  console.log(JSON.stringify(r).slice(0, 1500))
}
