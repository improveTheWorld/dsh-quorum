// Tests unitaires du CANAL DE RETOUR — node --test (decouverte automatique).
//
//   node --test                       (depuis la racine du depot)
//   node --test test/channel.test.mjs (depuis packages/boost-channel)
//
// Chaque cas ci-dessous porte une regle de docs/CANAL.md, et chacun peut ECHOUER :
// c'est la condition pour qu'il prouve quelque chose. Les cas retenus sont ceux
// qui ont decide la conception — la retrogradation (§6), le plafond dur, la
// borne par emetteur, la dedup par identite — pas seulement le chemin passant.
//
// Aucun harnais n'est requis : le canal prend ses dependances en parametres, donc
// la politique de reveil se teste avec deux agents factices et une horloge.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DELIVERY_WINDOW_MS,
  KEEP_PER_SENDER,
  ORDINARY_KINDS,
  ORDINARY_PER_SENDER,
  RESERVED_PER_TREE,
  SUMMARY_MAX_CHARS,
  WakeLimiter,
  apply,
  buildTools,
  clipSummary,
  createChannel,
  deriveState,
  filtersKind,
  injectedKinds,
  isWakeEligible,
  liveRootOf,
  normaliseInjectFilter,
  stoppedState,
  wakePolicy,
} from '../lib/index.js'

/** Un arbre factice : deux agents vivants, et la trace de ce qui leur est livre. */
function fakeTree() {
  const calls = []
  const agents = new Map()
  const add = (id, status = 'running', parent) => {
    const agent = {
      id,
      status,
      session: { id, header: parent === undefined ? {} : { parentSession: parent } },
      inject: (message) => calls.push({ method: 'inject', to: id, message }),
      send: (message, target, wakeup) => calls.push({ method: 'send', to: id, message, target, wakeup }),
    }
    agents.set(id, agent)
    return agent
  }
  return {
    add,
    calls,
    remove: (id) => agents.delete(id),
    agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
  }
}

/** Un canal sur un arbre factice, dans un DSH_HOME jetable. */
function mount({ clock = { at: 0 }, keep, maxBytes, readLimit, limiter, injectKinds } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-channel-'))
  const tree = fakeTree()
  const root = tree.add('session-root', 'running')
  const child = tree.add('session-child', 'running', 'session-root')
  const channel = createChannel({
    home,
    agents: tree.agents,
    rootOf: (id) => liveRootOf(tree.agents, id),
    factsOf: (from) => ({
      live: tree.agents.get(from) !== undefined,
      status: tree.agents.get(from)?.status,
      failed: tree.agents.get(from)?.failed === true,
    }),
    now: () => clock.at,
    makeMessage: (envelope) => ({ id: 'fake:' + envelope.id, role: 'user', content: [{ type: 'text', text: envelope.summary }] }),
    keep,
    maxBytes,
    readLimit,
    limiter,
    injectKinds,
  })
  return { home, tree, root, child, channel, clock }
}

