// Les tests de 'dsh-boost-lessons' — l'etape 1 des lecons a la compaction.
//
//   node --test packages/boost-lessons/test/lessons.test.mjs
//
// Chaque cas ci-dessous peut ECHOUER, et c'est la seule raison de l'ecrire :
//
//   T-L1   une compaction de RACINE au-dessus du plancher produit UNE ligne, avec
//          les champs attendus — et un evenement d'un AUTRE type n'ecrit rien ;
//   T-L1b  le plancher compte le TEXTE du resume, pas le nombre de blocs : la
//          forme reelle est 'ContentBlock[]' (mesure du corpus : 1 bloc de 11 786
//          caracteres), donc compter '.length' compterait '1' ;
//   T-L2   une compaction d'ENFANT n'ecrit rien — y compris avec
//          'delegationDepth: 0', le piege mesure : c'est 'parentSession' qui
//          marque la parente, pas la profondeur ;
//   T-L3   deux evenements de MEME 'compactionId' (le cas du fork) : UNE ligne ;
//   T-L3b  le re-amorcage : un SECOND montage sur le meme journal ne reecrit pas
//          l'id deja present (l'ensemble vit en memoire, mais il est re-amorce) ;
//   T-L4   sous le plancher : aucune ligne (et la frontiere exacte est incluse) ;
//   T-L5   L'ECHEC D'ECRITURE NE PROPAGE PAS : le chemin du journal est
//          inecrivable, et l'appel se termine normalement — l'erreur est comptee,
//          deposee dans un repli best-effort, et RIEN ne remonte ;
//   T-L5b  le meme cas sur une VRAIE 'Session.append' : le vrai magasin de
//          sessions ('@deepseek-ai/dsh-session') et une vraie application cordis,
//          avec un CONTROLE DE VIVACITE — un listener qui jette POUR DE VRAI est
//          vu par l'exportateur de log, donc l'absence d'alerte pour notre ligne
//          veut dire quelque chose ;
//   T-L6   une charge utile imprevue ne fait pas lever le listener (donnee
//          absente, session absente, header absent, getter hostile) ;
//   T-L7   la rotation garde une generation, et un re-montage se re-amorce depuis
//          les DEUX — la lecture qui n'en lit qu'une perd des ids et reecrit ;
//   T-L8   le plancher est CONFIGURABLE, et une valeur invalide retombe sur le
//          defaut sans casser le montage ;
//   T-T1   une RACINE (aucun parent) est RETENUE, registre vivant ou pas ;
//   T-T2   un parent VIVANT fait ECARTER son enfant (la recursion) ;
//   T-T3   un parent MORT fait RETENIR la session — LA SESSION CONTINUEE, le cas
//          qui a tout casse et qu'aucun cas ne couvrait ;
//   T-T4   SANS service 'agents', le comportement d'hier tient (les enfants sont
//          ecartes) ET le repli est JOURNALISE ('filter-no-registry'), une fois ;
//   T-T5   la trace de montage fonctionne toujours, et nomme le MODE de filtrage
//          retenu ('parent-liveness' avec registre, 'roots-only' sans).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_SUMMARY_FLOOR_CHARS,
  FILTER_FALLBACK_STEP,
  FILTER_PARENT_LIVENESS,
  FILTER_ROOTS_ONLY,
  REASON_RETAINED,
  apply,
  charsOf,
  isRootSession,
  journalPath,
  lessonsMaxBytes,
  parentVerdict,
  planCompaction,
  readSeen,
  textOf,
} from '../lib/index.js'

/** Un journal par cas : le fichier est la seule preuve lisible apres coup. */
function home() {
  return mkdtempSync(join(tmpdir(), 'boost-lessons-'))
}

/** Le journal d'un dossier jetable. */
function journalOf(dir) {
  return join(dir, 'plugin-data', 'dsh-boost-lessons', 'compactions.jsonl')
}

