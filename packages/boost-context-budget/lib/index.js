/**
 * dsh-boost-context-budget — l'occupation du contexte, EXPOSEE, et le fork GARDE.
 *
 * Le probleme, mesure : 'dsh-subagent-fork-in-process/lib/index.js:23-28'
 * construit le prefixe herite par `events.slice(0, last turn/end + 1)` — tout,
 * sans borne ni curseur — et la ligne n'a qu'une option (`providerName`). Un
 * parent a 85 % de sa fenetre donne donc a son enfant un prefixe qui ne lui
 * laisse presque aucune place pour travailler. Ce paquet ajoute la seule chose
 * qui manquait : une MESURE de ce qui sera herite, et un REFUS quand cette
 * mesure depasse un seuil configurable.
 *
 * Quatre pieces, et chacune existe pour une raison mesuree :
 *   1. l'outil 'context_occupancy' rend a l'agent APPELANT
 *      '{ inheritedTokens, windowTokens, ratio, forkThresholdRatio, verdict }'.
 *      Le capitaine l'appelle QUAND IL VEUT, y compris avant de decider ;
 *   2. un listener 'tools/pre-execute' (waterfall) REFUSE 'subagent_fork' quand
 *      'ratio > forkThresholdRatio', avec un message qui nomme les DEUX nombres
 *      et les TROIS sorties. Le refus est journalise ('fork-refused') et compte —
 *      et il N'ARME PLUS RIEN : un refus est un refus, il informe, il ne decide
 *      pas a la place du pere ;
 *   3. l'outil 'context_compact' : le pere DEMANDE sa propre compaction, une
 *      demande par tour au plus ;
 *   4. la COMPACTION DIFFEREE : un agent qui appelle un outil est 'running', donc
 *      il ne peut pas se compacter lui-meme a cet instant
 *      ('dsh-compaction/lib/types/index.d.ts:57-65' : 'runMaintenance' « throws
 *      synchronously when the agent is already active »). C'est le 'turn/end' du
 *      tour de la DEMANDE qui la declenche — quand l'agent n'est plus actif.
 *
 * L'ARBITRAGE, et c'est lui qui a fait retirer l'armement automatique du refus :
 * une compaction MANQUANTE coute un tour ; une compaction NON VOULUE coute de
 * l'histoire et un appel de modele. Le doute doit profiter a celui qui ne perd
 * rien. Le refus qui armait la compaction la declenchait MEME quand le pere
 * renoncait au fork pour deleguer avec un brief — un appel de modele et de
 * l'histoire perdue POUR UN FORK QUI N'AURA PAS LIEU. Et il la declenchait des
 * 60 % quand la politique du harnais ne compacte d'elle-meme qu'a 85 % : 25
 * points plus tot, sur une simple TENTATIVE de fork.
 *
 * OU LIT-ON LES DEUX NOMBRES. Ils ne sont pas codes en dur, et ils viennent de
 * la meme famille : les PROJECTIONS de session, que le harnais tient deja.
 *   - la FENETRE est `contextPressure.contextWindow` (projection 'contextPressure',
 *     'dsh-token-meter/lib/index.js:476-486'), dont la source durable est
 *     l'evenement 'request/context' (`data.contextWindow`), relu ici en second
 *     recours quand la projection n'est pas montee. Mesure sur une session
 *     reelle : `{"provider":"deepseek-official","model":"deepseek-flash",
 *     "contextWindow":1000000,"systemPromptUpdate":"in-history"}` ;
 *   - la TAILLE HERITEE est la somme des noeuds de SURFACE dont le seq est
 *     INFERIEUR OU EGAL au dernier 'turn/end' — exactement la frontiere que
 *     'completedTurnPrefix' applique. Deux sources, dans cet ordre : le service
 *     'tokenMeter' (`measure(session).nodes`, prix route compris) puis la
 *     projection 'contextBreakdown' (`stateOf(session, 'contextBreakdown').nodes`,
 *     l'estimateur fixe du harnais, 4 caracteres/token). Les noeuds qui suivent
 *     le dernier 'turn/end' sont EXCLUS : c'est le tour en vol, et il n'est pas
 *     herite.
 * Pourquoi la projection plutot qu'un comptage de caracteres maison : elle est
 * deja le prix OFFICIEL de la surface, elle honore les remplacements
 * (compaction) en supprimant les noeuds ombres, et un comptage parallele
 * deriverait de la seule source qui compte. Quand aucune des deux sources n'est
 * disponible, la mesure vaut 'null' et le verdict 'unknown' : on ne refuse
 * JAMAIS sur une mesure inventee (un controle qui devine est pire qu'un
 * controle qui s'abstient).
 *
 * MONTAGE : ligne HOTE, outils installes PAR AGENT sur 'agent/created' — un
 * outil enregistre depuis la portee d'une ligne n'atteint jamais la surface
 * composee d'un agent (mesure deux fois). Le motif et la source unique
 * 'TOOL_NAMES' sont ceux de 'packages/boost-channel/lib/index.js'.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-boost-context-budget'
export const inject = ['agents']

/**
 * LES OUTILS DU PAQUET — SOURCE UNIQUE, dans l'ordre ou ils sont enregistres.
 *
 * La fabrique ('buildTools'), les tests et toute sonde lisent CETTE liste : un
 * outil ajoute sans elle fait rougir la SUITE, pas une sonde que personne ne
 * lance. Copie assumee du motif de 'packages/boost-channel/lib/index.js:1552'.
 */
export const OCCUPANCY_TOOL = 'context_occupancy'

/**
 * L'OUTIL DE DEMANDE — nomme ici parce que le MESSAGE DE REFUS le nomme, et
 * qu'un message qui nomme un outil doit le nommer depuis une seule source.
 *
 * C'est la sortie n° 1 du pere qui veut toujours forker : il DEMANDE sa
 * compaction, elle tourne a son 'turn/end', et il forke au tour suivant.
 */
export const COMPACT_TOOL = 'context_compact'

export const TOOL_NAMES = [OCCUPANCY_TOOL, COMPACT_TOOL]

/**
 * L'outil que ce paquet garde — par son NOM, et c'est une LIMITE, ecrite ici
 * parce qu'un garde qui ne garde qu'un nom doit le dire.
 *
 * 'subagent_fork' est une valeur du PRESET ('dsh-base/cordis.patch.yml:383-388',
 * `toolName: subagent_fork`), pas une propriete du harnais : mesure faite, le
 * meme provider monte sous un autre nom ('subagent_fork_deep') passe SANS refus
 * ni trace. Reconnaitre le fork par son FOURNISSEUR est hors de portee de ce
 * seam : 'tools/pre-execute' ne remet que `{ callId, name, arguments, agent,
 * parent, signal }` ('dsh-tools/lib/types/index.d.ts:216-242', dispatch
 * 'dsh-tools/lib/index.js:3224') — aucun champ de provider. La riposte
 * disponible ici est la CONFIGURATION : 'forkToolNames'.
 */
export const FORK_TOOL = 'subagent_fork'

/** Les noms gardes par defaut : celui du preset. */
export const DEFAULT_FORK_TOOLS = [FORK_TOOL]

