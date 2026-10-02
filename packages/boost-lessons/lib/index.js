/**
 * dsh-boost-lessons — l'etape 1 des « lecons a la compaction » : JOURNALISER, rien de plus.
 *
 * Specification : docs/LECONS.md (§2 les coutures mesurees, §3 la forme retenue,
 * §8 « 1. le listener et le filtre, qui JOURNALISE seulement (aucun modele, aucune
 * depense) »). Ce paquet est la HUITIEME ligne de l'agregateur.
 *
 * Ce qu'il fait, exactement :
 *   - il ecoute 'session/event' SANS TAG. Un listener non tague recoit les
 *     evenements de TOUTES les sessions, racines ET enfants
 *     ('dsh-scope/lib/index.js:329-335' : `if (tag === void 0) return true`) ;
 *   - il ne retient que 'compaction/summary' — l'instant ou LE RESUME EST DANS
 *     L'EVENEMENT et ou la surface n'est PAS encore remplacee (ordre mesure :
 *     start 1818, summary 1820, replace 1821, end 1822) ;
 *   - il ne retient que les RACINES : 'session.header.parentSession === undefined'.
 *     Le marqueur de parente est 'parentSession', PAS la profondeur — une session
 *     mesuree porte 'parentSession' AVEC 'delegationDepth: 0'. C'est ce filtre qui
 *     ferme la recursion (un enfant de profondeur 1 a compacte seul, mesure) ;
 *   - il ne retient qu'au-dessus d'un PLANCHER de matiere configurable
 *     ('summaryFloorChars', 2000 caracteres par defaut, voir la constante) ;
 *   - il DEDUPLIQUE par 'compactionId', jamais par session : un enfant forke
 *     porte les MEMES ids que son pere (le seed ne republie pas) ;
 *   - il ecrit UNE ligne JSON par compaction retenue dans
 *     '$DSH_HOME/plugin-data/dsh-boost-lessons/compactions.jsonl', append-only,
 *     avec rotation d'une generation comme le journal du canal
 *     ('packages/boost-channel/lib/index.js:601-620' et ':728-747') ;
 *   - il laisse une TRACE DE MONTAGE dans 'decisions.jsonl' du meme repertoire
 *     ('{ at, step: "mounted", floor, reseeded, log }'), ecrite AU MONTAGE et
 *     jamais a la premiere compaction : une configuration au 'dump-config' ne
 *     prouve pas qu'une ligne est montee, et un controle qui ne se declenche pas
 *     ressemble a un controle qui passe.
 *
 * Ce qu'il ne fait PAS, et c'est la mission : aucun appel de modele, aucun enfant,
 * aucune depense. L'extracteur est l'etape 3 de la spec, pas celle-ci. Ajouter un
 * outil ici serait sortir du perimetre : ce paquet n'expose AUCUNE surface d'outil.
 *
 * L'EXIGENCE PREMIERE, et elle n'est pas dans la spec : l'invocation du listener
 * est SYNCHRONE. 'Session.append' resout puis invoque les listeners a la main,
 * sans 'await' ('dsh-session/lib/index.js:1466-1473'), et l'enveloppe du harnais
 * qui entoure chaque listener peut elle-meme lever ('ctx.logger.warn' sur un
 * contexte sans logger). AUCUN chemin de ce module ne peut donc lever : tout est
 * enveloppe, une erreur d'ecriture est COMPTEE et deposee dans un repli
 * best-effort qui ne leve pas lui non plus, et le pire cas est un silence. Un
 * journal qui casse la session qu'il observe est pire que pas de journal.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Identite de la ligne : c'est aussi le nom du repertoire sous 'plugin-data'. */
export const name = 'dsh-boost-lessons'

/**
 * PLANCHER DE MATIERE par defaut, en CARACTERES de resume : 2000.
 *
 * C'est une VALEUR DE DEPART, pas une calibration. La spec le dit explicitement
 * (docs/LECONS.md §7 : « LE PLANCHER DE MATIERE : a calibrer »), et le corpus
 * mesure ne la tranche pas : les resumes du corpus font en moyenne 12 896
 * caracteres (max 22 250), donc 2000 laisse passer la quasi-totalite des
 * compactions de racine reelles — c'est voulu pour la PREMIERE mesure (« a quelle
 * frequence cela se declencherait-il ? »). Une fois ce chiffre connu, le plancher
 * se regle par configuration sans toucher au code.
 */
