// Integrity check: did a run read what it was forbidden to read?
//
//   node tools/integrity.mjs <session-prefix> [--forbid <path-fragment>...]
//   node tools/integrity.mjs <session-prefix> --list
//
// Why this exists: a prompt rule is not an enforcement mechanism. The second
// torture campaign was explicitly told not to read the scoring tooling; its own
// narration says it read `protocol.mjs` and `audit.mjs` "to learn the exact
// patterns the log must carry" — which lets a reproduction scenario be satisfied
// by printing the expected string instead of by the mode failing.
//
// Prevention is not available: the agent runs as the same OS user, so no file is
// hidden from it. What IS available is proof. Every tool call is recorded in the
// session log, so a forbidden read leaves a durable trace. This turns an
// unenforceable rule into a detectable violation, and a contaminated run into
// something that can be discarded instead of believed.
//
// Exit code 1 when the run is contaminated.
import { headerOf, listSessionDirs, readSessionDir, sessionsRoot } from './session-log.mjs'
import { shortId } from './parse.mjs'

/** Paths that reveal the expected evidence to the agent under test. */
const DEFAULT_FORBIDDEN = [
  'dsh-boost-mode',        // the scoring tooling itself
  'protocol.mjs',
  'audit.mjs',
  'parse.mjs',
  'boost-report.mjs',
  'find-text.mjs',
  'PROTOCOL.md',
  'decisions.jsonl',       // the relay's own instrumentation
  // A previous campaign's extracted evidence. Its REAL location is
  // `C:\CodeSource\boost-torture-archive\campagne-1-2-contaminees\raw-notices*` — the
  // older `boost-torture\raw-notices` has not existed for a while (`Test-Path` → False)
  // — and one SEGMENT is the only form that can match here: the comparison below is a
  // case-insensitive SUBSTRING on a re-stringified JSON argument (l. 73), and
  // `JSON.stringify` doubles every backslash, so no multi-segment Windows path can ever
  // appear literally in it. A segment matches both separators and both spellings.
  'boost-torture-archive',
]

const argv = process.argv.slice(2)
const prefix = argv.find((a) => !a.startsWith('--'))
if (prefix === undefined) {
  console.error('usage: node tools/integrity.mjs <session-prefix> [--forbid <fragment>...]')
  process.exit(2)
}
const forbidden = [...DEFAULT_FORBIDDEN]
for (let i = 0; i < argv.length; i++) if (argv[i] === '--forbid' && argv[i + 1] !== undefined) forbidden.push(argv[i + 1])

const dirs = listSessionDirs(sessionsRoot())
const rootDir = dirs.find((d) => d.id.startsWith(prefix))
if (rootDir === undefined) {
  console.error(`no session matching ${prefix}`)
  process.exit(2)
}

// The run's OWN scratch directory is legitimate: a campaign writes traces there
// by design. Only OTHER runs' directories and the scoring tooling are forbidden.
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

// Every call's ARGUMENTS are searched, not its result: the arguments are what the
// agent chose to ask for, and a refused or failed read still shows intent.
const violations = []
for (const session of sessions) {
  for (const record of session.records) {
    if (record.type !== 'tool/call') continue
    const args = JSON.stringify(record.data.arguments ?? {})
    for (const needle of forbidden) {
      const at = args.toLowerCase().indexOf(needle.toLowerCase())
      if (at === -1) continue
      violations.push({
        session: session.id,
        tool: record.data.name,
        time: record.time,
        needle,
        excerpt: args.slice(Math.max(0, at - 60), at + 80).replace(/\\n/g, ' '),
      })
    }
  }
}

const preset = headerOf(readSessionDir(rootDir.dir).records)?.agentPreset
console.log(`Intégrité du run — session ${rootDir.id} (${preset ?? '?'})`)
console.log(`${sessions.length} session(s) parcourue(s), ${forbidden.length} motif(s) interdit(s)\n`)

if (violations.length === 0) {
  console.log('PROPRE — aucun appel d’outil ne touche un chemin interdit.')
  console.log('Ce run peut être noté : ses scénarios n’ont pas pu être préparés en connaissant les motifs.')
  process.exit(0)
}

console.log(`CONTAMINÉ — ${violations.length} appel(s) d’outil visant un chemin interdit :\n`)
for (const violation of violations.slice(0, 40)) {
  const age = Math.round((Date.now() - (violation.time ?? Date.now())) / 1000)
  console.log(`  [${String(violation.tool).padEnd(22)}] ${shortId(violation.session)} il y a ${age}s`)
  console.log(`      motif « ${violation.needle} » — …${violation.excerpt}…`)
}
if (violations.length > 40) console.log(`  … et ${violations.length - 40} autre(s)`)
console.log(`\nJeter ce run, ou n’en retenir que les preuves de forme « runtime » : un agent qui connaît`)
console.log(`les motifs attendus peut les imprimer sans que le mode ait échoué.`)
process.exit(1)