/**
 * Plancher de plausibilite d'une fenetre de contexte, en tokens.
 *
 * Une route annonce une fenetre de l'ordre du millier au million ; sous ce
 * plancher ce n'est plus une mesure mais un accident de lecture, et un ratio
 * calcule dessus vaut « 7 100 000 % de la fenetre » (mesure : 'windowTokens: 1'
 * rendait 'ratio: 71000, verdict: refused'). Un controle qui devine est pire
 * qu'un controle qui s'abstient : sous le plancher la mesure vaut 'unknown', la
 * garde s'abstient, et la source est nommee 'implausible-window'.
 */
export const MIN_PLAUSIBLE_WINDOW_TOKENS = 4096

/**
 * Seuil par defaut : 0,6. Justification, et ce n'est pas un gout.
 *
 * Un enfant FORKE ne recoit ni consigne fraiche ni contexte vierge : il recoit
 * le prefixe clos de son parent. Ce que le seuil protege est donc la part de
 * fenetre qui reste a l'enfant pour TRAVAILLER — lire, tester, ecrire — et non
 * la part que le parent voulait bien preter. A 0,6, l'enfant demarre avec ~40 %
 * de la fenetre libre : assez pour une investigation et un correctif, sans
 * repasser sous le seuil de compaction automatique des sa premiere lecture. Plus
 * haut, la garde ne se declenche jamais (mesure du corpus : les sessions racines
 * les plus lourdes tournent a ~349 000 cache-read par pas, au plafond) ; plus
 * bas, elle refuse des forks qui auraient tenu.
 */
export const DEFAULT_FORK_THRESHOLD_RATIO = 0.6

/** Verdicts rendus par l'outil. Trois etats, jamais deux. */
export const VERDICT_OK = 'ok'
export const VERDICT_REFUSED = 'refused'
export const VERDICT_UNKNOWN = 'unknown'

/**
 * Les motifs rendus par l'outil de DEMANDE ('context_compact').
 *
 *   - 'requested' — la demande est retenue, elle sera honoree au 'turn/end' ;
 *   - 'already-pending' — une demande du MEME tour est deja retenue : une seule
 *     compaction par tour, et la premiere suffit ;
 *   - 'below-threshold' — mesure faite, le fork n'est PAS bloque : une
 *     compaction ne gagnerait rien et perdrait de l'histoire ;
 *   - 'compact-ineffective' — une compaction DEMANDEE n'a pas fait descendre le
 *     ratio : elle ne sera pas repetee (journal 'compact-ineffective').
 */
export const REQUEST_PENDING = 'requested'
export const REQUEST_DUPLICATE = 'already-pending'
export const REQUEST_USELESS = 'below-threshold'
export const REQUEST_LATCHED = 'compact-ineffective'
export const REQUEST_REASONS = [REQUEST_PENDING, REQUEST_DUPLICATE, REQUEST_USELESS, REQUEST_LATCHED]

/** Journal du plugin : bornage par rotation, comme les autres lignes. */
export const JOURNAL_MAX_BYTES = 1024 * 1024

/** Identite du refus, pour un consommateur qui lit le resultat d'outil. */
export const REFUSAL_CODE = 'BOOST_FORK_OVER_THRESHOLD'

/** Racine du harnais, relue a chaque appel (un test peut la rediriger). */
export function dshHome() {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
}

/** Repertoire du journal. */
export function storeDir(home = dshHome()) {
  return join(home, 'plugin-data', name)
}

/** Journal du plugin : decisions et compteurs, jamais de charge utile. */
export function journalPath(home = dshHome()) {
  return join(storeDir(home), 'decisions.jsonl')
}

/** Cle rendue sure, pour journaliser un id de session sans surprises. */
export function safeKey(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

/** Journal append-only : un diagnostic qui casse ce qu'il observe est pire que rien. */
export function writeJournal(home, entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  try {
    const file = journalPath(home)
    mkdirSync(dirname(file), { recursive: true })
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      size = 0
    }
    if (size > 0 && size + Buffer.byteLength(line, 'utf8') + 1 > JOURNAL_MAX_BYTES) {
      rmSync(file + '.1', { force: true })
      renameSync(file, file + '.1')
    }
    appendFileSync(file, line + '\n', 'utf8')
  } catch {
    // Jamais remonte.
  }
}

/**
 * Le seuil, resolu depuis la configuration de la ligne.
 *
 * Valeur par defaut : 0,6. Une valeur hors [0,1] ou non numerique est
 * JOURNALISEE et remplacee par le defaut — le montage tient dans tous les cas,
 * parce qu'une ligne qui refuse de se monter sur une faute de frappe dans un
 * seuil est une ligne qui coute plus qu'elle ne rapporte.
 *
 * Une chaine numerique est acceptee (une config YAML citee l'est souvent) ;
 * `null`, une chaine vide, un booleen, NaN et l'infini sont refuses.
 *
 * `-0` est refuse AUSSI, et ce n'est pas une coquetterie : le harnais exige une
 * valeur JSON SANS PERTE ('isJsonNumber', 'dsh-tools/lib/index.js:126-128'
 * exclut -0), et un seuil de -0 faisait rejeter la reponse ENTIERE de l'outil
 * (`returned invalid output: value is not lossless JSON`). '-0' cite en YAML
 * arrive au meme endroit : la chaine est numerique, donc convertie en -0.
 *
 * @param value - la valeur brute de la cle 'forkThresholdRatio'.
 * @param journal - sink de journalisation, injecte pour les tests.
 * @returns le seuil effectif, toujours dans [0,1] et jamais -0.
 */
export function resolveThreshold(value, journal = () => {}) {
  if (value === undefined) return DEFAULT_FORK_THRESHOLD_RATIO
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric) || Object.is(numeric, -0) || numeric < 0 || numeric > 1) {
    journal({ step: 'threshold-invalid', value: Object.is(value, -0) ? '-0' : String(value), fallback: DEFAULT_FORK_THRESHOLD_RATIO })
    return DEFAULT_FORK_THRESHOLD_RATIO
  }
  return numeric
}

/**
 * Les NOMS d'outils gardes, depuis la configuration de la ligne.
 *
 * Le nom du fork est une valeur du preset (voir 'FORK_TOOL') : un deploiement qui
 * monte le provider sous un autre nom doit pouvoir le declarer ici. Une valeur
 * invalide (non-tableau, que des entrees vides) est JOURNALISEE et remplacee par
 * le defaut — le montage tient, comme pour le seuil.
 *
 * @param value - la valeur brute de la cle 'forkToolNames'.
 * @param journal - sink de journalisation, injecte pour les tests.
 * @returns au moins un nom, jamais une liste vide.
 */
export function resolveForkTools(value, journal = () => {}) {
  if (value === undefined) return [...DEFAULT_FORK_TOOLS]
  const cleaned = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'string') continue
      const trimmed = entry.trim()
      if (trimmed === '' || cleaned.includes(trimmed)) continue
      cleaned.push(trimmed)
    }
  }
  if (cleaned.length === 0) {
    journal({ step: 'fork-tools-invalid', value: Array.isArray(value) ? JSON.stringify(value) : String(value), fallback: [...DEFAULT_FORK_TOOLS] })
    return [...DEFAULT_FORK_TOOLS]
  }
  return cleaned
}