export const DEFAULT_SUMMARY_FLOOR_CHARS = 2000

/**
 * LA RAISON portee par chaque ligne retenue. Un seul token, stable : un
 * consommateur peut compter les lignes par raison sans parser une phrase.
 */
export const REASON_RETAINED = 'root-summary-above-floor'

/** Plafond du journal avant rotation d'une generation. */
export const JOURNAL_MAX_BYTES = 1024 * 1024

/** Nombre de messages d'erreur gardes EN MEMOIRE (le disque peut refuser). */
export const ERROR_RING = 20

/**
 * Plafond effectif du journal, en octets.
 *
 * 1 Mio par defaut ; la couture 'DSH_BOOST_LESSONS_LOG_MAX_BYTES' permet
 * d'exercer la frontiere en kilo-octets dans un test, sur EXACTEMENT le meme
 * chemin de code qu'en production — meme motif que 'channelMaxBytes()'
 * ('packages/boost-channel/lib/index.js:163-166').
 */
export function lessonsMaxBytes() {
  const override = Number.parseInt(process.env.DSH_BOOST_LESSONS_LOG_MAX_BYTES ?? '', 10)
  return Number.isInteger(override) && override > 0 ? override : JOURNAL_MAX_BYTES
}

/** Racine du harnais, relue a chaque appel (un test peut la rediriger). */
export function dshHome() {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
}

/** Repertoire du journal du paquet. */
export function storeDir(home = dshHome()) {
  return join(home, 'plugin-data', name)
}

/** Le journal : une ligne JSON par compaction de RACINE retenue. */
export function journalPath(home = dshHome()) {
  return join(storeDir(home), 'compactions.jsonl')
}

/** Repli best-effort : la meme ligne quand le journal principal refuse l'ecriture. */
export function failureJournalPath(home = dshHome()) {
  return journalPath(home) + '.failed.jsonl'
}

/**
 * Le journal de DIAGNOSTICS de la ligne — meme repertoire que 'compactions.jsonl'.
 *
 * Il ne porte qu'une chose : la TRACE DE MONTAGE. Une configuration au dump ne
 * prouve pas qu'une ligne est montee — mesure du 2026-10-02 : une ligne 'disabled'
 * figurait au dump, et un remaniement n'avait pas ete charge par le processus
 * vivant. Un controle qui ne se declenche pas ressemble a un controle qui passe :
 * il faut un signal POSITIF, ecrit AU MONTAGE et pas a la premiere compaction.
 */
export function decisionsPath(home = dshHome()) {
  return join(storeDir(home), 'decisions.jsonl')
}

/** Un id rendu sur : il ne porte que des caracteres surs, et il est borne. */
export function safeKey(id) {
  const text = String(id).replace(/[^A-Za-z0-9._-]/g, '_')
  return Array.from(text).slice(0, 120).join('')
}

/**
 * Le TEXTE d'une charge utile de contenu : une chaine, ou la concatenation des
 * blocs texte d'un 'ContentBlock[]'.
 *
 * La forme REELLE est un TABLEAU, pas une chaine : mesure du 2026-10-02 sur trois
 * 'compaction/summary' du corpus, 'data.summary' est un tableau d'UN bloc
 * '{ type: "text", text }' et 'data.rawOutput' un tableau de DEUX. Un comptage
 * naif de 'summary.length' rendrait donc '1' ou '2' — soit un plancher de 2000
 * qui ne passe jamais, ou qui passe toujours. Les deux formes sont acceptees.
 */
