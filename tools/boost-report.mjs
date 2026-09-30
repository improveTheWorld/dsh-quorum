// Boost run report: turn a DSH session (plus every session it delegated to) into
// one analyzable, compact report.
//
// Scope: this reads what DSH already records. It adds no instrumentation to the
// running harness, so it also works retroactively on sessions that already
// happened. What it does add is decoding: a session log on disk is a
// concatenation of independent zstd frames, one per flush, and no stock Node
// zstd entry point reads past the first frame (see tools/session-log.mjs).
//
// Usage:
//   node tools/boost-report.mjs                        # current/newest session
//   node tools/boost-report.mjs --session <id>         # exact session
//   node tools/boost-report.mjs --dir <session-dir>
//   node tools/boost-report.mjs --list                 # candidate sessions
//   node tools/boost-report.mjs --json                 # machine-readable
//   node tools/boost-report.mjs --brief-chars 400      # brief preview length
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { buildTree, hasTurn, headerOf, listSessionDirs, readSessionDir, sessionsRoot } from './session-log.mjs'

const ROLE_TOOLS = [
  'subagent_investigate',
  'subagent_implement',
  'subagent_verify',
  'subagent',
  'subagent_fork',
  'workflow',
  'ralph',
]
const DELEGATION_TOOLS = new Set(ROLE_TOOLS)
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
/** Failure kinds the PTC runtime can report (`dsh-ptc-runtime`). */
const PTC_FAILURES = ['exception', 'timeout', 'abort', 'worker-exit', 'invalid-output', 'output-limit', 'sandbox-unavailable']

const args = parseArgs(process.argv.slice(2))
const root = sessionsRoot(args.home)
const dirs = listSessionDirs(root)

if (args.list) {
  console.log(`sessions root: ${root}\n`)
  for (const d of dirs.slice(0, args.limit)) {
    const h = readHeader(d.file)
    const preset = h?.agentPreset ?? '(none)'
    const origin = h?.origin ?? 'root'
    const parent = h?.parentSession ? ` <- ${h.parentSession}` : ''
    console.log(`${d.id}  preset=${preset}  origin=${origin}  depth=${h?.delegationDepth ?? 0}${parent}`)
    console.log(`    ${new Date(d.mtime).toISOString()}  ${d.dir}`)
  }
  process.exit(0)
}

const target = pickTarget()
if (!target) {
  console.error(`no session found under ${root}`)
  process.exit(2)
}

const tree = buildTree(target.id, dirs)
if (!tree.root) {
  console.error(`could not read a header for session ${target.id}`)
  process.exit(2)
}

// ---- load every session of the tree once ----
const sessions = new Map()
for (const node of tree.nodes) {
  const log = readSessionDir(node.dir)
  sessions.set(node.id, { node, records: log.records, frames: log.frames, bytes: log.bytes })
}

// The spawning tool for each child: the parent records the child id in the
// delegation's tool result ("started subagent <id>"), so attribute by callId.
const spawnerOf = new Map()
const delegations = []
for (const [, session] of sessions) {
  const calls = new Map()
  for (const r of session.records) {
    if (r?.type === 'tool/call') calls.set(r.data.callId, r)
    if (r?.type === 'tool/result') {
      const resultCallId = callIdOf(r)
      const call = calls.get(resultCallId)
      if (!call || !DELEGATION_TOOLS.has(call.data.name)) continue
      const text = blocksToText(r.data.message?.content)
      const childId = UUID_RE.exec(text)?.[0]
      let callArgs = {}
      try {
        callArgs = JSON.parse(call.data.arguments ?? '{}')
      } catch {
        callArgs = {}
      }
      const entry = {
        parent: session.node.id,
        turn: call.data.turn,
        step: call.data.step,
        time: call.time,
        tool: call.data.name,
        background: callArgs.run_in_background !== false,
        explicitForeground: callArgs.run_in_background === false,
        briefChars: typeof callArgs.prompt === 'string' ? callArgs.prompt.length : 0,
        briefPreview: typeof callArgs.prompt === 'string' ? callArgs.prompt.replace(/\s+/g, ' ').slice(0, args.briefChars) : '',
        childId,
        resultChars: text.length,
        resultPreview: text.replace(/\s+/g, ' ').slice(0, 160),
      }
      delegations.push(entry)
      if (childId && !spawnerOf.has(childId)) spawnerOf.set(childId, entry)
    }
  }
}
delegations.sort((a, b) => a.time - b.time)