/**
 * La frontiere du fork : le seq du DERNIER 'turn/end', ou -1.
 *
 * Miroir exact de 'completedTurnPrefix'
 * ('dsh-subagent-fork-in-process/lib/index.js:23-28'), qui prend « every event up
 * to and including the last turn/end ». Avant tout tour clos, le fork n'herite
 * de RIEN (le provider rend un enfant neuf) : c'est -1, et la mesure vaut 0.
 *
 * @param events - le journal de la session, en ordre de seq.
 * @returns le seq du dernier 'turn/end', ou -1.
 */
export function boundarySeqOf(events) {
  if (!Array.isArray(events)) return -1
  let last = -1
  for (const event of events) {
    if (event?.type !== 'turn/end') continue
    const seq = event.seq
    if (typeof seq === 'number' && Number.isInteger(seq) && seq > last) last = seq
  }
  return last
}

/** Un entier strictement positif, ou rien : la fenetre d'une route. */
function positiveInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** Une fenetre PLAUSIBLE, ou rien — voir 'MIN_PLAUSIBLE_WINDOW_TOKENS'. */
function plausibleWindow(value) {
  const window = positiveInt(value)
  return window !== null && window >= MIN_PLAUSIBLE_WINDOW_TOKENS ? window : null
}

/**
 * La fenetre du modele de la route : projection d'abord, evenement durable ensuite.
 *
 * Une valeur annoncee mais IMPLAUSIBLE (entier positif sous le plancher) n'est pas
 * une fenetre : elle rend 'windowTokens: null' et la source 'implausible-window',
 * donc une mesure 'unknown' et une garde qui s'abstient. Une valeur plausible
 * trouvee dans l'autre source l'emporte : la lecture est tolerante, le verdict
 * ne l'est pas.
 */
export function windowOf(services, session, events) {
  let implausible = false
  try {
    const raw = services.sessionProjections?.snapshot?.(session, ['contextPressure'])?.values?.contextPressure?.contextWindow
    const window = plausibleWindow(raw)
    if (window !== null) return { windowTokens: window, source: 'context-pressure' }
    if (positiveInt(raw) !== null) implausible = true
  } catch {
    // Une projection qui jette ne doit pas empecher la lecture durable.
  }
  let window = null
  if (Array.isArray(events)) {
    for (const event of events) {
      if (event?.type !== 'request/context') continue
      const raw = event.data?.contextWindow
      const candidate = plausibleWindow(raw)
      if (candidate !== null) window = candidate
      else if (positiveInt(raw) !== null) implausible = true
    }
  }
  if (window !== null) return { windowTokens: window, source: 'request-context' }
  return { windowTokens: null, source: implausible ? 'implausible-window' : 'unavailable' }
}

// (La vue 'prefix-usage' a ete RETIREE : refutee sur la vraie pile, elle
// s'arretait au dernier echantillon du fournisseur, donc AVANT les tool/result du
// tour clos. La mesure est 'prefixBreakdownOf', plus bas.)

/** Le tour OUVERT d'apres le journal, ou null quand il n'est pas lisible. */
export function openTurnOf(events) {
  if (!Array.isArray(events)) return null
  let turn = null
  for (const event of events) {
    if (event?.type !== 'turn/start') continue
    const value = event.data?.turn
    if (typeof value === 'number' && Number.isInteger(value)) turn = value
  }
  return turn
}

/** La somme des trois champs de 'contextBreakdown', ou null si la vue manque. */
export function breakdownTotal(breakdown) {
  if (breakdown === null || typeof breakdown !== 'object') return null
  let total = 0
  for (const field of ['systemTokens', 'toolsTokens', 'messageTokens']) {
    const value = breakdown[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
    total += value
  }
  return total
}

/**
 * LA MESURE : ce que le fork transmet, lu sur les EVENEMENTS du prefixe.
 *
 * Source unique : 'SessionProjectionRegistry.restore(checkpoint, events, baseSeq,
 * — la SEULE API du harnais parametree par un seq d'arret, dont 'asOfSeq' vaut le
 * DERNIER evenement fourni ('dsh-session-projection/lib/index.js:288,314'). On lui
 * donne exactement ce que le fork tranche ('events[0..boundary]', la frontiere de
 * 'completedTurnPrefix'), et l'on somme les trois champs de 'contextBreakdown' —
 * la vue client de cette projection ('dsh-token-meter/lib/index.js:263').
 *
 * POURQUOI PAS LA SURFACE VIVE. Une compaction ne SP.LICE QUE LA SURFACE
 * ('dsh-session/lib/index.js:463' : 'state.nodes.splice(...)') ; le journal, lui,
 * ne perd rien ('snapshotEvents()' rend 'this.log'). Une region remplacee APRES la
 * frontiere disparait donc des noeuds retenus, et toute somme de surface close
 * s'effondre : mesure du verificateur, 0 contre 541 857 de prefixe reel.
 *
 * POURQUOI AUCUN REPLI : une somme de surface retenue n'est pas une mesure
 * degradee, c'est une MESURE FAUSSE — elle rend 13 849 la ou le prefixe en vaut
 * 542 393 (sous-mesure 39x), le fork PASSE, et le journal laisse croire que la
 * garde a decide. Confondre ABSENCE de mesure et mesure fausse est exactement le
 * defaut que ce paquet corrige.
 */
export function prefixBreakdownOf(services, session, events, boundary) {
  const registry = services.sessionProjections
  if (typeof registry?.restore !== 'function') return { tokens: null, source: 'no-restore' }
  if (!Array.isArray(events)) return { tokens: null, source: 'no-events' }
  const prefix = []
  for (const event of events) {
    const seq = event?.seq
    if (typeof seq !== 'number' || seq > boundary) continue
    prefix.push(event)
  }
  try {
    const restored = registry.restore({}, prefix, 0, session?.header, session?.inheritedEventCount ?? 0)
    const total = breakdownTotal(restored?.snapshot?.values?.contextBreakdown)
    if (total === null) return { tokens: null, source: 'restore-empty' }
    return { tokens: total, source: 'restore-boundary' }
  } catch (error) {
    return { tokens: null, source: 'restore-failed', error: String(error?.message ?? error) }
  }
}

/**
 * La taille de CE QU'UN FORK HERITERAIT : le prefixe clos, mesure par la meme API
 * que celle qui parametre un arret — 'restore' borne a la frontiere.
 *
 * AUCUN REPLI, et c'est deliberé : quand 'restore' est absent ou jette, la mesure
 * vaut 'null' et le verdict 'unknown'. La garde S'ABSTIENT, et le journal dit
 * pourquoi ('fork-unguarded', 'why: restore-failed'). Une mesure 'unknown' n'est
 * pas une mesure fausse — et une mesure fausse fait croire que la garde a decide :
 * mesure du verificateur, la somme de surface rendait 13 849 la ou le prefixe en
 * vaut 542 393 (sous-mesure 39x) et le fork PASSAIT.
 */
export function inheritedOf(services, session, boundary, events) {
  if (boundary < 0) return { inheritedTokens: 0, source: 'no-completed-turn' }
  const restored = prefixBreakdownOf(services, session, events, boundary)
  if (restored.tokens !== null) return { inheritedTokens: restored.tokens, source: restored.source }
  return {
    inheritedTokens: null,
    source: 'unavailable',
    failure: { source: restored.source, error: restored.error ?? null },
  }
}

/**
 * La mesure complete, pour une session et les services presents.
 *
 * @param services - '{ tokenMeter?, sessionProjections? }', tous optionnels.
 * @param session - la session mesuree (celle de l'appelant).
 * @param threshold - le seuil effectif de la ligne.
 * @param boundary - la FRONTIERE du prefixe mesure. Par defaut le dernier
 *   'turn/end' : c'est ce qu'un fork herite, et c'est la seule frontiere que la
 *   GARDE utilise. Une frontiere PLUS LARGE n'est fournie que par la mesure qui
 *   JUGE une compaction ('measureAfterCompaction', dans 'apply') : une compaction
 *   exige un tour ferme, donc elle ecrit ses evenements APRES le dernier
 *   'turn/end', et la frontiere du fork ne les voit pas encore. Mesure sur la
 *   vraie pile (Session + TokenMeter + SessionProjectionRegistry) : 4 532 tokens
 *   au dernier 'turn/end' AVANT la compaction, 4 532 au MEME cut APRES, et 10 au
 *   dernier evenement. Juger une compaction au cut du fork declarerait
 *   'ineffective' toute compaction qui MARCHE.
 * @returns '{ inheritedTokens, windowTokens, ratio, forkThresholdRatio, verdict, sources }',
 *   avec 'null' partout ou la mesure n'est pas etablie. 'sources' est DECLARE au
 *   schema de sortie : le registre valide la valeur rendue et rejette toute cle
 *   non declaree ('dsh-tools/lib/index.js:3541-3544').
 */
export function measure(services, session, threshold, boundary = undefined) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
  const cut = boundary === undefined ? boundarySeqOf(events) : boundary
  const inherited = inheritedOf(services, session, cut, events)
  const window = windowOf(services, session, events)
  const ratio = inherited.inheritedTokens === null || window.windowTokens === null
    ? null
    : inherited.inheritedTokens / window.windowTokens
  const verdict = ratio === null
    ? VERDICT_UNKNOWN
    : ratio > threshold ? VERDICT_REFUSED : VERDICT_OK
  return {
    inheritedTokens: inherited.inheritedTokens,
    windowTokens: window.windowTokens,
    ratio,
    forkThresholdRatio: threshold,
    verdict,
    sources: { inherited: inherited.source, window: window.source, boundarySeq: cut },
    // HORS schema de sortie : 'sources' n'a que trois cles declarees. L'outil
    // projette les six cles canoniques ; ce champ sert au JOURNAL et a l'appelant
    // interne, jamais au modele.
    ...inherited.failure === undefined ? {} : { failure: inherited.failure },
  }
}