/** Les lignes REELLEMENT ecrites, deja JSON-parsees. */
function rowsOf(dir) {
  const file = journalOf(dir)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

/** Les modules du harnais, resolus comme le fait 'test/aggregate.test.mjs'. */
function harnessModules() {
  return process.env.DSH_HARNESS
    ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
}

/**
 * Le montage : un contexte minimal qui n'expose que 'on' et 'provide'. Le
 * listener enregistre est celui du plugin, appele comme 'session/event'
 * l'appelle : '(session, event)', en SYNCHRONE.
 */
function harness(options = {}) {
  const dir = options.home ?? home()
  const listeners = []
  let provided
  const ctx = {
    on: (event, listener) => {
      if (event === 'session/event') listeners.push(listener)
    },
    provide: (serviceName, value) => {
      provided = { serviceName, value }
    },
    // LE REGISTRE VIVANT : le meme acces que 'apply' fait en production
    // ('ctx.get', jamais une propriete devinee). 'options.agents' est soit le
    // registre, soit une FONCTION qui le rend — la forme qui permet d'en fournir
    // un APRES le montage et de verifier que la ligne ne fige pas son repli.
    get: (serviceName) => (serviceName === 'agents'
      ? (typeof options.agents === 'function' ? options.agents() : options.agents)
      : undefined),
  }
  const controller = apply(ctx, { home: dir, ...options.config })
  return {
    dir,
    controller,
    provided: () => provided,
    fire: (session, event) => {
      for (const listener of listeners) listener(session, event)
    },
    listeners: () => listeners.length,
  }
}

/** Une session RACINE : 'parentSession' ABSENT du header. */
function rootSession(id = 'session-root') {
  return { id, header: { version: 4, id, createdAt: 0, cwd: process.cwd(), isSeeded: false } }
}

/**
 * Une session ENFANT, avec le piege mesure : 'parentSession' AVEC
 * 'delegationDepth: 0'. Un filtre par la profondeur prendrait cette session pour
 * une racine.
 */
function childSession(id = 'session-child') {
  return {
    id,
    header: { version: 4, id, createdAt: 0, cwd: process.cwd(), isSeeded: false, parentSession: 'session-root', delegationDepth: 0, origin: 'subagent' },
  }
}

/**
 * LA SESSION CONTINUEE — le cas qui a tout casse, dans sa forme MESUREE : un fork
 * seede ('isSeeded: true', 'delegationDepth: 0') dont le parent n'est PLUS VIVANT
 * (journal du relais, 2026-10-02 19:31 et 19:34 : 'register-skipped', 'why:
 * root-agent-unknown', id '7fa9e670', root '018354d9' — la session d'avant le
 * redemarrage). Son en-tete PORTE 'parentSession', donc un filtre par
 * 'parentSession === undefined' la prend pour un enfant et l'ignore.
 */
function continuedSession(id = 'session-continuee', deadParent = 'session-morte') {
  return {
    id,
    header: { version: 4, id, createdAt: 0, cwd: process.cwd(), isSeeded: true, parentSession: deadParent, delegationDepth: 0 },
  }
}

/**
 * Le REGISTRE VIVANT : les ids cites y sont vivants, tous les autres sont morts.
 * C'est la seule chose que le filtre lui demande.
 */
function liveAgents(...ids) {
  const alive = new Set(ids)
  return { get: (id) => (alive.has(id) ? { session: { id } } : undefined), list: () => [...alive] }
}

/** La charge utile REELLE d'une compaction, telle que le corpus la porte. */
function summaryEvent(overrides = {}) {
  return {
    type: 'compaction/summary',
    seq: 1820,
    data: {
      compactionId: '8073f4c0-dbc9-4c4b-b86e-26a6a9175037',
      summary: [{ type: 'text', text: 'S'.repeat(11_786) }],
      rawOutput: [{ type: 'text', text: 'R'.repeat(500) }, { type: 'text', text: 'r'.repeat(250) }],
      shadowedSeqs: [1, 2, 3, 345],
      shadowedRange: { start: 1, end: 345 },
      shadowedTokenCount: 421_120,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      ...overrides,
    },
  }
}

// --------------------------------------------------------------------------- //
// T-L1 — la ligne, et son contenu                                               //
// --------------------------------------------------------------------------- //

test('T-L1 : une compaction de RACINE au-dessus du plancher produit UNE ligne, avec ses champs', () => {
  const h = harness()
  const session = rootSession()

  // Le controle qui rend le cas suivant signifiant : un AUTRE type n'ecrit rien.
  h.fire(session, { type: 'turn/end', seq: 4, data: { turn: 1 } })
  h.fire(session, { type: 'compaction/start', seq: 1818, data: { compactionId: '8073f4c0-dbc9-4c4b-b86e-26a6a9175037', turn: 6 } })
  assert.deepEqual(rowsOf(h.dir), [], 'un evenement qui n est pas une compaction/summary ne doit rien ecrire')
  assert.equal(h.controller.stats.events, 2, 'les deux evenements ont bien ete vus')
  assert.equal(h.controller.stats.summaries, 0, 'compaction/start n est PAS un compaction/summary : rien a journaliser')

  h.fire(session, summaryEvent())

  const rows = rowsOf(h.dir)
  assert.equal(rows.length, 1, 'la compaction de racine doit produire exactement une ligne')
  const row = rows[0]
  assert.equal(row.session, 'session-root')
  assert.equal(row.cwd, process.cwd())
  assert.equal(row.compactionId, '8073f4c0-dbc9-4c4b-b86e-26a6a9175037')
  assert.equal(row.turn, null, 'turn est ABSENT des charges utiles reelles : null, jamais 0')
  assert.equal(row.summaryChars, 11_786)
  assert.equal(row.rawOutputChars, 750)
  assert.deepEqual(row.shadowedSeqs, [1, 2, 3, 345])
  assert.equal(row.reason, REASON_RETAINED)
  assert.equal(typeof row.at, 'string')
  assert.ok(!Number.isNaN(Date.parse(row.at)), 'at doit etre une date ISO : ' + row.at)
  // La ligne est UNE ligne : aucun saut de ligne dans la charge utile ecrite.
  assert.equal(readFileSync(journalOf(h.dir), 'utf8').split('\n').filter((line) => line !== '').length, 1)

  assert.equal(h.controller.stats.retained, 1)
  assert.equal(h.controller.stats.events, 3)
  assert.equal(h.controller.stats.write_failed, 0)
  assert.equal(h.provided()?.serviceName, 'boostLessons')
  assert.equal(h.provided()?.value, h.controller)
})

// --------------------------------------------------------------------------- //
// T-L1b — le plancher compte le TEXTE, pas le nombre de blocs                   //
// --------------------------------------------------------------------------- //

test('T-L1b : le plancher compte le TEXTE du resume, pas le nombre de blocs', () => {
  const text = 'L'.repeat(3000)
  assert.equal(textOf([{ type: 'text', text }]), text)
  assert.equal(textOf(text), text)
  assert.equal(charsOf([{ type: 'text', text }]), 3000)
  assert.equal(charsOf(undefined), 0)

  const h = harness()
  // UN bloc de 3000 caracteres : '.length' vaudrait 1, donc « sous le plancher ».
  h.fire(rootSession('session-un-bloc'), summaryEvent({ compactionId: 'un-bloc', summary: [{ type: 'text', text }] }))
  // Une CHAINE nue : la meme matiere.
  h.fire(rootSession('session-chaine'), summaryEvent({ compactionId: 'chaine', summary: text }))
  const rows = rowsOf(h.dir)
  assert.equal(rows.length, 2, 'les deux formes de charge utile portent 3000 caracteres de matiere')
  assert.deepEqual(rows.map((row) => row.summaryChars), [3000, 3000])
})

// --------------------------------------------------------------------------- //
// T-L2 — les enfants se taisent                                                 //
// --------------------------------------------------------------------------- //

test('T-L2 : une compaction d ENFANT n ecrit AUCUNE ligne, meme a delegationDepth 0', () => {
  const h = harness()
  const child = childSession()
  assert.equal(isRootSession(child), false)

  h.fire(child, summaryEvent())

  assert.deepEqual(rowsOf(h.dir), [], 'la compaction d un enfant ne doit rien ecrire')
  assert.equal(h.controller.stats.skipped_child, 1)
  assert.equal(h.controller.stats.retained, 0)

  // Et la MESURE qui rend le cas non-vide : la meme charge utile, sur une racine,
  // ecrit bel et bien une ligne.
  h.fire(rootSession('session-racine-temoin'), summaryEvent({ compactionId: 'racine-temoin' }))
  assert.equal(rowsOf(h.dir).length, 1, 'le temoin de racine doit ecrire : sinon le cas ne prouve rien')
})

// --------------------------------------------------------------------------- //
// T-L3 — la dedup par compactionId                                              //
// --------------------------------------------------------------------------- //

test('T-L3 : deux evenements de meme compactionId (le fork) produisent UNE ligne', () => {
  const h = harness()
  const event = summaryEvent()
  h.fire(rootSession('session-pere'), event)
  // Le fork rejoue le MEME id : dedup par 'compactionId', jamais par session.
  h.fire(rootSession('session-fork'), summaryEvent())
  h.fire(rootSession('session-fork'), summaryEvent())

  const rows = rowsOf(h.dir)
  assert.equal(rows.length, 1, 'un id deja vu ne doit pas etre journalise deux fois')
  assert.equal(rows[0].session, 'session-pere', 'la ligne est la PREMIERE observation')
  assert.equal(h.controller.stats.skipped_duplicate, 2)
})

test('T-L3b : un second montage sur le meme journal se re-amorce et n ecrit pas l id deja present', () => {
  const dir = home()
  const first = harness({ home: dir })
  first.fire(rootSession('session-pere'), summaryEvent())
  assert.equal(rowsOf(dir).length, 1)

  // Le SECOND montage : l'ensemble vit en memoire, donc il est relu du journal.
  const second = harness({ home: dir })
  assert.equal(second.controller.stats.reseeded, 1, 'l id du journal doit etre re-amorce')
  assert.deepEqual([...second.controller.seen], ['8073f4c0-dbc9-4c4b-b86e-26a6a9175037'])

  second.fire(rootSession('session-pere'), summaryEvent())
  assert.equal(rowsOf(dir).length, 1, 'le re-amorcage doit empecher la reecriture')
  assert.equal(second.controller.stats.skipped_duplicate, 1)
})

// --------------------------------------------------------------------------- //
// T-L4 — le plancher de matiere                                                 //
// --------------------------------------------------------------------------- //

test('T-L4 : sous le plancher, aucune ligne — et la frontiere exacte passe', () => {
  const h = harness()
  h.fire(rootSession('session-courte'), summaryEvent({ compactionId: 'courte', summary: [{ type: 'text', text: 'x'.repeat(DEFAULT_SUMMARY_FLOOR_CHARS - 1) }] }))
  assert.deepEqual(rowsOf(h.dir), [], '1999 caracteres sont sous le plancher de 2000')
  assert.equal(h.controller.stats.skipped_below_floor, 1)

  h.fire(rootSession('session-pile'), summaryEvent({ compactionId: 'pile', summary: [{ type: 'text', text: 'x'.repeat(DEFAULT_SUMMARY_FLOOR_CHARS) }] }))
  const rows = rowsOf(h.dir)
  assert.equal(rows.length, 1, '« au moins 2000 » inclut 2000')
  assert.equal(rows[0].summaryChars, DEFAULT_SUMMARY_FLOOR_CHARS)
})

// --------------------------------------------------------------------------- //
// T-L5 — l'echec d'ecriture ne propage pas                                      //
// --------------------------------------------------------------------------- //

test('T-L5 : un chemin de journal inecrivable ne propage RIEN hors du listener', () => {
  const dir = home()
  mkdirSync(join(dir, 'plugin-data'), { recursive: true })
  // Le repertoire du journal est un FICHIER : 'mkdirSync' leve (ENOTDIR/EEXIST).
  writeFileSync(join(dir, 'plugin-data', 'dsh-boost-lessons'), 'not a directory')

  const h = harness({ home: dir })
  assert.doesNotThrow(() => {
    h.fire(rootSession('session-disque-plein'), summaryEvent())
  }, 'l echec d ecriture ne doit JAMAIS remonter dans Session.append')

  assert.deepEqual(rowsOf(dir), [], 'aucune ligne n a pu etre ecrite')
  assert.equal(h.controller.stats.write_failed, 1, 'l echec doit etre COMPTE, pas avale')
  assert.equal(h.controller.stats.fallback_failed, 1, 'le repli a echoue lui aussi — et il ne leve pas non plus')
  assert.equal(h.controller.stats.retained, 0)
  // La trace de montage a echoue LA PREMIERE (meme repertoire impossible), sans
  // lever elle non plus : le montage a tenu, le listener est en place.
  assert.equal(h.controller.stats.mount_failed, 1)
  assert.equal(h.controller.stats.contained, 3, 'les trois erreurs sont enregistrees')
  assert.deepEqual(h.controller.errors.map((entry) => entry.step), ['mount', 'write', 'fallback'])
  for (const entry of h.controller.errors) assert.ok(entry.error.length > 0, 'une erreur sans message ne prouve rien')
  // L'identite est retenue AVANT l'ecriture : un rejeu ne rejoue pas l'echec.
  assert.ok(h.controller.seen.has('8073f4c0-dbc9-4c4b-b86e-26a6a9175037'))
  assert.doesNotThrow(() => h.fire(rootSession('session-disque-plein'), summaryEvent()))
  assert.equal(h.controller.stats.skipped_duplicate, 1)
})

test('T-L5c : l echec tombe sur l ECRITURE elle-meme (le journal est un repertoire)', () => {
  const dir = home()
  // Ici le 'mkdir' passe : c'est 'appendFileSync' qui echoue (EISDIR). Les deux
  // moities du chemin d'ecriture sont donc exercees, pas seulement la premiere.
  mkdirSync(join(dir, 'plugin-data', 'dsh-boost-lessons', 'compactions.jsonl'), { recursive: true })
  const h = harness({ home: dir })
  assert.doesNotThrow(() => h.fire(rootSession('session-eisdir'), summaryEvent()))
  assert.equal(h.controller.stats.write_failed, 1)
  assert.equal(h.controller.stats.contained, 1)
  assert.equal(h.controller.errors[0].step, 'write')
  assert.match(h.controller.errors[0].error, /EISDIR|EPERM|EACCES|illegal operation/)
  // Et la ligne n'est PAS perdue : le repli best-effort l'a sauvee telle quelle.
  assert.equal(h.controller.stats.fallback_failed, 0, 'le repli a fonctionne : rien a signaler de plus')
  const rescued = readFileSync(journalOf(dir) + '.failed.jsonl', 'utf8').split('\n').filter((line) => line !== '')
  assert.equal(rescued.length, 1)
  assert.equal(JSON.parse(rescued[0]).compactionId, '8073f4c0-dbc9-4c4b-b86e-26a6a9175037')
  assert.equal(h.controller.stats.retained, 0, 'la ligne n a PAS ete comptee comme retenue dans le journal principal')
})

test('T-L5b : sur une VRAIE Session.append, l echec d ecriture ne remonte pas et ne fait pas jeter le listener', async () => {
  const modules = harnessModules()
  const entries = {
    cordis: join(modules, '@deepseek-ai', 'cordis', 'lib', 'index.js'),
    sessions: join(modules, '@deepseek-ai', 'dsh-session', 'lib', 'index.js'),
  }
  for (const [label, file] of Object.entries(entries)) {
    assert.ok(existsSync(file), 'le harnais doit etre installe pour ce cas (' + label + ') : ' + file)
  }
  const { Context } = await import(pathToFileURL(entries.cordis).href)
  const SessionStore = (await import(pathToFileURL(entries.sessions).href)).default

  const dir = home()
  mkdirSync(join(dir, 'plugin-data'), { recursive: true })
  writeFileSync(join(dir, 'plugin-data', 'dsh-boost-lessons'), 'not a directory')

  const root = new Context()
  await root.plugin(SessionStore)
  // L'exportateur qui rend l'observation POSSIBLE : le niveau par defaut d'un
  // contexte nu est 1, donc 'warn' (2) n'atteindrait pas le tampon du logger.
  const records = []
  await root.plugin({
    name: 't-l5b-logs',
    apply: (ctx) => {
      ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { records.push(message) } })
    },
  })
  // Le controleur se capture par un relais : 'plugin(...)' rend une fibre, pas
  // ce que 'apply' a rendu. Le code monte est bien celui du paquet.
  let controller
  await root.plugin({ name: 'dsh-boost-lessons', apply: (ctx, config) => { controller = apply(ctx, config) } }, { home: dir })

  const session = root.sessions.create('session-l5b', { meta: { cwd: process.cwd() } })
  const event = session.append('compaction/summary', summaryEvent().data)

  assert.equal(event.type, 'compaction/summary', 'append doit rendre l evenement, pas lever')
  assert.equal(session.snapshotEvents().length, 1, 'l evenement doit etre dans le journal de la session')
  assert.equal(controller.stats.write_failed, 1, 'l echec d ecriture doit etre compte par le plugin')
  assert.deepEqual(rowsOf(dir), [])
  // L'ABSENCE qui compte : aucun listener n'a jete. Le controle de vivacite juste
  // apres prouve que cette absence serait VISIBLE si elle avait eu lieu.
  assert.deepEqual(records.filter((record) => String(record.args?.[0]).includes('listener threw')), [],
    'le listener du plugin a jete — la session n a pas fini son append normalement')

  // CONTROLE DE VIVACITE : un listener qui jette POUR DE VRAI est vu.
  await root.plugin({
    name: 't-l5b-thrower',
    apply: (ctx) => {
      ctx.on('session/event', () => { throw new Error('controle de vivacite') })
    },
  })
  root.sessions.create('session-l5b-temoin', { meta: { cwd: process.cwd() } }).append('turn/start', { turn: 1 })
  const threw = records.filter((record) => String(record.args?.[0]).includes('listener threw'))
  assert.equal(threw.length, 1, 'le controle de vivacite n a rien vu : l absence precedente ne prouverait rien')
  assert.match(String(threw[0].args[0]), /controle de vivacite/)
})

