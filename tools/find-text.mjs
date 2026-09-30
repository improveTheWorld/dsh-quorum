// Locate a literal string anywhere in a session tree, and say WHERE it lives.
//
//   node tools/find-text.mjs <session-prefix> <needle> [needle...]
//
// Written because three claims needed arbitrating at once: the torture agent
// reported failures that the protocol scorer could not see. The reason is a
// property of PTC — an inner tool failure is returned as TEXT INSIDE a
// successful `run_code` result, so it is never flagged as an error record. A
// scorer that only inspects flagged records therefore misses every failure a
// program swallowed, in both directions: it can neither confirm nor deny.
//
// This tool answers the neutral question: does the string exist, in which
// record type, in which session, and was that record flagged as failed?
import { headerOf, listSessionDirs, readSessionDir, sessionsRoot } from './session-log.mjs'
import { blocksToText, shortId } from './parse.mjs'

const [prefix, ...needles] = process.argv.slice(2)
if (prefix === undefined || needles.length === 0) {
  console.error('usage: node tools/find-text.mjs <session-prefix> <needle> [needle...]')
  process.exit(2)
}
const dirs = listSessionDirs(sessionsRoot())
const rootDir = dirs.find((d) => d.id.startsWith(prefix))
if (rootDir === undefined) {
  console.error(`no session matching ${prefix}`)
  process.exit(2)
}

const sessions = []
for (const dir of dirs) {
  let records
  try {
    records = readSessionDir(dir.dir).records
  } catch {
    continue
  }
  if (dir.id !== rootDir.id && records.find((r) => r.type === 'session')?.parentSession !== rootDir.id) continue
  sessions.push({ id: dir.id, records })
}

for (const needle of needles) {
  console.log(`\n« ${needle} »`)
  let total = 0
  for (const session of sessions) {
    const hits = []
    for (const record of session.records) {
      // The whole record is searched, not just its content: the answer to "did
      // this happen?" must not depend on which field carries it.
      const blob = JSON.stringify(record)
      if (!blob.includes(needle)) continue
      const flagged = record.data?.error !== undefined || record.data?.message?.isError === true
      hits.push(`${record.type}${flagged ? ' [ERROR FLAGGÉ]' : ''}`)
    }
    if (hits.length === 0) continue
    total += hits.length
    const kinds = [...new Set(hits)].map((h) => `${h}×${hits.filter((x) => x === h).length}`)
    console.log(`   ${shortId(session.id)} (${session.id === rootDir.id ? 'racine' : 'enfant'}) : ${kinds.join(', ')}`)
  }
  if (total === 0) console.log('   introuvable dans tout l’arbre')
  else {
    // A hit inside a successful run_code result is the PTC case worth naming.
    const insideProgram = sessions.some((s) => s.records.some((r) => r.type === 'tool/result'
      && (r.data.error === undefined && r.data.message?.isError !== true)
      && JSON.stringify(r.data).includes(needle)))
    console.log(`   total ${total} enregistrement(s)${insideProgram ? ' — dont au moins un DANS un résultat non marqué en échec (échec interne à un programme PTC)' : ''}`)
  }
}
console.log(`\n${headerOf(readSessionDir(rootDir.dir).records)?.agentPreset ?? '?'} — ${sessions.length} session(s) parcourue(s)`)