/** Arrondi d'affichage d'un ratio, sans bruit de flottant. */
function percent(ratio) {
  return Math.round(ratio * 100)
}

/**
 * Le message de refus : les DEUX nombres, et les TROIS sorties.
 *
 * Refuser sans dire pourquoi serait pire que ne pas refuser. Trois sorties, et
 * aucune n'est imposee : DEMANDER sa compaction (elle tourne a la fin du tour,
 * puis on forke), DELEGUER avec un brief indexe (la route la moins chere), ou
 * RENONCER au fork. Le refus n'arme RIEN — c'est le pere qui choisit, et la
 * seule compaction qui coute quelque chose est celle qu'il a demandee.
 */
export function refusalMessage(inheritedTokens, windowTokens, ratio, threshold) {
  return 'fork refuse : ton contexte heritable vaut ' + percent(ratio) + ' % de la fenetre, le seuil est '
    + percent(threshold) + ' % (' + inheritedTokens + ' tokens herites sur ' + windowTokens + '). trois sorties :'
    + ' 1) tu veux toujours forker -> demande ta compaction (outil ' + COMPACT_TOOL + '), elle tournera a ton'
    + ' turn end ; elle ecrit APRES la frontiere, donc ton fork ne la verra qu apres UN TOUR DE PLUS (mesure :'
    + ' le prefixe herite ne bouge pas au tour suivant) ; 2) ou delegue avec subagent_implement et un brief indexe'
    + ' (la route la moins chere) ; 3) ou renonce au fork et continue : rien ne t y oblige.'
}

/** Le texte rendu a l'appelant par l'outil d'occupation. */
export function occupancyText(value) {
  if (value.ratio === null) {
    return 'occupation inconnue : inheritedTokens=' + String(value.inheritedTokens)
      + ' windowTokens=' + String(value.windowTokens)
      + ' (sources ' + value.sources.inherited + '/' + value.sources.window
      + '). Le fork n est pas garde faute de mesure.'
  }
  return 'contexte heritable ' + percent(value.ratio) + ' % de la fenetre (seuil '
    + percent(value.forkThresholdRatio) + ' %) : ' + value.inheritedTokens + ' tokens herites sur '
    + value.windowTokens + ' — verdict ' + value.verdict + '.'
}

/**
 * Le texte rendu a l'appelant par l'outil de DEMANDE.
 *
 * Chaque motif dit la meme chose : ce qui va se passer, et ce que la demande
 * coute. 'compact-ineffective' dit en plus les deux autres sorties — un pere qui
 * ne peut pas descendre n'a plus que celles-la, et rien ne doit l'y forcer.
 */
export function compactText(value) {
  const head = value.ratio === null
    ? 'occupation INCONNUE (seuil ' + percent(value.forkThresholdRatio) + ' %)'
    : 'contexte heritable ' + percent(value.ratio) + ' % de la fenetre (seuil '
      + percent(value.forkThresholdRatio) + ' %)'
  if (value.reason === REQUEST_PENDING) {
    return 'compaction DEMANDEE : elle tournera a la fin de ce tour ('
      + (value.turn === null ? 'au prochain turn end' : 'turn ' + value.turn + ' end')
      + '). Comme elle ecrit APRES ta derniere frontiere, ton fork ne la verra qu apres UN TOUR DE PLUS'
      + ' — mesure : le prefixe herite ne bouge pas au tour suivant. ' + head
      + '. Une compaction resume l histoire : le detail remplace est perdu.'
  }
  if (value.reason === REQUEST_DUPLICATE) {
    return 'compaction DEJA demandee pour ce tour : une seule compaction par tour, la premiere suffit. ' + head + '.'
  }
  if (value.reason === REQUEST_USELESS) {
    return 'aucune compaction demandee : ' + head + ' — sous le seuil le fork n est PAS bloque,'
      + ' une compaction ne gagnerait rien et perdrait de l histoire.'
  }
  return 'aucune compaction demandee : ' + head + ' — une compaction DEMANDEE n a pas fait descendre'
    + ' ce ratio, elle ne sera pas repetee. Delegue avec subagent_implement et un brief indexe,'
    + ' ou renonce au fork.'
}

