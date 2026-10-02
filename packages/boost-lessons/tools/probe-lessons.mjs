// LE PROBE DE 'dsh-boost-lessons' — mesure, pas supposee.
//
//   node packages/boost-lessons/tools/probe-lessons.mjs [harness-node-modules] [plugin-entry]
//
// Pourquoi ce probe existe. Les tests du paquet montent un contexte MINIMAL : ils
// prouvent la logique du filtre, du plancher et de la dedup, mais pas que le
// listener recoit REELLEMENT 'session/event' d'une VRAIE 'Session.append', ni que
// l'echec d'ecriture ne remonte pas dans le tour de l'agent. Ce probe monte donc :
//   - une VRAIE application cordis ('@deepseek-ai/cordis') ;
//   - le VRAI magasin de sessions ('@deepseek-ai/dsh-session', 'ctx.sessions') ;
//   - la VRAIE ligne du paquet, montee comme le profil la monte (sans tag) ;
// et il MESURE :
//   1. une compaction/summary de RACINE -> UNE ligne de journal, montree BRUTE ;
//   2. la meme sur une session ENFANT ('parentSession' + 'delegationDepth: 0', le
//      piege mesure) -> AUCUNE ligne, et le temoin de racine qui suit en ecrit
//      une : sans ce temoin, le « aucune ligne » ne prouverait rien ;
//   3. le MEME 'compactionId' rejoue -> toujours une seule ligne (le cas du fork) ;
//   4. sous le plancher -> aucune ligne ;
//   5. une charge utile imprevue, sur une vraie session -> aucune levee ;
//   6. le JOURNAL INECRIVABLE -> 'append' rend l'evenement, la session garde son
//      evenement, et l'exportateur de log ne voit AUCUN 'listener threw' — avec le
//      CONTROLE DE VIVACITE qui prouve que cet exportateur verrait un listener qui
//      jette pour de vrai.
//
// Sortie 0 seulement si les sept mesures concordent. Toute divergence est un
// PROBE-FAIL nomme : une decouverte, pas un silence.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harnessModules = process.argv[2]
  ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
