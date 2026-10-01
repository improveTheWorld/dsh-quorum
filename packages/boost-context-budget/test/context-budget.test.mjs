// Les tests de 'dsh-boost-context-budget' — la garde du fork, et sa mesure.
//
//   node --test packages/boost-context-budget/test/context-budget.test.mjs
//
// Chaque cas ci-dessous peut ECHOUER, et c'est la seule raison de l'ecrire. Les
// cas T-C1..T-C8 sont ceux qui ont decide la conception :
//
//   T-C1  la mesure : le ratio est calcule, et le TOUR EN VOL est exclu du
//         prefixe herite — c'est la frontiere meme que le fork applique ;
//   T-C2  la regle : au-dessus du seuil le fork est REFUSE, et le message nomme
//         les DEUX nombres (71 % contre 60 %) ;
//   T-C3  le seuil est CONFIGURABLE : le meme ratio change de verdict ;
//   T-C4  la compaction differee : un refus pendant le tour, puis 'turn/end' ->
//         'compactNow' UNE fois, et jamais sur un tour sans refus ;
//   T-C5  idempotence par tour : deux tours refuses, deux compactions ; deux
//         refus dans le MEME tour, une seule ;
//   T-C6  un seuil invalide journalise et retombe sur le defaut, sans casser le
//         montage ;
//   T-C7  l'outil rend la mesure de l'APPELANT, et un appelant sans session ne
//         fait pas tomber ce qui l'entoure ;
//   T-C8  la valeur REELLE passe la validation du REGISTRE — le seul cas qui
//         aurait attrape le defaut reel : appeler 'tool.execute(...)' passe
//         AU-DESSUS de la couture qui valide le schema de sortie.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  apply,
  buildTools,
  DEFAULT_FORK_THRESHOLD_RATIO,
  FORK_TOOL,
  TOOL_NAMES,
  VERDICT_OK,
  VERDICT_REFUSED,
  VERDICT_UNKNOWN,
  breakdownTotal,
  measure,
  prefixBreakdownOf,
  resolveThreshold,
} from '../lib/index.js'

/** Un journal par test : le fichier est la seule preuve lisible apres coup. */
function home() {
  return mkdtempSync(join(tmpdir(), 'boost-context-budget-'))
}

/** Une attente courte : cordis active ses fibres hors du tour courant. */
const tick = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Les modules du harnais, resolus comme 'test/aggregate.test.mjs' resout 'yaml'.
 * Introuvables, c'est une ERREUR et jamais un saut : un controle qui ne peut pas
 * s'executer ne doit pas ressembler a un controle qui passe.
 */
function harnessModules() {
  return process.env.DSH_HARNESS
    ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
}

/** Les entrees reellement ecrites dans 'decisions.jsonl'. */
function journalEntries(dir) {
  const file = join(dir, 'plugin-data', 'dsh-boost-context-budget', 'decisions.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

/** Les entrees d'une etape donnee. */
function entriesOf(dir, step) {
  return journalEntries(dir).filter((entry) => entry.step === step)
}

/** Une session dont on maitrise le journal : c'est LUI qui porte la frontiere. */
function fakeSession(id, events) {
  return { id, snapshotEvents: () => events }
}

/**
 * Une journee de session : un tour clos (turn/end a seq 3) puis un tour OUVERT
 * (le tour en vol du fork, seq 4-5). Le prefixe herite s'arrete a seq 3.
 */
const EVENTS = [
  { type: 'turn/start', seq: 0, data: { turn: 1 } },
  { type: 'user/message', seq: 1 },
  { type: 'assistant/message', seq: 2 },
  { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  // Le tour EN VOL du fork : c'est le tour 2, et c'est lui que l'armement d'un
  // refus doit porter (voir T-C4e).
  { type: 'turn/start', seq: 4, data: { turn: 2 } },
  { type: 'assistant/message', seq: 5 },
]

/**
 * Le montage : un contexte minimal qui n'expose QUE ce que le plugin declare, et
 * qui enregistre tout ce qu'il faut pour juger — les decisions de pre-execute,
 * les appels de compaction, et l'ordre entre eux.
 */
function harness(options = {}) {
  const dir = options.home ?? home()
  const listeners = new Map()
  const registered = []
  const compactionCalls = []
  const agents = new Map()
  const compaction = {
    compactNow: (agent, signal) => {
      compactionCalls.push({ agent, signal, statusAtCall: agent.status })
      if (typeof options.compactNow === 'function') return options.compactNow(agent, signal)
      return Promise.resolve(options.compactionResult ?? null)
    },
  }
  const services = {
    compaction,
    ...options.services,
  }
  // FAUX REGISTRE PAR DEFAUT. Les cas qui portent sur la BORNE, le seuil ou la
  // garde n'ont pas a reconstruire un prefixe : le 'restore' injecte rend le
  // 'contextBreakdown' des noeuds CLOS du meter (ou de la composition), avec la
  // meme regle de frontiere — appartient au FAUX, jamais au plugin.
  // 'noRestore: true', ou un 'restore' qui jette, exerce l'ABSTENTION.
  if (options.noRestore !== true && typeof services.sessionProjections?.restore !== 'function') {
    const nodes = fakeNodes(services)
    if (nodes !== undefined) services.sessionProjections = { ...services.sessionProjections ?? {}, restore: restoreFromNodes(nodes) }
  }
  const ctx = {
    agents: {
      list: () => [...agents.values()],
      get: (id) => agents.get(id),
    },
    get: (serviceName) => {
      // Un 'get' qui jette est un cas reel : la lecture d'un service absent ne
      // doit jamais transformer une compaction en rejet non gere.
      if ((options.getThrows ?? []).includes(serviceName)) throw new Error('service lookup failed: ' + serviceName)
      return services[serviceName]
    },
    on: (event, listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
    },
    provide: () => {},
  }
  const config = { home: dir, ...options.config }
  const controller = apply(ctx, config)
  return {
    dir,
    controller,
    addAgent: (agent) => agents.set(agent.session.id, agent),
    registered,
    compactionCalls,
    fire: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    /** Le waterfall 'tools/pre-execute', appele comme le registre l'appelle. */
    preExecute: async (exec) => {
      const listenersFor = listeners.get('tools/pre-execute') ?? []
      let index = 0
      // 'chainEnd' compte les fois ou la chaine a ete DELEGUEE jusqu'au bout :
      // zero veut dire que la garde a rendu sa decision sans appeler 'next()',
      // donc que les politiques suivantes (approbation, sandbox) n'ont pas vu
      // passer l'appel.
      let chainEnd = 0
      const next = () => {
        const listener = listenersFor[index++]
        if (listener === undefined) {
          chainEnd++
          return Promise.resolve({ kind: 'allow' })
        }
        return listener(exec, next)
      }
      const decision = await next()
      return { decision, chainEnd }
    },
    tool: () => {
      // L'outil tel qu'il est enregistre DANS LA SURFACE d'un agent.
      const installed = registered.at(-1)
      assert.ok(installed !== undefined, 'aucun outil installe : rien ne peut etre appele')
      return installed.tool
    },
    installSurface: (agent) => {
      // Reproduit 'agent.ctx.inject([\'tools\'], ...)' : c'est ce que le plugin fait.
      const toolCtx = { tools: { register: (tool) => registered.push({ agent, tool }) } }
      agent.ctx = { inject: (deps, callback) => callback(toolCtx) }
    },
  }
}

/** Un agent vivant, avec SA surface, tel que 'agent/created' le porte. */
function fakeAgent(session, options = {}) {
  const agent = {
    session,
    status: options.status ?? 'running',
    whenIdleCalls: 0,
    whenIdle() {
      agent.whenIdleCalls++
      agent.status = 'idle'
      return Promise.resolve()
    },
  }
  return agent
}

/** Un meter de surface : des noeuds prices, indexes par seq. */
function meterOf(nodes) {
  return { measure: () => ({ nodes }) }
}

/** Les noeuds qu'un faux meter (ou une fausse composition) annonce, sans session. */
function fakeNodes(services) {
  const probe = { id: 'probe', snapshotEvents: () => [] }
  try {
    const measured = services.tokenMeter?.measure?.(probe)
    if (Array.isArray(measured?.nodes)) return measured.nodes
  } catch {
    // Pas de meter utilisable : on essaie la composition.
  }
  try {
    const state = services.sessionProjections?.stateOf?.(probe, 'contextBreakdown')
    if (Array.isArray(state?.nodes)) return state.nodes
  } catch {
    // Rien non plus.
  }
  return undefined
}

/** Un faux 'restore' qui somme les noeuds CLOS du prefixe qu'on lui donne. */
function restoreFromNodes(nodes) {
  return (checkpoint, events) => {
    const boundary = events.length === 0 ? -1 : events[events.length - 1].seq
    let total = 0
    for (const node of nodes) {
      const seq = node?.seq
      if (typeof seq !== 'number' || seq > boundary) continue
      const price = typeof node.tokens === 'number' ? node.tokens : node.heuristicTokens
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) total += price
    }
    return { snapshot: { asOfSeq: boundary, values: { contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: total } } }, checkpoint: {} }
  }
}

/**
 * Une projection de session : 'snapshot' pour la fenetre, 'stateOf' pour la
 * composition, et 'restore' — LA source de la mesure — quand le cas la fournit.
 * Sans 'restore', la mesure prend son REPLI et le journalise : c'est ce que
 * verifient les cas de repli, pas les autres.
 */
function projectionsOf({ window, nodes, restore }) {
  return {
    snapshot: (_session, keys) => {
      assert.deepEqual(keys, ['contextPressure'])
      return { asOfSeq: 5, values: window === undefined ? {} : { contextPressure: { contextWindow: window } } }
    },
    stateOf: (_session, key) => {
      if (key !== 'contextBreakdown') return undefined
      return nodes === undefined ? undefined : { nodes, breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } }
    },
    ...restore === undefined ? {} : { restore },
  }
}