// ---- per-session facts ----
const facts = new Map()
for (const [id, session] of sessions) {
  const header = headerOf(session.records) ?? session.node.header
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  const toolCalls = []
  const errors = []
  const anomalies = []
  const ptcSurfaces = []
  let lastAssistant = 0
  let lastAssistantText = ''
  let turnEnd = undefined
  let descriptor
  let systemPromptText = ''
  const results = new Map()
  const explicitErrors = new Map()
  const toolNames = new Set()
  for (const r of session.records) {
    switch (r?.type) {
      case 'subagent/descriptor':
        descriptor = r.data
        break
      case 'system/message':
        // A system message is re-emitted per request, so accumulate a bounded
        // sample instead of only the first: the persona can be contributed on
        // any of them, and marker detection must not depend on which one.
        if (systemPromptText.length < 40000) systemPromptText += `${blocksToText(r.data?.message?.content)}\n`
        break
      case 'assistant/message':
        if (r.data?.usage) {
          usage.input += r.data.usage.inputTokens ?? 0
          usage.output += r.data.usage.outputTokens ?? 0
          usage.cacheRead += r.data.usage.cacheReadTokens ?? 0
          usage.cacheWrite += r.data.usage.cacheWriteTokens ?? 0
          usage.total += r.data.usage.totalTokens ?? 0
        }
        if (blocksToText(r.data?.message?.content).trim() !== '') {
          lastAssistant = r.time
          lastAssistantText = blocksToText(r.data?.message?.content)
        }
        break
      case 'tool/call':
        toolCalls.push({ time: r.time, turn: r.data.turn, step: r.data.step, name: r.data.name, callId: r.data.callId, arguments: r.data.arguments })
        toolNames.add(r.data.name)
        break
      case 'tool/result':
        results.set(callIdOf(r), blocksToText(r.data.message?.content))
        if (r.data.error !== undefined || r.data.message?.isError === true) {
          explicitErrors.set(callIdOf(r), r.data.error !== undefined ? JSON.stringify(r.data.error).slice(0, 300) : 'isError=true')
        }
        break
      case 'turn/end':
        turnEnd = { time: r.time, reason: r.data?.reason?.kind ?? 'unknown' }
        break
      case 'request/header': {
        const names = (r.data?.header?.tools ?? []).map((t) => t.name)
        ptcSurfaces.push(names)
        break
      }
      default:
        break
    }
  }
  for (const call of toolCalls) {
    const text = results.get(call.callId) ?? ''
    // Authoritative signal only: the runtime marks a failed tool result.
    if (explicitErrors.has(call.callId)) {
      errors.push({ time: call.time, tool: call.name, marker: 'result.error', detail: explicitErrors.get(call.callId) })
    }
    // Heuristics, kept separate so a legitimate payload that merely mentions
    // "timeout" or "rejected" cannot be reported as a failure. A session log
    // contains every file the agent read; substring matching over whole results
    // produced ~40 false positives on a real run.
    const exitCodes = [...text.matchAll(/\[exit code: (\d+)\]/g)].map((m) => Number(m[1])).filter((n) => n !== 0)
    if (exitCodes.length > 0) {
      anomalies.push({ time: call.time, tool: call.name, kind: 'exit-code', detail: `exit ${exitCodes.join(',')} — ${text.replace(/\s+/g, ' ').slice(-200)}` })
    }
    if (call.name === 'run_code') {
      const head = text.slice(0, 300)
      const hit = PTC_FAILURES.find((k) => head.includes(k))
      if (hit !== undefined) anomalies.push({ time: call.time, tool: call.name, kind: 'ptc-failure', detail: `${hit} — ${head.replace(/\s+/g, ' ').slice(0, 200)}` })
    }
  }
  // PTC blind spot: with `mode: ptc` the only directly callable tool is
  // `run_code`, and the SDK's inner tool calls may not surface as their own
  // `tool/call` records. The program text is then the only place a delegation,
  // its role, and whether it was awaited are visible, so parse it.
  const ptcPrograms = []
  for (const call of toolCalls) {
    if (call.name !== 'run_code') continue
    let parsed = {}
    try {
      parsed = JSON.parse(call.arguments ?? '{}')
    } catch {
      parsed = {}
    }
    const code = typeof parsed.code === 'string' ? parsed.code : ''
    const roleMentions = {}
    for (const role of ROLE_TOOLS) {
      // `subagent` is a prefix of `subagent_investigate`/`_implement`/`_verify`,
      // so a plain substring count reports phantom generic delegations. Require
      // the name not to be followed by an identifier character.
      const count = (code.match(new RegExp(`${role}(?![A-Za-z0-9_])`, 'g')) ?? []).length
      if (count > 0) roleMentions[role] = count
    }
    ptcPrograms.push({
      time: call.time,
      turn: call.turn,
      step: call.step,
      description: typeof parsed.description === 'string' ? parsed.description : '',
      codeChars: code.length,
      roleMentions,
      // Delegation labels: the `description` values the program passes to the
      // role tools. The harness persists exactly those as `subagent/descriptor`
      // labels, so they are what lets a PTC run attribute a child to the program
      // that spawned it — inner SDK calls are not logged as their own
      // `tool/call`, so nothing else links the two.
      labels: [...new Set(
        [...code.matchAll(/description\s*:\s*["'`]([^"'`\n]{1,120})["'`]/g)].map((m) => m[1]),
      )],
      awaitVerify: /await[^\n]{0,140}\bsubagent_verify\b/.test(code),
      backgroundFalse: (code.match(/run_in_background\s*:\s*false/g) ?? []).length,
      codePreview: code.replace(/\s+/g, ' ').slice(0, 200),
    })
  }

  const times = session.records.map((r) => r.time).filter((t) => typeof t === 'number')
  facts.set(id, {
    header,
    descriptor,
    usage,
    toolCalls,
    errors,
    ptcSurfaces,
    startTime: times.length > 0 ? Math.min(...times) : undefined,
    endTime: turnEnd?.time ?? (times.length > 0 ? Math.max(...times) : undefined),
    turnEndReason: turnEnd?.reason,
    lastAssistantTime: lastAssistant,
    lastAssistantText,
    frames: session.frames,
    bytes: session.bytes,
    recordCount: session.records.length,
    systemPromptText,
    promptMarkers: markersOf(systemPromptText),
    toolNames: [...toolNames].sort(),
    ptcPrograms,
    anomalies,
  })
}

// ---- boost health checks ----
const rootFacts = facts.get(tree.root.id)
const rootPreset = rootFacts.header?.agentPreset
const children = tree.nodes.filter((n) => n.depth > 0)
const childPresets = children.map((n) => ({ id: n.id, preset: facts.get(n.id).header?.agentPreset }))
const roleUse = new Map()
for (const d of delegations) roleUse.set(d.tool, (roleUse.get(d.tool) ?? 0) + 1)

const verifyCalls = delegations.filter((d) => d.tool === 'subagent_verify')
const parallelSteps = groupBy(
  delegations.filter((d) => d.parent === tree.root.id),
  (d) => `${d.turn}/${d.step}`,
)
const parallelGroups = [...parallelSteps.values()].filter((g) => g.length > 1)
// In PTC there are no direct delegation records: a fan-out lives inside one
// `run_code` program. Counting only direct calls reported "aucun step
// parallèle" on a run whose single program started three workers, so a program
// that names two or more role tools counts as a fan-out too.
const ptcFanoutPrograms = rootFacts.ptcPrograms.filter(
  (p) => Object.values(p.roleMentions).reduce((sum, n) => sum + n, 0) >= 2,
)
const surfaceNames = rootFacts.ptcSurfaces.at(-1) ?? []
const isPtc = surfaceNames.length > 0 && surfaceNames.every((n) => n === 'run_code')
// The root's header records the preset the session was CREATED with, which goes
// stale when the preset is switched while the session is still blank (the
// composition changes, the header does not). A child's header is written from
// its parent's LIVE scope chain, so a unanimous child value reveals the root's
// live preset even when the root's own header is stale.
const childPresetValues = [...new Set(childPresets.map((c) => c.preset).filter((p) => p !== undefined))]
const livePreset = children.length > 0
  ? childPresetValues.length === 1
    ? childPresetValues[0]
    : `incohérent(${childPresetValues.join('|')})`
  : rootPreset
const unsettledAtFinal = children.filter((n) => {
  const f = facts.get(n.id)
  return f.lastAssistantTime > 0 && rootFacts.lastAssistantTime > 0 && f.endTime !== undefined && f.endTime > rootFacts.lastAssistantTime
})
const rootPtcPrograms = rootFacts.ptcPrograms
// Attribution for PTC runs. A child whose label appears among a program's
// delegation descriptions was spawned by that program: the harness persists the
// `description` argument as the child's `subagent/descriptor` label, and inner
// SDK calls are not logged as their own `tool/call`, so nothing else links a
// child to the code that created it.
const ptcSpawnerByLabel = new Map()
for (const p of rootPtcPrograms) {
  for (const label of p.labels) {
    if (!ptcSpawnerByLabel.has(label)) ptcSpawnerByLabel.set(label, `run_code@${p.turn}/${p.step}`)
  }
}
const verifyByCode = rootPtcPrograms.some((p) => p.awaitVerify || (p.roleMentions.subagent_verify !== undefined && p.backgroundFalse > 0))
const checks = [
  {
    id: 'live-preset',
    ok: livePreset === args.expect,
    detail: `attendu ${args.expect}, observé ${livePreset ?? '(absent)'}${children.length > 0 ? ' (déduit des en-têtes enfants, fiables)' : ' (en-tête racine)'}`,
  },
  {
    id: 'boost-persona',
    ok: rootFacts.promptMarkers.includes('boost orchestrator'),
    detail: rootFacts.promptMarkers.length === 0
      ? 'aucun marqueur reconnu dans le prompt système'
      : rootFacts.promptMarkers.join(', '),
  },
  {
    id: 'preset-declared',
    ok: true,
    info: true,
    detail: `${rootPreset ?? '(absent)'}${rootPreset !== livePreset ? ` — PÉRIMÉ: le preset vivant est ${livePreset}` : ''}`,
  },
  {
    id: 'children-inherit',
    ok: children.length === 0 || childPresetValues.length === 1,
    detail: children.length === 0 ? 'aucun enfant' : childPresets.map((c) => `${short(c.id)}=${c.preset ?? '?'}`).join(' '),
  },
  {
    id: 'ptc-surface',
    ok: isPtc,
    detail: surfaceNames.length === 0 ? 'aucun request/header' : isPtc ? 'run_code seul' : `${surfaceNames.length} schémas natifs: ${surfaceNames.slice(0, 6).join(',')}${surfaceNames.length > 6 ? ',…' : ''}`,
  },
  {
    id: 'verification-foreground',
    ok: verifyCalls.some((d) => d.explicitForeground) || verifyByCode,
    detail: verifyCalls.length > 0
      ? `${verifyCalls.length} appel(s) direct(s), ${verifyCalls.filter((d) => d.explicitForeground).length} avec run_in_background=false`
      : verifyByCode
        ? `aucun appel direct journalisé ; preuve dans le code PTC (await/foreground sur ${rootPtcPrograms.filter((p) => p.roleMentions.subagent_verify !== undefined).length} programme(s))`
        : 'AUCUNE preuve d’appel à subagent_verify',
  },
  {
    id: 'parallel-fanout',
    ok: parallelGroups.length > 0 || ptcFanoutPrograms.length > 0,
    detail: parallelGroups.length > 0
      ? `${parallelGroups.length} step(s) avec ≥2 délégations directes, max ${Math.max(...parallelGroups.map((g) => g.length))}`
      : ptcFanoutPrograms.length > 0
        ? `${ptcFanoutPrograms.length} programme(s) PTC lançant ≥2 rôles (ex. t${ptcFanoutPrograms[0].turn}/s${ptcFanoutPrograms[0].step}: ${Object.entries(ptcFanoutPrograms[0].roleMentions).map(([k, v]) => `${k}×${v}`).join(' ')})`
        : 'aucun fan-out détecté (ni délégation directe groupée, ni programme PTC à ≥2 rôles)',
  },
  {
    id: 'no-unsettled-at-answer',
    // Only meaningful once the root has ended its turn. While the run is live,
    // the root's last message can postdate a child's last write and flip this
    // check green: an unreliable pass is worse than an honest "unknown".
    ok: rootFacts.turnEndReason !== undefined && unsettledAtFinal.length === 0,
    info: rootFacts.turnEndReason === undefined,
    detail: rootFacts.turnEndReason === undefined
      ? `run en cours (aucun turn/end sur la racine) — ${children.filter((n) => facts.get(n.id).turnEndReason === undefined).length}/${children.length} enfant(s) sans turn/end`
      : unsettledAtFinal.length === 0
        ? 'tous réglés avant la réponse finale'
        : `${unsettledAtFinal.length} enfant(s) encore actifs: ${unsettledAtFinal.map((n) => short(n.id)).join(' ')}`,
  },
  { id: 'no-tool-errors', ok: rootFacts.errors.length === 0, detail: `${rootFacts.errors.length} erreur(s) dans la racine` },
]

const report = {
  sessionsRoot: root,
  root: {
    id: tree.root.id,
    preset: rootPreset,
    livePreset,
    promptMarkers: rootFacts.promptMarkers,
    cwd: rootFacts.header?.cwd,
    createdAt: rootFacts.header?.createdAt,
    durationMs: diff(rootFacts.startTime, rootFacts.endTime),
    turnEndReason: rootFacts.turnEndReason,
    usage: rootFacts.usage,
    toolCalls: rootFacts.toolCalls.length,
    toolNames: rootFacts.toolNames,
    ptcSurfaces: rootFacts.ptcSurfaces.length,
    ptcPrograms: rootPtcPrograms,
    systemPromptChars: rootFacts.systemPromptText.length,
  },
  sessions: tree.nodes.map((n) => {
    const f = facts.get(n.id)
    return {
      id: n.id,
      depth: n.depth,
      preset: f.header?.agentPreset,
      origin: f.header?.origin,
      label: f.descriptor?.label,
      mode: f.descriptor?.mode,
      provider: f.descriptor?.agentProvider,
      model: f.descriptor?.agentModel,
      effort: f.descriptor?.agentReasoningEffort,
      spawner: spawnerOf.get(n.id)?.tool ?? (f.descriptor?.label !== undefined ? ptcSpawnerByLabel.get(f.descriptor.label) : undefined),
      durationMs: diff(f.startTime, f.endTime),
      turnEndReason: f.turnEndReason,
      usage: f.usage,
      toolCalls: f.toolCalls.length,
      toolNames: f.toolNames,
      ptcPrograms: f.ptcPrograms,
      promptMarkers: f.promptMarkers,
      errors: f.errors.length,
      finalText: finalText(f),
    }
  }),
  delegations,
  roleUse: Object.fromEntries(roleUse),
  checks,
  errors: [...sessions].flatMap(([id, s]) => [...facts.get(id).errors].map((e) => ({ session: id, depth: s.node.depth, ...e }))),
  anomalies: [...sessions].flatMap(([id, s]) => facts.get(id).anomalies.map((a) => ({ session: id, depth: s.node.depth, ...a }))),
}

const text = renderReport(report, args)
if (args.jsonOut !== undefined) {
  writeFileSync(args.jsonOut, JSON.stringify(report, null, 2), 'utf8')
  console.log(`rapport JSON  : ${args.jsonOut}`)
}
if (args.out !== undefined) {
  writeFileSync(args.out, text, 'utf8')
  console.log(`rapport texte : ${args.out}`)
}
if (args.json) console.log(JSON.stringify(report, null, 2))
else if (args.out === undefined) console.log(text)

// ---------------------------------------------------------------------------

function renderReport(r, options) {
  const L = []
  L.push('# Rapport de run — Boost')
  L.push('')
  L.push(`racine          ${r.root.id}`)
  L.push(`preset déclaré  ${r.root.preset ?? '(absent)'}   (en-tête: peut être périmé)`)
  L.push(`preset vivant   ${r.root.livePreset ?? '(inconnu)'}   (déduit des enfants / en-tête)`)
  L.push(`marqueurs       ${r.root.promptMarkers.length > 0 ? r.root.promptMarkers.join(', ') : '(aucun)'}   prompt système ${r.root.systemPromptChars} car.`)
  L.push(`cwd             ${r.root.cwd ?? '?'}`)
  L.push(`démarré         ${r.root.createdAt ? new Date(r.root.createdAt).toISOString() : '?'}`)
  L.push(`durée           ${fmtDuration(r.root.durationMs)}   fin: ${r.root.turnEndReason ?? '?'}`)
  L.push(`sessions        ${r.sessions.length} (profondeur max ${Math.max(...r.sessions.map((s) => s.depth))})`)
  L.push(`tokens racine   in=${r.root.usage.input} out=${r.root.usage.output} cacheRead=${r.root.usage.cacheRead} total=${r.root.usage.total}`)
  L.push(`outils appelés  ${r.root.toolNames.join(', ') || '(aucun)'}`)

  L.push('')
  L.push('## Arbre de délégation')
  L.push('')
  L.push('| session | prof | rôle | label | preset (en-tête) | modèle | durée | tokens | outils appelés | issue |')
  L.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const s of r.sessions) {
    L.push(
      `| ${short(s.id)} | ${s.depth} | ${s.spawner ?? '—'} | ${trunc(s.label ?? '', 30)} | ${s.preset ?? '?'} | ${s.model ?? '?'}${s.effort ? `@${s.effort}` : ''} | ${fmtDuration(s.durationMs)} | ${s.usage.total} | ${s.toolNames.slice(0, 4).join(',') || '—'}${s.toolNames.length > 4 ? ',…' : ''} | ${s.turnEndReason ?? '?'} |`,
    )
  }

  L.push('')
  L.push('## Délégations, dans l’ordre')
  L.push('')
  if (r.delegations.length === 0) {
    L.push('_aucune délégation — l’orchestrateur a tout fait lui-même_')
  } else {
    L.push('| # | t/s | outil | fond | brief | enfant | retour |')
    L.push('|---|---|---|---|---|---|---|')
    r.delegations.forEach((d, i) => {
      L.push(`| ${i + 1} | ${d.turn}/${d.step} | ${d.tool} | ${d.explicitForeground ? 'NON (attendu)' : 'oui'} | ${d.briefChars} car. | ${d.childId ? short(d.childId) : '?'} | ${d.resultChars} car. |`)
    })
    if (options.briefs) {
      L.push('')
      L.push('### Briefs (extraits)')
      r.delegations.forEach((d, i) => {
        L.push('')
        L.push(`**${i + 1}. ${d.tool} → ${d.childId ? short(d.childId) : '?'}** (${d.briefChars} car.)`)
        L.push('')
        L.push(`> ${d.briefPreview || '(vide)'}`)
      })
    }
  }

  L.push('')
  L.push('## Programmes PTC exécutés (transport run_code)')
  L.push('')
  if (rootPtcPrograms.length === 0) {
    L.push('_aucun run_code : ce run n’est pas en PTC_')
  } else {
    L.push('| # | t/s | description | code | rôles cités | labels des délégations | await verify | bg=false |')
    L.push('|---|---|---|---|---|---|---|---|')
    rootPtcPrograms.forEach((p, i) => {
      L.push(`| ${i + 1} | ${p.turn}/${p.step} | ${trunc(p.description, 40)} | ${p.codeChars} car. | ${Object.entries(p.roleMentions).map(([k, v]) => `${k}×${v}`).join(' ') || '—'} | ${p.labels.map((l) => trunc(l, 26)).join(' ; ') || '—'} | ${p.awaitVerify ? 'oui' : 'non'} | ${p.backgroundFalse} |`)
    })
    L.push('')
    L.push('> Lecture : en PTC seul `run_code` est appelable, donc un appel de rôle peut')
    L.push('> n’exister que dans ce code. `await verify` = le vérificateur a été attendu.')
  }

  L.push('')
  L.push('## Contrôles')
  L.push('')
  for (const c of r.checks) L.push(`${c.info === true ? 'INFO' : c.ok ? 'OK  ' : 'KO  '} ${c.id.padEnd(20)} ${c.detail}`)

  L.push('')
  L.push('## Erreurs d’outil (signal explicite du runtime)')
  L.push('')
  if (r.errors.length === 0) {
    L.push('_aucune_')
  } else {
    for (const e of r.errors.slice(0, options.maxErrors)) {
      L.push(`- [d${e.depth} ${short(e.session)}] ${e.tool} — ${e.detail}`)
    }
    if (r.errors.length > options.maxErrors) L.push(`- … ${r.errors.length - options.maxErrors} de plus (--max-errors)`)
  }

  L.push('')
  L.push('## Anomalies (heuristique : codes de sortie, échecs PTC)')
  L.push('')
  if (r.anomalies.length === 0) {
    L.push('_aucune_')
  } else {
    for (const a of r.anomalies.slice(0, options.maxErrors)) {
      L.push(`- [d${a.depth} ${short(a.session)}] ${a.tool} — ${a.kind} — ${a.detail}`)
    }
    if (r.anomalies.length > options.maxErrors) L.push(`- … ${r.anomalies.length - options.maxErrors} de plus (--max-errors)`)
  }

  L.push('')
  L.push('## Réponses finales par session')
  L.push('')
  for (const s of r.sessions) {
    L.push(`### ${short(s.id)} (${s.spawner ?? 'racine'}, ${s.preset ?? '?'})`)
    L.push('')
    L.push(s.finalText === '' ? '_(aucun texte final)_' : indentQuote(s.finalText.slice(0, options.finalChars)))
    L.push('')
  }
  return L.join('\n')
}

function finalText(f) {
  return f.lastAssistantText ?? ''
}

/**
 * The call id of a `tool/result` record. It is NOT at the root of `data`: the
 * record nests the tool message, and `toolCallId` lives on that message.
 */
function callIdOf(result) {
  return result.data?.message?.toolCallId ?? result.data?.toolCallId
}

function blocksToText(content) {  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
    .filter((t) => t !== '')
    .join('\n')
}

function readHeader(file) {
  try {
    // One-shot decompression yields exactly the first frame, which is the header.
    const first = zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n')[0]
    return JSON.parse(first)
  } catch {
    return undefined
  }
}

function pickTarget() {
  if (args.dir) {
    const found = dirs.find((d) => d.dir === args.dir)
    if (found) return found
    return { id: args.dir.split(/[\\/]/).filter(Boolean).at(-1), dir: args.dir }
  }
  if (args.session) {
    const found = dirs.find((d) => d.id === args.session)
    if (!found) {
      console.error(`session ${args.session} introuvable sous ${root}`)
      process.exit(2)
    }
    return found
  }
  if (process.env.DSH_SESSION_ID) {
    // The session running this script is continuously written, so it would
    // always win a newest-first pick. Prefer the newest OTHER session that has
    // actually run a turn — a freshly created, still empty session would
    // otherwise be analyzed and produce a misleading empty report.
    const others = dirs.filter((d) => d.id !== process.env.DSH_SESSION_ID)
    const used = others.find((d) => hasTurn(d.file))
    if (used) return used
    if (others.length > 0) return others[0]
    const found = dirs.find((d) => d.id === process.env.DSH_SESSION_ID)
    if (found) return found
  }
  return dirs[0]
}

function parseArgs(argv) {
  const out = {
    session: undefined,
    dir: undefined,
    home: undefined,
    expect: 'boost',
    json: false,
    jsonOut: undefined,
    out: undefined,
    list: false,
    limit: 40,
    briefs: true,
    briefChars: 320,
    finalChars: 1400,
    maxErrors: 25,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session') out.session = argv[++i]
    else if (a === '--dir') out.dir = argv[++i]
    else if (a === '--home') out.home = argv[++i]
    else if (a === '--expect') out.expect = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--json-out') out.jsonOut = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--list') out.list = true
    else if (a === '--limit') out.limit = Number(argv[++i])
    else if (a === '--no-briefs') out.briefs = false
    else if (a === '--brief-chars') out.briefChars = Number(argv[++i])
    else if (a === '--final-chars') out.finalChars = Number(argv[++i])
    else if (a === '--max-errors') out.maxErrors = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 22).join('\n'))
      process.exit(0)
    }
  }
  return out
}

/**
 * Cheap fingerprint of which composition actually produced a system prompt.
 * Independent of the session header, which goes stale on a blank-session preset
 * switch, and of the tool surface, which PTC collapses to `run_code`.
 */
function markersOf(text) {
  const out = []
  if (text === '') return out
  if (text.includes('boost orchestrator')) out.push('boost orchestrator')
  if (text.includes('Programmatic Tool Calling')) out.push('Programmatic Tool Calling')
  if (text.includes('cordis-plugin-development')) out.push('skills:cordis')
  if (text.includes('helpful software engineer assistant')) out.push('persona:minimal')
  if (text.includes('You are a coding agent')) out.push('persona:standard-like')
  if (text.includes('complete: ')) out.push('persona:complete')
  if (text.includes('blockedBy') || text.includes('spawn_teammate')) out.push('agent-teams')
  return out
}

function groupBy(items, key) {  const map = new Map()
  for (const item of items) {
    const k = key(item)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(item)
  }
  return map
}

function short(id) {
  return typeof id === 'string' ? id.replace(/^session-/, '').slice(0, 8) : String(id)
}

function trunc(text, n) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`
}

function fmtDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '?'
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

function diff(a, b) {
  return typeof a === 'number' && typeof b === 'number' ? Math.max(0, b - a) : undefined
}

function indentQuote(text) {
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
}