export function textOf(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  let text = ''
  for (const block of value) {
    if (typeof block === 'string') {
      text += block
      continue
    }
    if (block !== null && typeof block === 'object' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * Le nombre de CARACTERES d'une charge utile de contenu.
 *
 * 'Array.from' compte les POINTS DE CODE, jamais les unites UTF-16 : couper une
 * paire de substituts tue une session (mesure : 3 journaux sur 182), et compter
 * doit suivre la meme regle que couper.
 */
export function charsOf(value) {
  return Array.from(textOf(value)).length
}

/**
 * La session est-elle une RACINE ?
 *
 * Le seul marqueur est 'session.header.parentSession === undefined' — PAS la
 * profondeur : une session mesuree porte 'parentSession' AVEC 'delegationDepth: 0',
 * donc tester la profondeur prendrait un enfant pour une racine.
 *
 * Un 'header' absent ou non-objet rend FALSE : on ne peut pas PROUVER la parente,
 * et « un controle qui devine est pire qu'un controle qui s'abstient ». La session
 * est alors comptee 'skipped_no_header'.
 */
export function isRootSession(session) {
  const header = session?.header
  if (header === null || typeof header !== 'object') return false
  return header.parentSession === undefined
}

/**
 * Le plancher effectif, resolu depuis la configuration de la ligne.
 *
 * Une valeur non numerique, negative ou '-0' est JOURNALISEE (dans le releve
 * d'erreurs en memoire) et remplacee par le defaut : une ligne qui refuse de se
 * monter sur une faute de frappe dans un seuil coute plus qu'elle ne rapporte.
 * '0' est une valeur legitime (« tout retenir »).
 */
export function resolveFloor(value) {
  if (value === undefined) return { floor: DEFAULT_SUMMARY_FLOOR_CHARS, invalid: false }
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric) || numeric < 0 || Object.is(numeric, -0)) {
    return { floor: DEFAULT_SUMMARY_FLOOR_CHARS, invalid: true, value: Object.is(value, -0) ? '-0' : String(value) }
  }
  return { floor: Math.floor(numeric), invalid: false }
}

/**
 * LE FILTRE, en une fonction PURE — donc testable sans disque ni session.
 *
 * Quatre portes, dans cet ordre, et chacune rend un motif distinct :
 *   1. le type : 'compaction/summary' seulement ('ignore' pour tout le reste) ;
 *   2. la RACINE : 'parentSession' absent du header ;
 *   3. le PLANCHER : assez de matiere dans 'data.summary' ;
 *   4. l'IDENTITE : un 'compactionId' utilisable (la dedup en depend).
 *
 * @param session - la session porteuse, telle que 'session/event' la transmet.
 * @param event - l'evenement, tel que 'session/event' le transmet.
 * @param floor - le plancher de matiere, en caracteres.
 * @returns '{ action: "ignore" }', '{ action: "skip", counter }' ou
 *   '{ action: "write", record, summaryChars }'.
 */
export function planCompaction(session, event, floor = DEFAULT_SUMMARY_FLOOR_CHARS) {
  if (event === null || typeof event !== 'object') return { action: 'ignore', why: 'no-event' }
  if (event.type !== 'compaction/summary') return { action: 'ignore', why: 'not-a-summary' }
  const header = session?.header
  if (header === null || typeof header !== 'object') return { action: 'skip', counter: 'skipped_no_header' }
  if (header.parentSession !== undefined) return { action: 'skip', counter: 'skipped_child' }
  const data = event.data
  if (data === null || typeof data !== 'object') return { action: 'skip', counter: 'skipped_no_payload' }
  const summaryChars = charsOf(data.summary)
  if (summaryChars < floor) return { action: 'skip', counter: 'skipped_below_floor', summaryChars }
  const compactionId = data.compactionId
  if (typeof compactionId !== 'string' || compactionId === '') return { action: 'skip', counter: 'skipped_no_id' }
  return {
    action: 'write',
    summaryChars,
    record: {
      at: new Date().toISOString(),
      session: safeKey(session?.id ?? ''),
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      compactionId,
      // 'turn' est ABSENT des charges utiles reelles mesurees : il vaut 'null',
      // jamais '0' — un tour invente serait un fait invente.
      turn: Number.isInteger(data.turn) ? data.turn : null,
      summaryChars,
      rawOutputChars: charsOf(data.rawOutput),
      // Les seqs ombres sont des ENTIERS, pas de la matiere : la charge utile de
      // la compaction n'entre jamais dans le journal, seulement sa METADONNE.
      shadowedSeqs: Array.isArray(data.shadowedSeqs)
        ? data.shadowedSeqs.filter((seq) => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0)
        : [],
      reason: REASON_RETAINED,
    },
  }
}

/**
 * Append + rotation AVANT l'ecriture, une generation gardee — la couture du canal.
 *
 * Cette fonction LEVE (c'est 'mkdirSync'/'appendFileSync' qui levent) : c'est
 * l'appelant qui contient, compte et replie. Un ecrivain qui avale ses erreurs
 * ne peut pas prouver qu'il les a vues.
 */
export function appendLine(file, line, cap = JOURNAL_MAX_BYTES) {
  mkdirSync(dirname(file), { recursive: true })
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    size = 0
  }
  if (size > 0 && size + Buffer.byteLength(line, 'utf8') + 1 > cap) {
    rmSync(file + '.1', { force: true })
    renameSync(file, file + '.1')
  }
  appendFileSync(file, line + '\n', 'utf8')
}