/**
 * Un 'restore' de faux registre : il REND le 'contextBreakdown' qu'on lui donne,
 * et il RETIENT ce qu'on lui a passe — la seule facon de prouver que la mesure
 * lui donne bien le prefixe borne.
 */
function restoreOf(breakdown, seen = []) {
  const restore = (checkpoint, events, baseSeq, header, inherited) => {
    seen.push({ checkpoint, events, baseSeq, header, inherited })
    return {
      snapshot: {
        asOfSeq: events.length === 0 ? -1 : events[events.length - 1].seq,
        values: { contextBreakdown: breakdown },
      },
      checkpoint: {},
    }
  }
  restore.seen = seen
  return restore
}

// --------------------------------------------------------------------------- //
// T-C1 — la mesure                                                             //
// --------------------------------------------------------------------------- //

test('T-C1 : le ratio est rendu, et le TOUR EN VOL est exclu du prefixe herite', () => {
  const session = fakeSession('session-c1', EVENTS)
  const dir = home()
  // 4 caracteres/token, comme l'estimateur du harnais : 400 000 caracteres clos
  // valent ~100 000 tokens. Le tour en vol en porte 300 000 DE PLUS, et ne doit
  // pas entrer dans le compte — c'est exactement ce que le fork n'herite pas.
  const meter = meterOf([
    { seq: 1, tokens: 60_000 },
    { seq: 2, tokens: 40_000 },
    { seq: 5, tokens: 75_000 },
  ])
  const harnessed = harness({
    home: dir,
    services: { tokenMeter: meter, sessionProjections: projectionsOf({ window: 160_000 }) },
  })
  const value = harnessed.controller.measureFor(session)

  assert.equal(value.inheritedTokens, 100_000, 'les noeuds clos valent 100 000 tokens')
  assert.equal(value.windowTokens, 160_000, 'la fenetre vient de contextPressure.contextWindow')
  assert.ok(Math.abs(value.ratio - 0.625) < 0.02, 'ratio attendu ~0,625, mesure ' + value.ratio)
  assert.equal(value.forkThresholdRatio, DEFAULT_FORK_THRESHOLD_RATIO)
  assert.equal(value.verdict, VERDICT_REFUSED, '0,625 > 0,6 : un fork serait refuse')
  assert.equal(value.sources.inherited, 'restore-boundary', 'la mesure vient du prefixe rendu par restore')
  assert.equal(value.sources.boundarySeq, 3, 'la frontiere est le dernier turn/end, seq 3')
})

test('T-C1b : la fenetre se lit aussi sur l evenement durable request/context', () => {
  // Mesure sur une session reelle : {"provider":"deepseek-official","model":
  // "deepseek-flash","contextWindow":1000000,"systemPromptUpdate":"in-history"}.
  const events = [
    { type: 'request/context', seq: 0, data: { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1_000_000 } },
    ...EVENTS,
  ]
  const session = fakeSession('session-c1b', events)
  const harnessed = harness({ services: { tokenMeter: meterOf([{ seq: 1, tokens: 700_000 }]) } })
  const value = harnessed.controller.measureFor(session)
  assert.equal(value.windowTokens, 1_000_000)
  assert.equal(value.sources.window, 'request-context')
  assert.ok(Math.abs(value.ratio - 0.7) < 0.02, 'ratio attendu ~0,70, mesure ' + value.ratio)
})

test('T-C1c : sans meter, la composition contextBreakdown donne le meme prefixe', () => {
  const session = fakeSession('session-c1c', EVENTS)
  const harnessed = harness({
    services: { sessionProjections: projectionsOf({ window: 160_000, nodes: [{ seq: 1, heuristicTokens: 60_000 }, { seq: 2, heuristicTokens: 40_000 }, { seq: 5, heuristicTokens: 75_000 }] }) },
  })
  const value = harnessed.controller.measureFor(session)
  assert.equal(value.sources.inherited, 'restore-boundary')
  assert.equal(value.inheritedTokens, 100_000)
  assert.equal(value.windowTokens, 160_000)
})

test('T-C1d : sans source de taille, la mesure vaut null et le verdict unknown', () => {
  const session = fakeSession('session-c1d', EVENTS)
  const harnessed = harness({ services: { sessionProjections: projectionsOf({ window: 160_000 }) } })
  const value = harnessed.controller.measureFor(session)
  assert.equal(value.inheritedTokens, null)
  assert.equal(value.ratio, null)
  assert.equal(value.verdict, VERDICT_UNKNOWN, 'trois etats, jamais deux : on ne devine pas')
})

