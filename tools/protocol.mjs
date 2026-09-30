// Score one boost session against the torture protocol.
//
//   node tools/protocol.mjs <session-id-prefix>
//
// Design rule, learned the hard way in this project: a model cannot judge the
// mode it is running in. Every narrative claim examined here turned out to be
// wrong (a "no live reload" rule, phantom delegations, a missing report), while
// the session log was right every time. So the protocol agent's only job is to
// PRODUCE traces, and this scorer derives pass/fail from those traces. An agent
// cannot mark its own scenario green.
//
// Every scenario below is therefore decided by evidence the harness wrote, never
// by a file the agent chose to create.
import { headerOf, listSessionDirs, readSessionDir, sessionsRoot } from './session-log.mjs'
import { ROLE_TOOLS, blocksToText, collectFailures, countRoleMentions, parseSubagentNotice } from './parse.mjs'

const prefix = process.argv[2]
if (prefix === undefined) {
  console.error('usage: node tools/protocol.mjs <session-id-prefix>')
  process.exit(2)
}
const dirs = listSessionDirs(sessionsRoot())
const rootDir = dirs.find((d) => d.id.startsWith(prefix))
if (rootDir === undefined) {
  console.error(`no session matching ${prefix}`)
  process.exit(2)
}

const root = readSessionDir(rootDir.dir).records
const children = []
for (const dir of dirs) {
  if (dir.id === rootDir.id) continue
  let records
  try {
    records = readSessionDir(dir.dir).records
  } catch {
    continue
  }
  if (records.find((r) => r.type === 'session')?.parentSession !== rootDir.id) continue
  children.push({ id: dir.id, records, mtime: dir.mtime })
}
const all = [root, ...children.map((c) => c.records)]

// ---- derive the facts once -------------------------------------------------
const programs = []
for (const record of root) {
  if (record.type !== 'tool/call' || record.data.name !== 'run_code') continue
  let parsed = {}
  try {
    parsed = JSON.parse(record.data.arguments ?? '{}')
  } catch {
    parsed = {}
  }
  const code = typeof parsed.code === 'string' ? parsed.code : ''
  programs.push({ call: record, code, timeoutMs: parsed.timeoutMs, mentions: countRoleMentions(code) })
}
const results = new Map()
for (const record of root) {
  if (record.type !== 'tool/result') continue
  const id = record.data?.message?.toolCallId ?? record.data?.toolCallId
  if (id !== undefined) results.set(id, record)
}
const textOf = (records) => records.map((r) => blocksToText(r.data?.message?.content)).join('\n')
const rootText = textOf(root)

// Count FAILURES, not occurrences of failure-shaped text.
//
// A first version of this scorer matched patterns over every text in every
// session, which counts the error strings a tool result merely *quotes* — a
// report quoting its own log, an audit printing a summary, this very tool being
// read. It reported 13 edit-discipline failures where the log holds 5. Only
// records the runtime marked as failed are counted here.
const errors = []
for (const [sessionId, records] of [[rootDir.id, root], ...children.map((c) => [c.id, c.records])]) {
  for (const failure of collectFailures(records)) errors.push({ session: sessionId, ...failure })
}
const failed = (pattern) => errors.filter((error) => pattern.test(error.text) || pattern.test(error.tool ?? ''))

const notices = []
for (const record of root) {
  if (record.type !== 'user/message') continue
  const text = blocksToText(record.data?.content)
  const notice = parseSubagentNotice(text)
  if (notice !== undefined) notices.push({ ...notice, time: record.time, text })
}
// Only inbox messages count. A text search over the whole log matches the agent
// WRITING about the relay, its own extractor scripts echoing it, and any document
// quoting it — which reported 36 relay notices where the session holds one.
const relayNotices = root
  .filter((r) => r.type === 'user/message' || r.type === 'agent/inbox/spliced')
  .map((r) => JSON.stringify(r.data))
  .filter((blob) => blob.includes('[boost-relay]'))
