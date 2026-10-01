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
  KEEP_PER_SENDER,
  SUMMARY_MAX_CHARS,
  WakeLimiter,
  apply,
  buildTools,
  clipSummary,
  createChannel,
  deriveState,
  isWakeEligible,
  liveRootOf,
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
function mount({ clock = { at: 0 }, keep, maxBytes, readLimit } = {}) {
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

test('compteurs : posted/read/read_refused/delivered/wake_sent/wake_refused/wake_pending/truncated/deduped', () => {
  const { home, child, channel } = mount()
  try {
    channel.post({ from: child.id, kind: 'avancement', summary: 'court' })                 // inject
    channel.post({ from: child.id, kind: 'question', summary: 'bloque ?' })                // pending
    channel.post({ from: child.id, kind: 'question', summary: 'q'.repeat(5000) })          // pending + tronque
    assert.equal(channel.stats().wake_pending, 2, 'deux reveils en attente d arret')
    channel.stopped(child.id, { why: 'turn/end' })                                         // reveil (1) + cadence (1)
    channel.post({ from: child.id, kind: 'avancement', summary: 'encore du travail' })     // inject
    channel.post({ from: child.id, kind: 'avancement', summary: 'dup', id: 'doublon' })    // inject
    channel.post({ from: child.id, kind: 'avancement', summary: 'dup', id: 'doublon' })    // dedup
    channel.read({ from: 'session-child' })                                                // lecture refusee (non-proprietaire)
    assert.equal(channel.read({ from: 'session-root' }).length, 5)
    assert.deepEqual(channel.stats(), {
      posted: 5,
      read: 5,
      read_refused: 1,
      delivered: 4,
      wake_sent: 1,
      wake_refused: 1,
      wake_pending: 0,
      truncated: 1,
      deduped: 1,
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
    assert.deepEqual(registered.map((tool) => tool.name), ['channel_post', 'channel_read'])
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

  // L'eligibilite au reveil DIFFERE : ce qui attend un arret, et ce qui n'attend rien.
  assert.equal(isWakeEligible('question', 'running'), true)
  assert.equal(isWakeEligible('resultat', 'running'), true)
  assert.equal(isWakeEligible('decouverte', 'failed'), true, 'un echec se constate, il ne se declare pas')
  assert.equal(isWakeEligible('avancement', 'running'), false)
  assert.equal(isWakeEligible('decouverte', 'done'), false)

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

test('buildTools rend exactement les deux outils documentes', () => {
  const { home, channel } = mount()
  try {
    assert.deepEqual(buildTools(channel).map((tool) => tool.name), ['channel_post', 'channel_read'])
    const [post, read] = buildTools(channel)
    assert.deepEqual(post.parameters.required, ['kind', 'summary'])
    assert.deepEqual(post.parameters.properties.kind.enum, ['decouverte', 'avancement', 'question', 'resultat'])
    assert.equal(typeof post.output.render, 'function', 'le registre REFUSE un outil sans output.render')
    assert.equal(typeof read.output.render, 'function')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