test('T-C1e : avant tout tour clos, le fork n herite de RIEN', () => {
  const session = fakeSession('session-c1e', [{ type: 'turn/start', seq: 0 }, { type: 'assistant/message', seq: 1 }])
  const harnessed = harness({ services: { tokenMeter: meterOf([{ seq: 1, tokens: 90_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) } })
  const value = harnessed.controller.measureFor(session)
  assert.equal(value.sources.boundarySeq, -1)
  assert.equal(value.inheritedTokens, 0, 'completedTurnPrefix rend un tableau vide : l enfant demarre a neuf')
  assert.equal(value.ratio, 0)
  assert.equal(value.verdict, VERDICT_OK)
})

test('T-C1f : la fonction de mesure est utilisable seule, hors montage', () => {
  const session = fakeSession('session-c1f', EVENTS)
  const value = measure({
    tokenMeter: meterOf([{ seq: 2, tokens: 50_000 }]),
    sessionProjections: projectionsOf({ window: 100_000, restore: restoreOf({ systemTokens: 0, toolsTokens: 0, messageTokens: 50_000 }) }),
  }, session, 0.6)
  assert.equal(value.inheritedTokens, 50_000)
  assert.equal(value.ratio, 0.5)
  assert.equal(value.verdict, VERDICT_OK)
})

// --------------------------------------------------------------------------- //
// T-C2 — la regle au moment du fork                                            //
// --------------------------------------------------------------------------- //

test('T-C2 : sous le seuil le fork PASSE, au-dessus il est REFUSE avec les deux nombres', async () => {
  // PASSAGE : 50 % de la fenetre.
  const passing = harness({
    services: { tokenMeter: meterOf([{ seq: 1, tokens: 50_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) },
  })
  const passSession = fakeSession('session-c2-pass', EVENTS)
  const passAgent = fakeAgent(passSession, { status: 'idle' })
  const pass = await passing.preExecute({ name: FORK_TOOL, agent: passAgent, arguments: {} })
  assert.deepEqual(pass.decision, { kind: 'allow' }, 'sous le seuil, la chaine continue')
  assert.equal(pass.chainEnd, 1, 'next() est appele : les autres politiques ne sont pas coupees')

  // REFUS : 71 % de la fenetre, seuil 60 %.
  const refusing = harness({
    services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }, { seq: 2, tokens: 0 }]), sessionProjections: projectionsOf({ window: 100_000 }) },
  })
  const refuseSession = fakeSession('session-c2-refuse', EVENTS)
  const refuseAgent = fakeAgent(refuseSession, { status: 'idle' })
  const refused = await refusing.preExecute({ name: FORK_TOOL, agent: refuseAgent, arguments: {} })
  assert.equal(refused.decision.kind, 'deny', 'au-dessus du seuil, le fork est refuse')
  assert.equal(refused.chainEnd, 0, 'un refus ne delegue pas la decision a la suite de la chaine')
  assert.ok(refused.decision.reason.includes('71 %'), 'le message nomme le ratio mesure : ' + refused.decision.reason)
  assert.ok(refused.decision.reason.includes('60 %'), 'le message nomme le seuil : ' + refused.decision.reason)
  assert.ok(refused.decision.reason.includes('71000'), 'le message nomme les tokens herites')
  assert.ok(refused.decision.reason.includes('100000'), 'le message nomme la fenetre')
  assert.ok(refused.decision.reason.includes('termine ton tour'), 'le message dit QUOI FAIRE')
  assert.ok(refused.decision.reason.includes('subagent_implement'), 'la sortie de secours est nommee')
  assert.equal(refused.decision.info?.code, 'BOOST_FORK_OVER_THRESHOLD')

  // Le refus est JOURNALISE avec les deux nombres, et COMPTE.
  const rows = entriesOf(refusing.dir, 'fork-refused')
  assert.equal(rows.length, 1, 'un refus, une ligne de journal')
  assert.equal(rows[0].inheritedTokens, 71_000)
  assert.equal(rows[0].windowTokens, 100_000)
  assert.equal(rows[0].threshold, 0.6)
  assert.equal(refusing.controller.stats.refused, 1)
  assert.equal(refusing.controller.stats.passed, 0)
  assert.equal(passing.controller.stats.passed, 1)
})

test('T-C2b : un autre outil traverse la chaine sans etre mesure', async () => {
  const harnessed = harness({ services: { tokenMeter: meterOf([{ seq: 1, tokens: 999_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) } })
  const session = fakeSession('session-c2b', EVENTS)
  const result = await harnessed.preExecute({ name: 'run_code', agent: fakeAgent(session, { status: 'idle' }), arguments: {} })
  assert.deepEqual(result.decision, { kind: 'allow' })
  assert.equal(harnessed.controller.stats.measured, 0, 'la garde ne mesure que le fork')
})

test('T-C2c : une mesure indisponible ne refuse pas — elle est journalisee', async () => {
  const harnessed = harness({ services: { sessionProjections: projectionsOf({ window: 100_000 }) } })
  const session = fakeSession('session-c2c', EVENTS)
  const result = await harnessed.preExecute({ name: FORK_TOOL, agent: fakeAgent(session, { status: 'idle' }), arguments: {} })
  assert.deepEqual(result.decision, { kind: 'allow' }, 'pas de mesure, pas de refus : on ne devine pas')
  assert.equal(entriesOf(harnessed.dir, 'fork-unguarded').length, 1)
})

// --------------------------------------------------------------------------- //
// T-C3 — le seuil est configurable                                             //
// --------------------------------------------------------------------------- //

test('T-C3 : le meme ratio change de verdict quand le seuil change', async () => {
  const build = (threshold) => {
    const session = fakeSession('session-c3-' + String(threshold), EVENTS)
    const harnessed = harness({
      config: { forkThresholdRatio: threshold },
      services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) },
    })
    return { harnessed, session }
  }
  const strict = build(0.6)
  const loose = build(0.8)
  assert.equal(strict.harnessed.controller.threshold, 0.6)
  assert.equal(loose.harnessed.controller.threshold, 0.8)

  const strictDecision = await strict.harnessed.preExecute({ name: FORK_TOOL, agent: fakeAgent(strict.session, { status: 'idle' }), arguments: {} })
  const looseDecision = await loose.harnessed.preExecute({ name: FORK_TOOL, agent: fakeAgent(loose.session, { status: 'idle' }), arguments: {} })
  assert.equal(strictDecision.decision.kind, 'deny', 'a 0,6 un ratio de 0,71 est refuse')
  assert.equal(looseDecision.decision.kind, 'allow', 'a 0,8 le MEME ratio passe')
  assert.equal(looseDecision.chainEnd, 1, 'sous le seuil, la chaine suit son cours')

  // La meme valeur est rendue a l'appelant par l'outil.
  const measured = loose.harnessed.controller.measureFor(loose.session)
  assert.equal(measured.forkThresholdRatio, 0.8)
  assert.equal(measured.verdict, VERDICT_OK)
})

test('T-C3b : le seuil par defaut est 0,6 et il est bien celui applique', async () => {
  const harnessed = harness({ services: { tokenMeter: meterOf([{ seq: 1, tokens: 60_001 }]), sessionProjections: projectionsOf({ window: 100_000 }) } })
  assert.equal(harnessed.controller.threshold, 0.6)
  assert.equal(DEFAULT_FORK_THRESHOLD_RATIO, 0.6)
  const session = fakeSession('session-c3b', EVENTS)
  const result = await harnessed.preExecute({ name: FORK_TOOL, agent: fakeAgent(session, { status: 'idle' }), arguments: {} })
  assert.equal(result.decision.kind, 'deny', 'juste au-dessus du defaut, on refuse')
})

// --------------------------------------------------------------------------- //
// T-C4 — la compaction differee                                                //
// --------------------------------------------------------------------------- //

test('T-C4 : un refus puis turn/end -> compactNow UNE fois ; un tour sans refus -> aucune', async () => {
  const harnessed = harness({ services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) } })
  const session = fakeSession('session-c4', EVENTS)
  const agent = fakeAgent(session, { status: 'running' })
  harnessed.addAgent(agent)

  // 1. Un tour SANS refus : rien ne doit etre compacte.
  harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 1 } })
  await harnessed.controller.settled()
  assert.equal(harnessed.compactionCalls.length, 0, 'sans refus, aucune compaction')

  // 2. Un refus PENDANT le tour, puis le 'turn/end' de ce tour.
  const refused = await harnessed.preExecute({ name: FORK_TOOL, agent, arguments: {} })
  assert.equal(refused.decision.kind, 'deny')
  harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 2 } })
  await harnessed.controller.settled()

  assert.equal(harnessed.compactionCalls.length, 1, 'un refus, une compaction')
  assert.equal(harnessed.compactionCalls[0].agent, agent, 'la compaction porte sur l agent du refus')
  assert.equal(harnessed.compactionCalls[0].statusAtCall, 'idle', 'on compacte un agent INACTIF, jamais un agent actif')
  assert.equal(agent.whenIdleCalls, 1, 'l inactivite a ete attendue : a turn/end le driver est encore ouvert')
  assert.equal(harnessed.controller.stats.compacted, 1)
  assert.equal(entriesOf(harnessed.dir, 'fork-compacted').length, 1)

  // 3. Le tour suivant, sans refus, ne recompacte pas.
  harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 3 } })
  await harnessed.controller.settled()
  assert.equal(harnessed.compactionCalls.length, 1, 'la compaction ne se rejoue pas toute seule')
})