// --------------------------------------------------------------------------- //
// T-L6 — les charges utiles imprevues                                           //
// --------------------------------------------------------------------------- //

test('T-L6 : une charge utile imprevue ne fait pas lever le listener', () => {
  const h = harness()
  const root = rootSession('session-imprevue')
  const cases = [
    ['evenement nul', () => h.fire(root, null)],
    ['type absent', () => h.fire(root, {})],
    ['data absent', () => h.fire(root, { type: 'compaction/summary' })],
    ['data undefined', () => h.fire(root, { type: 'compaction/summary', data: undefined })],
    ['data vide', () => h.fire(root, { type: 'compaction/summary', data: {} })],
    ['summary absent mais id present', () => h.fire(root, summaryEvent({ summary: undefined }))],
    ['summary d un type inconnu', () => h.fire(root, summaryEvent({ summary: 42 }))],
    ['id absent, matiere suffisante', () => h.fire(root, summaryEvent({ compactionId: undefined }))],
    ['id vide', () => h.fire(root, summaryEvent({ compactionId: '' }))],
    ['id non-chaine', () => h.fire(root, summaryEvent({ compactionId: 1234 }))],
    ['shadowedSeqs hostile', () => h.fire(root, summaryEvent({ compactionId: 'seqs-hostiles', shadowedSeqs: [1, 'deux', -3, 4.5, null, 7] }))],
    ['session absente', () => h.fire(undefined, summaryEvent({ compactionId: 'sans-session' }))],
    ['session sans header', () => h.fire({ id: 'session-sans-header' }, summaryEvent({ compactionId: 'sans-header' }))],
    ['header nul', () => h.fire({ id: 'session-header-nul', header: null }, summaryEvent({ compactionId: 'header-nul' }))],
    ['header getter qui jette', () => h.fire({ id: 'session-header-hostile', get header() { throw new Error('header hostile') } }, summaryEvent({ compactionId: 'header-hostile' }))],
    ['summary getter qui jette', () => h.fire(root, { type: 'compaction/summary', data: { get summary() { throw new Error('summary hostile') }, compactionId: 'summary-hostile' } })],
    ['compactionId getter qui jette', () => h.fire(root, { type: 'compaction/summary', data: { summary: [{ type: 'text', text: 'x'.repeat(4000) }], get compactionId() { throw new Error('id hostile') } } })],
  ]
  for (const [label, run] of cases) {
    assert.doesNotThrow(run, 'le listener a leve sur : ' + label)
  }

  // Rien de tout cela n'est une ligne, et AUCUN echec d'ecriture n'a eu lieu.
  const rows = rowsOf(h.dir)
  assert.deepEqual(rows.map((row) => row.compactionId), ['seqs-hostiles'])
  assert.equal(h.controller.stats.write_failed, 0)
  assert.equal(h.controller.stats.skipped_no_payload, 2, 'data absent et data undefined')
  assert.equal(h.controller.stats.skipped_below_floor, 3, 'data vide, summary absent, summary non-texte')
  assert.equal(h.controller.stats.skipped_no_id, 3, 'id absent, vide, non-chaine')
  assert.equal(h.controller.stats.skipped_no_header, 3, 'session absente, sans header, header nul')
  assert.equal(h.controller.stats.contained, 3, 'les trois getters hostiles sont contenus et comptes')
  assert.deepEqual(rows[0].shadowedSeqs, [1, 7], 'les seqs non entiers ou negatifs sont ecartes, jamais ecrits')
  assert.deepEqual([...new Set(h.controller.errors.map((entry) => entry.step))], ['note'])
})

