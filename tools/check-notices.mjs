// Did the orchestrator actually hear about its children?
//
// Usage: node tools/check-notices.mjs [session-id-prefix]
//
// Two different notice sources feed a boost parent, and conflating them hides
// bugs: the subagent runtime emits "Background subagent <id> finished and will do
// no further work unless you send it more.", while `dsh-tool-jobs` emits
// "background job <id> (<kind>: <label>) finished [status: ...]". This tool
// cross-tabulates, per child, its lifecycle mode against the notice the parent
// received — and whether the parent ever collected a child's result through
// `job_output`, which is the only way a settled child's output reaches it.
import { listSessionDirs, readSessionDir } from './session-log.mjs'

const prefix = process.argv[2] ?? 'session-d06c6d28'
const dirs = listSessionDirs()
const now = Date.now()
const root = dirs.find((d) => d.id.startsWith(prefix))
if (root === undefined) {
  console.error(`no session matching ${prefix}`)
  process.exit(2)
}
const rootRecords = readSessionDir(root.dir).records

// --- notices the parent received -------------------------------------------
const subagentNotices = new Map()
const jobNotices = []
for (const record of rootRecords) {
  if (record.type !== 'user/message') continue
  const text = (record.data.content ?? []).map((block) => block.text ?? '').join(' ')
  const subagent = /Background subagent ([0-9a-f-]{36}) finished/.exec(text)
  if (subagent !== null) {
    // The notice PUSHES the child's closing message; it is not a bare "finished"
    // signal, and nothing has to be collected with job_output. Measuring that
    // here is the point: an earlier version of this tool compared the child's
    // LAST assistant message against the parent log and reported "absent" for
    // nine children whose reports had in fact arrived — the closing message is
    // an earlier message than the last one.
    if (!subagentNotices.has(subagent[1])) {
      subagentNotices.set(subagent[1], {
        time: record.time,
        carriesClosing: text.includes('Its closing message:'),
        chars: text.length,
      })
    }
    continue
  }
  const job = /background job ([\w-]+) \(([\w-]+):?/.exec(text)
  if (job !== null) jobNotices.push({ id: job[1], kind: job[2], time: record.time })
}

console.log(`session ${root.id}`)
console.log(`avis « Background subagent … finished » : ${subagentNotices.size}`)
console.log(`avis « background job … finished »      : ${jobNotices.length}`)
if (jobNotices.length > 0) {
  for (const notice of jobNotices.slice(-6)) {
    console.log(`   ${notice.id} (${notice.kind}) il y a ${Math.round((now - notice.time) / 1000)}s`)
  }
}

// --- children: mode vs notice ----------------------------------------------
console.log('\nENFANT   MODE         LABEL                          TURN/END         AVIS (délai, taille)')
const rows = []
for (const dir of dirs) {
  if (dir.id === root.id) continue
  let records
  try {
    records = readSessionDir(dir.dir).records
  } catch {
    continue
  }
  if (records.find((r) => r.type === 'session')?.parentSession !== root.id) continue
  const descriptor = records.find((r) => r.type === 'subagent/descriptor')
  const end = records.filter((r) => r.type === 'turn/end').pop()
  const notice = subagentNotices.get(dir.id) ?? jobNotices.find((n) => n.id === dir.id)
  rows.push({
    id: dir.id,
    mode: descriptor?.data?.mode ?? '(aucun descripteur)',
    label: descriptor?.data?.label ?? '',
    endTime: end?.time,
    noticeTime: notice?.time,
    carriesClosing: notice?.carriesClosing,
    chars: notice?.chars,
  })
}
rows.sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0))
let missing = 0
let silent = 0
for (const row of rows) {
  const delta = row.endTime !== undefined && row.noticeTime !== undefined ? `+${Math.round((row.noticeTime - row.endTime) / 1000)}s` : '—'
  const ended = row.endTime === undefined ? 'pas de turn/end' : `il y a ${Math.round((now - row.endTime) / 1000)}s`
  const noticed = row.noticeTime === undefined
    ? 'NON'
    : `${delta}, ${row.chars} car.${row.carriesClosing === true ? '' : ' SANS closing'}`
  if (row.noticeTime === undefined) missing++
  else if (row.carriesClosing !== true) silent++
  console.log(
    `${row.id.slice(0, 8)}  ${String(row.mode).padEnd(12)} ${String(row.label).slice(0, 30).padEnd(31)} ${ended.padEnd(16)} ${noticed}`,
  )
}
console.log(`\nenfants sans aucun avis        : ${missing} / ${rows.length}`)
console.log(`avis sans message de clôture   : ${silent} / ${rows.length}`)

// --- did the parent ever collect a child's result? -------------------------
let byChild = 0
let byJob = 0
for (const call of rootRecords.filter((r) => r.type === 'tool/call' && r.data.name === 'run_code')) {
  const code = JSON.parse(call.data.arguments ?? '{}').code ?? ''
  for (const match of code.matchAll(/job_output\s*\(/g)) {
    const window = code.slice(match.index, match.index + 120)
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(window)) byChild++
    else if (/pwsh-\d+/.test(window)) byJob++
  }
}
console.log(`\njob_output visant un enfant (uuid) : ${byChild}`)
console.log(`job_output visant un job pwsh-*   : ${byJob}`)

// --- message provenance ----------------------------------------------------
const messages = rootRecords.filter((r) => r.type === 'user/message')
const bySource = new Map()
for (const message of messages) {
  const kind = message.data.source?.kind ?? '(sans source)'
  bySource.set(kind, (bySource.get(kind) ?? 0) + 1)
}
console.log(`\nuser/message dans la racine : ${messages.length} — ${JSON.stringify(Object.fromEntries(bySource))}`)
if (process.argv.includes('--dump')) {
  console.log('\n--- tous les user/message (source | âge | extrait) ---')
  for (const message of messages) {
    const kind = message.data.source?.kind ?? '(sans source)'
    const text = (message.data.content ?? [])
      .map((block) => block.text ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    console.log(`  ${String(kind).padEnd(17)} ${String(Math.round((now - message.time) / 1000)).padStart(6)}s  ${text.slice(0, 150)}`)
  }
}

// --- did a child's report CONTENT ever reach the parent's context? ---------
// Probe, not proof: the parent's own records are searched for the opening of
// each child's final text. A report the parent never received cannot appear,
// and one it received usually leaves a trace — quoted, summarised, or acted on.
const rootBlob = JSON.stringify(rootRecords)
console.log('\ncontenu du rapport enfant present dans la racine ?')
for (const row of rows) {
  const dir = dirs.find((d) => d.id === row.id)
  let childRecords
  try {
    childRecords = readSessionDir(dir.dir).records
  } catch {
    continue
  }
  const assistant = childRecords.filter((r) => r.type === 'assistant/message')
  const last = assistant[assistant.length - 1]
  const text = (last?.data?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const probe = text.slice(0, 60)
  const present = probe.length > 20 && rootBlob.includes(probe)
  console.log(
    `  ${row.id.slice(0, 8)} ${String(row.mode).padEnd(12)} ${present ? 'PRÉSENT' : 'absent '}  (« ${probe.slice(0, 48)} »)`,
  )
}