test('T-C4b : un agent deja idle n attend pas, et un agent disparu est journalise', async () => {
  const harnessed = harness({ services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) } })
  const session = fakeSession('session-c4b', EVENTS)
  const agent = fakeAgent(session, { status: 'idle' })
  harnessed.addAgent(agent)
  await harnessed.preExecute({ name: FORK_TOOL, agent, arguments: {} })
  // Le refus appartient au tour OUVERT du journal : le tour 2 (EVENTS).
  harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 2 } })
  await harnessed.controller.settled()
  assert.equal(harnessed.compactionCalls.length, 1)
  assert.equal(agent.whenIdleCalls, 0, 'un agent deja inactif n est pas attendu')

  // Un agent qui a quitte le registre : journalise, jamais une exception.
  const gone = harness({
    services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) },
  })
  const ghost = fakeSession('session-c4b-ghost', EVENTS)
  await gone.preExecute({ name: FORK_TOOL, agent: fakeAgent(ghost, { status: 'idle' }), arguments: {} })
  assert.doesNotThrow(() => gone.fire('session/event', ghost, { type: 'turn/end', data: { turn: 2 } }))
  await gone.controller.settled()
  assert.equal(gone.compactionCalls.length, 0)
  assert.equal(entriesOf(gone.dir, 'compact-skipped').length, 1)
})

test('T-C4c : une compaction qui echoue est comptee et journalisee, jamais propagee', async () => {
  // Le cas reel : 'compactNow' rend 'busy' (« manual compaction requires an idle
  // agent ») quand la course avec un reveil a deja repris la main. Un tour qui
  // echoue ne doit pas emporter la ligne avec lui.
  const harnessed = harness({
    compactNow: () => Promise.reject(new Error('manual compaction requires an idle agent with no waking queued work')),
    services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) },
  })
  const session = fakeSession('session-c4c', EVENTS)
  const agent = fakeAgent(session, { status: 'idle' })
  harnessed.addAgent(agent)
  await harnessed.preExecute({ name: FORK_TOOL, agent, arguments: {} })
  assert.doesNotThrow(() => harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 2 } }))
  await harnessed.controller.settled()
  assert.equal(harnessed.compactionCalls.length, 1, 'la compaction a bien ete tentee')
  assert.equal(harnessed.controller.stats.compacted, 0)
  assert.equal(harnessed.controller.stats.compact_failed, 1)
  const rows = entriesOf(harnessed.dir, 'compact-failed')
  assert.equal(rows.length, 1, 'un echec de compaction est journalise')
  assert.ok(rows[0].error.includes('idle agent'), rows[0].error)
})

// --------------------------------------------------------------------------- //
// T-C5 — l idempotence par tour                                                //
// --------------------------------------------------------------------------- //

test('T-C4d : un service de compaction illisible est journalise, jamais un rejet non gere', async () => {
  const harnessed = harness({
    getThrows: ['compaction'],
    services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) },
  })
  const session = fakeSession('session-c4d', EVENTS)
  const agent = fakeAgent(session, { status: 'idle' })
  harnessed.addAgent(agent)
  await harnessed.preExecute({ name: FORK_TOOL, agent, arguments: {} })
  assert.doesNotThrow(() => harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 2 } }))
  await harnessed.controller.settled()
  assert.equal(harnessed.compactionCalls.length, 0)
  assert.equal(harnessed.controller.stats.compact_failed, 1)
  const rows = entriesOf(harnessed.dir, 'compact-failed')
  assert.equal(rows.length, 1)
  assert.ok(rows[0].error.includes('service lookup failed: compaction'), rows[0].error)
})

test('T-C5 : deux tours refuses donnent deux compactions, jamais deux pour un meme tour', async () => {
  const harnessed = harness({ services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) } })
  const session = fakeSession('session-c5', EVENTS)
  const agent = fakeAgent(session, { status: 'idle' })
  harnessed.addAgent(agent)

  // DEUX refus dans le MEME tour : une seule compaction.
  assert.equal((await harnessed.preExecute({ name: FORK_TOOL, agent, arguments: {} })).decision.kind, 'deny')
  assert.equal((await harnessed.preExecute({ name: FORK_TOOL, agent, arguments: {} })).decision.kind, 'deny')
  assert.equal(harnessed.controller.stats.refused, 2, 'les deux refus sont comptes')
  harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 2 } })
  await harnessed.controller.settled()
  assert.equal(harnessed.compactionCalls.length, 1, 'un tour, une compaction — quel que soit le nombre de refus')

  // Un SECOND tour refuse : une seconde compaction.
  assert.equal((await harnessed.preExecute({ name: FORK_TOOL, agent, arguments: {} })).decision.kind, 'deny')
  harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 2 } })
  await harnessed.controller.settled()
  assert.equal(harnessed.compactionCalls.length, 2, 'deux tours refuses, deux compactions')
  assert.equal(harnessed.controller.stats.compacted, 2)
  assert.equal(entriesOf(harnessed.dir, 'fork-compacted').length, 2)
})

test('T-C5b : le tour d un AUTRE agent ne solde pas le refus de celui-ci', async () => {
  const harnessed = harness({ services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) } })
  const session = fakeSession('session-c5b', EVENTS)
  const other = fakeSession('session-c5b-other', EVENTS)
  const agent = fakeAgent(session, { status: 'idle' })
  harnessed.addAgent(agent)
  harnessed.addAgent(fakeAgent(other, { status: 'idle' }))
  await harnessed.preExecute({ name: FORK_TOOL, agent, arguments: {} })
  harnessed.fire('session/event', other, { type: 'turn/end', data: { turn: 1 } })
  await harnessed.controller.settled()
  assert.equal(harnessed.compactionCalls.length, 0, 'le refus appartient a SA session')
  harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 2 } })
  await harnessed.controller.settled()
  assert.equal(harnessed.compactionCalls.length, 1)
})

// --------------------------------------------------------------------------- //
// T-C6 — un seuil invalide ne casse pas le montage                             //
// --------------------------------------------------------------------------- //

test('T-C6 : un seuil invalide est journalise, remplace par le defaut, et le montage tient', async () => {
  // '-0' et '-0' cite : le harnais exige une valeur JSON SANS PERTE et
  // 'isJsonNumber' exclut -0 ('dsh-tools/lib/index.js:126-128'). Accepte, ce
  // seuil faisait rejeter TOUTE reponse de l'outil
  // ('value is not lossless JSON') — 24 cas verts et l'outil mort.
  for (const invalid of [1.5, -0.2, -0, '-0', 'abc', '', Number.NaN, Number.POSITIVE_INFINITY, null, true, {}]) {
    const dir = home()
    let controller
    assert.doesNotThrow(() => {
      controller = harness({ home: dir, config: { forkThresholdRatio: invalid } }).controller
    }, 'un seuil invalide ne fait pas tomber le montage : ' + String(invalid))
    assert.equal(controller.threshold, 0.6, 'on retombe sur le defaut pour ' + JSON.stringify(invalid))
    const rows = entriesOf(dir, 'threshold-invalid')
    assert.equal(rows.length, 1, 'la valeur invalide est JOURNALISEE pour ' + JSON.stringify(invalid))
    assert.equal(rows[0].fallback, 0.6)
    assert.equal(rows[0].value, Object.is(invalid, -0) ? '-0' : String(invalid))
    // Le seuil rendu doit survivre a un aller-retour JSON : c'est la propriete
    // que le registre verifie, et -0 la viole.
    const value = controller.measureFor(fakeSession('session-c6-' + String(invalid), EVENTS))
    assert.equal(Object.is(value.forkThresholdRatio, -0), false, '-0 ne doit JAMAIS sortir : ' + JSON.stringify(invalid))
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, 'la valeur rendue doit etre du JSON sans perte')
  }
})