test('un message depose est relu par le proprietaire, avec la meme enveloppe', () => {
  const { home, child, channel } = mount()
  try {
    const posted = channel.post({
      from: child.id,
      kind: 'avancement',
      summary: 'etape 12/30 : la suite de tests passe',
      target: 'packages/boost-channel/lib/index.js',
      revision: 'abc1234',
      verdict: 'en cours',
    })
    assert.equal(posted.duplicate, false)
    assert.equal(posted.id, 'session-child:1', 'l id est <from>:<seq>')
    assert.equal(posted.state, 'running', 'un enfant en cours derive running')

    const envelopes = channel.read({ from: 'session-root' })
    assert.equal(envelopes.length, 1)
    assert.deepEqual(envelopes[0], {
      id: 'session-child:1',
      from: 'session-child',
      at: new Date(0).toISOString(),
      kind: 'avancement',
      state: 'running',
      to: 'session-root',
      target: 'packages/boost-channel/lib/index.js',
      revision: 'abc1234',
      verdict: 'en cours',
      summary: 'etape 12/30 : la suite de tests passe',
      payloadRef: null,
      payloadChars: null,
      truncated: false,
    })
    assert.equal(channel.stats().posted, 1)
    assert.equal(channel.stats().read, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('plafond : un summary de 5000 caracteres est tronque a 2000 ET truncated:true', () => {
  const { home, child, channel } = mount()
  try {
    channel.post({ from: child.id, kind: 'avancement', summary: 'x'.repeat(5000) })
    const [envelope] = channel.read({ from: 'session-root' })
    assert.equal(Array.from(envelope.summary).length, SUMMARY_MAX_CHARS)
    assert.equal(envelope.truncated, true, 'la troncature est VISIBLE, jamais muette')
    assert.equal(envelope.summary, 'x'.repeat(2000))
    assert.equal(channel.stats().truncated, 1)

    // La coupe est en POINTS DE CODE : un index UTF-16 couperait la paire.
    channel.post({ from: child.id, kind: 'decouverte', summary: '\u{1F600}'.repeat(5000) })
    const second = channel.read({ from: 'session-root', kinds: ['decouverte'] })[0]
    assert.equal(Array.from(second.summary).length, 2000)
    assert.equal(/\p{Surrogate}/u.test(second.summary), false, 'aucun substitut isole ne doit sortir du canal')
    assert.equal(second.truncated, true)
    assert.equal(channel.stats().truncated, 2)

    // Et le clip lui-meme : borne atteinte, borne non atteinte.
    assert.deepEqual(clipSummary('court', 10), { summary: 'court', truncated: false })
    assert.deepEqual(clipSummary('0123456789A', 10), { summary: '0123456789', truncated: true })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('adressage : un arbre ne voit pas les messages d un autre arbre', () => {
  const { home, tree, child, channel } = mount()
  try {
    tree.add('session-other', 'running')
    const other = tree.add('session-other-child', 'running', 'session-other')
    channel.post({ from: child.id, kind: 'resultat', summary: 'fini' })
    channel.post({ from: other.id, kind: 'resultat', summary: 'autre arbre' })
    const mine = channel.read({ from: 'session-root' })
    const theirs = channel.read({ from: 'session-other' })
    assert.deepEqual(mine.map((row) => row.from), ['session-child'])
    assert.deepEqual(theirs.map((row) => row.from), ['session-other-child'])
    // Le stockage lui-meme est par arbre : deux fichiers, aucun melange.
    assert.ok(existsSync(join(home, 'plugin-data', 'dsh-boost-channel', 'session-root.jsonl')))
    assert.ok(existsSync(join(home, 'plugin-data', 'dsh-boost-channel', 'session-other.jsonl')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('dedup : deux depots du meme id ne comptent qu une fois (deduped incremente)', () => {
  const { home, child, channel } = mount()
  try {
    const first = channel.post({ from: child.id, kind: 'avancement', summary: 'meme texte', id: 'session-child:1' })
    const second = channel.post({ from: child.id, kind: 'avancement', summary: 'meme texte', id: 'session-child:1' })
    assert.equal(first.duplicate, false)
    assert.equal(second.duplicate, true)
    assert.equal(channel.stats().deduped, 1)
    assert.equal(channel.stats().posted, 1)
    assert.equal(channel.storeFor('session-root').load().length, 1)

    // La dedup est par IDENTITE, jamais par texte : deux messages identiques de
    // texte sont deux messages.
    channel.post({ from: child.id, kind: 'avancement', summary: 'meme texte' })
    channel.post({ from: child.id, kind: 'avancement', summary: 'meme texte' })
    assert.equal(channel.stats().posted, 3)
    assert.equal(channel.stats().deduped, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('borne : au 51e message d un meme emetteur, le plus ancien disparait', () => {
  const { home, child, channel } = mount()
  try {
    for (let index = 1; index <= KEEP_PER_SENDER + 1; index++) {
      channel.post({ from: child.id, kind: 'avancement', summary: 'message ' + index })
    }
    const stored = channel.storeFor('session-root').load()
    assert.equal(stored.length, KEEP_PER_SENDER, 'la borne est par emetteur : 50, pas 51')
    assert.equal(stored[0].id, 'session-child:2', 'le plus ancien est parti')
    assert.equal(stored[stored.length - 1].id, 'session-child:51')
    assert.equal(channel.stats().posted, 51)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-D1 : la faille que ce chantier corrige. 'channel_post' EST un appel d'outil,
// donc l'emetteur travaille toujours quand il depose : decider ici rendait les
// reveils 'question'+'blocked' et 'resultat'+'done' inatteignables.
test('T-D1 : question deposee pendant que l emetteur est running -> AUCUN reveil, wake_pending = 1', () => {
  const { home, tree, child, channel } = mount()
  try {
    const posted = channel.post({ from: child.id, kind: 'question', summary: 'dois-je continuer ?' })
    assert.equal(posted.state, 'running', 'un enfant qui n a pas cesse de produire derive running')
    assert.equal(posted.wake, 'pending', 'le depot ne decide RIEN : le reveil se re-evalue a l arret')
    assert.deepEqual(tree.calls, [], 'ni send ni inject : le declaratif ne force RIEN')
    assert.equal(channel.stats().wake_pending, 1, 'le message est en attente d arret')
    assert.equal(channel.stats().wake_sent, 0)
    assert.equal(channel.stats().wake_refused, 0, 'un message en attente n est pas encore retrograde')
    assert.equal(channel.stats().delivered, 0, 'rien n est livre au depot')
    const stored = channel.storeFor('session-root').load()
    assert.equal(stored.length, 1, 'le message est STOCKE')
    assert.equal(stored[0].wake_pending, true, 'le marqueur est dans l enregistrement, pas seulement en memoire')
    assert.deepEqual(channel.read({ from: 'session-root' }).map((row) => row.kind), ['question'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-D2 : LE point de decision. L'arret est le fait qui manquait au depot.
test('T-D2 : l emetteur s arrete, son etat derive est blocked -> le reveil part A CE MOMENT-LA', () => {
  const { home, tree, child, channel } = mount()
  try {
    assert.equal(channel.post({ from: child.id, kind: 'question', summary: 'bloque : quelle cible ?' }).wake, 'pending')
    assert.deepEqual(tree.calls, [], 'aucun reveil avant l arret')
    // 'status' reste 'running' : c'est exactement la fenetre ou 'turn/end' est
    // enregistre avant que le driver ne bascule 'idle'. L'arret observe EST le
    // fait ; lire 'status' ici serait un pari.
    child.status = 'running'
    const report = channel.stopped(child.id, { why: 'turn/end' })
    assert.equal(report.state, 'blocked')
    assert.equal(report.evaluated, 1)
    assert.equal(report.wake_sent, 1)
    assert.equal(report.still_pending, 0)
    assert.equal(channel.stats().wake_pending, 0, 'la jauge retombe a 0')
    assert.equal(channel.stats().wake_sent, 1)
    assert.equal(channel.stats().delivered, 1)
    assert.equal(tree.calls.length, 1)
    assert.equal(tree.calls[0].method, 'send')
    assert.equal(tree.calls[0].to, 'session-root')
    assert.equal(tree.calls[0].target, 'next-step')
    assert.equal(tree.calls[0].wakeup, true, 'un reveil reveille le driver')
    assert.equal(tree.calls[0].message.id, 'fake:session-child:1')
    const [stored] = channel.storeFor('session-root').load()
    assert.equal(stored.state, 'blocked', 'l etat RE-DERIVE a l arret est celui qui a decide')
    assert.equal(stored.wake_pending, false, 'consomme une fois, jamais re-evalue')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-D2b : la retrogradation AU POINT DE DECISION. §6 reste vrai — mais il se
// prononce a l'arret, pas au depot.
test('T-D2b : question dont l emetteur est parti (done) -> RETROGRADEE a l arret, aucun reveil', () => {
  const { home, tree, child, channel } = mount()
  try {
    channel.post({ from: child.id, kind: 'question', summary: 'je ne repondrai plus' })
    tree.remove(child.id) // l emetteur a quitte le registre : etat derive 'done'
    const report = channel.stopped(child.id, { why: 'agent/disposed' })
    assert.equal(report.state, 'done')
    assert.equal(report.wake_refused, 1, 'un kind eligible dont l etat ne justifie pas le reveil est retrograde')
    assert.equal(report.wake_sent, 0)
    assert.deepEqual(tree.calls, [], 'rien n est appele : ni send, ni inject')
    assert.equal(channel.stats().wake_refused, 1)
    assert.equal(channel.stats().wake_pending, 0, 'la retrogradation consomme le message')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-D3 : l'ordre REEL des deux arrets. Un 'resultat' n'est pas decidable a
// 'turn/end' (l'etat y est blocked, le §4 exige done) : il reste en attente
// jusqu'a la sortie du registre. C'est mesure par 'tools/probe-stop.mjs'.
test('T-D3 : resultat depose en cours de tour -> reveil quand l emetteur est done', () => {
  const { home, tree, child, channel } = mount()
  try {
    const posted = channel.post({ from: child.id, kind: 'resultat', summary: 'fini' })
    assert.equal(posted.wake, 'pending')
    assert.equal(channel.stats().wake_pending, 1)

    // Premier arret : la fin du tour. L'emetteur est vivant, donc 'blocked' —
    // le §4 exige 'done' pour un resultat : rien n'est decide, rien n'est perdu.
    const atTurnEnd = channel.stopped(child.id, { why: 'turn/end' })
    assert.equal(atTurnEnd.state, 'blocked')
    assert.equal(atTurnEnd.evaluated, 0, 'inject n est pas une consommation')
    assert.equal(atTurnEnd.still_pending, 1)
    assert.deepEqual(tree.calls, [], 'aucun reveil a la fin du tour')
    assert.equal(channel.stats().wake_pending, 1)

    // Second arret : la sortie du registre. L'etat derive est 'done' -> reveil.
    tree.remove(child.id)
    const atDisposal = channel.stopped(child.id, { why: 'agent/disposed' })
    assert.equal(atDisposal.state, 'done')
    assert.equal(atDisposal.wake_sent, 1)
    assert.equal(channel.stats().wake_sent, 1)
    assert.equal(channel.stats().wake_pending, 0)
    assert.equal(tree.calls.length, 1)
    assert.equal(tree.calls[0].method, 'send')
    assert.equal(tree.calls[0].wakeup, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-D4 : sans arret, rien. Le delai est simule par l'horloge injectee.
test('T-D4 : un emetteur qui ne s arrete JAMAIS laisse son message en attente, sans reveiller personne', () => {
  const { home, tree, child, channel, clock } = mount()
  try {
    channel.post({ from: child.id, kind: 'question', summary: 'dans le vide' })
    clock.at += 600000 // dix minutes simulees : aucun arret n est survenu
    assert.deepEqual(tree.calls, [], 'le temps ne remplace pas un arret')
    assert.equal(channel.stats().wake_pending, 1)
    assert.equal(channel.stats().wake_sent, 0)
    assert.equal(channel.stats().wake_refused, 0)
    // Le message reste lisible par le proprietaire : l attente n est pas une perte.
    assert.deepEqual(channel.read({ from: 'session-root' }).map((row) => row.id), ['session-child:1'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-D5 : idempotence. Un message consomme ne l est plus jamais, meme si l etat
// change entre deux arrets.
test('T-D5 : deux arrets successifs ne produisent qu UN SEUL reveil', () => {
  const { home, tree, child, channel } = mount()
  try {
    channel.post({ from: child.id, kind: 'question', summary: 'une seule fois' })
    assert.equal(channel.stopped(child.id, { why: 'turn/end' }).wake_sent, 1)
    assert.equal(tree.calls.length, 1)
    // Second arret, et cette fois l etat derive est 'done' : le message est deja
    // consomme, donc rien de neuf — pas de second reveil, pas de re-evaluation.
    tree.remove(child.id)
    const second = channel.stopped(child.id, { why: 'agent/disposed' })
    assert.equal(second.evaluated, 0)
    assert.equal(second.wake_sent, 0)
    assert.equal(second.still_pending, 0)
    assert.equal(tree.calls.length, 1, 'un seul reveil pour un seul message')
    assert.equal(channel.stats().wake_sent, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-D6 : le limiteur de cadence garde son role, mais il mord a la RE-EVALUATION.
test('T-D6 : le limiteur de cadence mord a la re-evaluation, jamais au depot', () => {
  const { home, tree, child, channel, clock } = mount()
  try {
    // Deux depots pendant le tour : aucune place du limiteur n est consommee.
    assert.equal(channel.post({ from: child.id, kind: 'question', summary: 'q1' }).wake, 'pending')
    assert.equal(channel.post({ from: child.id, kind: 'question', summary: 'q2' }).wake, 'pending')
    assert.deepEqual(channel.limiter.window_(channel.limiter.children, child.id), [], 'le depot ne consomme rien')
    assert.deepEqual(channel.limiter.window_(channel.limiter.trees, 'session-root'), [])
    assert.equal(channel.stats().wake_pending, 2)

    // Premier arret : une place consommee, la seconde est refusee par la cadence.
    const first = channel.stopped(child.id, { why: 'turn/end' })
    assert.equal(first.wake_sent, 1)
    assert.equal(first.wake_refused, 1)
    assert.equal(channel.stats().wake_sent, 1)
    assert.equal(channel.stats().wake_refused, 1)
    assert.equal(tree.calls.length, 1, 'le second reveil n a pas ete emis')
    assert.equal(channel.stats().wake_pending, 0, 'les deux messages sont consommes : l un reveille, l autre est retrograde')
    assert.equal(channel.limiter.window_(channel.limiter.children, child.id).length, 1)

    // La fenetre glisse : nouvel arret, nouveau reveil.
    clock.at += 120001
    assert.equal(channel.post({ from: child.id, kind: 'question', summary: 'q3' }).wake, 'pending')
    assert.equal(channel.stopped(child.id, { why: 'turn/end' }).wake_sent, 1)
    assert.equal(channel.stats().wake_sent, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('avancement : livre par inject, sans reveiller le driver', () => {
  const { home, child, channel, tree } = mount()
  try {
    const posted = channel.post({ from: child.id, kind: 'avancement', summary: 'etape 3' })
    assert.equal(posted.wake, 'injected')
    assert.equal(tree.calls.length, 1)
    assert.equal(tree.calls[0].method, 'inject')
    assert.equal(channel.stats().wake_sent, 0, 'un battement de coeur ne coute pas un tour')
    assert.equal(channel.stats().delivered, 1)
    assert.equal(channel.stats().wake_refused, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('cadence : au plus 3 reveils par arbre et par 120 s', () => {
  const limiter = new WakeLimiter({ now: () => 0 })
  const first = limiter.allow('session-a', 'session-root')
  const second = limiter.allow('session-b', 'session-root')
  const third = limiter.allow('session-c', 'session-root')
  const fourth = limiter.allow('session-d', 'session-root')
  assert.deepEqual([first, second, third], [{ ok: true }, { ok: true }, { ok: true }])
  assert.deepEqual(fourth, { ok: false, why: 'tree-rate' })
  assert.equal(limiter.allow('session-e', 'session-root', 0).ok, false)
})

// CE CAS A ETE ADAPTE deux fois : par le jeton de livraison, puis par la politique
// d'injection. Il epingle l'instantane ENTIER de stats(), donc toute lecture neuve
// le fait echouer ; et le troisieme 'avancement' du meme enfant n'est plus injecte
// — la bourse ordinaire vaut 2 par emetteur et par 300 s. Le message reste STOCKE
// (la lecture en rend toujours 5), il n'est plus LIVRE : 'delivered' passe de 4 a
// 3, 'throttled' apparait, et 'filtered'/'subscribe_refused' valent 0 ici (aucune
// politique posee : le defaut est permissif).
test('compteurs : posted/read/read_refused/delivered/wake_sent/wake_refused/wake_pending/truncated/deduped/throttled/filtered', () => {
  const { home, child, channel } = mount()
  try {
    channel.post({ from: child.id, kind: 'avancement', summary: 'court' })                 // inject (ordinaire 1/2)
    channel.post({ from: child.id, kind: 'question', summary: 'bloque ?' })                // pending
    channel.post({ from: child.id, kind: 'question', summary: 'q'.repeat(5000) })          // pending + tronque
    assert.equal(channel.stats().wake_pending, 2, 'deux reveils en attente d arret')
    channel.stopped(child.id, { why: 'turn/end' })                                         // reveil (1) + cadence (1)
    channel.post({ from: child.id, kind: 'avancement', summary: 'encore du travail' })     // inject (ordinaire 2/2)
    channel.post({ from: child.id, kind: 'avancement', summary: 'dup', id: 'doublon' })    // THROTTLE (2/2 epuise)
    channel.post({ from: child.id, kind: 'avancement', summary: 'dup', id: 'doublon' })    // dedup
    channel.read({ from: 'session-child' })                                                // lecture refusee (non-proprietaire)
    assert.equal(channel.read({ from: 'session-root' }).length, 5)
    assert.deepEqual(channel.stats(), {
      posted: 5,
      read: 5,
      read_refused: 1,
      // 1 reveil + 2 injections : le troisieme avancement du meme emetteur n est
      // plus livre, mais il est STOCKE — la lecture en rend 5, juste au-dessus.
      delivered: 3,
      wake_sent: 1,
      wake_refused: 1,
      wake_pending: 0,
      truncated: 1,
      deduped: 1,
      throttled: 1,
      throttled_by_sender: { 'session-child': 1 },
      filtered: 0,
      filtered_by_kind: {},
      subscribe_refused: 0,
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('les outils sont installes PAR AGENT sur agent/created, jamais depuis la ligne hote', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-channel-mount-'))
  try {
    const registered = []
    const hostRegistered = []
    const handlers = new Map()
    const agent = { session: { id: 'session-child' }, status: 'running' }
    agent.ctx = { inject: (names, callback) => callback({ tools: { register: (tool) => registered.push(tool) } }) }
    const ctx = {
      agents: { get: (id) => (id === 'session-child' ? agent : undefined), list: () => [] },
      on: (event, handler) => handlers.set(event, handler),
      provide: () => {},
      // Un enregistrement depuis la portee HOTE : c'est exactement ce qui ne
      // marche pas (mesure deux fois). Il est la pour que le test puisse ECHOUER
      // si un jour les outils etaient declares au niveau de la ligne.
      tools: { register: (tool) => hostRegistered.push(tool) },
    }
    const channel = apply(ctx, { home, makeMessage: (envelope) => ({ id: envelope.id }) })
    assert.deepEqual(hostRegistered, [], 'la ligne hote n enregistre AUCUN outil')
    assert.deepEqual(registered, [], 'rien n est installe avant qu un agent existe')

    handlers.get('agent/created')({ agent })
    // TROIS outils depuis la politique du destinataire : 'channel_subscribe' est
    // installe pour tout le monde, et c'est le CORPS qui refuse un non-proprietaire
    // (un enfant le voit donc dans sa surface, et son appel est compte).
    assert.deepEqual(registered.map((tool) => tool.name), ['channel_post', 'channel_read', 'channel_subscribe'])
    assert.equal(typeof handlers.get('tools/post-execute'), 'function', 'le suivi des echecs passe par le waterfall')

    // Les outils passent par le MEME canal que les tests ci-dessus.
    const post = registered[0]
    const read = registered[1]
    const exec = { agent }
    const posted = await post.execute({ kind: 'decouverte', summary: 'vue dans le code' }, exec)
    assert.equal(posted.id, 'session-child:1')
    assert.equal(posted.wake, 'self', 'la racine se parle a elle-meme : personne a reveiller')
    const pulled = await read.execute({}, exec)
    assert.equal(pulled.count, 1)
    assert.equal(pulled.envelopes[0].summary, 'vue dans le code')
    assert.equal(channel.stats().posted, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('payloadRef est un CHEMIN, jamais la charge utile', () => {
  const { home, child, channel } = mount()
  try {
    const payload = join(home, 'preuve.txt')
    writeFileSync(payload, 'la preuve brute', 'utf8')
    channel.post({ from: child.id, kind: 'resultat', summary: 'fini', payloadRef: payload })
    const [envelope] = channel.read({ from: 'session-root' })
    assert.equal(envelope.payloadRef, payload)
    assert.equal(envelope.payloadChars, 15, 'la taille annoncee est celle du fichier pointe')
    assert.equal(JSON.stringify(envelope).includes('la preuve brute'), false, 'le contenu n entre JAMAIS dans l enveloppe')

    assert.throws(
      () => channel.post({ from: child.id, kind: 'resultat', summary: 'x', payloadRef: 'ligne 1\nligne 2' }),
      /must be a PATH/,
      'un payloadRef multiligne est du contenu, pas un chemin',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rotation : le fichier d un arbre est borne a 8 Mio (couture DSH_BOOST_CHANNEL_LOG_MAX_BYTES)', () => {
  // La couture est exercee telle qu'elle est documentee : par la variable
  // d'environnement, donc sur le meme chemin de code qu'en production.
  const previous = process.env.DSH_BOOST_CHANNEL_LOG_MAX_BYTES
  process.env.DSH_BOOST_CHANNEL_LOG_MAX_BYTES = '400'
  const { home, child, channel } = mount()
  try {
    for (let index = 0; index < 20; index++) {
      channel.post({ from: child.id, kind: 'avancement', summary: 'message ' + index + ' ' + 'y'.repeat(60) })
    }
    const file = join(home, 'plugin-data', 'dsh-boost-channel', 'session-root.jsonl')
    assert.ok(existsSync(file), 'le fichier actif existe')
    assert.ok(existsSync(file + '.1'), 'la generation precedente est gardee')
    assert.ok(readFileSync(file, 'utf8').length <= 400 + 200, 'le fichier actif reste sous le plafond')
    assert.equal(channel.storeFor('session-root').load().length <= 50, true)
  } finally {
    if (previous === undefined) delete process.env.DSH_BOOST_CHANNEL_LOG_MAX_BYTES
    else process.env.DSH_BOOST_CHANNEL_LOG_MAX_BYTES = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('les etats derives et la politique de reveil couvrent la table du §4', () => {
  assert.equal(deriveState({ failed: true, live: true, status: 'running' }), 'failed')
  assert.equal(deriveState({ live: false }), 'done')
  assert.equal(deriveState({ live: true, status: 'idle' }), 'blocked')
  assert.equal(deriveState({ live: true, status: 'running' }), 'running')

  assert.equal(wakePolicy('decouverte', 'running'), 'inject')
  assert.equal(wakePolicy('avancement', 'running'), 'inject')
  assert.equal(wakePolicy('question', 'blocked'), 'wake')
  assert.equal(wakePolicy('question', 'running'), 'refuse')
  assert.equal(wakePolicy('resultat', 'done'), 'wake')
  assert.equal(wakePolicy('resultat', 'failed'), 'wake')
  assert.equal(wakePolicy('avancement', 'failed'), 'wake')
  assert.equal(wakePolicy('decouverte', 'done'), 'inject')

  // L'eligibilite au reveil DIFFERE depend du KIND SEUL. L'etat est une
  // annotation : il garde son role dans la table ('done' / 'blocked' decide si un
  // 'resultat' est decide ou reste en attente), mais il ne promeut plus un
  // 'avancement' en reveil. Un echec qui doit reveiller se DECLARE : 'echec'.
  assert.equal(isWakeEligible('question'), true)
  assert.equal(isWakeEligible('resultat'), true)
  assert.equal(isWakeEligible('echec'), true)
  assert.equal(isWakeEligible('avancement'), false)
  assert.equal(isWakeEligible('decouverte'), false)
  assert.equal(isWakeEligible('avancement', 'failed'), false, 'un etat ne rend pas eligible')

  // 'echec' reveille des que l'emetteur s'arrete : c'est le seul kind qui porte
  // l'urgence lui-meme.
  assert.equal(wakePolicy('echec', 'blocked'), 'wake')
  assert.equal(wakePolicy('echec', 'done'), 'wake')
  assert.equal(wakePolicy('echec', 'failed'), 'wake')

  // L'etat derive A L'ARRET : la branche 'running' disparait, et ce n'est pas un
  // oubli — l'arret observe est la preuve que l'emetteur a cesse de produire,
  // meme si 'status' n'a pas encore bascule.
  assert.equal(stoppedState({ live: true, status: 'running', failed: false }), 'blocked')
  assert.equal(stoppedState({ live: true, status: 'idle', failed: false }), 'blocked')
  assert.equal(stoppedState({ live: false }), 'done')
  assert.equal(stoppedState({ live: false, failed: true }), 'failed')
  assert.equal(stoppedState({}), 'done')
})

test('un echec observe sur un tool/result est eligible, et reveille A L ARRET', () => {
  const { home, tree, child, channel } = mount()
  try {
    child.failed = true
    const posted = channel.post({ from: child.id, kind: 'resultat', summary: 'la suite echoue' })
    assert.equal(posted.state, 'failed')
    assert.equal(posted.wake, 'pending', 'l echec se constate au depot, il se reveille a l arret')
    assert.deepEqual(tree.calls, [])
    assert.equal(channel.stopped(child.id, { why: 'turn/end' }).state, 'failed')
    assert.equal(channel.stats().wake_sent, 1)
    assert.equal(tree.calls[0].method, 'send')
    assert.equal(tree.calls[0].wakeup, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('only_unread : ce qui a ete tire une fois ne l est plus', () => {
  const { home, child, channel } = mount()
  try {
    channel.post({ from: child.id, kind: 'avancement', summary: 'un' })
    channel.post({ from: child.id, kind: 'avancement', summary: 'deux' })
    assert.equal(channel.read({ from: 'session-root', only_unread: true }).length, 2)
    assert.equal(channel.read({ from: 'session-root', only_unread: true }).length, 0)
    // Sans only_unread, le proprietaire peut toujours relire.
    assert.equal(channel.read({ from: 'session-root' }).length, 2)
    // since par id : tout ce qui suit.
    assert.deepEqual(channel.read({ from: 'session-root', since: 'session-child:1' }).map((row) => row.id), ['session-child:2'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-D7 : le branchement sur les deux signaux REELS (mesures par
// 'tools/probe-stop.mjs' : turn/end atteint la ligne hote pour un enfant, et
// agent/disposed aussi). Un evenement qui n'est pas un arret ne doit rien faire.
test('T-D7 : l arret est branche sur turn/end ET agent/disposed, sur rien d autre', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-channel-stop-'))
  try {
    const handlers = new Map()
    const calls = []
    const agents = new Map()
    const add = (id, parent) => {
      const agent = {
        id,
        status: 'running',
        session: { id, header: parent === undefined ? {} : { parentSession: parent } },
        inject: (message) => calls.push({ method: 'inject', to: id, message }),
        send: (message, target, wakeup) => calls.push({ method: 'send', to: id, message, target, wakeup }),
      }
      agents.set(id, agent)
      return agent
    }
    add('session-root')
    const child = add('session-child', 'session-root')
    const ctx = {
      agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
      on: (event, handler) => handlers.set(event, handler),
      provide: () => {},
      tools: { register: () => {} },
    }
    const channel = apply(ctx, { home, makeMessage: (envelope) => ({ id: envelope.id }) })
    assert.equal(typeof handlers.get('session/event'), 'function', 'le feed des sessions est ecoute')
    assert.equal(typeof handlers.get('agent/disposed'), 'function', 'la sortie du registre est ecoutee')

    assert.equal(channel.post({ from: child.id, kind: 'question', summary: 'arrete-toi' }).wake, 'pending')
    handlers.get('session/event')({ id: child.id }, { type: 'step/start' })
    assert.equal(channel.stats().wake_pending, 1, 'un evenement qui n est pas un arret ne decide rien')
    assert.deepEqual(calls, [])
    handlers.get('session/event')({ id: child.id }, { type: 'turn/end' })
    assert.equal(channel.stats().wake_sent, 1)
    assert.equal(channel.stats().wake_pending, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'send')

    // La sortie du registre : le registre REEL retire l'agent AVANT d'annoncer
    // ('detachEntered'), donc l'etat derive a cet instant est 'done'.
    const second = add('session-second', 'session-root')
    assert.equal(channel.post({ from: second.id, kind: 'resultat', summary: 'fini' }).wake, 'pending')
    agents.delete('session-second')
    handlers.get('agent/disposed')({ agent: second })
    assert.equal(channel.stats().wake_sent, 2)
    assert.equal(channel.stats().wake_pending, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-A1 : l'adressage n'est pas une propriete du stockage seul. Un enfant de
// l'arbre — le VERIFICATEUR, par exemple — ne doit pas recevoir les conclusions
// de l'implementateur qu'il est cense contredire.
test('T-A1 : un enfant appelle la lecture -> page VIDE, read_refused, AUCUN marqueur ecrit', () => {
  const { home, child, channel } = mount()
  try {
    const posted = channel.post({ from: child.id, kind: 'question', summary: 'au proprietaire' })
    assert.equal(posted.wake, 'pending')
    const page = channel.read({ from: child.id, only_unread: true })
    assert.deepEqual(page, [], 'un enfant ne recoit pas les resumes des autres')
    assert.equal(channel.stats().read_refused, 1, 'un refus silencieux serait indistinguable d un canal vide')
    assert.equal(channel.stats().read, 0, 'une lecture refusee ne rend rien')
    // Rien n a ete marque lu : l id reste only_unread VRAI pour le proprietaire.
    const owner = channel.read({ from: 'session-root', only_unread: true })
    assert.deepEqual(owner.map((row) => row.id), ['session-child:1'])
    // Le refus est trace, avec son motif.
    const journal = readFileSync(join(home, 'plugin-data', 'dsh-boost-channel', 'decisions.jsonl'), 'utf8')
    assert.equal(journal.includes('"step":"read-refused"'), true)
    assert.equal(journal.includes('"why":"not-addressee"'), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-A2 : le proprietaire, lui, voit tout ce qui est adresse a son arbre.
test('T-A2 : le proprietaire lit les messages de ses enfants', () => {
  const { home, tree, child, channel } = mount()
  try {
    const sibling = tree.add('session-sibling', 'running', 'session-root')
    channel.post({ from: child.id, kind: 'avancement', summary: 'de l enfant' })
    channel.post({ from: sibling.id, kind: 'resultat', summary: 'du frere' })
    const page = channel.read({ from: 'session-root' })
    assert.deepEqual(page.map((row) => row.summary), ['de l enfant', 'du frere'])
    assert.equal(channel.stats().read_refused, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-A3 : un message adresse a une session n'est rendu qu'a elle.
test('T-A3 : un message adresse a un enfant est rendu A CET ENFANT, et a personne d autre', () => {
  const { home, tree, child, channel } = mount()
  try {
    const sibling = tree.add('session-sibling', 'running', 'session-root')
    // La voie du SERVICE INTERNE nomme le destinataire ('to') ; la voie de
    // l'outil, elle, adresse toujours la racine de l'arbre.
    channel.post({ from: 'session-root', kind: 'avancement', summary: 'pour le seul enfant', to: child.id })
    channel.post({ from: child.id, kind: 'avancement', summary: 'pour la racine' })
    assert.deepEqual(channel.read({ from: child.id }).map((row) => row.summary), ['pour le seul enfant'])
    assert.deepEqual(channel.read({ from: sibling.id }), [], 'le frere ne voit pas ce qui est adresse a l autre')
    assert.equal(channel.stats().read_refused, 1)
    assert.deepEqual(channel.read({ from: 'session-root' }).map((row) => row.summary), ['pour la racine'],
      'le proprietaire ne voit pas ce qui est adresse a un enfant')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-A4 : le compteur est expose ET journalise (jamais un refus muet).
test('T-A4 : read_refused figure dans stats() et dans le journal, avec son motif', () => {
  const { home, child, channel } = mount()
  try {
    channel.post({ from: child.id, kind: 'avancement', summary: 'pour la racine' })
    assert.equal(Object.prototype.hasOwnProperty.call(channel.stats(), 'read_refused'), true)
    assert.equal(channel.stats().read_refused, 0)
    channel.read({ from: child.id })
    assert.equal(channel.stats().read_refused, 1)
    const lines = readFileSync(join(home, 'plugin-data', 'dsh-boost-channel', 'decisions.jsonl'), 'utf8')
      .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    const refused = lines.filter((row) => row.step === 'read-refused')
    assert.equal(refused.length, 1)
    assert.equal(refused[0].from, 'session-child')
    assert.equal(refused[0].why, 'not-addressee')
    assert.equal(lines.some((row) => row.step === 'stats' && row.read_refused === 1), true, 'l instantane porte le compteur')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-B1 et T-B2 : LA FRONTIERE DE L'OUTIL. Mesure du verificateur independant :
// le harnais passe 'exec.arguments' tel quel au corps ('dsh-tools/lib/index.js:3310')
// et ne rejette une cle non declaree que si le schema porte
// 'additionalProperties: false' ('dsh-tools' :467-468). Un enfant pouvait donc
// adresser un FRERE, ecrire dans le magasin d'un AUTRE ARBRE, et ouvrir un tour
// du proprietaire de cet autre arbre.
test('T-B1 : channel_post ignore un argument non declare et le journalise', async () => {
  const { home, tree, child, channel } = mount()
  try {
    const sibling = tree.add('session-sibling', 'running', 'session-root')
    const [post] = buildTools(channel)
    const posted = await post.execute(
      { kind: 'question', summary: 'chez moi', to: sibling.id, root: 'session-other-root' },
      { agent: child },
    )
    assert.equal(posted.wake, 'pending', 'le tour de l appelant n est PAS casse')
    const [stored] = channel.storeFor('session-root').load()
    assert.equal(stored.to, 'session-root', 'le destinataire reste la racine de SON arbre')
    assert.equal(channel.storeFor('session-other-root').load().length, 0, 'aucun magasin etranger n est touche')
    assert.deepEqual(tree.calls.filter((call) => call.to === sibling.id), [], 'aucun envoi vers un frere')
    const journal = readFileSync(join(home, 'plugin-data', 'dsh-boost-channel', 'decisions.jsonl'), 'utf8')
      .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    const undeclared = journal.filter((row) => row.step === 'undeclared-argument')
    assert.equal(undeclared.length, 1, 'l argument ignore est journalise, jamais muet')
    assert.equal(undeclared[0].tool, 'channel_post')
    assert.deepEqual(undeclared[0].keys, ['to', 'root'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('T-B2 : channel_post ignore un argument root non declare — le message reste dans SON arbre', async () => {
  const { home, tree, child, channel } = mount()
  try {
    tree.add('session-other-root', 'running')
    const [post] = buildTools(channel)
    const posted = await post.execute({ kind: 'question', summary: 'x', root: 'session-other-root' }, { agent: child })
    assert.equal(posted.wake, 'pending')
    assert.equal(posted.id, 'session-child:1', 'l id n est pas qualifie : le magasin est le sien')
    assert.equal(channel.storeFor('session-root').load().length, 1, 'le message est dans SON magasin')
    assert.equal(channel.storeFor('session-other-root').load().length, 0, 'le magasin etranger est intact')
    assert.deepEqual(tree.calls, [], 'aucun appel vers le proprietaire d un autre arbre')
    assert.equal(channel.stopped(child.id, { why: 'turn/end' }).wake_sent, 1, 'le message de SON arbre est decide')
    assert.deepEqual(tree.calls.map((call) => call.to), ['session-root'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-B3 : la meme frontiere sur la lecture. Sans elle, 'root'/'from' non declares
// redirigeaient la lecture et feraient marquer lu le message d'un autre arbre.
test('T-B3 : channel_read ignore root et from non declares — le controle de destinataire tient', async () => {
  const { home, tree, child, channel } = mount()
  try {
    tree.add('session-other-root', 'running')
    const outsider = tree.add('session-other-child', 'running', 'session-other-root')
    channel.post({ from: outsider.id, kind: 'avancement', summary: 'message d un autre arbre' })
    const [, read] = buildTools(channel)
    const viaRoot = await read.execute({ root: 'session-other-root' }, { agent: child })
    assert.equal(viaRoot.count, 0, 'root ne redirige pas la lecture')
    const viaFrom = await read.execute({ from: 'session-other-root' }, { agent: child })
    assert.equal(viaFrom.count, 0, 'from ne fait pas lire a la place d un autre')
    assert.equal(channel.stats().read_refused, 2)
    // La lecture refusee n a RIEN marque : le message de l autre arbre est encore
    // 'only_unread' pour son proprietaire.
    assert.equal(channel.read({ from: 'session-other-root', only_unread: true }).length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-B4 et T-B7 : L'INDEX DES ATTENTES. '<de>:<seq>' n'est unique que DANS un
// magasin ; indexer sur (de, id) faisait disparaitre un message quand un meme
// emetteur en depositait deux, de meme id, dans deux magasins — le second
// ecrasait le premier, et le premier n'etait plus jamais decide.
test('T-B4 : deux depots eligibles du meme emetteur dans deux magasins -> chacun est decide', () => {
  const { home, tree, child, channel } = mount({ limiter: new WakeLimiter({ now: () => 0, perChild: 5, perTree: 5 }) })
  try {
    tree.add('session-other-root', 'running')
    const first = channel.post({ from: child.id, kind: 'question', summary: 'chez moi' })
    const second = channel.post({ from: child.id, kind: 'echec', summary: 'ailleurs', root: 'session-other-root' })
    assert.notEqual(first.id, second.id, 'deux magasins, deux identites distinctes')
    assert.equal(second.id, 'session-other-root:session-child:1', 'un depot hors de son arbre qualifie l id')
    assert.equal(channel.stats().wake_pending, 2, 'les DEUX messages attendent leur arret')
    const report = channel.stopped(child.id, { why: 'turn/end' })
    assert.equal(report.evaluated, 2, 'les deux sont decides, chacun dans son magasin')
    assert.equal(report.wake_sent, 2)
    assert.deepEqual(tree.calls.map((call) => call.to).sort(), ['session-other-root', 'session-root'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-B8 : LA DEFENSE EN PROFONDEUR. L'id qualifie (T-B4) empeche la collision par
// la voie normale ; mais l'id EXPLICITE est une capacite du service interne, et
// c'est elle qui peut encore produire deux fois la meme identite dans deux
// magasins. L'index doit donc porter la racine pour lui-meme.
test('T-B8 : deux messages de MEME id dans deux magasins sont decides chacun dans le sien', () => {
  const { home, tree, child, channel } = mount({ limiter: new WakeLimiter({ now: () => 0, perChild: 5, perTree: 5 }) })
  try {
    tree.add('session-other-root', 'running')
    const first = channel.post({ from: child.id, kind: 'question', summary: 'chez moi', id: 'commun:1' })
    const second = channel.post({ from: child.id, kind: 'question', summary: 'ailleurs', root: 'session-other-root', id: 'commun:1' })
    assert.equal(first.id, second.id, 'la meme identite, dans deux magasins')
    assert.equal(channel.stats().wake_pending, 2, 'deux attentes distinctes, malgre une identite identique')
    const report = channel.stopped(child.id, { why: 'turn/end' })
    assert.equal(report.evaluated, 2, 'chacune est decidee dans SON magasin')
    assert.equal(report.wake_sent, 2)
    assert.deepEqual(tree.calls.map((call) => call.to).sort(), ['session-other-root', 'session-root'])
    assert.equal(channel.storeFor('session-root').load()[0].wake_pending, false)
    assert.equal(channel.storeFor('session-other-root').load()[0].wake_pending, false)
    assert.equal(channel.stats().wake_pending, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('T-B7 : la jauge wake_pending retombe a 0 apres decision, dans les deux magasins', () => {
  const { home, tree, child, channel } = mount({ limiter: new WakeLimiter({ now: () => 0, perChild: 5, perTree: 5 }) })
  try {
    tree.add('session-other-root', 'running')
    channel.post({ from: child.id, kind: 'question', summary: 'chez moi' })
    channel.post({ from: child.id, kind: 'resultat', summary: 'ailleurs', root: 'session-other-root' })
    assert.equal(channel.stats().wake_pending, 2)
    tree.remove(child.id) // l emetteur quitte le registre : etat re-derive 'done'
    channel.stopped(child.id, { why: 'agent/disposed' })
    assert.equal(channel.stats().wake_pending, 0, 'la jauge ne compte plus rien')
    assert.equal(channel.storeFor('session-root').load()[0].wake_pending, false)
    assert.equal(channel.storeFor('session-other-root').load()[0].wake_pending, false)
    assert.equal(channel.storeFor('session-root').load()[0].state, 'done', 'l etat re-derive est ecrit dans les deux magasins')
    assert.equal(channel.storeFor('session-other-root').load()[0].state, 'done')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-B5 : « un avancement ne reveille personne » redevient vrai. Un etat 'failed'
// ne promeut plus un kind : l'eligibilite depend du KIND SEUL.
test('T-B5 : un avancement depose avec un etat failed ne reveille PAS', () => {
  const { home, tree, child, channel } = mount()
  try {
    child.failed = true
    const posted = channel.post({ from: child.id, kind: 'avancement', summary: 'un outil a echoue' })
    assert.equal(posted.state, 'failed', 'l etat reste constate')
    assert.equal(posted.wake, 'injected', 'le kind SEUL rend eligible : un avancement se livre, il ne reveille pas')
    assert.equal(channel.stats().wake_pending, 0)
    assert.equal(channel.storeFor('session-root').load()[0].wake_pending, undefined, 'aucun marqueur d attente')
    const report = channel.stopped(child.id, { why: 'turn/end' })
    assert.equal(report.evaluated, 0, 'rien n attend, donc rien n est decide')
    assert.equal(channel.stats().wake_sent, 0)
    assert.deepEqual(tree.calls.map((call) => call.method), ['inject'], 'un inject, jamais un tour')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-B6 : l'echec qui doit reveiller se DECLARE.
test('T-B6 : le kind echec est eligible au reveil differe', () => {
  const { home, tree, child, channel } = mount()
  try {
    const posted = channel.post({ from: child.id, kind: 'echec', summary: 'la suite echoue' })
    assert.equal(posted.wake, 'pending')
    assert.equal(channel.stats().wake_pending, 1)
    assert.deepEqual(tree.calls, [], 'aucun reveil au depot')
    const report = channel.stopped(child.id, { why: 'turn/end' })
    assert.equal(report.state, 'blocked')
    assert.equal(report.wake_sent, 1)
    assert.equal(tree.calls[0].method, 'send')
    assert.equal(tree.calls[0].wakeup, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('buildTools rend exactement les trois outils documentes', () => {
  const { home, channel } = mount()
  try {
    assert.deepEqual(buildTools(channel).map((tool) => tool.name), ['channel_post', 'channel_read', 'channel_subscribe'])
    const [post, read, subscribe] = buildTools(channel)
    assert.deepEqual(post.parameters.required, ['kind', 'summary'])
    assert.deepEqual(post.parameters.properties.kind.enum, ['decouverte', 'avancement', 'question', 'resultat', 'echec'])
    assert.equal(typeof post.output.render, 'function', 'le registre REFUSE un outil sans output.render')
    assert.equal(typeof read.output.render, 'function')
    // Le JETON est declare dans la surface de sortie : il n'est pas seulement
    // calcule, il est rendu a l'appelant.
    assert.deepEqual(post.output.schema.required, ['id', 'state', 'duplicate', 'wake', 'budget'])
    assert.deepEqual(
      [post.output.schema.properties.budget.properties.ordinary.type, post.output.schema.properties.budget.properties.reserved.type],
      ['number', 'number'],
    )
    // Le reglage du destinataire est un OUTIL, avec sa frontiere d'arguments.
    assert.deepEqual(subscribe.parameters.required, ['inject'])
    assert.deepEqual(subscribe.parameters.properties.inject.items.enum, ['decouverte', 'avancement', 'question', 'resultat', 'echec'])
    assert.equal(typeof subscribe.output.render, 'function', 'le registre REFUSE un outil sans output.render')
    assert.deepEqual(subscribe.output.schema.required, ['inject', 'refused', 'why'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ============================================================================
// LE JETON DE LIVRAISON — T-J1 a T-J7
//
// La taille etait bornee, le NOMBRE ne l'etait pas : un enfant qui postait 200
// 'avancement' injectait 200 lignes dans le contexte de son proprietaire. Ces cas
// tiennent la borne, et surtout la regle qui la rend acceptable : ce qui est
// borne est la LIVRAISON, jamais l'ECRITURE — un message non livre est STOCKE,
// marque 'throttled', et tirable par 'channel_read'.
//
// Chacun de ces cas peut ECHOUER : la falsification (retirer la borne d'arbre)
// fait tomber T-J2, et c'est ecrit dans le README.
// ============================================================================

// T-J1 : la borne par emetteur, ET la preuve que rien n'est perdu.
test('T-J1 : 3 avancements du meme enfant -> le 3e est throttled, mais STOCKE et TIRABLE', () => {
  const { home, tree, child, channel } = mount()
  try {
    const first = channel.post({ from: child.id, kind: 'avancement', summary: 'etape 1' })
    const second = channel.post({ from: child.id, kind: 'avancement', summary: 'etape 2' })
    const third = channel.post({ from: child.id, kind: 'avancement', summary: 'etape 3' })
    assert.equal(first.wake, 'injected')
    assert.equal(second.wake, 'injected')
    assert.equal(third.wake, 'throttled', 'la bourse ordinaire vaut 2 par emetteur et par fenetre')
    assert.deepEqual(tree.calls.map((call) => call.method), ['inject', 'inject'], 'le 3e n est PAS injecte')
    // Le restant est rendu a l'appelant, qui peut choisir de se taire.
    assert.deepEqual([first.budget.ordinary, second.budget.ordinary, third.budget.ordinary], [1, 0, 0])
    assert.deepEqual([first.budget.reserved, second.budget.reserved, third.budget.reserved], [3, 3, 3],
      'un avancement ne touche JAMAIS la bourse reservee')
    // Regle 1 (« tirer, pas pousser ») : le message refuse n'est pas perdu.
    const stored = channel.storeFor('session-root').load()
    assert.equal(stored.length, 3, 'les TROIS messages sont stockes')
    assert.equal(stored[2].throttled, true, 'le marqueur est dans l ENREGISTREMENT, pas seulement en memoire')
    assert.equal(stored[2].wake_pending, undefined, 'et un avancement ne devient pas eligible pour autant')
    assert.deepEqual(channel.read({ from: 'session-root' }).map((row) => row.summary), ['etape 1', 'etape 2', 'etape 3'],
      'le proprietaire TIRE les trois, y compris celui qui n a pas ete livre')
    assert.equal(channel.stats().throttled, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-J2 : la borne d'ARBRE, et le compteur qui NOMME le refuse. C'est ce cas que la
// falsification fait tomber : sans la borne d'arbre, les cinq passent.
test('T-J2 : 5 avancements de 5 enfants differents -> 4 livres au plus, et le refuse est NOMME', () => {
  const { home, tree, channel } = mount()
  try {
    const children = ['a', 'b', 'c', 'd', 'e'].map((suffix) => tree.add('session-child-' + suffix, 'running', 'session-root'))
    const posted = children.map((child) => channel.post({ from: child.id, kind: 'avancement', summary: 'etape de ' + child.id }))
    assert.deepEqual(posted.map((row) => row.wake), ['injected', 'injected', 'injected', 'injected', 'throttled'],
      'chaque enfant n a parle QU UNE fois : c est la borne d ARBRE (4) qui mord')
    assert.deepEqual(posted.map((row) => row.budget.ordinary), [1, 1, 1, 0, 0])
    assert.equal(tree.calls.length, 4, 'quatre injections, pas cinq')
    assert.equal(tree.calls.every((call) => call.method === 'inject' && call.to === 'session-root'), true)
    assert.equal(channel.stats().throttled, 1)
    assert.deepEqual(channel.stats().throttled_by_sender, { 'session-child-e': 1 },
      'le compteur dit QUI a ete refuse — un total ne designe pas le brouilleur')
    // Rien n est perdu : le cinquieme est stocke, et le proprietaire le tire.
    assert.equal(channel.storeFor('session-root').load().length, 5)
    assert.equal(channel.read({ from: 'session-root' }).length, 5)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-J3 : les deux bourses sont SEPAREES. Le bruit sature l'ordinaire ; le signal
// passe quand meme — c'est la raison d'etre de la reservee.
test('T-J3 : bourse ordinaire saturee -> une question est LIVREE : le bruit n affame pas le signal', () => {
  const { home, tree, channel } = mount()
  try {
    const children = ['a', 'b', 'c', 'd', 'e'].map((suffix) => tree.add('session-child-' + suffix, 'running', 'session-root'))
    for (const child of children) channel.post({ from: child.id, kind: 'avancement', summary: 'bruit de ' + child.id })
    assert.equal(channel.stats().throttled, 1, 'l ordinaire de l arbre est sature : 4 livres, 1 refuse')
    assert.equal(tree.calls.filter((call) => call.method === 'inject').length, 4)
    // L'enfant bloque : sa bourse RESERVEE n a pas ete touchee par le bruit.
    const posted = channel.post({ from: children[0].id, kind: 'question', summary: 'bloque : quelle cible ?' })
    assert.equal(posted.wake, 'pending')
    assert.equal(posted.budget.reserved, RESERVED_PER_TREE - 1, 'la reservee est INTACTE : une place reservee, deux restantes')
    assert.equal(posted.budget.ordinary, 0, 'et l ordinaire, lui, reste sature')
    const report = channel.stopped(children[0].id, { why: 'turn/end' })
    assert.equal(report.state, 'blocked')
    assert.equal(report.wake_sent, 1, 'le signal passe malgre cinq messages de bruit')
    assert.equal(tree.calls.filter((call) => call.method === 'send').length, 1)
    assert.equal(channel.stats().wake_refused, 0, 'aucun reveil refuse : le bruit n a rien pris au signal')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-J4 : la reservee est bornee ELLE AUSSI — au depot (la place se reserve) et a
// la livraison (la place reservee est la seule qui ouvre le reveil). Le limiteur de
// reveil est PERMISSIF ici : ce qui refuse la quatrieme, c'est la bourse, et rien
// d'autre — les deux dispositifs ne se confondent pas.
test('T-J4 : 4 questions d affilee -> la 4e est throttled (bourse reservee bornee)', () => {
  const { home, tree, child, channel } = mount({ limiter: new WakeLimiter({ now: () => 0, perChild: 99, perTree: 99 }) })
  try {
    const posted = [1, 2, 3, 4].map((n) => channel.post({ from: child.id, kind: 'question', summary: 'q' + n }))
    assert.deepEqual(posted.map((row) => row.budget.reserved), [2, 1, 0, 0])
    assert.deepEqual(posted.map((row) => row.wake), ['pending', 'pending', 'pending', 'pending'],
      'un budget epuise ne change PAS le verdict du depot : le reveil se decide a l arret')
    const stored = channel.storeFor('session-root').load()
    assert.equal(stored.length, 4, 'les QUATRE questions sont stockees')
    assert.equal(stored[3].throttled, true)
    assert.equal(stored[3].wake_pending, true, 'l eligibilite depend du KIND SEUL : la bourse ne la retire pas')
    assert.equal(channel.stats().throttled, 1)
    const report = channel.stopped(child.id, { why: 'turn/end' })
    assert.equal(report.wake_sent, 3, 'trois livraisons reservees')
    assert.equal(report.wake_refused, 1, 'la quatrieme est refusee par la BOURSE')
    assert.equal(tree.calls.length, 3)
    const journal = readFileSync(join(home, 'plugin-data', 'dsh-boost-channel', 'decisions.jsonl'), 'utf8')
      .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    assert.equal(journal.filter((row) => row.step === 'throttled').length, 1)
    assert.equal(journal.filter((row) => row.step === 'wake-reeval' && row.wake === 'throttled').length, 1,
      'a l arret, la quatrieme est consommee comme les autres — mais refusee par la bourse')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-J5 : le jeton est VISIBLE et il se recharge. L'horloge est injectee (mount la
// passe a createChannel ET a DeliveryBudget) : la fenetre est donc simulee par la
// meme couture que le limiteur de reveil, pas par une attente reelle.
test('T-J5 : le champ budget DECROIT, et se recharge apres la fenetre', () => {
  const { home, child, channel, clock } = mount()
  try {
    assert.equal(DELIVERY_WINDOW_MS, 300000, 'la fenetre est nommee, exportee et vaut 300 s')
    assert.deepEqual(channel.post({ from: child.id, kind: 'avancement', summary: 'un' }).budget, { ordinary: ORDINARY_PER_SENDER - 1, reserved: RESERVED_PER_TREE })
    assert.deepEqual(channel.post({ from: child.id, kind: 'avancement', summary: 'deux' }).budget, { ordinary: 0, reserved: RESERVED_PER_TREE })
    assert.deepEqual(channel.post({ from: child.id, kind: 'avancement', summary: 'trois' }).budget, { ordinary: 0, reserved: RESERVED_PER_TREE },
      'un message refuse ne consomme rien de plus')
    // La reservee ne decroit que sur les kinds qui la puisent.
    assert.deepEqual(channel.post({ from: child.id, kind: 'question', summary: 'q1' }).budget, { ordinary: 0, reserved: 2 })
    assert.deepEqual(channel.post({ from: child.id, kind: 'question', summary: 'q2' }).budget, { ordinary: 0, reserved: 1 })
    // La fenetre est glissante : a une milliseconde de la fin, rien n'est rendu.
    clock.at += DELIVERY_WINDOW_MS - 1
    assert.deepEqual(channel.post({ from: child.id, kind: 'avancement', summary: 'presque' }).budget, { ordinary: 0, reserved: 1 })
    clock.at += 2
    assert.deepEqual(channel.post({ from: child.id, kind: 'avancement', summary: 'apres' }).budget, { ordinary: ORDINARY_PER_SENDER - 1, reserved: RESERVED_PER_TREE },
      'les DEUX bourses sont revenues a plein')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-J6 : un budget n'est pas une politique. Il ne promeut RIEN (l'eligibilite
// depend du kind seul), il ne change pas la table du §4, et il ne touche pas au
// limiteur de reveil — deux dispositifs distincts.
test('T-J6 : une bourse epuisee ne promeut rien et ne change pas la politique de reveil', () => {
  const { home, tree, child, channel } = mount()
  try {
    const noisy = tree.add('session-noisy', 'running', 'session-root')
    for (let index = 0; index < 5; index++) channel.post({ from: noisy.id, kind: 'avancement', summary: 'bruit ' + index })
    assert.ok(channel.stats().throttled >= 3, 'l ordinaire de cet enfant est sature')
    // 1. Un kind NON eligible ne le devient pas parce que sa bourse est vide.
    const beat = channel.post({ from: noisy.id, kind: 'avancement', summary: 'encore' })
    assert.equal(beat.wake, 'throttled')
    assert.equal(channel.storeFor('session-root').load().every((row) => row.wake_pending === undefined), true,
      'aucun avancement ne porte wake_pending : une bourse ne promeut pas un kind')
    // 2. Un kind eligible ne perd pas son eligibilite quand la reservee est vide.
    for (let index = 0; index < RESERVED_PER_TREE; index++) channel.post({ from: child.id, kind: 'echec', summary: 'echec ' + index })
    const fourth = channel.post({ from: child.id, kind: 'echec', summary: 'echec 3' })
    assert.equal(fourth.wake, 'pending')
    assert.equal(fourth.budget.reserved, 0)
    const mine = channel.storeFor('session-root').load().filter((row) => row.from === child.id)
    assert.deepEqual(mine.map((row) => row.wake_pending), [true, true, true, true], 'les QUATRE restent eligibles')
    assert.deepEqual(mine.map((row) => row.throttled === true), [false, false, false, true], 'et un seul est throttled')
    // 3. La bourse ne consomme AUCUNE place du limiteur de reveil.
    assert.deepEqual(channel.limiter.window_(channel.limiter.children, child.id), [])
    assert.deepEqual(channel.limiter.window_(channel.limiter.trees, 'session-root'), [])
    // 4. La politique elle-meme est inchangee par le budget : la meme table, et
    //    l'eligibilite toujours par le KIND SEUL.
    assert.equal(wakePolicy('question', 'blocked'), 'wake')
    assert.equal(wakePolicy('question', 'done'), 'refuse')
    assert.equal(wakePolicy('resultat', 'done'), 'wake')
    assert.equal(isWakeEligible('avancement'), false, 'une bourse vide ne promeut pas un avancement')
    assert.equal(isWakeEligible('echec'), true, 'et une bourse vide ne retrograde pas un echec')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-J7 : les compteurs disent COMBIEN et QUI, et le journal porte la ligne exigee
// (id, from, kind, bourse epuisee, restant) — un refus muet serait indistinguable
// d'un canal vide.
test('T-J7 : throttled et throttled_by_sender, et la ligne de journal correspondante', () => {
  const { home, tree, channel } = mount()
  try {
    const noisy = tree.add('session-noisy', 'running', 'session-root')
    const quiet = tree.add('session-quiet', 'running', 'session-root')
    const extra = tree.add('session-extra', 'running', 'session-root')
    const last = tree.add('session-last', 'running', 'session-root')
    channel.post({ from: noisy.id, kind: 'avancement', summary: 'n1' })   // livre (emetteur 1/2)
    channel.post({ from: noisy.id, kind: 'avancement', summary: 'n2' })   // livre (emetteur 2/2)
    channel.post({ from: noisy.id, kind: 'avancement', summary: 'n3' })   // THROTTLE (emetteur)
    channel.post({ from: quiet.id, kind: 'decouverte', summary: 'd1' })   // livre (arbre 3/4)
    channel.post({ from: extra.id, kind: 'avancement', summary: 'x1' })   // livre (arbre 4/4)
    const refused = channel.post({ from: last.id, kind: 'avancement', summary: 'x2' })  // THROTTLE (arbre)
    assert.equal(refused.wake, 'throttled')
    assert.equal(channel.stats().throttled, 2)
    assert.deepEqual(channel.stats().throttled_by_sender, { 'session-noisy': 1, 'session-last': 1 })
    // La bourse RESERVEE alimente les MEMES compteurs : c'est un compteur de
    // messages livres a zero, pas un compteur d'une seule bourse.
    const questions = [1, 2, 3, 4].map((n) => channel.post({ from: noisy.id, kind: 'question', summary: 'q' + n }))
    assert.deepEqual(questions.map((row) => row.wake), ['pending', 'pending', 'pending', 'pending'])
    const storedQuestions = channel.storeFor('session-root').load().filter((row) => row.kind === 'question')
    assert.equal(storedQuestions.length, 4)
    assert.deepEqual(storedQuestions.map((row) => row.throttled === true), [false, false, false, true])
    assert.equal(channel.stats().throttled, 3)
    assert.deepEqual(channel.stats().throttled_by_sender, { 'session-noisy': 2, 'session-last': 1 })
    const lines = readFileSync(join(home, 'plugin-data', 'dsh-boost-channel', 'decisions.jsonl'), 'utf8')
      .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    const throttled = lines.filter((row) => row.step === 'throttled')
    assert.equal(throttled.length, 3, 'une ligne par message refuse, jamais deux pour le meme')
    assert.equal(throttled.length, channel.stats().throttled)
    assert.deepEqual(
      { id: throttled[0].id, from: throttled[0].from, kind: throttled[0].kind, purse: throttled[0].purse, remaining: throttled[0].remaining },
      { id: 'session-noisy:3', from: 'session-noisy', kind: 'avancement', purse: 'ordinary', remaining: 0 },
    )
    assert.equal(throttled[2].purse, 'reserved', 'la bourse epuisee est NOMMEE dans le journal')
    assert.equal(throttled[2].remaining, 0)
    assert.equal(lines.some((row) => row.step === 'stats' && row.throttled === 3), true, 'l instantane porte le compteur')
    assert.equal(lines.some((row) => row.step === 'stats' && row.throttled_by_sender?.['session-noisy'] === 2), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ============================================================================
// LA POLITIQUE DU DESTINATAIRE — T-F1 a T-F5
//
// Le proprietaire pouvait filtrer ce qu'il TIRE (kind, date, jamais-lu) mais
// subissait tout ce qu'on lui POUSSE : le jeton bornait le VOLUME, rien ne bornait
// le CONTENU. Or le §5 regle 6 dit « le destinataire peut dire stop » — sur la
// poussee, il ne pouvait pas.
//
// La politique appartient au DESTINATAIRE (le proprietaire de l'arbre), jamais a
// l'emetteur, et elle ne porte QUE sur les kinds NON REVEILLANTS. La falsification
// (retirer la clause « les kinds reveillants passent toujours ») fait tomber T-F2,
// et c'est ecrit dans le README.
// ============================================================================

/** L'outil de politique, tel que le registre le rendrait. */
const subscribeTool = (channel) => buildTools(channel).find((tool) => tool.name === 'channel_subscribe')
/** L'exec d'un appel fait par le PROPRIETAIRE de l'arbre factice. */
const OWNER_EXEC = { agent: { session: { id: 'session-root' } } }

// T-F1 : le contenu est regle par le destinataire, et un message filtre n'est
// jamais perdu — meme regle que le jeton.
test('T-F1 : filtre du proprietaire -> le kind exclu n est PAS injecte, mais STOCKE et TIRABLE', async () => {
  const { home, tree, child, channel } = mount()
  try {
    const applied = await subscribeTool(channel).execute({ inject: ['decouverte'] }, OWNER_EXEC)
    assert.deepEqual(applied, { inject: ['decouverte'], refused: false, why: '' }, 'l appel repond ce qui est desormais injecte')
    const welcome = channel.post({ from: child.id, kind: 'decouverte', summary: 'vue dans le code' })
    const excluded = channel.post({ from: child.id, kind: 'avancement', summary: 'etape 12/30' })
    assert.equal(welcome.wake, 'injected')
    assert.equal(excluded.wake, 'filtered', 'la politique du DESTINATAIRE refuse ce kind')
    assert.deepEqual(tree.calls.map((call) => call.method), ['inject'], 'un seul inject : l avancement n entre PAS dans le contexte')
    // Regle 1 (« tirer, pas pousser ») : le message filtre n'est pas perdu.
    const stored = channel.storeFor('session-root').load()
    assert.equal(stored.length, 2, 'les DEUX messages sont stockes')
    assert.equal(stored[1].filtered, true, 'le marqueur est dans l ENREGISTREMENT, pas seulement en memoire')
    assert.equal(stored[1].summary, 'etape 12/30')
    assert.deepEqual(channel.read({ from: 'session-root' }).map((row) => row.kind), ['decouverte', 'avancement'],
      'le proprietaire TIRE ce qu il a refuse de subir')
    assert.equal(channel.stats().filtered, 1)
    assert.equal(channel.stats().delivered, 1, 'un message filtre n est pas une livraison')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-F2 : LA CLAUSE NON NEGOCIABLE. Un filtre vide ne peut pas faire disparaitre le
// signal : sans elle, l'arbitre deviendrait un filtre a disparition.
test('T-F2 : inject: [] -> une QUESTION reveille quand meme son proprietaire', async () => {
  const { home, tree, child, channel } = mount()
  try {
    const applied = await subscribeTool(channel).execute({ inject: [] }, OWNER_EXEC)
    assert.deepEqual(applied.inject, [], 'plus AUCUN kind ordinaire n est injecte')
    const beat = channel.post({ from: child.id, kind: 'avancement', summary: 'bruit' })
    assert.equal(beat.wake, 'filtered')
    // LE SIGNAL, sous le filtre le plus restrictif possible.
    const posted = channel.post({ from: child.id, kind: 'question', summary: 'bloque : quelle cible ?' })
    assert.equal(posted.wake, 'pending', 'une question n est JAMAIS filtree')
    assert.equal(posted.budget.reserved, RESERVED_PER_TREE - 1, 'la bourse reservee est intacte')
    const report = channel.stopped(child.id, { why: 'turn/end' })
    assert.equal(report.state, 'blocked')
    assert.equal(report.wake_sent, 1, 'le signal passe malgre un filtre vide')
    assert.deepEqual(tree.calls.filter((call) => call.method === 'send').map((call) => call.to), ['session-root'])
    assert.equal(channel.stats().filtered, 1, 'seul le battement a ete filtre')
    assert.equal(channel.stats().wake_refused, 0)
    // 'resultat' et 'echec' : meme regle — aucun des trois n'est filtrable.
    const result = channel.post({ from: child.id, kind: 'resultat', summary: 'fini' })
    assert.equal(result.wake, 'pending')
    const stored = channel.storeFor('session-root').load()
    assert.deepEqual(stored.map((row) => row.kind), ['avancement', 'question', 'resultat'])
    assert.deepEqual(stored.map((row) => row.filtered === true), [true, false, false])
    // La clause, en clair, sur les fonctions pures — apres la consequence
    // observable, pour que la falsification la montre AVANT le detail.
    assert.deepEqual(ORDINARY_KINDS, ['decouverte', 'avancement'], 'seuls les kinds non reveillants sont filtrables')
    for (const kind of ['question', 'resultat', 'echec']) {
      assert.equal(filtersKind(normaliseInjectFilter([]), kind), false, kind + ' passe TOUJOURS')
    }
    assert.equal(filtersKind(normaliseInjectFilter([]), 'avancement'), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-F3 : la politique appartient au PROPRIETAIRE. Un enfant qui l'appelle est
// refuse, compte, et sa demande ne change rien.
test('T-F3 : un ENFANT qui appelle la politique est REFUSE, compte, et ne change RIEN', async () => {
  const { home, child, channel } = mount()
  try {
    const refused = await subscribeTool(channel).execute({ inject: [] }, { agent: child })
    assert.equal(refused.refused, true, 'la politique appartient au proprietaire de l arbre')
    assert.equal(refused.why, 'not-owner')
    assert.deepEqual(refused.inject, ['decouverte', 'avancement'], 'la reponse rend la politique EN VIGUEUR, inchangee')
    assert.equal(channel.stats().subscribe_refused, 1)
    // Elle n'a PAS bouge : le battement de l enfant est toujours injecte.
    assert.equal(channel.post({ from: child.id, kind: 'avancement', summary: 'etape 1' }).wake, 'injected')
    assert.equal(channel.stats().filtered, 0)
    const journal = readFileSync(join(home, 'plugin-data', 'dsh-boost-channel', 'decisions.jsonl'), 'utf8')
      .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    const line = journal.filter((row) => row.step === 'subscribe-refused')
    assert.equal(line.length, 1, 'un refus silencieux serait indistinguable d un reglage applique')
    assert.equal(line[0].from, 'session-child')
    assert.equal(line[0].why, 'not-owner')
    // Un argument INVALIDE leve (l'appelant est vivant et peut lire l'erreur) : une
    // politique qu'on devine est pire qu'une politique qui s'abstient.
    assert.throws(() => normaliseInjectFilter('avancement'), /must be a list/)
    assert.throws(() => normaliseInjectFilter(['inconnu']), /declared kinds only/)
    assert.deepEqual(injectedKinds(normaliseInjectFilter(['question'])), [], 'lister un kind reveillant est un NO-OP')
    // Le proprietaire, lui, passe : le refus n'a pas ferme la porte.
    const applied = await subscribeTool(channel).execute({ inject: ['decouverte'] }, OWNER_EXEC)
    assert.deepEqual(applied, { inject: ['decouverte'], refused: false, why: '' })
    assert.equal(channel.post({ from: child.id, kind: 'avancement', summary: 'etape 2' }).wake, 'filtered')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-F4 : les compteurs disent COMBIEN et LESQUELS, le journal porte le filtre en
// vigueur, et le refus du destinataire prime sur la borne de volume.
test('T-F4 : filtered et filtered_by_kind disent COMBIEN et LESQUELS', async () => {
  const { home, tree, channel } = mount()
  try {
    await subscribeTool(channel).execute({ inject: ['decouverte'] }, OWNER_EXEC)
    const kids = ['a', 'b', 'c', 'd', 'e'].map((suffix) => tree.add('session-child-' + suffix, 'running', 'session-root'))
    channel.post({ from: kids[0].id, kind: 'avancement', summary: 'a1' })
    channel.post({ from: kids[0].id, kind: 'avancement', summary: 'a2' })
    channel.post({ from: kids[1].id, kind: 'avancement', summary: 'a3' })
    // Quatre 'decouverte' ACCEPTEES : elles saturent la bourse ordinaire de l arbre.
    for (const kid of kids.slice(0, 4)) channel.post({ from: kid.id, kind: 'decouverte', summary: 'd ' + kid.id })
    assert.equal(channel.stats().delivered, 4)
    assert.equal(channel.stats().throttled, 0, 'un message filtre ne consomme AUCUNE place de bourse')
    // Les DEUX refuseraient (kind filtre ET arbre sature) : c'est la POLITIQUE qui
    // est rendue — le refus explicite du destinataire passe avant la borne.
    const both = channel.post({ from: kids[4].id, kind: 'avancement', summary: 'a4' })
    assert.equal(both.wake, 'filtered', 'le refus EXPLICITE du destinataire prime sur la borne de volume')
    assert.equal(channel.stats().filtered, 4)
    assert.deepEqual(channel.stats().filtered_by_kind, { avancement: 4 }, 'le compte est PAR KIND')
    assert.equal(channel.stats().throttled, 0)
    const lines = readFileSync(join(home, 'plugin-data', 'dsh-boost-channel', 'decisions.jsonl'), 'utf8')
      .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    const filtered = lines.filter((row) => row.step === 'filtered')
    assert.equal(filtered.length, 4, 'une ligne par message filtre')
    assert.equal(filtered.length, channel.stats().filtered)
    assert.deepEqual(
      { id: filtered[0].id, from: filtered[0].from, kind: filtered[0].kind, inject: filtered[0].inject },
      { id: 'session-child-a:1', from: 'session-child-a', kind: 'avancement', inject: ['decouverte'] },
      'le journal porte id, from, kind ET le filtre en vigueur',
    )
    assert.equal(lines.some((row) => row.step === 'stats' && row.filtered === 4), true, 'l instantane porte le compteur')
    assert.equal(lines.some((row) => row.step === 'stats' && row.filtered_by_kind?.avancement === 4), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// T-F5 : les DEUX facons de regler, et le defaut PERMISSIF : rien ne change pour
// qui ne regle rien.
test('T-F5 : sans reglage le defaut est PERMISSIF ; la cle de configuration regle pareil', () => {
  // (a) aucun reglage.
  const free = mount()
  try {
    assert.equal(free.channel.filterFor('session-root'), null, 'le defaut est permissif')
    assert.deepEqual(injectedKinds(free.channel.filterFor('session-root')), ['decouverte', 'avancement'])
    assert.equal(free.channel.post({ from: free.child.id, kind: 'avancement', summary: 'libre' }).wake, 'injected')
    assert.equal(free.channel.post({ from: free.child.id, kind: 'decouverte', summary: 'libre aussi' }).wake, 'injected')
    assert.equal(free.channel.stats().filtered, 0)
    assert.equal(free.channel.stats().subscribe_refused, 0)
  } finally {
    rmSync(free.home, { recursive: true, force: true })
  }
  // (b) la CLE DE CONFIGURATION de la ligne — meme endroit que maxBytes/keep/readLimit.
  const configured = mount({ injectKinds: ['decouverte'] })
  try {
    assert.deepEqual(injectedKinds(configured.channel.filterFor('session-root')), ['decouverte'])
    assert.equal(configured.channel.post({ from: configured.child.id, kind: 'avancement', summary: 'non' }).wake, 'filtered')
    assert.equal(configured.channel.post({ from: configured.child.id, kind: 'decouverte', summary: 'oui' }).wake, 'injected')
  } finally {
    rmSync(configured.home, { recursive: true, force: true })
  }
  // (c) une valeur INVALIDE est journalisee et laisse le defaut permissif : un
  //     montage ne tombe pas pour un reglage.
  const broken = mount({ injectKinds: 'avancement' })
  try {
    assert.equal(broken.channel.filterFor('session-root'), null, 'le montage survit au reglage invalide')
    assert.equal(broken.channel.post({ from: broken.child.id, kind: 'avancement', summary: 'libre' }).wake, 'injected')
    const lines = readFileSync(join(broken.home, 'plugin-data', 'dsh-boost-channel', 'decisions.jsonl'), 'utf8')
      .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    assert.equal(lines.some((row) => row.step === 'inject-config-invalid'), true, 'le reglage invalide est JOURNALISE')
  } finally {
    rmSync(broken.home, { recursive: true, force: true })
  }
})

