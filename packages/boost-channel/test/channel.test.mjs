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
  liveRootOf,
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

test('retrogradation : question avec etat derive running -> stocke, wake_refused, AUCUN reveil', () => {
  const { home, tree, child, channel } = mount()
  try {
    const posted = channel.post({ from: child.id, kind: 'question', summary: 'dois-je continuer ?' })
    assert.equal(posted.state, 'running', 'un enfant qui n a pas cesse de produire derive running')
    assert.equal(posted.wake, 'refused')
    assert.deepEqual(tree.calls, [], 'ni send ni inject : le declaratif ne force RIEN')
    assert.equal(channel.stats().wake_refused, 1)
    assert.equal(channel.stats().wake_sent, 0)
    assert.equal(channel.stats().delivered, 0, 'une question retrogradee n est meme pas injectee')
    assert.equal(channel.storeFor('session-root').load().length, 1, 'le message est STOCKE')
    assert.deepEqual(channel.read({ from: 'session-root' }).map((row) => row.kind), ['question'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('reveil legitime : question avec etat blocked -> reveil compte', () => {
  const { home, tree, child, channel } = mount()
  try {
    child.status = 'idle' // vivant, mais il a cesse de produire
    const posted = channel.post({ from: child.id, kind: 'question', summary: 'bloque : quelle cible ?' })
    assert.equal(posted.state, 'blocked')
    assert.equal(posted.wake, 'sent')
    assert.equal(channel.stats().wake_sent, 1)
    assert.equal(channel.stats().delivered, 1)
    assert.equal(tree.calls.length, 1)
    assert.equal(tree.calls[0].method, 'send')
    assert.equal(tree.calls[0].to, 'session-root')
    assert.equal(tree.calls[0].target, 'next-step')
    assert.equal(tree.calls[0].wakeup, true, 'un reveil reveille le driver')
    assert.equal(tree.calls[0].message.id, 'fake:session-child:1')
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

test('cadence : deux reveils en moins de 120 s pour le meme enfant -> le second est refuse', () => {
  const { home, tree, child, channel, clock } = mount()
  try {
    child.status = 'idle'
    assert.equal(channel.post({ from: child.id, kind: 'question', summary: 'q1' }).wake, 'sent')
    assert.equal(channel.post({ from: child.id, kind: 'question', summary: 'q2' }).wake, 'refused:child-rate')
    assert.equal(channel.stats().wake_sent, 1)
    assert.equal(channel.stats().wake_refused, 1)
    assert.equal(tree.calls.length, 1, 'le second reveil n a pas ete emis')

    // Au-dela de la fenetre, le reveil est de nouveau possible.
    clock.at += 120001
    assert.equal(channel.post({ from: child.id, kind: 'question', summary: 'q3' }).wake, 'sent')
    assert.equal(channel.stats().wake_sent, 2)
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

test('compteurs : posted/read/delivered/wake_sent/wake_refused/truncated/deduped refletent les scenarios', () => {
  const { home, child, channel } = mount()
  try {
    channel.post({ from: child.id, kind: 'avancement', summary: 'court' })                 // inject
    channel.post({ from: child.id, kind: 'question', summary: 'bloque ?' })                // retrograde
    channel.post({ from: child.id, kind: 'question', summary: 'q'.repeat(5000) })          // retrograde + tronque
    child.status = 'idle'
    channel.post({ from: child.id, kind: 'question', summary: 'vraiment bloque' })         // reveil
    channel.post({ from: child.id, kind: 'question', summary: 'encore' })                  // cadence : refuse
    channel.post({ from: child.id, kind: 'avancement', summary: 'encore du travail' })     // inject
    channel.post({ from: child.id, kind: 'avancement', summary: 'dup', id: 'doublon' })    // inject
    channel.post({ from: child.id, kind: 'avancement', summary: 'dup', id: 'doublon' })    // dedup
    assert.equal(channel.read({ from: 'session-root' }).length, 7)
    assert.deepEqual(channel.stats(), {
      posted: 7,
      read: 7,
      delivered: 4,
      wake_sent: 1,
      wake_refused: 3,
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
})

test('un echec observe sur un tool/result derive failed, et reveille', () => {
  const { home, tree, child, channel } = mount()
  try {
    child.failed = true
    const posted = channel.post({ from: child.id, kind: 'resultat', summary: 'la suite echoue' })
    assert.equal(posted.state, 'failed')
    assert.equal(posted.wake, 'sent')
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