/**
 * L'OUTIL D'OCCUPATION.
 *
 * Il ne prend AUCUN argument : un appelant ne peut pas demander l'occupation
 * d'un autre agent, parce que la mesure est CELLE DE L'APPELANT — celui qui
 * forke ou ne forke pas. Deux appels du meme agent sur le meme journal rendent
 * donc la meme valeur, et aucun argument ne peut detourner la mesure.
 *
 * @param controller - l'etat du paquet (mesure, stats, journal).
 * @returns la liste des outils, dans l'ordre de 'TOOL_NAMES'.
 */
export function buildTools(controller) {
  return [
    {
      name: OCCUPANCY_TOOL,
      description: 'Rend l occupation du contexte de TON agent : inheritedTokens (ce qu un fork heriterait '
        + '— le prefixe clos jusqu au dernier turn/end), windowTokens (la fenetre du modele de ta route), '
        + 'ratio, forkThresholdRatio (le seuil de la ligne), verdict (ok | refused | unknown) et sources '
        + '(quelle source a servi). Appelle-le '
        + 'QUAND TU VEUX, et notamment AVANT de decider de forker : au-dela du seuil, subagent_fork est '
        + 'refuse. L outil ne prend aucun argument : la mesure est la tienne, jamais celle d un autre.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            inheritedTokens: {
              description: 'Tokens du prefixe clos du parent (jusqu au dernier turn/end) — ce qu un fork heriterait. null quand aucune source ne l etablit.',
              oneOf: [{ type: 'number' }, { type: 'null' }],
            },
            windowTokens: {
              description: 'Fenetre du modele de la route, lue sur la projection contextPressure ou sur l evenement request/context. null quand aucune route ne l a annoncee.',
              oneOf: [{ type: 'number' }, { type: 'null' }],
            },
            ratio: {
              description: 'inheritedTokens / windowTokens. null quand l un des deux manque.',
              oneOf: [{ type: 'number' }, { type: 'null' }],
            },
            forkThresholdRatio: { type: 'number', description: 'Seuil effectif de la ligne : au-dela, subagent_fork est refuse.' },
            verdict: { type: 'string', enum: [VERDICT_OK, VERDICT_REFUSED, VERDICT_UNKNOWN], description: 'ok (un fork passe) | refused (il serait refuse) | unknown (mesure incomplete).' },
            // 'sources' est DECLARE, pas retire : il dit QUELLE source a servi, et
            // c'est la part honnete de la mesure. Un nombre sans sa source ne se
            // verifie pas ; et le schema le valide desormais au retour, comme le
            // registre le fait ('dsh-tools/lib/index.js:3541-3544').
            sources: {
              type: 'object',
              additionalProperties: false,
              description: 'D ou viennent les deux nombres : inherited (token-meter | context-breakdown | no-completed-turn | unavailable), window (context-pressure | request-context | unavailable), et la frontiere du prefixe herite.',
              properties: {
                inherited: { type: 'string', description: 'Source de inheritedTokens.' },
                window: { type: 'string', description: 'Source de windowTokens.' },
                boundarySeq: { type: 'integer', description: 'Seq du dernier turn/end — la frontiere du prefixe herite ; -1 avant tout tour clos.' },
              },
              required: ['inherited', 'window', 'boundarySeq'],
            },
          },
          required: ['inheritedTokens', 'windowTokens', 'ratio', 'forkThresholdRatio', 'verdict', 'sources'],
        },
        render: (_args, value) => [{ type: 'text', text: occupancyText(value) }],
      },
      execute: async (_args, exec) => {
        const session = exec?.agent?.session
        if (session === undefined || session === null) {
          throw new Error('context_occupancy: aucune session appelante — la mesure appartient a un agent.')
        }
        const value = controller.measureFor(session)
        // PROJECTION EXPLICITE sur les six cles declarees : la mesure porte en plus
        // la cause d'une abstention ('failure'), qui n'a rien a faire dans la
        // valeur rendue — le registre rejette toute cle non declaree.
        return {
          inheritedTokens: value.inheritedTokens,
          windowTokens: value.windowTokens,
          ratio: value.ratio,
          forkThresholdRatio: value.forkThresholdRatio,
          verdict: value.verdict,
          sources: value.sources,
        }
      },
    },
    {
      name: COMPACT_TOOL,
      description: 'DEMANDE la compaction de TON contexte. Elle ne tourne pas pendant cet appel — un agent qui'
        + ' appelle un outil est actif, et il ne peut pas se compacter — mais a la FIN DE TON TOUR, quand tu ne'
        + ' l es plus. Une demande par tour au plus. C est IRREVERSIBLE : la compaction resume ton histoire, et'
        + ' le detail remplace est perdu. A appeler quand context_occupancy dit que le fork est refuse'
        + ' (ratio > forkThresholdRatio) et que tu veux TOUJOURS forker : apres la compaction, forke au tour'
        + ' suivant. Si la compaction ne fait pas descendre le ratio, elle ne sera pas repetee : delegue avec'
        + ' subagent_implement et un brief indexe, ou renonce au fork. Aucun argument.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            requested: { type: 'boolean', description: 'true quand une compaction est demandee pour CE tour — retenue par cet appel, ou deja retenue par un appel du meme tour.' },
            pending: { type: 'boolean', description: 'true quand une demande attend le turn/end de ce tour.' },
            duplicate: { type: 'boolean', description: 'true quand la demande etait DEJA retenue pour ce tour : elle n a pas ete doublee.' },
            turn: {
              description: 'Le tour dont le turn/end soldera la demande. null quand le turn/start n a pas ete lisible : la demande se soldera alors au prochain turn/end.',
              oneOf: [{ type: 'integer' }, { type: 'null' }],
            },
            ratio: {
              description: 'Le ratio mesure AU MOMENT DE LA DEMANDE. null quand la mesure n est pas etablie.',
              oneOf: [{ type: 'number' }, { type: 'null' }],
            },
            forkThresholdRatio: { type: 'number', description: 'Seuil effectif de la ligne : au-dela, subagent_fork est refuse.' },
            verdict: { type: 'string', enum: [VERDICT_OK, VERDICT_REFUSED, VERDICT_UNKNOWN], description: 'ok (un fork passe) | refused (il serait refuse) | unknown (mesure incomplete).' },
            reason: { type: 'string', enum: REQUEST_REASONS, description: 'requested (demande retenue) | already-pending (deja demandee pour ce tour) | below-threshold (le fork n est pas bloque) | compact-ineffective (une compaction demandee n a pas suffi : elle ne sera pas repetee).' },
          },
          required: ['requested', 'pending', 'duplicate', 'turn', 'ratio', 'forkThresholdRatio', 'verdict', 'reason'],
        },
        render: (_args, value) => [{ type: 'text', text: compactText(value) }],
      },
      execute: async (_args, exec) => {
        const session = exec?.agent?.session
        if (session === undefined || session === null) {
          throw new Error(COMPACT_TOOL + ': aucune session appelante — une demande appartient a un agent.')
        }
        return controller.requestCompaction(session)
      },
    },
  ]
}