// --------------------------------------------------------------------------- //
// T-L7 — la rotation, et le re-amorcage depuis les DEUX generations            //
// --------------------------------------------------------------------------- //

test('T-L7 : la rotation garde une generation, et un re-montage relit les DEUX', () => {
  const dir = home()
  const previous = process.env.DSH_BOOST_LESSONS_LOG_MAX_BYTES
  assert.equal(lessonsMaxBytes(), 1024 * 1024, 'sans couture, le plafond est celui du module')
  // La couture d'environnement : le meme chemin de code, une frontiere atteignable.
  process.env.DSH_BOOST_LESSONS_LOG_MAX_BYTES = '600'
  try {
    assert.equal(lessonsMaxBytes(), 600)
    const h = harness({ home: dir })
    for (const id of ['a', 'b', 'c']) {
      h.fire(rootSession('session-' + id), summaryEvent({ compactionId: id }))
    }
    assert.equal(h.controller.stats.retained, 3)
    const active = rowsOf(dir)
    const generation = existsSync(journalOf(dir) + '.1')
      ? readFileSync(journalOf(dir) + '.1', 'utf8').split('\n').filter((line) => line !== '').length
      : 0
    assert.ok(generation >= 1, 'la rotation doit avoir garde une generation')
    assert.equal(generation + active.length, 3, 'AUCUNE ligne ne doit avoir disparu')

    // Le re-montage relit les DEUX : sinon les ids de la generation renommee
    // seraient reecrits — le defaut qui a coute une passe au canal.
    const second = harness({ home: dir })
    assert.equal(second.controller.stats.reseeded, 3)
    for (const id of ['a', 'b', 'c']) second.fire(rootSession('session-' + id), summaryEvent({ compactionId: id }))
    assert.equal(second.controller.stats.skipped_duplicate, 3)
    assert.equal(rowsOf(dir).length + readFileSync(journalOf(dir) + '.1', 'utf8').split('\n').filter((line) => line !== '').length, 3)
    assert.equal(readSeen(journalPath(dir)).size, 3)
  } finally {
    if (previous === undefined) delete process.env.DSH_BOOST_LESSONS_LOG_MAX_BYTES
    else process.env.DSH_BOOST_LESSONS_LOG_MAX_BYTES = previous
  }
})