const entries = {
  cordis: join(harnessModules, '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  sessions: join(harnessModules, '@deepseek-ai', 'dsh-session', 'lib', 'index.js'),
}
const pluginEntry = process.argv[3] !== undefined
  ? resolve(process.argv[3])
  : fileURLToPath(new URL('../lib/index.js', import.meta.url))

const say = (key, value) => console.log('PROBE-' + key + ': ' + value)
const failures = []
const check = (label, ok, detail = '') => {
  console.log((ok ? 'PROBE-CHECK ok   ' : 'PROBE-CHECK FAIL ') + label + (detail === '' ? '' : ' — ' + detail))
  if (!ok) failures.push(label)
}

/** La forme REELLE d'une compaction/summary, mesuree sur le corpus. */
const summaryOf = (chars) => [{ type: 'text', text: 'R'.repeat(chars) }]
const payload = (compactionId, summaryChars) => ({
  compactionId,
  summary: summaryOf(summaryChars),
  rawOutput: [{ type: 'text', text: 'O'.repeat(400) }, { type: 'text', text: 'o'.repeat(120) }],
  shadowedRange: { start: 1, end: 345 },
  shadowedSeqs: [1, 2, 3, 345],
  shadowedTokenCount: 421_120,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
})

/** Les lignes du journal, telles qu'elles sont sur le disque. */
const journalFile = (home) => join(home, 'plugin-data', 'dsh-boost-lessons', 'compactions.jsonl')
function journalLines(home) {
  const file = journalFile(home)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
}
const threw = (records) => records.filter((record) => String(record.args?.[0]).includes('listener threw'))

/** Les lignes du journal de diagnostics du paquet (montage, repli), deja parsees. */
const decisionsLines = (home) => {
  const file = join(home, 'plugin-data', 'dsh-boost-lessons', 'decisions.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

async function main() {
  for (const [label, file] of Object.entries(entries)) {
    if (!existsSync(file)) throw new Error('le module ' + label + ' n est pas installe ici : ' + file)
  }
  if (!existsSync(pluginEntry)) throw new Error('la ligne du paquet n est pas la : ' + pluginEntry)

  const scratch = mkdtempSync(join(tmpdir(), 'dsh-lessons-probe-'))
  const blocked = mkdtempSync(join(tmpdir(), 'dsh-lessons-blocked-'))
  process.env.DSH_HOME = scratch

  const { Context } = await import(pathToFileURL(entries.cordis).href)
  const SessionStore = (await import(pathToFileURL(entries.sessions).href)).default
  const plugin = await import(pathToFileURL(pluginEntry).href)

  say('journal', journalFile(scratch))
  say('plugin', pluginEntry)
  say('floor', String(plugin.DEFAULT_SUMMARY_FLOOR_CHARS))

  // ---- l'application REELLE -------------------------------------------------
  const root = new Context()
  await root.plugin(SessionStore)
  const records = []
  await root.plugin({
    name: 'probe-logs',
    apply: (ctx) => {
      // Le niveau par defaut d'un contexte nu est 1 : 'warn' (2) n'atteindrait pas
      // le tampon. Sans cet exportateur, l'absence d'alerte ne prouverait rien.
      ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { records.push(message) } })
    },
  })
  let controller
  await root.plugin({ name: plugin.name, apply: (ctx, config) => { controller = plugin.apply(ctx, config) } }, { home: scratch })
  say('mounted', 'id=' + plugin.name + ' home=' + scratch)

  // ---- 0. LA TRACE DE MONTAGE ------------------------------------------------
  // Une configuration au 'dump-config' ne prouve pas qu'une ligne est montee :
  // sans signal POSITIF, un listener mort et un listener vivant se ressemblent.
  const decisionsFile = join(scratch, 'plugin-data', plugin.name, 'decisions.jsonl')
  const traces = existsSync(decisionsFile)
    ? readFileSync(decisionsFile, 'utf8').split('\n').filter((line) => line !== '')
    : []
  check('0.un: le montage laisse une trace decisions.jsonl', traces.length === 1, 'lignes=' + traces.length)
  if (traces.length > 0) console.log('PROBE-RAW-DECISIONS: ' + traces[0])
  const trace = traces.length > 0 ? JSON.parse(traces[0]) : {}
  check('0.deux: la trace porte le plancher effectif, reseeded et le journal observe',
    trace.step === 'mounted' && trace.floor === plugin.DEFAULT_SUMMARY_FLOOR_CHARS && trace.reseeded === 0 && trace.log === journalFile(scratch),
    JSON.stringify(trace))
  // Le MODE de filtrage est ecrit au montage : sans lui, un journal vide ne dit pas
  // si la ligne filtre sur le registre vivant ou si elle est retombee sur hier.
  check('0.trois: la trace nomme le mode de filtrage retenu',
    trace.filter === plugin.FILTER_ROOTS_ONLY, 'filter=' + String(trace.filter))

  const createRoot = (id) => root.sessions.create(id, { meta: { cwd: process.cwd() } })
  const createChild = (id) => root.sessions.create(id, {
    meta: { cwd: process.cwd(), parentSession: 'session-probe-root', delegationDepth: 0, origin: 'subagent' },
  })

  // ---- 1. une compaction de RACINE -----------------------------------------
  const racine = createRoot('session-probe-root')
  say('root-header', JSON.stringify(racine.header))
  racine.append('compaction/summary', payload('8073f4c0-dbc9-4c4b-b86e-26a6a9175037', 11_786))

  const afterRoot = journalLines(scratch)
  check('1.un: une compaction de racine ecrit UNE ligne', afterRoot.length === 1, 'lignes=' + afterRoot.length)
  console.log('PROBE-RAW-JOURNAL: ' + (afterRoot[0] ?? '<aucune ligne>'))

  // ---- 2. une compaction d'ENFANT, et son temoin ----------------------------
  const enfant = createChild('session-probe-child')
  say('child-header', JSON.stringify(enfant.header))
  enfant.append('compaction/summary', payload('942b56bf-1111-2222-3333-444455556666', 9_000))
  const afterChild = journalLines(scratch)
  check('2.un: une compaction d ENFANT n ecrit RIEN', afterChild.length === 1, 'lignes=' + afterChild.length)
  // Le temoin : la meme matiere sur une racine ECRIT — sinon « rien » ne prouve rien.
  createRoot('session-probe-temoin').append('compaction/summary', payload('temoin-racine', 9_000))
  check('2.deux: le temoin de racine ecrit, lui', journalLines(scratch).length === 2, 'lignes=' + journalLines(scratch).length)
  // Sans registre, l'enfant a ete ecarte par le REPLI : il doit l'avoir DIT.
  const replis = decisionsLines(scratch).filter((line) => line.step === plugin.FILTER_FALLBACK_STEP)
  check('2.trois: sans registre, le repli est JOURNALISE une fois',
    replis.length === 1 && replis[0].filter === plugin.FILTER_ROOTS_ONLY,
    'lignes=' + replis.length + ' ' + JSON.stringify(replis[0] ?? null))

  // ---- 3. le meme compactionId (le fork) ------------------------------------
  createRoot('session-probe-fork').append('compaction/summary', payload('8073f4c0-dbc9-4c4b-b86e-26a6a9175037', 11_786))
  check('3.un: le meme compactionId ne reecrit pas', journalLines(scratch).length === 2, 'lignes=' + journalLines(scratch).length)

  // ---- 4. sous le plancher ---------------------------------------------------
  createRoot('session-probe-courte').append('compaction/summary', payload('courte-1999', plugin.DEFAULT_SUMMARY_FLOOR_CHARS - 1))
  check('4.un: sous le plancher, aucune ligne', journalLines(scratch).length === 2, 'lignes=' + journalLines(scratch).length)

  // ---- 5. une charge utile imprevue, sur une VRAIE session -------------------
  const muette = createRoot('session-probe-imprevue')
  let unexpectedThrew = null
  try {
    muette.append('compaction/summary', {})
    createRoot('session-probe-imprevue-2').append('compaction/summary', { compactionId: 'sans-matiere', summary: 'court' })
  } catch (error) {
    unexpectedThrew = String(error?.message ?? error)
  }
  check('5.un: une charge utile imprevue ne leve pas dans append', unexpectedThrew === null, String(unexpectedThrew))
  check('5.deux: et elle n ecrit aucune ligne', journalLines(scratch).length === 2, 'lignes=' + journalLines(scratch).length)

  say('stats-apres-mesures', JSON.stringify(controller.stats))

  // ---- 6. le journal INECRIVABLE --------------------------------------------
  mkdirSync(join(blocked, 'plugin-data'), { recursive: true })
  writeFileSync(join(blocked, 'plugin-data', 'dsh-boost-lessons'), 'not a directory')
  const root2 = new Context()
  await root2.plugin(SessionStore)
  const records2 = []
  await root2.plugin({
    name: 'probe-logs-2',
    apply: (ctx) => {
      ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { records2.push(message) } })
    },
  })
  let blockedController
  await root2.plugin({ name: plugin.name, apply: (ctx, config) => { blockedController = plugin.apply(ctx, config) } }, { home: blocked })
  const session = root2.sessions.create('session-probe-disque', { meta: { cwd: process.cwd() } })
  let appendError = null
  let appended = null
  try {
    appended = session.append('compaction/summary', payload('disque-plein', 8_000))
  } catch (error) {
    appendError = String(error?.message ?? error)
  }
  check('6.un: append se termine normalement malgre un journal inecrivable', appendError === null, String(appendError))
  check('6.deux: l evenement est bien entre dans le journal de la session', appended?.type === 'compaction/summary', 'retour=' + String(appended?.type))
  check('6.trois: l echec d ecriture est COMPTE par le plugin', blockedController.stats.write_failed === 1, 'write_failed=' + blockedController.stats.write_failed)
  check('6.quatre: le repli best-effort a echoue lui aussi, sans lever', blockedController.stats.fallback_failed === 1, 'fallback_failed=' + blockedController.stats.fallback_failed)
  check('6.cinq: aucun listener n a jete (exportateur de log)', threw(records2).length === 0, 'alertes=' + threw(records2).length)
  check('6.six: le montage a tenu malgre une trace impossible, et il est compte', blockedController.stats.mount_failed === 1, 'mount_failed=' + blockedController.stats.mount_failed)
  say('stats-journal-inecrivable', JSON.stringify(blockedController.stats))
  say('erreurs-en-memoire', JSON.stringify(blockedController.errors))

  // ---- 6b. le MEME cas, mais l'echec tombe sur l'ECRITURE elle-meme ---------
  // 'plugin-data/dsh-boost-lessons/compactions.jsonl' est un REPERTOIRE : le
  // 'mkdir' passe, c'est 'appendFileSync' qui echoue. Les deux moities du chemin
  // d'ecriture sont donc exercees, pas seulement la premiere.
  const blocked2 = mkdtempSync(join(tmpdir(), 'dsh-lessons-blocked2-'))
  mkdirSync(join(blocked2, 'plugin-data', 'dsh-boost-lessons', 'compactions.jsonl'), { recursive: true })
  const root3 = new Context()
  await root3.plugin(SessionStore)
  const records3 = []
  await root3.plugin({
    name: 'probe-logs-3',
    apply: (ctx) => {
      ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { records3.push(message) } })
    },
  })
  let writeController
  await root3.plugin({ name: plugin.name, apply: (ctx, config) => { writeController = plugin.apply(ctx, config) } }, { home: blocked2 })
  const session3 = root3.sessions.create('session-probe-ecriture', { meta: { cwd: process.cwd() } })
  let writeError = null
  try {
    session3.append('compaction/summary', payload('ecriture-refusee', 8_000))
  } catch (error) {
    writeError = String(error?.message ?? error)
  }
  check('6b.un: append se termine normalement quand ECRIRE echoue', writeError === null, String(writeError))
  check('6b.deux: l echec est compte, et aucun listener n a jete', writeController.stats.write_failed === 1 && threw(records3).length === 0,
    'write_failed=' + writeController.stats.write_failed + ' alertes=' + threw(records3).length)
  say('erreurs-ecriture-refusee', JSON.stringify(writeController.errors))

  // ---- 6c. le re-amorcage sur un journal REEL -------------------------------
  let second
  await root.plugin({ name: plugin.name + '-second', apply: (ctx, config) => { second = plugin.apply(ctx, config) } }, { home: scratch })
  check('6c.un: un second montage se re-amorce depuis le journal', second.stats.reseeded === 2, 'reseeded=' + second.stats.reseeded)

  // ---- 7. LE CONTROLE DE VIVACITE -------------------------------------------
  await root2.plugin({
    name: 'probe-thrower',
    apply: (ctx) => {
      ctx.on('session/event', () => { throw new Error('controle de vivacite') })
    },
  })
  root2.sessions.create('session-probe-thrower', { meta: { cwd: process.cwd() } }).append('turn/start', { turn: 1 })
  const seen = threw(records2)
  check('7.un: le controle de vivacite est VU par le meme exportateur', seen.length === 1, 'alertes=' + seen.length)
  if (seen.length > 0) console.log('PROBE-RAW-LOGGER: ' + String(seen[0].args?.[0]))

  // ---- 8. LA SESSION CONTINUEE — le cas qui a tout casse ---------------------
  // Application et journal NEUFS, et le registre VIVANT fourni AVANT le montage :
  // sur 'root', le second montage de 6c partage le meme journal et reecrirait la
  // MEME ligne (la dedup est par montage, pas par fichier), donc un ecart de
  // comptage pris la-bas ne prouverait rien.
  //
  // 'session-probe-root' est VIVANT ; 'session-018354d9' est MORT — la session
  // d'avant le redemarrage, dont descend la session reprise.
  //
  // La session reprise passe par la VRAIE porte du magasin, elle n'est pas ecrite a
  // la main : le magasin REFUSE 'isSeeded' sans germe explicite (mesure : « seeded
  // session requires an explicit constructor seed »), donc elle porte un germe
  // contigu ('turn/start', seq 0) et son compte d'heritage — et son en-tete dit
  // alors 'isSeeded: true', 'delegationDepth: 0' et le parent MORT.
  const vivant = mkdtempSync(join(tmpdir(), 'dsh-lessons-vivant-'))
  const root4 = new Context()
  await root4.plugin(SessionStore)
  root4.provide('agents', {
    get: (id) => (id === 'session-probe-root' ? { session: { id } } : undefined),
    list: () => ['session-probe-root'],
  })
  let controller4
  await root4.plugin({ name: plugin.name, apply: (ctx, config) => { controller4 = plugin.apply(ctx, config) } }, { home: vivant })
  const traceVivante = decisionsLines(vivant)[0] ?? {}
  check('8.un: registre vivant des le montage -> la trace nomme « parent-liveness »',
    traceVivante.filter === plugin.FILTER_PARENT_LIVENESS, 'filter=' + String(traceVivante.filter))

  const continuee = root4.sessions.create('session-probe-continuee', {
    seed: [{ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } }],
    inheritedEventCount: 1,
    meta: { cwd: process.cwd(), isSeeded: true, parentSession: 'session-018354d9-73b1-42af-97c7-f732a2dcb3b5', delegationDepth: 0 },
  })
  say('continuee-header', JSON.stringify(continuee.header))
  const before8 = journalLines(vivant).length
  root4.sessions.create('session-probe-enfant-vivant', {
    meta: { cwd: process.cwd(), parentSession: 'session-probe-root', delegationDepth: 0, origin: 'subagent' },
  }).append('compaction/summary', payload('enfant-parent-vivant', 9_000))
  check('8.deux: un enfant dont le parent est VIVANT n ecrit RIEN',
    journalLines(vivant).length === before8, 'lignes=' + journalLines(vivant).length)

  continuee.append('compaction/summary', payload('continuee-parent-mort', 9_000))
  const after8 = journalLines(vivant)
  check('8.trois: une session CONTINUEE (parent MORT) ECRIT, elle',
    after8.length === before8 + 1, 'lignes=' + after8.length + ' avant=' + before8)
  check('8.quatre: la ligne retenue est bien celle de la session continuee',
    String(after8[after8.length - 1] ?? '').includes('session-probe-continuee'),
    String(after8[after8.length - 1] ?? '<aucune ligne>'))
  say('stats-continuee', JSON.stringify(controller4.stats))
  console.log('PROBE-RAW-JOURNAL-CONTINUEE: ' + (after8[after8.length - 1] ?? '<aucune ligne>'))

  // ---- la preuve brute, a la fin --------------------------------------------
  console.log('PROBE-RAW-JOURNAL-FINAL:')
  const final = journalLines(scratch)
  for (const line of final) console.log(line)
  say('lignes', String(final.length))
  say('stats-final', JSON.stringify(controller.stats))
  say('erreurs-journal-principal', JSON.stringify(controller.errors))

  if (failures.length > 0) {
    console.log('PROBE-FAIL — ' + failures.length + ' mesure(s) en desaccord : ' + failures.join(' | '))
    process.exitCode = 1
    return
  }
  console.log('PROBE-PASS — les mesures concordent : une racine ecrit, un enfant non, le fork ne double pas,')
  console.log('             le plancher tient, l imprevu ne leve pas, le journal inecrivable ne propage RIEN,')
  console.log('             le controle de vivacite prouve que l absence d alerte veut dire quelque chose,')
  console.log('             et une session CONTINUEE (parent MORT) est RETENUE quand son parent VIVANT fait taire l enfant.')
}

await main()