/**
 * Monte la garde et l'outil.
 *
 * LIGNE HOTE, outils installes PAR AGENT sur 'agent/created' : un outil
 * enregistre depuis la portee d'une ligne n'atteint jamais la surface composee
 * d'un agent (mesure deux fois). Les services autres que 'agents' sont lus par
 * 'ctx.get(...)' — absents, ils degradent la MESURE (verdict 'unknown'), ils ne
 * font pas tomber le montage.
 *
 * @param ctx - le contexte de la ligne.
 * @param config - '{ home?, forkThresholdRatio? }'.
 * @returns le controleur : mesure, stats, journal lisible par un test.
 */
export function apply(ctx, config = {}) {
  const agents = ctx.agents
  const services = {
    get tokenMeter() {
      return ctx.get('tokenMeter')
    },
    get sessionProjections() {
      return ctx.get('sessionProjections')
    },
  }
  const journal = (entry) => writeJournal(config.home ?? dshHome(), entry)
  const threshold = resolveThreshold(config.forkThresholdRatio, journal)
  const forkTools = resolveForkTools(config.forkToolNames, journal)
  const guarded = new Set(forkTools)
  const stats = {
    measured: 0, refused: 0, passed: 0, unknown: 0, provider_guarded: 0,
    compacted: 0, compact_failed: 0, compact_ineffective: 0,
    request_duplicate: 0, request_useless: 0, request_latched: 0, request_orphaned: 0, request_unbounded: 0,
  }
  // LES DEMANDES DE COMPACTION, par session, AVEC LE TOUR de la demande. Un
  // booleen ne suffirait pas : la demande survivrait a un tour qui ne se ferme
  // JAMAIS, et tirerait sur le premier 'turn/end' venu — un tour etranger, sans
  // rapport. Un refus n'ecrit JAMAIS ici : c'est l'outil 'context_compact' qui
  // remplit cette table, et rien d'autre.
  const compactRequests = new Map()
  // Les sessions ou une compaction DEMANDEE n'a PAS fait descendre le ratio. Le
  // verrou tombe de lui-meme des qu'une mesure repasse sous le seuil : il ne
  // bloque que la repetition d'une depense qui a deja echoue.
  const ineffective = new Map()
  const inflight = new Set()

  journal({ step: 'mounted', pid: process.pid, threshold, forkTools: forkTools.join(',') })

  const measureFor = (session) => {
    const value = measure(services, session, threshold)
    stats.measured++
    if (value.verdict === VERDICT_UNKNOWN) stats.unknown++
    return value
  }

  /** Le seq du DERNIER evenement du journal, ou -1 quand il n'est pas lisible. */
  const lastSeqOf = (session) => {
    let events
    try {
      events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
    } catch {
      return -1
    }
    if (!Array.isArray(events) || events.length === 0) return -1
    const seq = events[events.length - 1]?.seq
    return typeof seq === 'number' && Number.isInteger(seq) ? seq : -1
  }

  /**
   * LA MESURE QUI JUGE LA COMPACTION — et ce n'est PAS celle du fork.
   *
   * Une compaction exige un tour FERME ('dsh-compaction-basic/lib/index.js:455-462'
   * : 'manual compaction: the session already has an open turn' est le refus
   * 'busy'), donc elle ecrit ses evenements APRES le dernier 'turn/end'. Au cut du
   * fork, une compaction qui MARCHE ne change donc RIEN : mesure sur la vraie pile,
   * 4 532 tokens avant, 4 532 apres, contre 10 au dernier evenement. Juger au cut du
   * fork declarerait 'compact-ineffective' TOUTE compaction reussie, et le verrou
   * qui suit refuserait la demande suivante d'un pere qui a pourtant de la place.
   *
   * La frontiere est donc le DERNIER EVENEMENT : « ce que le fork heriterait si ce
   * tour se fermait maintenant ». Meme source que la garde ('restore'), meme
   * fonction, une seule frontiere change — et elle est ECRITE dans 'sources'.
   */
  const measureAfterCompaction = (session) => {
    const value = measure(services, session, threshold, lastSeqOf(session))
    stats.measured++
    if (value.verdict === VERDICT_UNKNOWN) stats.unknown++
    return value
  }

  /**
   * LA DEMANDE — le SEUL chemin qui retient une compaction.
   *
   * Un refus n'ecrit plus rien ici (voir l'arbitrage en tete de module) : le pere
   * DEMANDE, et sa demande est retenue pour SON tour. Quatre reponses, et chacune
   * dit pourquoi :
   *   - 'already-pending' : une demande du meme tour est deja retenue — une seule
   *     compaction par tour, et la premiere suffit ;
   *   - 'below-threshold' : la mesure est faite, et le fork n'est PAS bloque ;
   *     compacter ne gagnerait rien et perdrait de l'histoire ;
   *   - 'compact-ineffective' : une compaction DEMANDEE n'a pas fait descendre ce
   *     ratio — on ne la paie pas une seconde fois ;
   *   - 'requested' : la demande est retenue, 'turn/end' la soldera.
   *
   * Une mesure ABSENTE ('ratio: null') n'empeche pas la demande : le pere a
   * demande, il sait ce qu'il fait, et rien ici ne peut prouver le contraire.
   */
  const requestCompaction = (session) => {
    const id = session?.id
    if (typeof id !== 'string' || id === '') {
      throw new Error(COMPACT_TOOL + ': aucune session appelante — une demande appartient a un agent.')
    }
    const value = measureFor(session)
    const shape = { ratio: value.ratio, forkThresholdRatio: threshold, verdict: value.verdict }
    const pending = compactRequests.get(id)
    if (pending !== undefined) {
      stats.request_duplicate++
      journal({ step: 'compact-request-duplicate', id: safeKey(id), turn: pending.turn, ratio: value.ratio })
      return { ...shape, requested: true, pending: true, duplicate: true, turn: pending.turn, reason: REQUEST_DUPLICATE }
    }
    if (value.ratio !== null && value.ratio <= threshold) {
      // Le fork n'est pas bloque : rien a gagner, et de l'histoire a perdre. Le
      // verrou d'inefficacite tombe ici, parce que la mesure qui le fondait a
      // change.
      if (ineffective.delete(id)) {
        journal({ step: 'compact-request-latch-cleared', id: safeKey(id), ratio: value.ratio, threshold })
      }
      stats.request_useless++
      journal({ step: 'compact-request-below-threshold', id: safeKey(id), ratio: value.ratio, threshold })
      return { ...shape, requested: false, pending: false, duplicate: false, turn: null, reason: REQUEST_USELESS }
    }
    if (ineffective.has(id)) {
      // La PREUVE est faite : cette compaction-la ne fait pas descendre ce ratio.
      const proof = ineffective.get(id)
      stats.request_latched++
      journal({ step: 'compact-request-refused', id: safeKey(id), why: REQUEST_LATCHED, ratio: value.ratio, threshold, provenRatio: proof.ratio })
      return { ...shape, requested: false, pending: false, duplicate: false, turn: null, reason: REQUEST_LATCHED }
    }
    let turn = null
    try {
      turn = openTurnOf(session?.snapshotEvents?.())
    } catch {
      turn = null
    }
    compactRequests.set(id, { turn, ratio: value.ratio, at: Date.now() })
    if (turn === null) {
      stats.request_unbounded++
      journal({ step: 'compact-request-unbounded', id: safeKey(id), why: 'turn/start illisible : la demande se soldera au prochain turn/end' })
    }
    journal({ step: 'compact-requested', id: safeKey(id), turn, ratio: value.ratio, threshold, sources: value.sources })
    return { ...shape, requested: true, pending: true, duplicate: false, turn, reason: REQUEST_PENDING }
  }

  const controller = {
    threshold,
    forkTools,
    stats,
    measureFor,
    /** LA DEMANDE : le seul chemin qui retient une compaction differee. */
    requestCompaction,
    /** Attend les compactions differees en vol — la seule attente qu'un test doit faire. */
    settled: () => Promise.all([...inflight]),
    /** Les demandes en attente, par session — le tour de chacune. */
    compactRequests,
    /** Les sessions dont une compaction DEMANDEE n'a pas fait descendre le ratio. */
    ineffective,
  }

  // ---- 1. L'outil, installe par agent, dans SA surface ----------------------
  const tools = buildTools(controller)
  const install = (agent) => {
    const id = agent?.session?.id
    const target = agent?.ctx
    if (target === undefined) {
      journal({ step: 'install-skipped', why: 'agent-has-no-ctx', id: typeof id === 'string' ? safeKey(id) : null })
      return
    }
    try {
      target.inject(['tools'], (toolCtx) => {
        for (const tool of tools) {
          try {
            toolCtx.tools.register(tool)
            journal({ step: 'registered', id: typeof id === 'string' ? safeKey(id) : null, tool: tool.name })
          } catch (error) {
            journal({ step: 'register-failed', tool: tool.name, error: String(error?.message ?? error) })
          }
        }
      })
    } catch (error) {
      journal({ step: 'install-failed', id: typeof id === 'string' ? safeKey(id) : null, error: String(error?.message ?? error) })
    }
  }
  // 'agent/created' ne rejoue pas pour un agent deja vivant au montage.
  for (const agent of agents?.list?.() ?? []) install(agent)
  ctx.on('agent/created', (payload) => install(payload?.agent ?? payload))

  try {
    if (typeof ctx.provide === 'function') ctx.provide('boostContextBudget', controller)
  } catch (error) {
    journal({ step: 'provide-failed', error: String(error?.message ?? error) })
  }

  // ---- 2. La regle, au moment du fork ---------------------------------------
  //
  // Waterfall : pour tout autre outil on rend 'next()' — un listener qui rend une
  // decision sans appeler 'next()' COUPERAIT la chaine des autres politiques
  // (approbation, sandbox), ce qui serait un degat collateral silencieux.
  ctx.on('tools/pre-execute', async (exec, next) => {
    // Le nom garde vient de la CONFIGURATION ('forkToolNames'). Voir 'FORK_TOOL'
    // pour la LIMITE : le fork se reconnait a son nom, qui est une valeur du
    // preset, et non a son fournisseur — 'exec' n'en porte aucun.
    if (!guarded.has(exec?.name)) return next()
    let verdict
    try {
      verdict = measureFor(exec?.agent?.session)
    } catch (error) {
      journal({ step: 'fork-check-failed', error: String(error?.message ?? error) })
      return next()
    }
    const id = exec?.agent?.session?.id
    if (verdict.ratio === null) {
      // Pas de mesure, pas de refus : on ne devine pas. Et le journal DIT POURQUOI
      // la mesure manque — 'restore-failed' n'est pas 'pas de mesure possible'.
      const failure = verdict.failure ?? { source: verdict.sources?.inherited ?? 'unknown' }
      journal({
        step: 'fork-unguarded',
        id: typeof id === 'string' ? safeKey(id) : null,
        why: failure.source,
        error: failure.error ?? null,
        sources: verdict.sources,
      })
      return next()
    }
    if (verdict.ratio <= threshold) {
      stats.passed++
      return next()
    }
    stats.refused++
    // LE REFUS N'ARME RIEN. Il nommait deja les deux nombres ; il nomme maintenant
    // les TROIS sorties, et la seule qui coute — demander sa compaction — est une
    // DEMANDE explicite du pere (outil 'context_compact'). Armer ici declenchait la
    // compaction MEME quand le pere renoncait au fork pour deleguer avec un brief,
    // et 25 points sous la politique du harnais (0,6 contre 0,85) : une action
    // IRREVERSIBLE prise sans demande, pour un fork qui n'aurait pas lieu.
    const reason = refusalMessage(verdict.inheritedTokens, verdict.windowTokens, verdict.ratio, threshold)
    journal({
      step: 'fork-refused',
      id: typeof id === 'string' ? safeKey(id) : null,
      inheritedTokens: verdict.inheritedTokens,
      windowTokens: verdict.windowTokens,
      ratio: Math.round(verdict.ratio * 10000) / 10000,
      threshold,
      sources: verdict.sources,
    })
    return { kind: 'deny', reason, info: { name: 'ForkRefused', code: REFUSAL_CODE, reason } }
  })

  // ---- 2bis. LE GARDE PAR PROPRIETE, au seam ou le provider EST connu --------
  //
  // 'exec.name === "subagent_fork"' est une VALEUR du preset : le meme provider
  // monte sous un autre nom passe (mesure). Et le NOM est tout ce que
  // 'tools/pre-execute' remet ('dsh-tools/lib/types/index.d.ts:216-242').
  //
  // Ou le provider ET le contexte sont-ils connus tous les deux ? Sur le provider
  // lui-meme : 'SubagentProvider.inheritsParentContext' est une PROPRIETE REQUISE
  // de l'interface ('dsh-subagent/lib/types/types.d.ts:337'), elle vaut 'true'
  // exactement pour un fork ('dsh-subagent-fork-in-process/lib/index.js:44'), et
  // 'start(request)' recoit 'request.parent' — l'agent delegant, donc sa session
  // ('dsh-subagent-in-process-driver/lib/index.js:164-185'). Le registre publie
  // chaque enregistrement ('subagent/provider-added',
  // 'dsh-subagent/lib/index.js:3076-3086').
  //
  // On enveloppe donc 'start' et 'prepareContinuable' des providers qui heritent :
  // le controle ne depend plus d'un nom, il depend de la propriete qui DEFNIT le
  // fork. Le refus est une levee portant le meme message que la garde par outil.
  const GUARDED = Symbol.for('dsh-boost-context-budget.provider-guarded')
  const guardProvider = (provider) => {
    try {
      if (provider === null || typeof provider !== 'object') return
      if (provider.inheritsParentContext !== true) return
      if (provider[GUARDED] === true) return
      let wrapped = 0
      for (const method of ['start', 'prepareContinuable']) {
        const original = provider[method]
        if (typeof original !== 'function') continue
        provider[method] = function guardedDelegation(request) {
          let verdict
          try {
            verdict = measureFor(request?.parent?.session)
          } catch (error) {
            // Une mesure qui jette ne refuse pas : elle delegue et se journalise.
            journal({ step: 'provider-guard-failed', error: String(error?.message ?? error) })
            return original.call(this, request)
          }
          if (verdict.ratio !== null && verdict.ratio > threshold) {
            const reason = refusalMessage(verdict.inheritedTokens, verdict.windowTokens, verdict.ratio, threshold)
            stats.refused++
            journal({
              step: 'fork-refused',
              seam: 'provider',
              provider: typeof provider.name === 'string' ? provider.name : null,
              id: safeKey(request?.parent?.session?.id ?? '?'),
              inheritedTokens: verdict.inheritedTokens,
              windowTokens: verdict.windowTokens,
              ratio: Math.round(verdict.ratio * 10000) / 10000,
              threshold,
              sources: verdict.sources,
            })
            // Le provider declare rendre une PROMESSE : le refus est donc une
            // promesse rejetee, jamais une levee synchrone — un appelant qui fait
            // '.then()' sur 'start' doit voir le refus comme les autres echecs.
            return Promise.reject(new Error(reason))
          }
          return original.call(this, request)
        }
        wrapped++
      }
      if (wrapped === 0) return
      Object.defineProperty(provider, GUARDED, { value: true, enumerable: false, configurable: true })
      stats.provider_guarded++
      journal({ step: 'provider-guarded', provider: typeof provider.name === 'string' ? provider.name : null, methods: wrapped })
    } catch (error) {
      // Un provider gele, ou une propriete non configurable : le garde par nom
      // reste en place, et l'impossibilite est ECRITE plutot que supposee.
      journal({ step: 'provider-guard-unavailable', error: String(error?.message ?? error) })
    }
  }
  ctx.on('subagent/provider-added', (provider) => guardProvider(provider))
  // Les providers DEJA enregistres au montage.
  try {
    const subagents = ctx.get('subagents')
    for (const name of subagents?.list?.() ?? []) guardProvider(subagents.getProvider?.(name))
  } catch (error) {
    journal({ step: 'provider-scan-failed', error: String(error?.message ?? error) })
  }

  // ---- 3. La compaction DEMANDEE, sur 'turn/end' ----------------------------
  //
  // 'turn/end' est le seul instant ou une demande se solde : la trace est publiee
  // par 'session.append' ('dsh-session/lib/index.js:1473'), appelee SYNCHRONEMENT
  // dans le 'finally' de 'runTurn' ('dsh-agent-loop/lib/index.js:1027') — donc
  // AVANT que 'kick' ne ramene la phase a 'idle'
  // ('dsh-agent-loop/lib/index.js:892-899'). A cet instant precis l'agent est
  // encore 'running' et 'runMaintenance' leverait (« already has active work »).
  // La garde attend donc l'inactivite OBSERVEE avant d'appeler 'compactNow', qui
  // prend lui-meme l'agent en maintenance.
  const track = (promise) => {
    // Un suivi ne doit JAMAIS produire un rejet non gere : le processus du
    // harnais ne doit pas mourir d'une compaction qui a echoue.
    const safe = Promise.resolve(promise).catch(() => null)
    inflight.add(safe)
    void safe.finally(() => inflight.delete(safe))
  }

  const waitIdle = async (agent) => {
    if (agent?.status === 'idle') return 'idle'
    if (typeof agent?.whenIdle === 'function') {
      await agent.whenIdle()
      return 'awaited'
    }
    return 'unverified'
  }

  /**
   * LA COMPACTION DEMANDEE, honoree a la fin du tour.
   *
   * Elle rend TOUJOURS la main sans jeter (le suivi l'attrape), et elle REFERME LA
   * BOUCLE : apres coup, on re-mesure. Une compaction qui ne fait pas descendre le
   * ratio est une depense perdue — journalisee ('compact-ineffective', avec les
   * deux valeurs) — et on n'en arme plus aucune : un pere qui ne peut pas descendre
   * ne doit pas payer une compaction par tour.
   */
  const compactAfterTurn = async (id, request) => {
    let agent
    try {
      agent = agents?.get?.(id)
      if (agent === undefined) {
        journal({ step: 'compact-skipped', id: safeKey(id), why: 'no-live-agent' })
        return null
      }
      const compaction = ctx.get('compaction')
      if (typeof compaction?.compactNow !== 'function') {
        journal({ step: 'compact-skipped', id: safeKey(id), why: 'no-compaction-service' })
        return null
      }
      const idle = await waitIdle(agent)
      const result = await compaction.compactNow(agent, new AbortController().signal)
      stats.compacted++
      journal({
        step: 'compact-done',
        id: safeKey(id),
        idle,
        requestedTurn: request?.turn ?? null,
        ratioBefore: request?.ratio ?? null,
        compacted: result != null,
      })
      // LA MESURE QUI FERME LA BOUCLE (voir 'measureAfterCompaction') ; sans
      // chiffre, on ne conclut RIEN (trois etats, jamais deux).
      let after = null
      try {
        after = measureAfterCompaction(agent?.session)
      } catch (error) {
        journal({ step: 'compact-remeasure-failed', id: safeKey(id), error: String(error?.message ?? error) })
      }
      if (after !== null && after.ratio !== null && after.ratio > threshold) {
        stats.compact_ineffective++
        ineffective.set(id, { ratio: after.ratio, threshold, at: new Date().toISOString() })
        journal({
          step: 'compact-ineffective',
          id: safeKey(id),
          ratio: after.ratio,
          ratioBefore: request?.ratio ?? null,
          threshold,
          inheritedTokens: after.inheritedTokens,
          windowTokens: after.windowTokens,
          sources: after.sources,
        })
      } else if (after !== null && after.ratio !== null) {
        // La compaction a fait son travail : plus rien a prouver pour cette
        // session, le verrou d'inefficacite tombe.
        ineffective.delete(id)
      }
      return result
    } catch (error) {
      stats.compact_failed++
      journal({ step: 'compact-failed', id: safeKey(id), error: String(error?.message ?? error) })
      return null
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const id = session?.id
    if (typeof id !== 'string' || id === '') return
    const request = compactRequests.get(id)
    if (request === undefined) return
    // Consommee dans TOUS les cas : une demande ne survit jamais a son tour, et ne
    // peut etre reposee que par une NOUVELLE demande (une compaction par tour,
    // jamais deux).
    compactRequests.delete(id)
    const closing = typeof event.data?.turn === 'number' && Number.isInteger(event.data.turn) ? event.data.turn : null
    if (request.turn !== null && closing !== null && request.turn !== closing) {
      // Le tour de la demande ne s'est JAMAIS ferme (arret, annulation,
      // disparition de l'agent) : ce 'turn/end'-ci appartient a un AUTRE tour.
      // Compacter ici agirait sur une session qui n'a rien a voir avec la demande
      // — on le journalise et on s'arrete la.
      stats.request_orphaned++
      journal({ step: 'compact-request-orphaned', id: safeKey(id), requestedTurn: request.turn, closingTurn: closing })
      return
    }
    track(compactAfterTurn(id, request))
  })

  return controller
}