// --------------------------------------------------------------------------- //
// T-L8 — le plancher est configurable                                           //
// --------------------------------------------------------------------------- //

test('T-L8 : le plancher est configurable, et une valeur invalide retombe sur le defaut', () => {
  const event = summaryEvent({ summary: [{ type: 'text', text: 'M'.repeat(3000) }] })

  const strict = harness({ config: { summaryFloorChars: 5000 } })
  strict.fire(rootSession('session-stricte'), event)
  assert.deepEqual(rowsOf(strict.dir), [], '3000 caracteres sont sous un plancher de 5000')
  assert.equal(strict.controller.floor, 5000)

  const permissive = harness({ config: { summaryFloorChars: 0 } })
  permissive.fire(rootSession('session-permissive'), summaryEvent({ compactionId: 'permissive', summary: [{ type: 'text', text: 'M' }] }))
  assert.equal(rowsOf(permissive.dir).length, 1, 'un plancher de 0 retient tout')

  const broken = harness({ config: { summaryFloorChars: 'beaucoup' } })
  assert.equal(broken.controller.floor, DEFAULT_SUMMARY_FLOOR_CHARS, 'une valeur invalide retombe sur le defaut')
  assert.equal(broken.controller.stats.floor_invalid, 1)
  assert.equal(broken.controller.errors[0].step, 'floor-invalid')
  broken.fire(rootSession('session-invalide'), event)
  assert.equal(rowsOf(broken.dir).length, 1, 'le montage tient malgre la faute de frappe')

  // Le filtre PUR, sans disque : les quatre portes dans l'ordre.
  assert.deepEqual(planCompaction(rootSession(), { type: 'turn/end' }), { action: 'ignore', why: 'not-a-summary' })
  assert.equal(planCompaction(childSession(), summaryEvent()).counter, 'skipped_child')
  assert.equal(planCompaction(rootSession(), summaryEvent({ summary: 'court' })).counter, 'skipped_below_floor')
  assert.equal(planCompaction(rootSession(), summaryEvent({ compactionId: undefined })).counter, 'skipped_no_id')
  assert.equal(planCompaction(rootSession(), summaryEvent()).action, 'write')
})