/** Les lignes lisibles d'un fichier JSONL. Une ligne dechiree est ignoree. */
function readRows(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const row = JSON.parse(line)
      if (row !== null && typeof row === 'object') rows.push(row)
    } catch {
      // Une ligne dechiree (ecriture concurrente, disque plein) ne doit pas
      // empecher le re-amorcage des autres.
    }
  }
  return rows
}

/**
 * Le re-amorcage : les 'compactionId' deja journalises, lus a la QUEUE du journal.
 *
 * Les DEUX generations sont lues ('.1' puis le fichier actif), comme 'ChannelStore.load'
 * ('packages/boost-channel/lib/index.js:587-592') : ne lire que l'actif ferait
 * reecrire un id qu'une rotation vient de renommer, exactement le defaut qui a
 * coutu une passe sur le canal.
 */
export function readSeen(journal) {
  const seen = new Set()
  for (const file of [journal + '.1', journal]) {
    for (const row of readRows(file)) {
      if (typeof row.compactionId === 'string' && row.compactionId !== '') seen.add(row.compactionId)
    }
  }
  return seen
}

/**
 * LE COEUR : l'etat (l'ensemble deduit), les compteurs, et 'note()' — la seule
 * fonction que le listener appelle.
 *
 * Rien n'y est lie a cordis : les tests et la sonde le montent directement.
 *
 * @param deps - '{ home?, journalPath?, failurePath?, floorChars?, maxBytes?, seed? }'.
 * @returns le controleur : 'note', 'stats', 'errors', 'seen', 'journal', 'floor'.
 */
