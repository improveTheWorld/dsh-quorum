// QUEL EVENEMENT MARQUE « L'EMETTEUR S'ARRETE » — MESURE.
//
//   node tools/probe-stop.mjs [harness-node-modules] [plugin-entry]
//
// Pourquoi ce probe existe. La decision de reveil du §4 ne peut pas etre prise
// au depot : 'channel_post' EST un appel d'outil, donc l'emetteur travaille
// toujours quand il depose. Elle doit etre prise quand il S'ARRETE. Reste a
// savoir quel evenement du runtime constate cet arret — et cela ne se devine
// pas. Trois candidats etaient sur la table : l'enregistrement 'turn/end' de la
// session (feed 'session/event'), 'agent/disposed', et les evenements
// 'subagent/start'/'subagent/end'. Ce probe monte le VRAI magasin de sessions
// ('@deepseek-ai/dsh-session'), le VRAI registre d'agents
// ('@deepseek-ai/dsh-agent') et la VRAIE ligne du plugin sur une vraie
// application cordis, puis il MESURE :
//
//   1. 'turn/end' atteint-il un listener de ligne HOTE, pour la session d'un
//      ENFANT ? (l'enfant est entre par la portee de l'appelant : la reponse
//      n'est pas dans la documentation, elle est dans le dispatch) ;
//   2. a cet instant, l'etat re-derive est-il 'blocked' — c'est-a-dire l'enfant
//      qui RESTE OUVERT, celui qu'aucun 'agent/disposed' ne couvrira jamais ?
//   3. 'agent/disposed' atteint-il le meme listener, et donne-t-il 'done' ?
//   4. dans quel ORDRE les deux arrivent-ils pour un enfant qui termine ?
//
// La reponse est un couple, pas un evenement : 'turn/end' couvre l'enfant qui
// reste ouvert, 'agent/disposed' couvre celui qui part. La ligne du plugin
// ecoute les deux ; ce probe le constate au lieu de le supposer.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harnessModules = process.argv[2]
  ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