test('T-C6b : un seuil valide est pris tel quel, et ne journalise rien', () => {
  const dir = home()
  const numeric = harness({ home: dir, config: { forkThresholdRatio: 0.85 } })
  assert.equal(numeric.controller.threshold, 0.85)
  const stringy = harness({ home: home(), config: { forkThresholdRatio: '0.25' } })
  assert.equal(stringy.controller.threshold, 0.25, 'une chaine numerique citee est acceptee')
  const zero = harness({ home: home(), config: { forkThresholdRatio: 0 } })
  assert.equal(zero.controller.threshold, 0, '0 est dans [0,1] et se refuse pas')
  assert.equal(entriesOf(dir, 'threshold-invalid').length, 0)
})

test('T-C6c : resolveThreshold est utilisable seule, avec son propre sink', () => {
  const seen = []
  assert.equal(resolveThreshold(undefined, (entry) => seen.push(entry)), 0.6)
  assert.equal(resolveThreshold(0.9, (entry) => seen.push(entry)), 0.9)
  assert.equal(resolveThreshold('nope', (entry) => seen.push(entry)), 0.6)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].step, 'threshold-invalid')
})

// --------------------------------------------------------------------------- //
// T-C7 — l outil d occupation                                                  //
// --------------------------------------------------------------------------- //

test('T-C7 : l outil est installe par agent, sous le nom de TOOL_NAMES', () => {
  const harnessed = harness()
  const session = fakeSession('session-c7', EVENTS)
  const agent = fakeAgent(session, { status: 'idle' })
  harnessed.installSurface(agent)

  // 'agent/created' n a pas encore eu lieu : la surface est vide.
  assert.equal(harnessed.registered.length, 0)

  harnessed.fire('agent/created', { agent })
  assert.deepEqual(
    harnessed.registered.map((row) => row.tool.name),
    TOOL_NAMES,
    'la suite lit TOOL_NAMES : un outil ajoute sans elle fait rougir CE cas',
  )
  assert.deepEqual(buildTools(harnessed.controller).map((tool) => tool.name), TOOL_NAMES)
})

test('T-C7b : l outil rend la mesure de l APPELANT, jamais celle d un autre', async () => {
  // La mesure est celle de l APPELANT : elle se lit sur SON journal. Deux agents,
  // donc deux journaux, donc deux mesures — le faux restore lit les evenements.
  const longLog = EVENTS
  // Le journal de Bob est DIFFERENT (son propre tour, son propre numero) : la
  // mesure se lit sur SON journal, pas sur celui d Alice.
  const shortLog = [
    { type: 'turn/start', seq: 0, data: { turn: 9 } },
    { type: 'turn/end', seq: 1, data: { turn: 9, reason: { kind: 'completed' } } },
  ]
  const harnessed = harness({
    services: {
      tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]),
      sessionProjections: projectionsOf({
        window: 100_000,
        restore: (checkpoint, events) => ({
          snapshot: { asOfSeq: events.length === 0 ? -1 : events[events.length - 1].seq, values: { contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: events.some((event) => event.data?.turn === 9) ? 10_000 : 71_000 } } },
          checkpoint: {},
        }),
      }),
    },
  })
  const alice = fakeAgent(fakeSession('session-a', longLog), { status: 'idle' })
  const bob = fakeAgent(fakeSession('session-b', shortLog), { status: 'idle' })
  harnessed.installSurface(alice)
  harnessed.installSurface(bob)
  harnessed.fire('agent/created', { agent: alice })
  harnessed.fire('agent/created', { agent: bob })

  const tool = harnessed.registered[0].tool
  const fromAlice = await tool.execute({}, { agent: alice })
  const fromBob = await tool.execute({}, { agent: bob })

  assert.equal(fromAlice.inheritedTokens, 71_000)
  assert.equal(fromAlice.ratio, 0.71)
  assert.equal(fromAlice.verdict, VERDICT_REFUSED)
  assert.equal(fromAlice.forkThresholdRatio, harnessed.controller.threshold)
  assert.equal(fromBob.inheritedTokens, 10_000, 'Bob voit SON contexte, pas celui d Alice')
  assert.equal(fromBob.ratio, 0.1)
  assert.equal(fromBob.verdict, VERDICT_OK)

  // Aucun argument ne detourne la mesure : le schema n a que des proprietes vides.
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false })
  const again = await tool.execute({ agent: 'session-a', session: 'session-a', root: 'session-a' }, { agent: alice })
  assert.deepEqual(again, fromAlice, 'un argument hallucine ne change RIEN a la mesure')
})

test('T-C7c : un appelant sans session leve une erreur claire, sans casser le reste', async () => {
  const harnessed = harness({
    services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) },
  })
  const session = fakeSession('session-c7c', EVENTS)
  const agent = fakeAgent(session, { status: 'idle' })
  harnessed.installSurface(agent)
  harnessed.fire('agent/created', { agent })
  const tool = harnessed.registered[0].tool

  await assert.rejects(() => tool.execute({}, {}), /aucune session appelante/)
  await assert.rejects(() => tool.execute({}, { agent: {} }), /aucune session appelante/)

  // Le canal tient : l appel suivant, avec une session, repond normalement.
  const value = await tool.execute({}, { agent })
  assert.equal(value.inheritedTokens, 71_000)
  // Et la garde du fork fonctionne toujours apres ces echecs.
  const decision = await harnessed.preExecute({ name: FORK_TOOL, agent, arguments: {} })
  assert.equal(decision.decision.kind, 'deny')
})

test('T-C7d : le rendu texte porte le ratio et le seuil, et l inconnu se dit', () => {
  const harnessed = harness({
    services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) },
  })
  const known = buildTools(harnessed.controller)[0].output.render({}, harnessed.controller.measureFor(fakeSession('session-c7d', EVENTS)))
  assert.ok(known[0].text.includes('71 %'), known[0].text)
  assert.ok(known[0].text.includes('60 %'), known[0].text)

  const blind = harness({})
  const unknown = buildTools(blind.controller)[0].output.render({}, blind.controller.measureFor(fakeSession('session-c7d-2', EVENTS)))
  assert.ok(unknown[0].text.includes('occupation inconnue'), unknown[0].text)
})

// --------------------------------------------------------------------------- //
// T-C8 — le retour REEL, par le REGISTRE                                       //
// --------------------------------------------------------------------------- //

/**
 * LE cas qui aurait attrape le defaut reel : l'outil rendait 'sources', absent du
 * schema de sortie, et 'dsh-tools' REJETTE toute cle non declaree
 * ('dsh-tools/lib/index.js:3541-3544' :
 * `tool "..." returned invalid output: "value.sources" is not a declared property`).
 *
 * Les cas precedents appellent 'tool.execute(...)' DIRECTEMENT — donc AU-DESSUS
 * de la couture qui valide, et c'est pour cela qu'ils etaient verts quand l'outil
 * ne marchait pas. Celui-ci monte le VRAI 'ToolRuntime', monte la ligne du plugin
 * comme le profil la monte, laisse 'agent/created' installer l'outil dans la
 * surface de l'agent, puis passe par 'registry.execute(...)'. Si le schema cesse
 * de correspondre a la valeur rendue, ce cas rougit — et lui seul.
 */
