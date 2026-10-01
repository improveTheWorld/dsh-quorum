// L'ADMISSION DE 'tools/pre-execute' SUR UNE LIGNE HOTE — MESUREE, PAS SUPPOSEE.
//
//   node packages/boost-context-budget/tools/probe-fork-guard.mjs [harness-node-modules] [plugin-entry]
//
// Pourquoi ce probe existe. Le paquet 'boost-context-budget' refuse 'subagent_fork'
// depuis un listener 'tools/pre-execute' monte sur une ligne HOTE sans tag. Cette
// admission etait INFEREE de 'dsh-scope/lib/index.js:327-337' et de la mesure
// 'session/event' de 'probe-stop.mjs' (qui, elle, est mesuree) — jamais mesuree
// pour 'tools/pre-execute'. Si elle echouait, l'outil 'context_occupancy'
// marcherait et le refus ne se declencherait JAMAIS : un garde qui ne garde pas
// est pire qu'aucun garde, parce qu'il rassure. C'est le defaut qui a coute deux
// passes sur le canal (une sonde qui ne mesurait plus rien).
//
// Ce probe monte le VRAI registre d'outils ('@deepseek-ai/dsh-tools') sur une
// vraie application cordis, avec les VRAIES portees ('@deepseek-ai/dsh-scope') :
// une portee de preset, une portee d'agent racine, une portee d'enfant. Il monte
// la VRAIE ligne du plugin, puis il MESURE :
//
//   1. l'ADMISSION : un listener 'tools/pre-execute' SANS TAG monte sur la ligne
//      HOTE recoit les appels — avec le CONTROLE DE VIVACITE : un listener monte
//      sous une portee TAGUEE ne recoit pas l'appel d'un AUTRE agent, sinon
//      l'absence de mesure passerait pour une preuve ;
//   2. le REFUS ARRIVE JUSQU'AU REGISTRE : 'registry.execute(...)' — la couture
//      ou cela compte, pas 'tool.execute' — rend un refus portant le motif du
//      plugin, et le corps de l'outil n'est PAS invoque ;
//   3. le PASSAGE : le meme appel sous le seuil passe, le corps s'execute, et la
//      chaine n'est pas coupee (un listener place en aval voit l'appel) ;
//   4. le FAUX NEGATIF : sans mesure ('unknown'), le fork n'est PAS refuse, et le
//      journal du plugin le dit ('fork-unguarded') ;
//   5. la COMPACTION DIFFEREE : apres un refus, 'turn/end' -> 'compactNow' appele
//      UNE fois ; un tour sans refus -> jamais.
//
// Sortie 0 seulement si les cinq mesures concordent. Toute divergence est un
// PROBE-FAIL nomme : une decouverte, pas un silence.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harnessModules = process.argv[2]
  ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