export function createLessons(deps = {}) {
  const home = typeof deps.home === 'string' && deps.home !== '' ? deps.home : dshHome()
  const journal = typeof deps.journalPath === 'string' && deps.journalPath !== '' ? deps.journalPath : journalPath(home)
  const failures = typeof deps.failurePath === 'string' && deps.failurePath !== '' ? deps.failurePath : journal + '.failed.jsonl'
  const decisions = typeof deps.decisionsPath === 'string' && deps.decisionsPath !== '' ? deps.decisionsPath : decisionsPath(home)
  const maxBytes = Number.isInteger(deps.maxBytes) && deps.maxBytes > 0 ? deps.maxBytes : lessonsMaxBytes()
  const resolved = resolveFloor(deps.floorChars)
  const floor = resolved.floor
  const seen = new Set(Array.isArray(deps.seed) ? deps.seed : readSeen(journal))
  const stats = {
    events: 0,
    summaries: 0,
    retained: 0,
    skipped_child: 0,
    skipped_no_header: 0,
    skipped_no_payload: 0,
    skipped_below_floor: 0,
    skipped_no_id: 0,
    skipped_duplicate: 0,
    write_failed: 0,
    fallback_failed: 0,
    mount_failed: 0,
    contained: 0,
    reseeded: seen.size,
    floor_invalid: resolved.invalid ? 1 : 0,
  }
  /** Le releve d'erreurs en MEMOIRE : c'est le repli qui ne peut pas echouer. */
  const errors = []

  /** Une erreur est enregistree, comptee, bornee — et jamais propagee. */
  function contain(step, error) {
    stats.contained++
    let message
    try {
      message = Array.from(String(error?.message ?? error)).slice(0, 300).join('')
    } catch {
      message = 'unreadable-error'
    }
    errors.push({ at: new Date().toISOString(), step, error: message })
    while (errors.length > ERROR_RING) errors.shift()
  }

  if (resolved.invalid) {
    contain('floor-invalid', new Error('summaryFloorChars invalide (' + resolved.value + ') : defaut ' + DEFAULT_SUMMARY_FLOOR_CHARS))
  }

  /**
   * LE LISTENER, corps entier. Aucun chemin ne leve — ni un disque plein, ni un
   * chemin invalide, ni un JSON imprevu, ni une charge utile absente.
   *
   * @returns la ligne ecrite, ou null. La valeur de retour n'est pas utilisee par
   *   le listener ; elle l'est par les tests et la sonde.
   */
  function note(session, event) {
    try {
      stats.events++
      const plan = planCompaction(session, event, floor)
      if (plan.action === 'ignore') return null
      stats.summaries++
      if (plan.action === 'skip') {
        stats[plan.counter]++
        return null
      }
      const record = plan.record
      // Marque AVANT d'ecrire : un evenement rejoue apres un echec d'ecriture ne
      // doit pas rejouer l'echec — l'identite est connue, la tentative est faite.
      if (seen.has(record.compactionId)) {
        stats.skipped_duplicate++
        return null
      }
      seen.add(record.compactionId)
      let line
      try {
        line = JSON.stringify(record)
      } catch (error) {
        // Une valeur hostile (getter circulaire) : la ligne n'existe pas, l'id est
        // deja retenu, et RIEN ne remonte.
        contain('serialize', error)
        return null
      }
      try {
        appendLine(journal, line, maxBytes)
        stats.retained++
      } catch (error) {
        stats.write_failed++
        contain('write', error)
        try {
          appendLine(failures, line, maxBytes)
        } catch (fallbackError) {
          stats.fallback_failed++
          contain('fallback', fallbackError)
        }
      }
      return record
    } catch (error) {
      // Le filet du filet : tout ce qui n'a pas ete vu plus haut s'arrete ICI.
      contain('note', error)
      return null
    }
  }

  /**
   * LA TRACE DE MONTAGE — une ligne, ecrite par 'apply' au moment ou la ligne est
   * montee, JAMAIS a la premiere compaction.
   *
   * C'est le seul signal POSITIF que le listener est en place : une configuration
   * presente au 'dump-config' ne prouve rien (mesure du 2026-10-02 : une ligne
   * 'disabled' y figurait, et un remaniement n'avait pas ete charge par le
   * processus vivant). 'floor' est le plancher EFFECTIF, 'reseeded' le nombre
   * d'identites re-amorcees depuis le journal — c'est ce qui prouve que la
   * re-amorce a bien tourne.
   *
   * MEME REGLE que tout le reste : elle ne peut pas lever. Le repertoire ne peut
   * pas etre cree ? on abandonne — le montage tient, l'echec est compte
   * ('mount_failed') et garde en memoire. Aucun chemin ne remonte.
   */
  function mount() {
    const entry = { at: new Date().toISOString(), step: 'mounted', floor, reseeded: seen.size, log: journal }
    try {
      appendLine(decisions, JSON.stringify(entry), maxBytes)
    } catch (error) {
      stats.mount_failed++
      contain('mount', error)
    }
    return entry
  }

  return { note, mount, stats, errors, seen, journal, failures, decisions, floor, home, contain }
}

/**
 * Monte la ligne.
 *
 * LIGNE HOTE, listener SANS TAG : c'est ce qui la fait voir les racines ET les
 * enfants sans plomberie ('dsh-scope/lib/index.js:329-335'). Elle ne declare
 * AUCUNE injection : elle ne lit aucun service, donc rien ne peut retarder son
 * montage ni le faire echouer sur un service absent.
 *
 * @param ctx - le contexte de la ligne.
 * @param config - '{ home?, summaryFloorChars?, maxBytes? }'.
 * @returns le controleur (compteurs, erreurs, ensemble deduit).
 */
export function apply(ctx, config = {}) {
  const controller = createLessons({
    home: config.home,
    floorChars: config.summaryFloorChars,
    maxBytes: config.maxBytes,
  })
  // Le listener est SYNCHRONE et rend toujours la main : 'Session.append' n'attend
  // jamais, et une promesse rejetee ne serait vue qu'apres le tour.
  ctx.on('session/event', (session, event) => {
    controller.note(session, event)
  })
  // La trace de montage vient APRES l'enregistrement du listener : une trace
  // ecrite avant serait un mensonge. Elle est ecrite AU MONTAGE, pas a la
  // premiere compaction, et elle ne peut pas faire echouer le montage.
  controller.mount()
  try {
    if (typeof ctx.provide === 'function') ctx.provide('boostLessons', controller)
  } catch (error) {
    // Un service deja pris ne fait pas tomber la ligne : le journal continue.
    controller.contain('provide', error)
  }
  return controller
}