test('T-C8 : la valeur RELLE passe la validation du REGISTRE (la couture que execute() contourne)', async () => {
  const modules = harnessModules()
  const entries = {
    cordis: join(modules, '@deepseek-ai', 'cordis', 'lib', 'index.js'),
    scope: join(modules, '@deepseek-ai', 'dsh-scope', 'lib', 'index.js'),
    tools: join(modules, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
  }
  for (const [label, file] of Object.entries(entries)) {
    assert.ok(existsSync(file), 'le harnais doit etre installe pour ce cas (' + label + ') : ' + file)
  }
  const { Context } = await import(pathToFileURL(entries.cordis).href)
  const { createScope } = await import(pathToFileURL(entries.scope).href)
  const ToolRuntime = (await import(pathToFileURL(entries.tools).href)).default

  const root = new Context()
  const session = fakeSession('session-c8', EVENTS)
  const agent = { id: 'session-c8', session, status: 'idle' }
  await root.plugin({
    name: 't-c8-services',
    apply: (ctx) => {
      // 'ToolRuntime' declare 'inject: ["systemPrompt"]' : sans ce service la
      // ligne ne s'active pas et le registre reste introuvable.
      ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 })
      ctx.provide('agents', { get: (id) => (id === 'session-c8' ? agent : undefined), list: () => [] })
      ctx.provide('tokenMeter', meterOf([{ seq: 1, tokens: 71_000 }]))
      ctx.provide('sessionProjections', projectionsOf({ window: 100_000, restore: restoreOf({ systemTokens: 0, toolsTokens: 0, messageTokens: 71_000 }) }))
    },
  })
  await root.plugin(ToolRuntime, { mode: 'native' })
  let registry
  await root.plugin({ name: 't-c8-view', inject: ['tools'], apply: (ctx) => { registry = ctx.tools } })
  assert.ok(registry !== undefined, 'le registre d outils n a pas ete capture')

  // La LIGNE HOTE, montee comme le profil la monte, puis l'annonce de l'agent :
  // c'est 'agent/created' qui installe l'outil dans SA surface. Le journal part
  // dans un dossier jetable, jamais dans le '$DSH_HOME' de la machine.
  const dir = home()
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx
  await root.plugin({ name: 'dsh-boost-context-budget', inject: ['agents'], apply }, { home: dir })
  await tick(30)
  root.emit('agent/created', { agent, source: 'startup' })
  await tick(150)

  const surface = registry.schemas(agent).map((schema) => schema.name)
  assert.ok(surface.includes('context_occupancy'), 'l outil n est pas sur la surface de l agent : ' + surface.join(', '))

  const result = await registry.execute({
    callId: 't-c8-call',
    name: 'context_occupancy',
    arguments: {},
    agent,
    signal: new AbortController().signal,
  })

  assert.equal(result.isError, false, 'le registre a REJETE la valeur rendue : ' + String(result.error?.message))
  assert.equal(result.value.inheritedTokens, 71_000)
  assert.equal(result.value.windowTokens, 100_000)
  assert.equal(result.value.ratio, 0.71)
  assert.equal(result.value.verdict, VERDICT_REFUSED)
  assert.equal(result.value.sources.inherited, 'restore-boundary', 'sources doit survivre a la validation du registre')
  assert.equal(result.value.sources.boundarySeq, 3)
  try { await root.dispose?.() } catch { /* le teardown ne masque jamais le verdict */ }
})

// --------------------------------------------------------------------------- //
// T-C9 — les defauts STRUCTURELS trouves par falsification                      //
// --------------------------------------------------------------------------- //

/**
 * LE cas qui compte : une compaction 'replace' posee DANS le tour en cours.
 *
 * Le fork tranche des POSITIONS DE JOURNAL ('events.slice(0, lastEnd.seq + 1)',
 * 'dsh-subagent-fork-in-process/lib/index.js:23-28') ; la compaction, elle, retire
 * des NOEUDS DE SURFACE ('dsh-compaction-basic/lib/index.js:650-661'). Une somme de
 * surface RETENUE tombait donc a ZERO sur un prefixe de 750 008 tokens, et la garde
 * se ROUVRAIT sur le fork qu'elle venait de refuser — fabrique par notre propre
 * compaction differee. Avant correctif, ce cas rend 0 et laisse passer le fork.
 */
const COMPACTED_EVENTS = [
  { type: 'turn/start', seq: 0, data: { turn: 1 } },
  { type: 'user/message', seq: 1 },
  { type: 'assistant/message', seq: 2, data: { usage: { inputTokens: 8, cacheReadTokens: 750_000, cacheWriteTokens: 0 } } },
  { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 4, data: { turn: 2 } },
  // LA COMPACTION : elle REMPLACE la region 1-3, donc APRES la frontiere.
  { type: 'user/message', seq: 5, data: { message: 'resume' }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 } },
]

test('T-C9a : la mesure lit le PREFIXE par restore, borne a la frontiere, et ne prend pas le maximum', async () => {
  const session = fakeSession('session-c9a', COMPACTED_EVENTS)
  // Le registre rend 5 000 tokens pour le prefixe, alors que la surface close en
  // annonce 70 000 : c'est le RESTORE qui fait foi, meme quand il est plus PETIT.
  // Un maximum avec une vue fausse fabriquait une valeur fausse.
  const restore = restoreOf({ systemTokens: 1_000, toolsTokens: 500, messageTokens: 3_500 })
  const harnessed = harness({
    services: {
      tokenMeter: meterOf([{ seq: 1, tokens: 40_000 }, { seq: 2, tokens: 30_000 }]),
      sessionProjections: projectionsOf({ window: 100_000, restore }),
    },
  })
  const value = harnessed.controller.measureFor(session)
  assert.equal(value.sources.boundarySeq, 3)
  assert.equal(value.inheritedTokens, 5_000, 'la mesure est le contextBreakdown du prefixe rendu par restore')
  assert.equal(value.sources.inherited, 'restore-boundary')
  assert.equal(value.ratio, 0.05)
  assert.equal(value.verdict, VERDICT_OK)

  // LA BORNE, prouvee sur ce que 'restore' a RECU : les evenements du prefixe, et
  // rien apres le dernier turn/end (l'evenement de compaction est a seq 5).
  assert.equal(restore.seen.length, 1)
  assert.deepEqual(restore.seen[0].events.map((event) => event.seq), [0, 1, 2, 3])
  assert.equal(restore.seen[0].baseSeq, 0)
  assert.deepEqual(restore.seen[0].checkpoint, {})
  assert.equal(harnessed.controller.stats.unknown, 0, 'restore a servi : aucune abstention')

  // La garde ne se rouvre pas : c'est le defaut, en une ligne.
  const refusing = harness({
    services: {
      tokenMeter: meterOf([{ seq: 5, tokens: 1_200 }]),
      sessionProjections: projectionsOf({ window: 1_000_000, restore: restoreOf({ systemTokens: 0, toolsTokens: 0, messageTokens: 750_008 }) }),
    },
  })
  const refusal = await refusing.preExecute({ name: FORK_TOOL, agent: fakeAgent(session, { status: 'idle' }), arguments: {} })
  assert.equal(refusal.decision.kind, 'deny', 'la garde ne doit PAS se rouvrir apres une compaction')
})