// --------------------------------------------------------------------------- //
// T-T1 .. T-T5 — le filtre « cette session n a pas de parent VIVANT »           //
// --------------------------------------------------------------------------- //
//
// Le filtre d'hier etait 'session.header.parentSession === undefined' : RACINES
// SEULEMENT. Il fermait la recursion, mais il IGNORAIT la session CONTINUEE — un
// fork seede dont le parent est mort — et c'est exactement la mesure que
// l'utilisateur attend : sa propre frequence. Le filtre demande desormais au
// registre VIVANT ; sans registre il s'abstient et journalise son repli.

test('T-T1 : racine (aucun parent) -> RETENUE, registre vivant ou pas', () => {
  // Avec un registre : la racine n'a pas de parent a y chercher, donc elle passe.
  const avec = harness({ agents: liveAgents('session-autre') })
  avec.fire(rootSession('session-racine-avec'), summaryEvent({ compactionId: 'racine-avec' }))
  assert.deepEqual(rowsOf(avec.dir).map((row) => row.compactionId), ['racine-avec'],
    'une racine doit etre RETENUE meme quand un registre vivant est disponible')
  assert.equal(avec.controller.stats.retained, 1)

  // Sans registre : comportement d'hier, inchange.
  const sans = harness()
  sans.fire(rootSession('session-racine-sans'), summaryEvent({ compactionId: 'racine-sans' }))
  assert.deepEqual(rowsOf(sans.dir).map((row) => row.compactionId), ['racine-sans'],
    'une racine doit etre RETENUE sans registre aussi')
  assert.equal(sans.controller.stats.retained, 1)
})