const entries = {
  cordis: join(harnessModules, '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  sessions: join(harnessModules, '@deepseek-ai', 'dsh-session', 'lib', 'index.js'),
  agents: join(harnessModules, '@deepseek-ai', 'dsh-agent', 'lib', 'index.js'),
  // La fabrique de portee que le harnais utilise pour un preset et pour un agent :
  // c'est elle qui donne son sens a « ligne HOTE ».
  scope: join(harnessModules, '@deepseek-ai', 'dsh-scope', 'lib', 'index.js'),
}
const pluginEntry = process.argv[3] !== undefined
  ? resolve(process.argv[3])
  : fileURLToPath(new URL('../lib/index.js', import.meta.url))
const say = (key, value) => console.log('PROBE-' + key + ': ' + value)
const failures = []
const tick = (ms) => new Promise((done) => setTimeout(done, ms))

/** Un agent factice MAIS enregistre dans le VRAI registre, sur une VRAIE session. */
function makeAgent(session, parent, status) {
  const calls = []
  return {
    id: session.id,
    status,
    session,
    parent,
    calls,
    send: (message, target, wakeup) => calls.push({ method: 'send', message, target, wakeup }),
    inject: (message) => calls.push({ method: 'inject', message }),
  }
}

try {
  for (const [label, file] of [...Object.entries(entries), ['plugin', pluginEntry]]) {
    if (!existsSync(file)) throw new Error('le module ' + label + ' n est pas installe ici : ' + file)
  }
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-channel-stop-'))
  process.env.DSH_HOME = scratch
  const { Context } = await import(pathToFileURL(entries.cordis).href)
  const SessionStore = (await import(pathToFileURL(entries.sessions).href)).default
  const AgentRegistry = (await import(pathToFileURL(entries.agents).href)).default
  const { createScope } = await import(pathToFileURL(entries.scope).href)
  const plugin = await import(pathToFileURL(pluginEntry).href)

  const root = new Context()
  await root.plugin(SessionStore)
  await root.plugin(AgentRegistry)
  say('runtime', 'magasin de sessions reel + registre d agents reel montes sur une vraie application cordis')

  // Les sessions sont creees par le VRAI magasin : c'est ce qui branche le feed.
  const rootSession = root.sessions.create('session-root', { meta: { cwd: process.cwd() } })
  const childA = root.sessions.create('session-child-a', { meta: { cwd: process.cwd(), parentSession: 'session-root' } })
  const childB = root.sessions.create('session-child-b', { meta: { cwd: process.cwd(), parentSession: 'session-root' } })
  const childC = root.sessions.create('session-child-c', { meta: { cwd: process.cwd(), parentSession: 'session-root' } })

  const tools = new Map()
  const stubCtx = { inject: (names, callback) => callback({ tools: { register: (tool) => tools.set(tool.name, tool) } }) }
  const owner = { ...makeAgent(rootSession, undefined, 'running'), ctx: stubCtx }
  const workerA = { ...makeAgent(childA, 'session-root', 'running'), ctx: stubCtx }
  const workerB = { ...makeAgent(childB, 'session-root', 'running'), ctx: stubCtx }
  const workerC = { ...makeAgent(childC, 'session-root', 'running'), ctx: stubCtx }
  const disposers = {}
  for (const agent of [owner, workerA, workerB, workerC]) disposers[agent.id] = root.agents.register(agent)
  await tick(50)

  // LA LIGNE HOTE, montee comme le profil la monte.
  await root.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, {
    home: scratch,
    makeMessage: (envelope) => ({ id: 'probe:' + envelope.id, role: 'user', content: [] }),
  })
  await tick(50)

  const channel = root.get('boostChannel')
  if (channel === undefined) throw new Error('le service boostChannel n a pas ete fourni : la ligne hote n est pas montee')
  // Une enveloppe sur la methode d arret : elle prouve que le listener a ete
  // appele, par quel evenement, et pour quelle session.
  const stops = []
  const realStopped = channel.stopped.bind(channel)
  channel.stopped = (from, meta) => {
    stops.push(from + ' <- ' + String(meta?.why))
    return realStopped(from, meta)
  }
  if (tools.size !== 2) throw new Error('les outils ne sont pas installes par agent : ' + [...tools.keys()].join(', '))
  const post = tools.get('channel_post')
  const read = tools.get('channel_read')

  // ---- 1. L'ENFANT QUI RESTE OUVERT : une question pendant le tour ----------
  const first = await post.execute({ kind: 'question', summary: 'bloque : quelle cible ?' }, { agent: workerA })
  say('T-D1', 'question pendant le tour -> wake=' + first.wake + ' · reçus par le proprietaire=' + owner.calls.length
    + ' · wake_pending=' + channel.stats().wake_pending)

  // L'ARRET REEL : la session de l'enfant ferme son tour.
  childA.append('turn/start', { turn: 1 })
  childA.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await tick(30)
  const afterTurnEnd = owner.calls.length
  say('T-D2', 'turn/end de la session de l enfant -> arrets observes=' + JSON.stringify(stops)
    + ' · reveils recus=' + afterTurnEnd + ' · etat du reveil=' + JSON.stringify(owner.calls.map((call) => call.target ?? null))
    + ' · wake_pending=' + channel.stats().wake_pending)
  say('T-D2-bis', 'la ligne hote VOIT le turn/end d un ENFANT (aucun listener de portee agent ne le lui masque)')
  if (afterTurnEnd !== 1) failures.push('turn/end ne reveille pas : l arret d un enfant qui reste ouvert n est pas couvert')
  if (owner.calls[0]?.wakeup !== true) failures.push('le reveil de turn/end n a pas ouvert de tour (wakeup !== true)')
  if (first.wake !== 'pending') failures.push('le depot a decide un reveil : wake=' + first.wake)

  // ---- 2. L'ENFANT QUI PART : un resultat, puis la sortie du registre -------
  const second = await post.execute({ kind: 'resultat', summary: 'fini' }, { agent: workerB })
  childB.append('turn/start', { turn: 1 })
  childB.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await tick(30)
  const afterChildBTurnEnd = owner.calls.length
  say('T-D3-a', 'resultat + turn/end -> reveils recus=' + afterChildBTurnEnd
    + ' · wake_pending=' + channel.stats().wake_pending + ' (l etat a l arret est blocked, le §4 exige done : rien n est decide)')
  disposers['session-child-b']()
  await tick(30)
  const afterDispose = owner.calls.length
  say('T-D3-b', 'agent/disposed -> reveils recus=' + afterDispose + ' · wake_pending=' + channel.stats().wake_pending
    + ' · arrets observes=' + JSON.stringify(stops))
  if (second.wake !== 'pending') failures.push('le resultat a decide au depot : wake=' + second.wake)
  if (afterChildBTurnEnd !== 1) failures.push('turn/end a decide un resultat : le §4 exige done, pas blocked')
  if (afterDispose !== 2) failures.push('agent/disposed ne reveille pas : l arret done est inatteignable')

  // ---- 3. CONTROLE : l'emetteur qui ne s'arrete jamais ---------------------
  await post.execute({ kind: 'question', summary: 'personne ne repondra' }, { agent: workerC })
  await tick(200)
  say('T-D4', 'aucun arret de l enfant C -> reveils recus=' + owner.calls.length
    + ' · wake_pending=' + channel.stats().wake_pending
    + ' · arrets observes=' + JSON.stringify(stops))
  if (owner.calls.length !== 2) failures.push('un message sans arret a reveille quelqu un')
  if (channel.stats().wake_pending !== 1) failures.push('le message sans arret ne porte pas wake_pending')

  // ---- 4. CONTROLE : un tour qui n est PAS une fin de tour -----------------
  childC.append('turn/start', { turn: 1 })
  childC.append('step/start', { turn: 1, step: 1 })
  await tick(30)
  say('controle', 'step/start ne declenche aucun arret : arrets observes=' + JSON.stringify(stops))
  if (stops.length !== 3) failures.push('un evenement qui n est pas un arret a ete pris pour un arret')

  // La lecture adressee, sur le meme montage reel : l'enfant ne voit rien.
  const pulledByOwner = await read.execute({}, { agent: owner })
  const pulledByChild = await read.execute({}, { agent: workerA })
  say('T-A', 'proprietaire -> ' + pulledByOwner.count + ' enveloppe(s) · enfant -> ' + pulledByChild.count
    + ' · read_refused=' + channel.stats().read_refused)
  if (pulledByOwner.count < 1) failures.push('le proprietaire ne voit pas les messages de son arbre')
  if (pulledByChild.count !== 0) failures.push('un enfant voit des messages qui ne lui sont pas adresses')

  // ---- 5. CONTROLE DE PORTEE : pourquoi la ligne doit etre HOTE -------------
  // Le feed est dispatche avec le porteur de la session, dont la cle de portee est
  // celle du contexte du MAGASIN (la racine de l'application). Un listener enregistre
  // SOUS la racine porte un tag, et « un tag SOUS la cle de dispatch reste exclu ».
  // La consequence est directement operationnelle : une ligne montee dans une portee
  // de preset ne verrait AUCUN arret, donc ne reveillerait jamais personne.
  const childD = root.sessions.create('session-child-d', { meta: { cwd: process.cwd(), parentSession: 'session-root' } })
  let hostSeen = 0
  let scopedSeen = 0
  await root.plugin({ name: 'probe-host-listener', apply: (ctx) => { ctx.on('session/event', () => { hostSeen++ }) } })
  const scopeKey = {}
  const scoped = createScope(root, scopeKey)
  await scoped.ctx.plugin({ name: 'probe-scoped-listener', apply: (ctx) => { ctx.on('session/event', () => { scopedSeen++ }) } })
  childD.append('turn/start', { turn: 1 })
  childD.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await tick(30)
  say('controle-portee', 'listener HOTE: ' + hostSeen + ' evenement(s) · listener SOUS la racine: ' + scopedSeen
    + ' — une ligne montee sous la racine ne voit aucun arret')
  if (hostSeen === 0) failures.push('le feed session/event n atteint pas la racine : la mesure ne prouve rien')
  if (scopedSeen !== 0) failures.push('un listener de portee inferieure voit le feed : la portee hote n est pas une condition')
  scoped.dispose()

  // La trace brute du plugin : les decisions telles qu'elles ont ete prises.
  const journal = readFileSync(join(scratch, 'plugin-data', 'dsh-boost-channel', 'decisions.jsonl'), 'utf8')
    .split('\n').filter((line) => line.includes('"wake-reeval"') || line.includes('"step":"stop"') || line.includes('"read-refused"'))
  for (const line of journal) say('journal', line)
  say('compteurs', JSON.stringify(channel.stats()))

  try { await root.dispose?.() } catch { /* le teardown ne masque jamais le verdict */ }
  rmSync(scratch, { recursive: true, force: true })
} catch (error) {
  failures.push('MESURE EN ECHEC — ' + String(error?.stack ?? error))
}

if (failures.length > 0) {
  console.log('PROBE-FAIL — ' + failures.join(' ; '))
  process.exit(1)
}
console.log('PROBE-PASS — l arret est mesure : turn/end (session/event) couvre l enfant qui reste ouvert et derive blocked,'
  + ' agent/disposed couvre celui qui part et derive done ; le depot ne decide rien, et la lecture est adressee')