test('T-C9b : sans restore (ou s il jette) la mesure vaut NULL et la garde S ABSTIENT', async () => {
  const session = fakeSession('session-c9b', EVENTS)
  // Un meter qui ANNONCE 100 000 tokens : c'est exactement le chiffre qu'un repli
  // rendrait. Aucun repli ne doit le rendre.
  const services = (projections) => ({ tokenMeter: meterOf([{ seq: 1, tokens: 60_000 }, { seq: 2, tokens: 40_000 }]), sessionProjections: projections })

  // 1. 'restore' ABSENT : pas de chiffre, une abstention.
  const absent = harness({ noRestore: true, services: services(projectionsOf({ window: 160_000 })) })
  const withoutRestore = absent.controller.measureFor(session)
  assert.equal(withoutRestore.inheritedTokens, null, 'AUCUNE valeur de repli, jamais : pas de chiffre plutot qu un chiffre faux')
  assert.equal(withoutRestore.ratio, null)
  assert.equal(withoutRestore.verdict, VERDICT_UNKNOWN)
  assert.equal(withoutRestore.sources.inherited, 'unavailable', 'la source dit que la mesure est indisponible')
  assert.equal(absent.controller.stats.unknown, 1)
  const passedWithout = await absent.preExecute({ name: FORK_TOOL, agent: fakeAgent(session, { status: 'idle' }), arguments: {} })
  assert.equal(passedWithout.decision.kind, 'allow', 'sans mesure, la garde s abstient : le fork passe')
  const rowsAbsent = entriesOf(absent.dir, 'fork-unguarded')
  assert.equal(rowsAbsent.length, 1)
  assert.equal(rowsAbsent[0].why, 'no-restore')
  assert.equal(entriesOf(absent.dir, 'measure-fallback').length, 0, 'plus aucune ligne de repli : il n y a plus de repli')

  // 2. 'restore' qui JETTE : meme abstention, et le journal porte la CAUSE.
  const broken = harness({ services: services(projectionsOf({ window: 160_000, restore: () => { throw new Error('registre indisponible') } })) })
  const failed = broken.controller.measureFor(session)
  assert.equal(failed.inheritedTokens, null, 'un restore qui jette ne rend PAS de chiffre')
  assert.equal(failed.ratio, null)
  assert.equal(failed.verdict, VERDICT_UNKNOWN)
  assert.equal(failed.sources.inherited, 'unavailable', 'la valeur ne porte aucun chiffre')
  assert.equal(failed.failure.source, 'restore-failed', 'mais la CAUSE est nommee : le journal la porte')
  const passed = await broken.preExecute({ name: FORK_TOOL, agent: fakeAgent(session, { status: 'idle' }), arguments: {} })
  assert.equal(passed.decision.kind, 'allow', 'la garde ne peut NI refuser NI autoriser sur la foi d un chiffre faux : elle s abstient')
  const rowsBroken = entriesOf(broken.dir, 'fork-unguarded')
  assert.equal(rowsBroken.length, 1)
  assert.equal(rowsBroken[0].why, 'restore-failed')
  assert.ok(String(rowsBroken[0].error).includes('registre indisponible'), String(rowsBroken[0].error))

  // 3. 'restore' PRESENT : la mesure est celle du prefixe, et rien d autre.
  const primary = harness({ services: services(projectionsOf({ window: 160_000, restore: restoreOf({ systemTokens: 0, toolsTokens: 0, messageTokens: 12_345 }) })) })
  assert.equal(primary.controller.measureFor(session).inheritedTokens, 12_345)
  assert.equal(entriesOf(primary.dir, 'fork-unguarded').length, 0)
})

test('T-C9c : une fenetre IMPLAUSIBLE rend la mesure inconnue, et la garde s abstient', async () => {
  const harnessed = harness({
    services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 1 }) },
  })
  const session = fakeSession('session-c9c', EVENTS)
  const value = harnessed.controller.measureFor(session)
  assert.equal(value.windowTokens, null, 'une fenetre de 1 token n est pas une mesure')
  assert.equal(value.ratio, null)
  assert.equal(value.sources.window, 'implausible-window')
  assert.equal(value.verdict, VERDICT_UNKNOWN)
  const decision = await harnessed.preExecute({ name: FORK_TOOL, agent: fakeAgent(session, { status: 'idle' }), arguments: {} })
  assert.equal(decision.decision.kind, 'allow', 'un controle qui devine est pire qu un controle qui s abstient')
  assert.equal(entriesOf(harnessed.dir, 'fork-unguarded').length, 1)
})

test('T-C9d : le nom garde est CONFIGURABLE, parce que le nom est une valeur du preset', async () => {
  const services = { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) }
  const session = fakeSession('session-c9d', EVENTS)
  const agent = fakeAgent(session, { status: 'idle' })
  // Sous son nom par defaut : garde.
  const byDefault = harness({ services })
  assert.deepEqual(byDefault.controller.forkTools, ['subagent_fork'])
  assert.equal((await byDefault.preExecute({ name: 'subagent_fork', agent, arguments: {} })).decision.kind, 'deny')
  // Le meme provider monte sous un AUTRE nom : la ligne doit pouvoir le declarer.
  const renamed = harness({ config: { forkToolNames: ['subagent_fork_deep'] }, services })
  assert.deepEqual(renamed.controller.forkTools, ['subagent_fork_deep'])
  assert.equal((await renamed.preExecute({ name: 'subagent_fork_deep', agent, arguments: {} })).decision.kind, 'deny')
  assert.equal((await renamed.preExecute({ name: 'subagent_fork', agent, arguments: {} })).decision.kind, 'allow',
    'la liste est CLOSE : ce qui n y est pas passe — la limite est ecrite dans le README')
  // Une liste invalide journalise et retombe sur le defaut.
  const broken = harness({ config: { forkToolNames: ['', 42] }, services })
  assert.deepEqual(broken.controller.forkTools, ['subagent_fork'])
  assert.equal(entriesOf(broken.dir, 'fork-tools-invalid').length, 1)
})

test('T-C9e : un refus dans un tour qui ne se ferme JAMAIS ne compacte pas un tour etranger', async () => {
  const harnessed = harness({ services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) } })
  const session = fakeSession('session-c9e', EVENTS)
  const agent = fakeAgent(session, { status: 'idle' })
  harnessed.addAgent(agent)
  const refused = await harnessed.preExecute({ name: FORK_TOOL, agent, arguments: {} })
  assert.equal(refused.decision.kind, 'deny')
  // L'armement porte le tour du refus (le tour 2, celui qu'EVENTS laisse ouvert).
  assert.equal(harnessed.controller.refusedThisTurn.get('session-c9e'), 2)
  // Le tour 2 ne se ferme JAMAIS : c'est le tour 3 qui se ferme.
  harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 3 } })
  await harnessed.controller.settled()
  assert.equal(harnessed.compactionCalls.length, 0, 'un tour etranger ne solde pas le refus')
  assert.equal(harnessed.controller.refusedThisTurn.has('session-c9e'), false, 'l armement est consomme')
  const rows = entriesOf(harnessed.dir, 'fork-arm-orphaned')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].armedTurn, 2)
  assert.equal(rows[0].closingTurn, 3)
})

// --------------------------------------------------------------------------- //
// T-C10 / T-C11 — l'acceptation contre un ENFANT REEL, et le garde par PROPRIETE //
// --------------------------------------------------------------------------- //

/**
 * L'ACCEPTATION. La mesure vaut ce que le fork transmet, prouve contre un ENFANT
 * REEL : une vraie 'Session' construite a partir du seed ('Session.create(id,
 * seed, header, inheritedEventCount)', 'dsh-session/lib/types/index.d.ts:155'), et
 * mesuree par la MEME pile — le vrai 'SessionProjectionRegistry' et la vraie
 * projection 'contextBreakdown' du 'TokenMeter'.
 *
 * Trois cuts, dont un APRES une compaction posee dans le tour en cours : a ce
 * cut, la surface vive du parent s'est effondree (elle ne contient plus que le
 * resume), et l'ancienne source y lisait zero.
 */