test('T-T2 : parent VIVANT -> ECARTEE (la recursion, non-regression)', () => {
  // Le parent EST dans le registre : c'est un enfant, sa compaction se tait.
  const h = harness({ agents: liveAgents('session-root') })
  h.fire(childSession(), summaryEvent({ compactionId: 'enfant-parent-vivant' }))

  assert.deepEqual(rowsOf(h.dir), [], 'un enfant dont le parent est VIVANT ne doit rien ecrire')
  assert.equal(h.controller.stats.skipped_child, 1)
  assert.equal(h.controller.stats.filter_no_registry, 0, 'le registre etait la : aucun repli')

  // LE TEMOIN : la meme matiere, sur une racine, ECRIT — sinon « aucune ligne » ne
  // prouve rien.
  h.fire(rootSession('session-temoin-t2'), summaryEvent({ compactionId: 'temoin-t2' }))
  assert.equal(rowsOf(h.dir).length, 1, 'le temoin de racine doit ecrire : sinon le cas ne prouve rien')
})

test('T-T3 : parent MORT -> RETENUE (la session continuee : le cas manquant)', () => {
  // Le registre ne connait PAS 'session-morte-018354d9' : c'est la session d'avant
  // le redemarrage. La session reprise est donc la plus haute vivante de sa chaine.
  // 'session-root' est VIVANT — c'est le parent de l'enfant temoin juste apres.
  const h = harness({ agents: liveAgents('session-root') })
  h.fire(continuedSession('session-continuee', 'session-morte-018354d9'), summaryEvent({ compactionId: 'continuee-parent-mort' }))

  const rows = rowsOf(h.dir)
  assert.equal(rows.length, 1, 'une session CONTINUEE doit etre RETENUE : son parent n est plus vivant')
  assert.equal(rows[0].session, 'session-continuee')
  assert.equal(rows[0].compactionId, 'continuee-parent-mort')
  assert.equal(rows[0].reason, REASON_RETAINED)
  assert.equal(h.controller.stats.retained, 1)

  // LE TEMOIN, dans le MEME montage : l'enfant d'un parent VIVANT se tait toujours.
  h.fire(childSession('session-enfant-t3'), summaryEvent({ compactionId: 'enfant-t3' }))
  assert.equal(rowsOf(h.dir).length, 1, 'le parent VIVANT doit toujours faire taire son enfant')
  assert.equal(h.controller.stats.skipped_child, 1)

  // Le VERDICT pur, sans disque : c'est la decision, pas l'ecriture, qui est testee.
  assert.deepEqual(parentVerdict(continuedSession(), liveAgents('session-parent-vivant')),
    { verdict: 'parent-dead', parent: 'session-morte' })
  assert.equal(parentVerdict(childSession(), liveAgents('session-root')).verdict, 'parent-alive')
  assert.equal(parentVerdict(rootSession(), liveAgents('session-root')).verdict, 'no-parent')
})

test('T-T4 : sans service agents, le comportement d hier tient ET le repli est JOURNALISE', () => {
  // 'registry' reste 'undefined' au montage : la ligne est montee SANS registre.
  let registry
  const h = harness({ agents: () => registry })
  assert.equal(decisionLines(h.dir)[0].filter, FILTER_ROOTS_ONLY, 'sans registre, le montage le DIT')

  h.fire(childSession(), summaryEvent({ compactionId: 'enfant-sans-registre' }))
  assert.deepEqual(rowsOf(h.dir), [], 'sans registre on ne peut pas savoir : l enfant est ecarte, comme hier')
  assert.equal(h.controller.stats.skipped_child, 1)
  assert.equal(h.controller.stats.filter_no_registry, 1, 'le repli est COMPTE, pas avale')

  const replis = () => decisionLines(h.dir).filter((line) => line.step === FILTER_FALLBACK_STEP)
  assert.equal(replis().length, 1, 'le repli doit etre JOURNALISE — un controle muet ressemble a un controle qui passe')
  assert.equal(replis()[0].filter, FILTER_ROOTS_ONLY)
  assert.equal(replis()[0].log, journalOf(h.dir))
  assert.ok(!Number.isNaN(Date.parse(replis()[0].at)), 'at doit etre une date ISO : ' + replis()[0].at)

  // UNE ligne, pas un flot : deux decisions de repli, un seul enregistrement.
  h.fire(childSession('session-enfant-sans-registre-2'), summaryEvent({ compactionId: 'enfant-sans-registre-2' }))
  assert.equal(h.controller.stats.filter_no_registry, 2)
  assert.equal(replis().length, 1, 'le repli se journalise une fois par montage')

  // ET LE REPLI N'EST PAS UNE CONDAMNATION : le registre qui arrive APRES le
  // montage est vu, parce que la ligne relit le service a chaque evenement.
  registry = liveAgents('session-root')
  h.fire(continuedSession('session-continuee-t4', 'session-morte-t4'), summaryEvent({ compactionId: 'continuee-t4' }))
  assert.deepEqual(rowsOf(h.dir).map((row) => row.compactionId), ['continuee-t4'],
    'un registre fourni apres le montage doit etre vu : la ligne ne fige pas son repli')
  assert.equal(h.controller.stats.filter_no_registry, 2, 'plus aucun repli une fois le registre la')
})