const entries = {
  cordis: join(harnessModules, '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  scope: join(harnessModules, '@deepseek-ai', 'dsh-scope', 'lib', 'index.js'),
  tools: join(harnessModules, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
}
const pluginEntry = process.argv[3] !== undefined
  ? resolve(process.argv[3])
  : fileURLToPath(new URL('../lib/index.js', import.meta.url))

const say = (key, value) => console.log('PROBE-' + key + ': ' + value)
const tick = (ms) => new Promise((done) => setTimeout(done, ms))
const failures = []

/** Le journal d'une session : le tour clos a seq 3, le tour en vol a seq 4-5. */
const EVENTS = [
  { type: 'turn/start', seq: 0 },
  { type: 'user/message', seq: 1 },
  { type: 'assistant/message', seq: 2 },
  { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 4 },
  { type: 'assistant/message', seq: 5 },
]
const WINDOW = 100_000

async function main() {
  for (const [label, file] of [...Object.entries(entries), ['plugin', pluginEntry]]) {
    if (!existsSync(file)) throw new Error('le module ' + label + ' n est pas installe ici : ' + file)
  }
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-fork-guard-'))
  process.env.DSH_HOME = scratch

  const { Context } = await import(pathToFileURL(entries.cordis).href)
  const { createScope } = await import(pathToFileURL(entries.scope).href)
  const ToolRuntime = (await import(pathToFileURL(entries.tools).href)).default
  const plugin = await import(pathToFileURL(pluginEntry).href)
  const FORK = plugin.FORK_TOOL
  const REFUSAL_CODE = plugin.REFUSAL_CODE

  const root = new Context()
  const sessionOf = (id) => ({ id, header: {}, snapshotEvents: () => EVENTS })
  const rootAgent = { id: 'session-root', session: sessionOf('session-root'), status: 'idle' }
  const workerAgent = { id: 'session-child', session: sessionOf('session-child'), status: 'idle' }

  // Les trois leviers de la mesure : ce que le meter rend, la fenetre annoncee,
  // et de quoi compter ce que le registre et la compaction ont reellement vu.
  let meterNodes = [{ seq: 1, tokens: 50_000 }]
  let meterAvailable = true
  let windowTokens = WINDOW
  const bodyCalls = []
  const compactionCalls = []
  const seq = { n: 0 }

  await root.plugin({
    name: 'probe-services',
    apply: (ctx) => {
      ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 })
      ctx.provide('agents', {
        get: (id) => (id === 'session-root' ? rootAgent : id === 'session-child' ? workerAgent : undefined),
        list: () => [],
      })
      ctx.provide('tokenMeter', {
        measure: (session) => (meterAvailable ? { logRevision: 6, baseline: { kind: 'estimated', tokens: 0 }, surfaceDeltaTokens: 0, totalTokens: 0, surfaceTokens: 0, nodes: meterNodes } : undefined),
      })
      ctx.provide('sessionProjections', {
        snapshot: () => ({ asOfSeq: 5, values: windowTokens === null ? {} : { contextPressure: { contextWindow: windowTokens } } }),
      })
      ctx.provide('compaction', {
        compactNow: (agent, signal) => {
          compactionCalls.push({ agent, statusAtCall: agent.status, signalAborted: signal?.aborted === true })
          return Promise.resolve({ id: 'compaction-probe' })
        },
      })
    },
  })
  await root.plugin(ToolRuntime, { mode: 'native' })
  // La vue du registre s'obtient en DECLARANT l'injection (une lecture par
  // propriete sans 'inject' est refusee : probe-mount s'y est casse les dents).
  let registry
  await root.plugin({ name: 'probe-tools-view', inject: ['tools'], apply: (ctx) => { registry = ctx.tools } })
  await root.plugin({
    name: 'probe-fixtures',
    inject: ['tools'],
    apply: (ctx) => {
      for (const fixture of ['read', FORK]) {
        ctx.tools.register({
          name: fixture,
          description: 'fixture du probe',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'fixture' }] },
          execute: async () => {
            bodyCalls.push(fixture)
            return { fixture }
          },
        })
      }
    },
  })
  await tick(30)

  // Les portees, dans la forme que le harnais compose : preset, puis agent.
  const presetKey = {}
  const preset = createScope(root, presetKey)
  const rootScope = createScope(preset.ctx, rootAgent, { parent: presetKey })
  rootAgent.ctx = rootScope.ctx
  const workerScope = createScope(preset.ctx, workerAgent, { parent: presetKey })
  workerAgent.ctx = workerScope.ctx

  // (A) LE COMPTEUR AMONT, sans tag, sur la LIGNE HOTE : monte AVANT le plugin.
  const upstream = { calls: [] }
  await root.plugin({
    name: 'probe-host-upstream',
    apply: (ctx) => {
      ctx.on('tools/pre-execute', (exec, next) => {
        upstream.calls.push(exec.name)
        return next()
      })
    },
  })
  // (B) LE CONTROLE DE VIVACITE : le meme listener, TAGUE par la portee de l ENFANT.
  const tagged = { calls: [] }
  await workerScope.ctx.plugin({
    name: 'probe-tagged-control',
    apply: (ctx) => {
      ctx.on('tools/pre-execute', (exec, next) => {
        tagged.calls.push(exec.name)
        return next()
      })
    },
  })
  // (C) LA LIGNE HOTE : le plugin, la ou le profil le monte.
  await root.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
  // (D) LE COMPTEUR AVAL, sans tag, monte APRES le plugin : il ne doit voir que
  // ce que la garde laisse PASSER.
  const downstream = { calls: [] }
  await root.plugin({
    name: 'probe-host-downstream',
    apply: (ctx) => {
      ctx.on('tools/pre-execute', (exec, next) => {
        downstream.calls.push(exec.name)
        return next()
      })
    },
  })
  await tick(30)
  root.emit('agent/created', { agent: workerAgent, source: 'spawn' })
  await tick(150)

  if (registry === undefined) throw new Error('le registre d outils n a pas ete capture : la composition du probe est invalide')

  const call = async (name, agent) => {
    const result = await registry.execute({
      callId: 'probe-' + (++seq.n),
      name,
      arguments: {},
      agent,
      signal: new AbortController().signal,
    })
    return result
  }

  // ---- 1. L'ADMISSION, et son controle de vivacite -------------------------
  const before = upstream.calls.length
  await call('read', workerAgent)
  await call('read', rootAgent)
  const seen = upstream.calls.slice(before)
  say('1-admission', 'listener SANS TAG (ligne HOTE) : ' + seen.length + ' appel(s) recus -> ' + seen.join(', '))
  say('1-controle', 'listener TAGUE par la portee de l ENFANT : ' + (tagged.calls.join(', ') || '(aucun)')
    + ' — il voit l appel de SON agent, pas celui de la racine')
  if (seen.length !== 2) {
    failures.push('l admission est REFUSEE : un listener tools/pre-execute sans tag monte sur la ligne HOTE ne recoit pas les appels (recus: ' + seen.length + ')')
  }
  if (tagged.calls.length !== 1 || tagged.calls[0] !== 'read') {
    failures.push('le controle de vivacite ne mord pas : le listener TAGUE a vu ' + JSON.stringify(tagged.calls) + ' — sans discrimination, l absence de mesure passerait pour une preuve')
  }

  // ---- 2. LE REFUS ARRIVE JUSQU'AU REGISTRE --------------------------------
  meterNodes = [{ seq: 1, tokens: 71_000 }]
  const bodyBefore = bodyCalls.length
  // Des DELTAS, jamais des totaux : un total ferait passer une assertion pour
  // une preuve par le seul hasard de l ordre des appels.
  const downstreamBeforeDenied = downstream.calls.filter((name) => name === FORK).length
  const denied = await call(FORK, rootAgent)
  const downstreamAfterDenied = downstream.calls.filter((name) => name === FORK).length
  say('2-refus', 'registry.execute -> isError=' + denied.isError + ' · code=' + (denied.error?.info?.code ?? '(aucun)'))
  say('2-refus', 'motif rendu par le registre : ' + (denied.error?.message ?? '(aucun)'))
  say('2-refus', 'corps de l outil invoque = ' + (bodyCalls.length > bodyBefore ? 'OUI' : 'non')
    + ' · aval a vu = ' + (downstreamAfterDenied - downstreamBeforeDenied))
  if (denied.isError !== true) failures.push('le refus n atteint pas le registre : le fork a ete ACCEPTE alors qu il est au-dessus du seuil')
  if (denied.error?.info?.code !== REFUSAL_CODE) failures.push('le refus rendu ne porte pas l identite du plugin (' + String(denied.error?.info?.code) + ')')
  if (!String(denied.error?.message ?? '').includes('fork refuse')) failures.push('le motif rendu n est pas celui du plugin : ' + String(denied.error?.message))
  if (bodyCalls.length > bodyBefore) failures.push('le corps de l outil a ete invoque MALGRE le refus')

  // ---- 3. LE PASSAGE, et par 'next()' --------------------------------------
  meterNodes = [{ seq: 1, tokens: 50_000 }]
  const forkBodiesBefore = bodyCalls.filter((name) => name === FORK).length
  const downstreamBefore = downstream.calls.filter((name) => name === FORK).length
  const passed = await call(FORK, rootAgent)
  const downstreamDelta = downstream.calls.filter((name) => name === FORK).length - downstreamBefore
  say('3-passage', 'registry.execute -> isError=' + passed.isError + ' · corps invoque = '
    + (bodyCalls.filter((name) => name === FORK).length > forkBodiesBefore ? 'OUI' : 'non')
    + ' · aval a vu le fork ' + downstreamDelta + ' fois')
  if (passed.isError !== false) failures.push('sous le seuil, le fork est refuse : ' + String(passed.error?.message))
  if (bodyCalls.filter((name) => name === FORK).length <= forkBodiesBefore) failures.push('sous le seuil, la chaine n atteint pas le corps de l outil : next() est coupe')
  if (downstreamDelta !== 1) failures.push('un listener en AVAL ne voit pas le fork qui passe : la chaine est coupee')

  // ---- 4. LE FAUX NEGATIF ---------------------------------------------------
  meterAvailable = false
  windowTokens = null
  const blindBodiesBefore = bodyCalls.filter((name) => name === FORK).length
  const blind = await call(FORK, rootAgent)
  say('4-faux-negatif', 'sans mesure -> isError=' + blind.isError + ' · corps invoque = '
    + (bodyCalls.filter((name) => name === FORK).length > blindBodiesBefore ? 'OUI' : 'non'))
  if (blind.isError !== false) failures.push('sans mesure, le fork est REFUSE : on ne devine pas, on s abstient — ' + String(blind.error?.message))

  // ---- 5. LA COMPACTION DIFFEREE -------------------------------------------
  // Le refus de l etape 2 a arme la compaction du tour courant.
  root.emit('session/event', rootAgent.session, { type: 'turn/end', data: { turn: 2 } })
  await tick(120)
  const afterRefusal = compactionCalls.length
  say('5-compaction', 'apres un refus puis turn/end : compactNow appele ' + afterRefusal + ' fois'
    + (afterRefusal > 0 ? ' sur l agent ' + (compactionCalls[0].agent === rootAgent ? 'du refus' : 'INATTENDU') + ' (status=' + compactionCalls[0].statusAtCall + ')' : ''))
  // Un tour SANS refus : la garde n a rien arme, rien ne doit partir.
  root.emit('session/event', rootAgent.session, { type: 'turn/end', data: { turn: 3 } })
  await tick(120)
  say('5-compaction', 'apres un tour SANS refus : total compactNow = ' + compactionCalls.length)
  if (afterRefusal !== 1) failures.push('apres un refus, compactNow a ete appele ' + afterRefusal + ' fois au lieu d une')
  if (compactionCalls.length !== 1) failures.push('un tour sans refus a declenche une compaction (total ' + compactionCalls.length + ')')

  // ---- 6. LE RETOUR REEL DE L OUTIL D OCCUPATION, PAR LE REGISTRE ----------
  //
  // Le defaut reel, mesure : l'outil rendait une cle ('sources') absente du
  // schema de sortie, et le registre REJETTE toute cle non declaree
  // ('dsh-tools/lib/index.js:3541-3544'). La sonde exerce donc AUSSI le RETOUR de
  // l'outil, par la meme couture que le fork — un test qui appelle 'execute()'
  // directement passe au-dessus de cette validation et ne prouve rien.
  meterAvailable = true
  windowTokens = WINDOW
  meterNodes = [{ seq: 1, tokens: 71_000 }]
  const occupancy = await call('context_occupancy', workerAgent)
  say('6-outil', 'registry.execute(context_occupancy) -> isError=' + occupancy.isError
    + ' · inheritedTokens=' + (occupancy.value?.inheritedTokens ?? '(aucune valeur)')
    + ' · windowTokens=' + (occupancy.value?.windowTokens ?? '(aucune valeur)')
    + ' · ratio=' + (occupancy.value?.ratio ?? '(aucune valeur)')
    + ' · verdict=' + (occupancy.value?.verdict ?? '(aucune valeur)')
    + ' · sources=' + JSON.stringify(occupancy.value?.sources ?? null))
  if (occupancy.isError === true) failures.push('le retour REEL de context_occupancy est rejete par le registre : ' + String(occupancy.error?.message))
  if (occupancy.value?.sources?.inherited !== 'token-meter') failures.push('le retour REEL de context_occupancy ne porte pas ses sources : ' + JSON.stringify(occupancy.value ?? null))

  // ---- Le journal du plugin : la meme histoire, cote production -------------
  const journalFile = join(scratch, 'plugin-data', plugin.name, 'decisions.jsonl')
  const rows = existsSync(journalFile)
    ? readFileSync(journalFile, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    : []
  const steps = rows.map((row) => row.step)
  const refusedRows = rows.filter((row) => row.step === 'fork-refused')
  const unguardedRows = rows.filter((row) => row.step === 'fork-unguarded')
  say('journal', 'etapes ecrites : ' + steps.join(', '))
  if (refusedRows.length > 0) {
    say('journal', 'fork-refused : inheritedTokens=' + refusedRows[0].inheritedTokens + ' windowTokens=' + refusedRows[0].windowTokens
      + ' ratio=' + refusedRows[0].ratio + ' threshold=' + refusedRows[0].threshold)
  }
  if (refusedRows.length !== 1) failures.push('le journal ne porte pas UNE ligne fork-refused (recu ' + refusedRows.length + ')')
  if (unguardedRows.length !== 1) failures.push('le journal ne porte pas la ligne fork-unguarded du faux negatif (recu ' + unguardedRows.length + ')')
  if (steps.filter((step) => step === 'fork-compacted').length !== 1) {
    failures.push('le journal ne porte pas UNE ligne fork-compacted (recu ' + steps.filter((step) => step === 'fork-compacted').length + ')')
  }

  // Observation, hors verdict : l outil est-il sur la surface de l agent ?
  const surface = registry.schemas(workerAgent).map((schema) => schema.name)
  const installed = plugin.TOOL_NAMES.filter((name) => surface.includes(name))
  say('surface', 'outils du paquet sur la surface modele de l agent : ' + (installed.join(', ') || '(aucun)')
    + ' (attendu ' + plugin.TOOL_NAMES.join(', ') + ')')

  try { await root.dispose?.() } catch { /* le teardown ne masque jamais le verdict */ }
  rmSync(scratch, { recursive: true, force: true })
}

try {
  await main()
} catch (error) {
  failures.push('MESURE EN ECHEC — ' + String(error?.stack ?? error))
}

if (failures.length > 0) {
  console.log('PROBE-FAIL — ' + failures.join(' ; '))
  process.exit(1)
}
console.log('PROBE-PASS — l admission de tools/pre-execute sur une ligne HOTE sans tag est MESUREE : le listener recoit les appels, le refus atteint le registre avec son motif, le passage suit next(), le faux negatif s abstient, et la compaction differee part une fois par tour refuse')
