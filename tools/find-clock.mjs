// Which sessions received a clock reading, and under what record shape?
//
//   node tools/find-clock.mjs
//
// Written because the audit's detector looked for `source.plugin ===
// 'time-context'` on a `user/message` and found nothing while a reading was
// demonstrably visible in the UI. Either the reading lands in a different
// session, under a different record type, or with a different source shape — and
// guessing which has already cost this project two wrong conclusions.
import { listSessionDirs, readSessionDir, sessionsRoot } from './session-log.mjs'
import { blocksToText, shortId } from './parse.mjs'

const dirs = listSessionDirs(sessionsRoot())
let total = 0
console.log(`balayage de ${dirs.length} sessions\n`)
for (const dir of dirs) {
  let records
  try {
    records = readSessionDir(dir.dir).records
  } catch {
    continue
  }
  const hits = records.filter((r) => JSON.stringify(r).includes('Time sampled'))
  if (hits.length === 0) continue
  total += hits.length
  const shapes = new Map()
  for (const hit of hits) {
    const key = `${hit.type} | source=${JSON.stringify(hit.data?.source ?? null).slice(0, 90)}`
    shapes.set(key, (shapes.get(key) ?? 0) + 1)
  }
  console.log(`${dir.id}  —  ${hits.length} lecture(s)`)
  for (const [shape, count] of shapes) console.log(`   ×${count}  ${shape}`)
  const last = hits[hits.length - 1]
  console.log(`   dernier extrait : ${blocksToText(last.data?.content).replace(/\s+/g, ' ').slice(0, 150)}`)
  console.log('')
}
console.log(`total : ${total} lecture(s) sur ${dirs.length} sessions`)
if (total === 0) console.log('aucune lecture : le plugin est actif mais n’a encore rien annoté')