test('T-T5 : la trace de montage fonctionne toujours, et nomme le mode de filtrage retenu', () => {
  // Sans registre : le mode retenu est le repli, et il est ECRIT.
  const sans = harness()
  const traceSans = decisionLines(sans.dir)
  assert.equal(traceSans.length, 1, 'le montage laisse UNE ligne, et une seule')
  assert.equal(traceSans[0].step, 'mounted')
  assert.equal(traceSans[0].filter, FILTER_ROOTS_ONLY, 'sans registre, la trace dit « racines seulement »')
  assert.equal(traceSans[0].floor, DEFAULT_SUMMARY_FLOOR_CHARS, 'le plancher EFFECTIF, inchange')
  assert.equal(traceSans[0].reseeded, 0)
  assert.equal(traceSans[0].log, journalOf(sans.dir))

  // Avec registre : le mode retenu est la vivacite du parent.
  const avec = harness({ agents: liveAgents('session-root') })
  const traceAvec = decisionLines(avec.dir)
  assert.equal(traceAvec.length, 1)
  assert.equal(traceAvec[0].step, 'mounted')
  assert.equal(traceAvec[0].filter, FILTER_PARENT_LIVENESS, 'avec registre, la trace nomme le mode qui filtre')
  // Ecrite AU MONTAGE : aucun evenement n'a encore ete vu.
  assert.equal(avec.controller.stats.events, 0)
  assert.equal(traceAvec[0].reseeded, 0)
})

// --------------------------------------------------------------------------- //
// T-L9 / T-L10 — la TRACE DE MONTAGE                                            //
// --------------------------------------------------------------------------- //

/** Les lignes du journal de diagnostics d'un dossier jetable. */
function decisionLines(dir) {
  const file = join(dir, 'plugin-data', 'dsh-boost-lessons', 'decisions.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

/**
 * Une configuration presente au 'dump-config' ne prouve PAS qu'une ligne est
 * montee (mesure du 2026-10-02 : une ligne 'disabled' y figurait, et un
 * remaniement n'avait pas ete charge par le processus vivant). La trace de
 * montage est le signal POSITIF : sans elle, un listener mort et un listener
 * vivant se ressemblent.
 */
test('T-L9 : au montage, une ligne mounted porte le plancher effectif et le compte reseeded', () => {
  const dir = home()
  const first = harness({ home: dir })

  const lines = decisionLines(dir)
  assert.equal(lines.length, 1, 'le montage doit laisser UNE ligne, et une seule')
  const entry = lines[0]
  assert.equal(entry.step, 'mounted')
  assert.equal(entry.floor, DEFAULT_SUMMARY_FLOOR_CHARS, 'le plancher EFFECTIF')
  assert.equal(entry.reseeded, 0, 'aucun journal au premier montage')
  assert.equal(entry.log, journalOf(dir), 'la trace nomme le journal qu elle observe')
  assert.ok(!Number.isNaN(Date.parse(entry.at)), 'at doit etre une date ISO : ' + entry.at)
  // Ecrite AU MONTAGE : aucun evenement n'a encore ete vu.
  assert.equal(first.controller.stats.events, 0)

  // Le compte est REEL, pas une constante : deux ids au journal, et le montage
  // SUIVANT le dit — c'est ce qui prouve que la re-amorce a tourne.
  first.fire(rootSession('session-trace-a'), summaryEvent({ compactionId: 'trace-a' }))
  first.fire(rootSession('session-trace-b'), summaryEvent({ compactionId: 'trace-b' }))
  const second = harness({ home: dir })
  const after = decisionLines(dir)
  assert.equal(after.length, 2, 'une ligne PAR montage')
  assert.equal(after[1].step, 'mounted')
  assert.equal(after[1].reseeded, 2)
  assert.equal(second.controller.stats.reseeded, 2)

  // Et le plancher porte est celui de la CONFIGURATION, pas le defaut du module.
  const strict = harness({ config: { summaryFloorChars: 5000 } })
  assert.equal(decisionLines(strict.dir)[0].floor, 5000)
})

test('T-L10 : un repertoire de journal impossible ne fait PAS lever le montage, et rien n est ecrit', () => {
  const dir = home()
  mkdirSync(join(dir, 'plugin-data'), { recursive: true })
  // Meme denial que T-L5 : le repertoire du plugin est un FICHIER.
  writeFileSync(join(dir, 'plugin-data', 'dsh-boost-lessons'), 'not a directory')

  let h
  assert.doesNotThrow(() => { h = harness({ home: dir }) }, 'le montage ne doit JAMAIS lever')
  assert.equal(h.listeners(), 1, 'le listener est monte quand meme : la trace n est pas une condition de montage')
  assert.equal(h.controller.stats.mount_failed, 1, 'l echec de la trace est compte, pas avale')
  assert.equal(h.controller.stats.contained, 1)
  assert.equal(h.controller.errors[0].step, 'mount')
  assert.deepEqual(decisionLines(dir), [], 'aucune trace n a pu etre ecrite')
  assert.deepEqual(rowsOf(dir), [], 'et le journal de compactions reste vide')
  // Le montage tient : la preuve, c est que le listener repond encore.
  assert.doesNotThrow(() => h.fire(rootSession('session-trace-impossible'), summaryEvent()))
  assert.equal(h.controller.stats.events, 1)
  assert.equal(h.controller.stats.write_failed, 1, 'le meme chemin impossible vaut aussi pour l ecriture')
})