const sleeps = programs.filter((p) => /Start-Sleep|setTimeout\s*\(|await\s+sleep/i.test(p.code))
const waits = programs.filter((p) => /job_output[\s\S]{0,120}wait\s*:\s*true/.test(p.code))
const verifyPrograms = programs.filter((p) => /await[^\n]{0,140}\bsubagent_verify\b/.test(p.code))
const fanned = programs.filter((p) => Object.values(p.mentions).reduce((a, b) => a + b, 0) >= 2)
const continuableEnded = children.filter((c) => {
  const descriptor = c.records.find((r) => r.type === 'subagent/descriptor')
  return descriptor?.data?.mode === 'continuable' && c.records.some((r) => r.type === 'turn/end')
})

// ---- scenarios -------------------------------------------------------------
const scenarios = []
const add = (id, status, evidence) => scenarios.push({ id, status, evidence })

add('01-delegation',
  children.length > 0 && notices.length > 0 ? 'pass' : 'fail',
  `${children.length} enfant(s), ${notices.length} avis de fin`)

add('02-report-pushed',
  notices.length === 0 ? 'indeterminate'
    : notices.every((n) => n.carriesClosing) ? 'pass' : 'fail',
  `${notices.filter((n) => n.carriesClosing).length}/${notices.length} avis portent « Its closing message »`)

add('03-fanout',
  fanned.length > 0 ? 'pass' : programs.length === 0 ? 'indeterminate' : 'fail',
  `${fanned.length} programme(s) lançant ≥ 2 rôles sur ${programs.length}`)

add('04-verification-foreground',
  verifyPrograms.length > 0 ? 'pass' : 'fail',
  verifyPrograms.length > 0
    ? `${verifyPrograms.length} programme(s) attendent subagent_verify en premier plan`
    : 'aucune vérification déléguée : l’orchestrateur valide son propre travail')

const depthRefusal = failed(/exceeds maxDepth/).length
const grandchildren = children.some((c) => dirs.some((d) => headerOf(safeRecords(d))?.parentSession === c.id))
add('05-depth-cap',
  grandchildren ? 'fail' : depthRefusal > 0 ? 'pass' : 'indeterminate',
  grandchildren ? 'un petit-enfant existe : le plafond a été contourné'
    : depthRefusal > 0 ? `un worker a tenté de déléguer et s’est fait refuser (${depthRefusal} fois)`
      : 'aucune tentative de délégation observée — scénario non déclenché')

const longSleeps = sleeps.filter((p) => /Start-Sleep\s+-Seconds\s+(\d+)/i.test(p.code)
  && [...p.code.matchAll(/Start-Sleep\s+-Seconds\s+(\d+)/gi)].some((m) => Number(m[1]) >= 30))
add('06-no-sleep-polling',
  longSleeps.length === 0 ? 'pass' : 'fail',
  longSleeps.length === 0
    ? `${waits.length} attente(s) par job_output(wait) — attente qui rend la main à la settlement`
    : `${longSleeps.length} programme(s) dorment ≥ 30 s au lieu d'une attente sur settlement`)

// (the deadline trap is scored by the `reproduced` helper below, which expects
// the documented failure instead of forbidding it)
// Scenarios 07 to 09 are REPRODUCTION scenarios: the protocol asks the agent to
// provoke the failure and record the exact message, so the expected outcome IS
// the error. Scoring "no error" as PASS — or the error as FAIL — inverts the
// test. What matters is that the documented failure appears; the shape is
// reported because a buried failure is weaker evidence than a flagged one.
const reproduced = (pattern, documented) => {
  const hits = failed(pattern)
  return {
    status: hits.length > 0 ? 'pass' : 'indeterminate',
    evidence: hits.length > 0
      ? `${documented} reproduit ${hits.length}× (forme : ${[...new Set(hits.map((h) => h.shape))].join(', ')})`
      : `${documented} NON reproduit — scénario non déclenché`,
  }
}

const deadline = reproduced(/execution deadline reached/, 'le piège du délai par défaut')
add('07-program-deadline', deadline.status, deadline.evidence)

const envReproduced = reproduced(/undefined[\\/]/, 'le chemin issu d’un process.env vide')
add('08-empty-env', envReproduced.status, envReproduced.evidence)

const editReproduced = reproduced(/has not been read|old_string[^.]*?(?:not found|matched \d+ times|must differ)/, 'le refus d’un edit sans lecture préalable')
add('09-edit-discipline', editReproduced.status, editReproduced.evidence)

// This scenario cannot be decided from the log.
//
// The whole point of the blind spot is that a child-owned job settlement leaves
// NO trace in the parent's session: there is nothing to find when it works, and
// nothing to find when it does not. Two heuristics were tried and both lied —
// the root log's mtime is always "now" for a live session, and a child's log
// mtime is touched by unrelated activity. The authoritative source is the
// relay's own counter, read with `/boost-relay`; this scorer only reports the
// absences it can prove.
const orphanProbe = children.some((c) => JSON.stringify(c.records).includes('run_in_background'))
add('10-relay-orphan-job',
  relayNotices.length > 0 ? 'pass' : 'indeterminate',
  relayNotices.length > 0 ? `${relayNotices.length} avis [boost-relay] reçus par le père`
    : orphanProbe
      ? 'indécidable depuis le log : un job d’enfant est invisible au père par construction. Vérifier le compteur avec /boost-relay'
      : 'aucun job lancé depuis un enfant — scénario non déclenché')

const unrelated = continuableEnded.filter((c) => !notices.some((n) => n.childId === c.id))
add('11-settlement-notice',
  continuableEnded.length === 0 ? 'indeterminate' : unrelated.length === 0 ? 'pass' : 'fail',
  `${continuableEnded.length - unrelated.length}/${continuableEnded.length} enfants continuable terminés ont reçu un avis`)

// ---- report ----------------------------------------------------------------
const icon = { pass: 'PASS', fail: 'FAIL', indeterminate: '????' }
console.log(`Protocole de torture — session ${rootDir.id}`)
console.log(`${programs.length} programmes, ${children.length} enfants, ${notices.length} avis\n`)
for (const scenario of scenarios) console.log(`${icon[scenario.status]}  ${scenario.id.padEnd(26)} ${scenario.evidence}`)
const fails = scenarios.filter((s) => s.status === 'fail').length
const unknown = scenarios.filter((s) => s.status === 'indeterminate').length
console.log(`\n${scenarios.length - fails - unknown} PASS, ${fails} FAIL, ${unknown} non déclenché(s)`)

function safeRecords(dir) {
  try {
    return readSessionDir(dir.dir).records
  } catch {
    return []
  }
}
