// Full audit of the trace store: every check the tooling can make without being
// told what to look for.
//
//   node tools/audit.mjs                 # newest session tree with children
//   node tools/audit.mjs <session-id>    # one tree
//   node tools/audit.mjs --all           # every session, structural checks only
//
// Exit code is 1 when any check FAILs, so this can gate a workflow. WARN means
// "a human should look"; FAIL means "a report built from this would be wrong".
import { readSessionDir, headerOf, listSessionDirs, sessionsRoot } from './session-log.mjs'
import { ROLE_TOOLS, blocksToText, collectFailures, countRoleMentions, firstUuid, markersOf, parseSubagentNotice, shortId } from './parse.mjs'

const args = process.argv.slice(2)
const all = args.includes('--all')
const wanted = args.find((a) => !a.startsWith('--'))
const dirs = listSessionDirs(sessionsRoot())
const now = Date.now()

const findings = []
const check = (level, id, detail) => findings.push({ level, id, detail })

// Persona corrections that only a restarted host carries. Their absence is not a
// defect in the run — it means that session predates the change, which is
// precisely what a reader needs to know before interpreting it.
const PERSONA_SIGNATURES = [
  ['Field notes', 'bloc Field notes (M1-quinquies)'],
  ['timebox a wait', 'règle timebox insomniaque (M1-sexies)'],
  ['Read a file before you edit it', 'règle lire-avant-éditer (M1-quater)'],
  ['You do not verify your own work', 'phase 3 réécrite (M1-quater)'],
]

function load(id) {
  const dir = dirs.find((d) => d.id === id || d.id.startsWith(id))
  if (dir === undefined) return undefined
  const log = readSessionDir(dir.dir)
  return { id: dir.id, dir, mtime: dir.mtime, ...log }
}

// --------------------------------------------------------------------------
// structural sweep: every session on disk
// --------------------------------------------------------------------------
const known = new Set()
const headers = new Map()
for (const dir of dirs) {
  try {
    const header = headerOf(readSessionDir(dir.dir).records)
    if (header !== undefined) {
      known.add(dir.id)
      headers.set(dir.id, header)
    }
  } catch {
    check('fail', 'unreadable-session', `${dir.id} : en-tête illisible`)
  }
}

let emptyTails = 0
let skippedRecords = 0
for (const dir of dirs) {
  let log
  try {
    log = readSessionDir(dir.dir)
  } catch {
    continue
  }
  if (log.emptyTail === true) {
    emptyTails++
    check('warn', 'partial-tail', `${shortId(dir.id)} : dernière frame zstd vide — écriture en cours, le dernier enregistrement peut manquer`)
  }
  if (log.skipped > 0) {
    skippedRecords += log.skipped
    check('warn', 'skipped-records', `${shortId(dir.id)} : ${log.skipped} enregistrement(s) illisible(s)`)
  }
}

const orphans = []
for (const [id, header] of headers) {
  if (header.parentSession !== undefined && !known.has(header.parentSession)) orphans.push(id)
}
if (orphans.length > 0) {
  check('warn', 'orphan-children', `${orphans.length} session(s) dont le parent n'existe plus : ${orphans.map(shortId).join(' ')}`)
}

// --------------------------------------------------------------------------
// pick a tree
// --------------------------------------------------------------------------
let root = undefined
if (!all) {
  if (wanted !== undefined) root = load(wanted)
  else {
    // Newest session that actually has children: the interesting shape.
    for (const dir of dirs) {
      const hasChild = [...headers.values()].some((header) => header.parentSession === dir.id)
      if (hasChild) {
        root = load(dir.id)
        break
      }
    }
  }
}

if (!all) {
  if (root === undefined) {
    check('fail', 'no-tree', 'aucune session avec enfants trouvée')
  } else {
    await auditTree(root)
  }
}