test('T-C10 : la mesure EGALE la taille d un ENFANT REEL, a trois cuts dont un apres compaction', async () => {
  const modules = harnessModules()
  const entries = {
    cordis: join(modules, '@deepseek-ai', 'cordis', 'lib', 'index.js'),
    projections: join(modules, '@deepseek-ai', 'dsh-session-projection', 'lib', 'index.js'),
    meter: join(modules, '@deepseek-ai', 'dsh-token-meter', 'lib', 'index.js'),
    sessions: join(modules, '@deepseek-ai', 'dsh-session', 'lib', 'index.js'),
  }
  for (const [label, file] of Object.entries(entries)) {
    assert.ok(existsSync(file), 'le harnais doit etre installe (' + label + ') : ' + file)
  }
  const { Context } = await import(pathToFileURL(entries.cordis).href)
  const SessionProjections = (await import(pathToFileURL(entries.projections).href)).default
  const TokenMeter = (await import(pathToFileURL(entries.meter).href)).default
  const SessionStore = (await import(pathToFileURL(entries.sessions).href)).default
  const { Session } = await import(pathToFileURL(entries.sessions).href)

  const root = new Context()
  await root.plugin(SessionProjections)
  await root.plugin(TokenMeter)
  await root.plugin(SessionStore)
  await tick(50)
  const registry = root.get('sessionProjections')
  assert.ok(typeof registry?.restore === 'function', 'le registre REEL de projections n a pas ete monte')
  const services = { sessionProjections: registry }

  // Les formes d'evenements du harnais : source de message, champs de reglement,
  // marqueurs de surface. C'est ce que le fork rejoue chez l'enfant.
  const SOURCE = { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }
  const APPEND = { surfaceOp: 'append' }
  const parent = root.sessions.create('session-t10', { meta: { cwd: process.cwd() } })
  const turn = (n, chars) => {
    parent.append('turn/start', { turn: n })
    parent.append('user/message', { id: 'u' + n, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'A'.repeat(chars) }] }, APPEND)
    parent.append('assistant/message', {
      message: { id: 'a' + n, role: 'assistant', source: SOURCE, content: [{ type: 'text', text: 'B'.repeat(Math.floor(chars / 2)) }] },
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: chars, cacheWriteTokens: 0 },
      turn: n, step: 0, stream: [],
    }, APPEND)
    parent.append('turn/end', { turn: n, reason: { kind: 'completed' } })
  }
  turn(1, 4_000)
  const cut1 = parent.snapshotEvents().length - 1
  turn(2, 8_000)
  const cut2 = parent.snapshotEvents().length - 1
  turn(3, 12_000)
  const cut3 = parent.snapshotEvents().length - 1
  // LA COMPACTION, posee DANS le tour en cours : elle remplace les noeuds 1..9.
  parent.append('turn/start', { turn: 4 })
  // Les noeuds de surface ombres sont les MESSAGES : 1,2 (tour 1), 5,6 (tour 2),
  // 9,10 (tour 3) — les 'turn/start' et 'turn/end' ne portent aucun message.
  parent.append('user/message', { id: 'u4', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'SUMMARY' }] }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 10 }, sourceEventSeqs: [1, 2, 5, 6, 9, 10] })
  const events = parent.snapshotEvents()

  const sizes = []
  for (const cut of [cut1, cut2, cut3]) {
    const prefix = events.filter((event) => event.seq <= cut)
    // L'ENFANT REEL : le seed que 'completedTurnPrefix' transmet.
    const child = Session.create('child-' + cut, prefix, { ...parent.header, id: 'child-' + cut, isSeeded: true }, prefix.length)
    const childSize = breakdownTotal(registry.snapshot(child, ['contextBreakdown']).values.contextBreakdown)
    const measured = prefixBreakdownOf(services, parent, events, cut)
    // L'EGALITE D'ABORD : c'est elle qui doit rougir quand la source change.
    assert.equal(measured.tokens, childSize, 'cut ' + cut + ' : la mesure doit EGALER la taille de l enfant reel')
    assert.equal(measured.source, 'restore-boundary', 'cut ' + cut + ' : la source doit etre le restore borne')
    sizes.push({ cut, measured: measured.tokens, childSize })
  }
  assert.equal(sizes.length, 3)
  assert.ok(sizes[2].measured > sizes[0].measured, 'le prefixe grandit avec les cuts')

  // La mesure VIVE, apres la compaction, vaut encore celle du prefixe...
  const live = measure(services, parent, DEFAULT_FORK_THRESHOLD_RATIO)
  assert.equal(live.inheritedTokens, sizes[2].childSize)
  assert.equal(live.sources.inherited, 'restore-boundary')
  // ...et la surface VIVE, elle, s'est effondree : le cas n'est pas vide.
  const liveSurface = breakdownTotal(registry.snapshot(parent, ['contextBreakdown']).values.contextBreakdown)
  assert.ok(liveSurface < sizes[2].childSize, 'la surface vive (' + liveSurface + ') doit etre PLUS PETITE que le prefixe (' + sizes[2].childSize + ')')
  try { await root.dispose?.() } catch { /* le teardown ne masque jamais le verdict */ }
})

test('T-C11 : le garde par PROPRIETE reconnait le fork sans son nom', async () => {
  const session = fakeSession('session-c11', EVENTS)
  const parent = { session }
  const calls = []
  const harnessed = harness({
    services: {
      tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]),
      sessionProjections: projectionsOf({ window: 100_000, restore: restoreOf({ systemTokens: 0, toolsTokens: 0, messageTokens: 71_000 }) }),
    },
  })
  // Le provider du fork, monte sous un AUTRE nom : c'est la PROPRIETE qui le
  // designe ('inheritsParentContext', 'dsh-subagent/lib/types/types.d.ts:337').
  const renamed = {
    name: 'fork-sous-un-autre-nom',
    inheritsParentContext: true,
    start: (request) => { calls.push('start'); return Promise.resolve({ ok: true }) },
    prepareContinuable: (request) => { calls.push('prepare'); return Promise.resolve({}) },
  }
  harnessed.fire('subagent/provider-added', renamed)
  assert.equal(harnessed.controller.stats.provider_guarded, 1)
  await assert.rejects(() => renamed.start({ parent }), /fork refuse/, 'au-dessus du seuil, le provider est refuse')
  await assert.rejects(() => renamed.prepareContinuable({ parent }), /fork refuse/)
  assert.deepEqual(calls, [], 'le corps du provider n a PAS tourne : la delegation est refusee')
  const rows = entriesOf(harnessed.dir, 'fork-refused')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].seam, 'provider', 'le refus dit par quel seam il est passe')

  // Un provider qui n herite PAS du contexte parent n est pas touche.
  const spawn = { name: 'spawn', inheritsParentContext: false, start: () => { calls.push('spawn'); return Promise.resolve({}) } }
  harnessed.fire('subagent/provider-added', spawn)
  await spawn.start({ parent })
  assert.deepEqual(calls, ['spawn'])

  // Sous le seuil, le provider garde passe.
  const passing = harness({
    services: {
      tokenMeter: meterOf([{ seq: 1, tokens: 10_000 }]),
      sessionProjections: projectionsOf({ window: 100_000, restore: restoreOf({ systemTokens: 0, toolsTokens: 0, messageTokens: 10_000 }) }),
    },
  })
  const ok = { name: 'fork', inheritsParentContext: true, start: () => { calls.push('ok'); return Promise.resolve({ ok: true }) } }
  passing.fire('subagent/provider-added', ok)
  await ok.start({ parent })
  assert.deepEqual(calls, ['spawn', 'ok'], 'sous le seuil, la delegation suit son cours')
})

