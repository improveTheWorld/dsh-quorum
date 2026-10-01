// Les tests de 'dsh-boost-context-budget' — la garde du fork, et sa mesure.
//
//   node --test packages/boost-context-budget/test/context-budget.test.mjs
//
// Chaque cas ci-dessous peut ECHOUER, et c'est la seule raison de l'ecrire. Les
// cas T-C1..T-C7 sont ceux qui ont decide la conception :
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
//         fait pas tomber ce qui l'entoure.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  apply,
  buildTools,
  DEFAULT_FORK_THRESHOLD_RATIO,
  FORK_TOOL,
  TOOL_NAMES,
  VERDICT_OK,
  VERDICT_REFUSED,
  VERDICT_UNKNOWN,
  measure,
  resolveThreshold,
} from '../lib/index.js'

/** Un journal par test : le fichier est la seule preuve lisible apres coup. */
function home() {
  return mkdtempSync(join(tmpdir(), 'boost-context-budget-'))
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
  { type: 'turn/start', seq: 0 },
  { type: 'user/message', seq: 1 },
  { type: 'assistant/message', seq: 2 },
  { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 4 },
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

/** Une projection de session : 'snapshot' pour la fenetre, 'stateOf' pour la composition. */
function projectionsOf({ window, nodes }) {
  return {
    snapshot: (_session, keys) => {
      assert.deepEqual(keys, ['contextPressure'])
      return { asOfSeq: 5, values: window === undefined ? {} : { contextPressure: { contextWindow: window } } }
    },
    stateOf: (_session, key) => {
      if (key !== 'contextBreakdown') return undefined
      return nodes === undefined ? undefined : { nodes, breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } }
    },
  }
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
  assert.equal(value.sources.inherited, 'token-meter')
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
  assert.equal(value.sources.inherited, 'context-breakdown')
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
  const value = measure({ tokenMeter: meterOf([{ seq: 2, tokens: 50_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) }, session, 0.6)
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
  harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 1 } })
  await harnessed.controller.settled()
  assert.equal(harnessed.compactionCalls.length, 1)
  assert.equal(agent.whenIdleCalls, 0, 'un agent deja inactif n est pas attendu')

  // Un agent qui a quitte le registre : journalise, jamais une exception.
  const gone = harness({
    services: { tokenMeter: meterOf([{ seq: 1, tokens: 71_000 }]), sessionProjections: projectionsOf({ window: 100_000 }) },
  })
  const ghost = fakeSession('session-c4b-ghost', EVENTS)
  await gone.preExecute({ name: FORK_TOOL, agent: fakeAgent(ghost, { status: 'idle' }), arguments: {} })
  assert.doesNotThrow(() => gone.fire('session/event', ghost, { type: 'turn/end', data: { turn: 1 } }))
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
  assert.doesNotThrow(() => harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 1 } }))
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
  assert.doesNotThrow(() => harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 1 } }))
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
  harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 1 } })
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
  harnessed.fire('session/event', session, { type: 'turn/end', data: { turn: 1 } })
  await harnessed.controller.settled()
  assert.equal(harnessed.compactionCalls.length, 1)
})

// --------------------------------------------------------------------------- //
// T-C6 — un seuil invalide ne casse pas le montage                             //
// --------------------------------------------------------------------------- //

test('T-C6 : un seuil invalide est journalise, remplace par le defaut, et le montage tient', async () => {
  for (const invalid of [1.5, -0.2, 'abc', '', Number.NaN, Number.POSITIVE_INFINITY, null, true, {}]) {
    const dir = home()
    let controller
    assert.doesNotThrow(() => {
      controller = harness({ home: dir, config: { forkThresholdRatio: invalid } }).controller
    }, 'un seuil invalide ne fait pas tomber le montage : ' + String(invalid))
    assert.equal(controller.threshold, 0.6, 'on retombe sur le defaut pour ' + JSON.stringify(invalid))
    const rows = entriesOf(dir, 'threshold-invalid')
    assert.equal(rows.length, 1, 'la valeur invalide est JOURNALISEE pour ' + JSON.stringify(invalid))
    assert.equal(rows[0].fallback, 0.6)
    assert.equal(rows[0].value, typeof invalid === 'string' ? invalid : String(invalid))
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
  const nodes = [{ seq: 1, tokens: 71_000 }]
  const harnessed = harness({
    services: { tokenMeter: { measure: (session) => ({ nodes: session.id === 'session-a' ? nodes : [{ seq: 1, tokens: 10_000 }] }) }, sessionProjections: projectionsOf({ window: 100_000 }) },
  })
  const alice = fakeAgent(fakeSession('session-a', EVENTS), { status: 'idle' })
  const bob = fakeAgent(fakeSession('session-b', EVENTS), { status: 'idle' })
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