// --------------------------------------------------------------------------
// one delegation tree
// --------------------------------------------------------------------------
async function auditTree(rootLog) {
  const rootRecords = rootLog.records
  const rootHeader = headerOf(rootRecords) ?? {}
  const children = []
  for (const dir of dirs) {
    if (dir.id === rootLog.id) continue
    let records
    try {
      records = readSessionDir(dir.dir).records
    } catch {
      continue
    }
    if (records.find((r) => r.type === 'session')?.parentSession !== rootLog.id) continue
    children.push({ id: dir.id, records, mtime: dir.mtime })
  }

  const rootEnded = rootRecords.some((r) => r.type === 'turn/end')
  const promptText = rootRecords
    .filter((r) => r.type === 'system/message')
    .map((r) => blocksToText(r.data?.message?.content))
    .join('\n')

  // --- which revision is this session on? --------------------------------
  // The prompt is re-emitted per request, so one session can span several
  // persona revisions. Each signature is therefore dated by the first request
  // that carried it, and the excerpt is printed as proof: twice already a
  // plausible-looking probe of this file produced a confident wrong answer.
  const requestTexts = rootRecords.filter((r) => r.type === 'system/message')
  const signatureAt = new Map()
  const signatureProof = new Map()
  for (const [needle, label] of PERSONA_SIGNATURES) {
    for (const record of requestTexts) {
      const text = blocksToText(record.data?.message?.content)
      const at = text.indexOf(needle)
      if (at === -1) continue
      signatureAt.set(label, record.time)
      signatureProof.set(label, text.slice(Math.max(0, at - 20), at + 70).replace(/\s+/g, ' '))
      break
    }
  }
  const absent = PERSONA_SIGNATURES.map(([, label]) => label).filter((label) => !signatureAt.has(label))
  if (absent.length === 0) {
    check('ok', 'persona-revision', `prompt système à jour (${signatureAt.size}/${PERSONA_SIGNATURES.length} signatures)`)
  } else {
    check('warn', 'persona-revision', `prompt système ANTÉRIEUR aux corrections : ${absent.join(', ')}`)
  }
  for (const [label, proof] of signatureProof) {
    check('info', 'persona-proof', `${label} — « ${proof.slice(0, 76)} »`)
  }

  // --- did a persona correction actually change the error rate? -----------
  // The one measurement the plan asks for, available the moment a session spans
  // two revisions: same session, same task family, error rate before vs after.
  // Collected below, once `errors` exists.

  const markers = markersOf(promptText)
  if (markers.includes('boost orchestrator')) check('ok', 'preset-markers', markers.join(', '))
  else check('warn', 'preset-markers', `aucune signature boost dans le prompt (${markers.join(', ') || 'vide'})`)

  // --- header staleness ---------------------------------------------------
  const childPresets = [...new Set(children.map((c) => headerOf(c.records)?.agentPreset).filter(Boolean))]
  const livePreset = childPresets.length === 1 ? childPresets[0] : undefined
  if (livePreset !== undefined && livePreset !== rootHeader.agentPreset) {
    check('warn', 'stale-header', `en-tête « ${rootHeader.agentPreset} » alors que la composition vivante est « ${livePreset} »`)
  }

  // --- turn outcomes ------------------------------------------------------
  const ends = rootRecords.filter((r) => r.type === 'turn/end').map((r) => r.data?.reason?.kind)
  const bad = ends.filter((kind) => kind !== undefined && kind !== 'completed')
  if (bad.length > 0) check('warn', 'turn-outcomes', `tours non terminés normalement : ${bad.join(', ')}`)
  else check('ok', 'turn-outcomes', `${ends.length} tour(s), tous « completed »`)

  // --- delegation integrity ----------------------------------------------
  const calls = new Map()
  for (const record of rootRecords) if (record.type === 'tool/call') calls.set(record.data.callId, record)
  const results = new Set()
  for (const record of rootRecords) {
    if (record.type !== 'tool/result') continue
    const id = record.data?.message?.toolCallId ?? record.data?.toolCallId
    if (id !== undefined) results.add(id)
  }
  const unanswered = [...calls.values()].filter((call) => !results.has(call.data.callId))
  const delegationCalls = [...calls.values()].filter((call) => ROLE_TOOLS.includes(call.data.name))
  if (unanswered.length > 0 && rootEnded) {
    check('warn', 'unanswered-calls', `${unanswered.length} appel(s) d'outil sans résultat alors que la racine a terminé : ${unanswered.map((c) => c.data.name).join(' ')}`)
  }

  // --- mute windows: programs with a long deadline ------------------------
  const programs = []
  for (const call of [...calls.values()].filter((c) => c.data.name === 'run_code')) {
    let parsed = {}
    try {
      parsed = JSON.parse(call.data.arguments ?? '{}')
    } catch {
      parsed = {}
    }
    const code = typeof parsed.code === 'string' ? parsed.code : ''
    programs.push({ call, code, timeoutMs: parsed.timeoutMs, description: parsed.description ?? '' })
  }
  const longDeadlines = programs.filter((p) => typeof p.timeoutMs === 'number' && p.timeoutMs > 60_000)
  const sleeps = programs
    .map((p) => ({ ...p, seconds: (p.code.match(/Start-Sleep\s+-Seconds\s+(\d+)/gi) ?? []).reduce((sum, m) => sum + Number(/(\d+)/.exec(m)[1]), 0) }))
    .filter((p) => p.seconds > 0)
  const sleptSeconds = sleeps.reduce((sum, p) => sum + p.seconds, 0)
  if (sleptSeconds >= 60) {
    check('warn', 'sleep-polling', `${sleeps.length} programme(s) dorment au total ${sleptSeconds} s (pire : ${Math.max(...sleeps.map((p) => p.seconds))} s) — préférer une attente qui rend la main à la settlement`)
  } else if (programs.length > 0) {
    check('ok', 'sleep-polling', `aucune dormance significative (${sleeps.length} programme, ${sleptSeconds} s)`)
  }
  if (longDeadlines.length > 0) {
    const worst = Math.max(...longDeadlines.map((p) => p.timeoutMs))
    check('warn', 'mute-windows', `${longDeadlines.length}/${programs.length} programme(s) avec un délai > 60 s (pire : ${Math.round(worst / 1000)} s) — la session est muette pendant ce temps`)
  }

  // --- verification actually delegated? ----------------------------------
  const verifyPrograms = programs.filter((p) => /await[^\n]{0,140}\bsubagent_verify\b/.test(p.code))
  const verifyCalls = delegationCalls.filter((c) => c.data.name === 'subagent_verify')
  if (verifyPrograms.length > 0 || verifyCalls.length > 0) {
    check('ok', 'verification', `${verifyPrograms.length} programme(s) attendent subagent_verify, ${verifyCalls.length} appel(s) direct(s)`)
  } else {
    check('fail', 'verification', 'AUCUNE vérification déléguée : l’orchestrateur a validé son propre travail')
  }

  // --- fan-out ------------------------------------------------------------
  const fanned = programs.filter((p) => Object.values(countRoleMentions(p.code)).reduce((a, b) => a + b, 0) >= 2)
  if (fanned.length > 0) check('ok', 'fanout', `${fanned.length} programme(s) lançant ≥ 2 rôles`)
  else if (programs.length > 5) check('warn', 'fanout', 'aucun programme ne lance plusieurs rôles : la délégation est séquentielle')

  // --- notices: did reports arrive, and how late? ------------------------
  const notices = new Map()
  for (const record of rootRecords) {
    if (record.type !== 'user/message') continue
    const text = blocksToText(record.data?.content)
    const notice = parseSubagentNotice(text)
    if (notice !== undefined && !notices.has(notice.childId)) notices.set(notice.childId, { time: record.time, ...notice })
  }
  const delays = []
  let silentNotices = 0
  for (const child of children) {
    const end = child.records.filter((r) => r.type === 'turn/end').pop()
    const notice = notices.get(child.id)
    if (notice === undefined) continue
    if (notice.carriesClosing !== true) silentNotices++
    if (end !== undefined) delays.push(notice.time - end.time)
  }
  const unended = children.filter((c) => !c.records.some((r) => r.type === 'turn/end'))
  const unnotified = children.filter((c) => {
    const descriptor = c.records.find((r) => r.type === 'subagent/descriptor')
    return descriptor?.data?.mode === 'continuable' && c.records.some((r) => r.type === 'turn/end') && !notices.has(c.id)
  })
  if (silentNotices > 0) check('fail', 'notices-without-report', `${silentNotices} avis de fin SANS message de clôture — le rapport n'est pas parvenu`)
  else if (notices.size > 0) check('ok', 'notices-with-report', `${notices.size} avis, tous porteurs du rapport de clôture`)
  if (unnotified.length > 0) check('fail', 'continuable-without-notice', `${unnotified.length} enfant(s) continuable(s) terminé(s) sans avis : ${unnotified.map((c) => shortId(c.id)).join(' ')}`)
  if (delays.length > 0) {
    const worst = Math.max(...delays)
    const median = [...delays].sort((a, b) => a - b)[Math.floor(delays.length / 2)]
    if (worst > 120_000) {
      check('warn', 'notice-delay', `délai de notification jusqu'à ${Math.round(worst / 1000)} s (médiane ${Math.round(median / 1000)} s) : un père occupé reçoit l'avis à son étape suivante`)
    } else {
      check('ok', 'notice-delay', `délai max ${Math.round(worst / 1000)} s`)
    }
  }
  if (unended.length > 0 && rootEnded) {
    check('warn', 'children-open-at-root-end', `${unended.length} enfant(s) sans turn/end alors que la racine a terminé : ${unended.map((c) => shortId(c.id)).join(' ')}`)
  }

  // --- exponential guard --------------------------------------------------
  const grandchildren = []
  for (const child of children) {
    const depth = headerOf(child.records)?.delegationDepth ?? 1
    const hasChild = [...headers.values()].some((header) => header.parentSession === child.id)
    if (depth >= 1 && hasChild) grandchildren.push(child.id)
  }
  if (grandchildren.length > 0) {
    check('fail', 'depth-violation', `${grandchildren.length} enfant(s) de profondeur ≥ 1 ont eux-mêmes des enfants : ${grandchildren.map(shortId).join(' ')} — le plafond maxDepth=1 a été contourné`)
  } else {
    check('ok', 'depth-guard', 'aucun petit-enfant : le plafond de profondeur tient')
  }

  // --- errors -------------------------------------------------------------
  const errors = []
  for (const session of [{ id: rootLog.id, records: rootRecords }, ...children]) {
    // collectFailures reads all three shapes a PTC failure can take — a flagged
    // result, a flagged `tool/ptc-dispatch`, and a failure buried in a successful
    // `run_code` result. A collector limited to the first undercounts every run:
    // this audit reported 30 errors on a tree whose true count is higher.
    for (const failure of collectFailures(session.records)) {
      errors.push({ session: session.id, ...failure, text: failure.text.replace(/\s+/g, ' ') })
    }
  }
  const classes = new Map()
  for (const error of errors) {
    const key = /execution deadline/.test(error.text) ? 'délai de programme'
      : /EditConflict|old_string|has not been read|matched \d+ times/.test(error.text) ? 'discipline edit'
      : /Expected|syntax/i.test(error.text) ? 'syntaxe TS'
      : /ENOENT|undefined/.test(error.text) ? 'chemin invalide'
      : /SetNamedSecurityInfo|ReplaceFileW|EIO/.test(error.text) ? 'bug plateforme'
      : /binary file/.test(error.text) ? 'lecture binaire'
      : 'autre'
    classes.set(key, (classes.get(key) ?? 0) + 1)
  }
  if (errors.length === 0) check('ok', 'tool-errors', 'aucune erreur d’outil')
  else {
    const breakdown = [...classes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')
    const level = classes.get('bug plateforme') !== undefined || classes.get('syntaxe TS') !== undefined ? 'warn' : 'warn'
    check(level, 'tool-errors', `${errors.length} erreur(s) sur ${programs.length} programmes : ${breakdown}`)
  }

  // --- did a persona correction actually change the error rate? -----------
  // Placed after the error collection: the measurement needs `errors`, and a
  // `const` read before its declaration is a temporal-dead-zone crash, not an
  // empty array.
  for (const [, label] of PERSONA_SIGNATURES) {
    const at = signatureAt.get(label)
    if (at === undefined || label !== 'bloc Field notes (M1-quinquies)') continue
    const before = errors.filter((error) => typeof error.time === 'number' && error.time < at)
    const after = errors.filter((error) => typeof error.time === 'number' && error.time >= at)
    const programsBefore = programs.filter((p) => p.call.time < at).length
    const programsAfter = programs.filter((p) => p.call.time >= at).length
    const rate = (count, total) => (total === 0 ? 'n/a' : `${((count / total) * 100).toFixed(0)} %`)
    check('info', 'field-notes-effect',
      `erreurs avant ${before.length}/${programsBefore} programmes (${rate(before.length, programsBefore)}) → après ${after.length}/${programsAfter} (${rate(after.length, programsAfter)})`)
  }

  // --- clock context: does the agent know how long it has been waiting? ----
  // `dsh-time-context` annotates the steps that HAPPEN; it wakes nothing. A huge
  // gap is therefore not a plugin fault — it means no step occurred, which is
  // exactly why a clock cannot replace a heartbeat and both are needed.
  //
  // Two traps are encoded here. The README documents the source as
  // `{ kind: 'plugin', plugin: 'time-context', … }`, but the running harness
  // writes `{ kind: 'time-context', … }`; and matching the reading's TEXT counts
  // the reports that merely quote it — a first sweep found five "readings" in a
  // session that held one, the rest being this tooling's own output.
  const isClockReading = (record) => {
    const source = record.data?.source
    return source?.kind === 'time-context' || source?.plugin === 'time-context'
  }
  const readings = rootRecords
    .filter((r) => r.type === 'user/message' && isClockReading(r))
    .map((r) => r.time)
    .sort((a, b) => a - b)
  if (readings.length === 0) {
    check('info', 'clock-context', 'aucune lecture dans cette session — le plugin annote les étapes qui ont lieu, il ne réveille rien : une session au repos n’en reçoit aucune')
  } else {
    const gaps = readings.slice(1).map((t, index) => t - readings[index])
    const worst = gaps.length === 0 ? 0 : Math.max(...gaps)
    check('info', 'clock-context', `${readings.length} lecture(s), écart max ${Math.round(worst / 1000)} s, dernière il y a ${Math.round((now - readings[readings.length - 1]) / 1000)} s`)
  }

  // --- heartbeat: does anything wake this session on a timer? --------------
  const reminders = rootRecords.filter((r) => r.type === 'user/message' && JSON.stringify(r.data.source ?? {}).includes('schedule'))
  check('info', 'heartbeat', reminders.length === 0
    ? 'aucun rappel planifié reçu dans cette session (dsh-schedule actif mais non utilisé)'
    : `${reminders.length} rappel(s) reçu(s) dans cette session`)

  // --- summary line -------------------------------------------------------
  const usage = { input: 0, output: 0, cacheRead: 0 }
  for (const record of rootRecords) {
    if (record.type !== 'assistant/message' || record.data.usage === undefined) continue
    usage.input += record.data.usage.inputTokens ?? 0
    usage.output += record.data.usage.outputTokens ?? 0
    usage.cacheRead += record.data.usage.cacheReadTokens ?? 0
  }
  const cacheRatio = usage.input + usage.cacheRead === 0 ? 0 : usage.cacheRead / (usage.input + usage.cacheRead)
  findings.push({
    level: 'info',
    id: 'tree',
    detail: `racine ${shortId(rootLog.id)} — ${programs.length} programmes, ${children.length} enfants, ${ends.length} tours, `
      + `${Math.round((now - Math.min(...rootRecords.map((r) => r.time).filter(Boolean))) / 60000)} min, `
      + `cache ${(cacheRatio * 100).toFixed(1)} %`,
  })
}

if (all) {
  // A global sweep earns its keep only if it says what it covered: a run that
  // prints no finding at all is indistinguishable from a run that checked
  // nothing, which is exactly how a silent pass misleads.
  findings.push({
    level: 'info',
    id: 'sweep',
    detail: `${known.size}/${dirs.length} sessions lisibles, ${orphans.length} orpheline(s), `
      + `${emptyTails} frame(s) finale(s) partielle(s), ${skippedRecords} enregistrement(s) illisible(s) `
      + '(les contrôles de protocole se font par arbre : node tools/protocol.mjs <session-id>)',
  })
}

// --------------------------------------------------------------------------
// report
// --------------------------------------------------------------------------
const order = { fail: 0, warn: 1, ok: 2, info: 3 }
const icon = { fail: 'KO  ', warn: 'WARN', ok: 'OK  ', info: 'INFO' }
findings.sort((a, b) => order[a.level] - order[b.level])
console.log(`Audit des traces — ${dirs.length} sessions sur disque${all ? ' (balayage global)' : ''}\n`)
for (const finding of findings) console.log(`${icon[finding.level]} ${finding.id.padEnd(28)} ${finding.detail}`)
const fails = findings.filter((f) => f.level === 'fail').length
const warns = findings.filter((f) => f.level === 'warn').length
console.log(`\n${fails} KO, ${warns} avertissement(s), ${findings.filter((f) => f.level === 'ok').length} OK`)
if (emptyTails > 0) console.log(`${emptyTails} session(s) en cours d'écriture (frame finale partielle) — relancer l'audit après la fin du run`)
process.exit(fails > 0 ? 1 : 0)
