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
 * Trois pieces, et chacune existe pour une raison mesuree :
 *   1. l'outil 'context_occupancy' rend a l'agent APPELANT
 *      '{ inheritedTokens, windowTokens, ratio, forkThresholdRatio, verdict }'.
 *      Le capitaine l'appelle QUAND IL VEUT, y compris avant de decider ;
 *   2. un listener 'tools/pre-execute' (waterfall) REFUSE 'subagent_fork' quand
 *      'ratio > forkThresholdRatio', avec un message qui nomme les DEUX nombres
 *      et dit quoi faire. Le refus est journalise ('fork-refused') et compte ;
 *   3. la COMPACTION DIFFEREE : un agent qui appelle un outil est 'running',
 *      donc il ne peut pas se compacter lui-meme a cet instant
 *      ('dsh-compaction/lib/types/index.d.ts:57-65' : 'runMaintenance' « throws
 *      synchronously when the agent is already active »). Le refus ARME une
 *      compaction, et c'est le 'turn/end' du meme tour qui la declenche — quand
 *      l'agent n'est plus actif. C'est ce qui rend la regle executable au lieu
 *      de punitive.
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
export const TOOL_NAMES = ['context_occupancy']

/** L'outil que ce paquet garde. Nommee par l'appelant dans sa propre surface. */
export const FORK_TOOL = 'subagent_fork'

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
 * @param value - la valeur brute de la cle 'forkThresholdRatio'.
 * @param journal - sink de journalisation, injecte pour les tests.
 * @returns le seuil effectif, toujours dans [0,1].
 */
export function resolveThreshold(value, journal = () => {}) {
  if (value === undefined) return DEFAULT_FORK_THRESHOLD_RATIO
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
    journal({ step: 'threshold-invalid', value: String(value), fallback: DEFAULT_FORK_THRESHOLD_RATIO })
    return DEFAULT_FORK_THRESHOLD_RATIO
  }
  return numeric
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

/** Somme des noeuds de surface CLOS (seq <= frontiere) sur un champ de prix. */
function sumClosedNodes(nodes, boundary, field) {
  if (!Array.isArray(nodes)) return null
  let total = 0
  for (const node of nodes) {
    const seq = node?.seq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq > boundary) continue
    const price = node[field]
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) total += price
  }
  return total
}

/** Un entier strictement positif, ou rien : la fenetre d'une route. */
function positiveInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** La fenetre du modele de la route : projection d'abord, evenement durable ensuite. */
export function windowOf(services, session, events) {
  try {
    const values = services.sessionProjections?.snapshot?.(session, ['contextPressure'])?.values
    const window = positiveInt(values?.contextPressure?.contextWindow)
    if (window !== null) return { windowTokens: window, source: 'context-pressure' }
  } catch {
    // Une projection qui jette ne doit pas empecher la lecture durable.
  }
  let window = null
  if (Array.isArray(events)) {
    for (const event of events) {
      if (event?.type !== 'request/context') continue
      const candidate = positiveInt(event.data?.contextWindow)
      if (candidate !== null) window = candidate
    }
  }
  return window === null
    ? { windowTokens: null, source: 'unavailable' }
    : { windowTokens: window, source: 'request-context' }
}

/**
 * La taille de CE QU'UN FORK HERITERAIT : les noeuds de surface clos.
 *
 * Deux sources, dans cet ordre, et la source retenue est rendue a l'appelant :
 *   1. 'tokenMeter'.measure(session).nodes -> champ 'tokens' (prix de la ROUTE,
 *      images comprises) ;
 *   2. 'sessionProjections'.stateOf(session, 'contextBreakdown').nodes -> champ
 *      'heuristicTokens' (estimateur fixe du harnais, 4 caracteres/token).
 * Aucune des deux : 'null'. On ne devine pas.
 */
export function inheritedOf(services, session, boundary) {
  if (boundary < 0) return { inheritedTokens: 0, source: 'no-completed-turn' }
  try {
    const measurement = services.tokenMeter?.measure?.(session)
    const total = sumClosedNodes(measurement?.nodes, boundary, 'tokens')
    if (total !== null) return { inheritedTokens: total, source: 'token-meter' }
  } catch {
    // On passe a la source suivante.
  }
  try {
    const state = services.sessionProjections?.stateOf?.(session, 'contextBreakdown')
    const total = sumClosedNodes(state?.nodes, boundary, 'heuristicTokens')
    if (total !== null) return { inheritedTokens: total, source: 'context-breakdown' }
  } catch {
    // Idem.
  }
  return { inheritedTokens: null, source: 'unavailable' }
}

/**
 * La mesure complete, pour une session et les services presents.
 *
 * @param services - '{ tokenMeter?, sessionProjections? }', tous optionnels.
 * @param session - la session mesuree (celle de l'appelant).
 * @param threshold - le seuil effectif de la ligne.
 * @returns '{ inheritedTokens, windowTokens, ratio, forkThresholdRatio, verdict, sources }',
 *   avec 'null' partout ou la mesure n'est pas etablie. 'sources' est DECLARE au
 *   schema de sortie : le registre valide la valeur rendue et rejette toute cle
 *   non declaree ('dsh-tools/lib/index.js:3541-3544').
 */
export function measure(services, session, threshold) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
  const boundary = boundarySeqOf(events)
  const inherited = inheritedOf(services, session, boundary)
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
    sources: { inherited: inherited.source, window: window.source, boundarySeq: boundary },
  }
}

/** Arrondi d'affichage d'un ratio, sans bruit de flottant. */
function percent(ratio) {
  return Math.round(ratio * 100)
}

/**
 * Le message de refus : les DEUX nombres, et ce qu'il faut FAIRE.
 *
 * Refuser sans dire pourquoi serait pire que ne pas refuser : le modele doit
 * pouvoir executer la sortie de secours, et la sortie de secours est ecrite ici.
 */
export function refusalMessage(inheritedTokens, windowTokens, ratio, threshold) {
  return 'fork refuse : ton contexte heritable vaut ' + percent(ratio) + ' % de la fenetre, le seuil est '
    + percent(threshold) + ' % (' + inheritedTokens + ' tokens herites sur ' + windowTokens + '). termine ton tour'
    + ' — la compaction tournera pendant que tu es inactif — puis forke au tour suivant, ou delegue avec'
    + ' subagent_implement et un brief indexe.'
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
      name: 'context_occupancy',
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
        return controller.measureFor(session)
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
  const stats = { measured: 0, refused: 0, passed: 0, compacted: 0, compact_failed: 0, unknown: 0 }
  // Une session dont le tour courant a subi un refus. Un booleen SUFFIT : un
  // refus ne peut naitre que dans un tour, et le tour ne se ferme qu'une fois.
  const refusedThisTurn = new Set()
  const inflight = new Set()

  journal({ step: 'mounted', pid: process.pid, threshold })

  const measureFor = (session) => {
    const value = measure(services, session, threshold)
    stats.measured++
    if (value.verdict === VERDICT_UNKNOWN) stats.unknown++
    return value
  }

  const controller = {
    threshold,
    stats,
    measureFor,
    /** Attend les compactions differees en vol — la seule attente qu'un test doit faire. */
    settled: () => Promise.all([...inflight]),
    refusedThisTurn,
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
    if (exec?.name !== FORK_TOOL) return next()
    let verdict
    try {
      verdict = measureFor(exec?.agent?.session)
    } catch (error) {
      journal({ step: 'fork-check-failed', error: String(error?.message ?? error) })
      return next()
    }
    const id = exec?.agent?.session?.id
    if (verdict.ratio === null) {
      // Pas de mesure, pas de refus : on ne devine pas.
      journal({ step: 'fork-unguarded', id: typeof id === 'string' ? safeKey(id) : null, sources: verdict.sources })
      return next()
    }
    if (verdict.ratio <= threshold) {
      stats.passed++
      return next()
    }
    stats.refused++
    // Le refus ARME la compaction differee du tour courant — c'est elle qui rend
    // la regle executable, puisque l'agent ne peut pas se compacter lui-meme
    // pendant qu'il appelle un outil.
    if (typeof id === 'string' && id !== '') refusedThisTurn.add(id)
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

  // ---- 3. La compaction differee, sur 'turn/end' ----------------------------
  //
  // 'turn/end' est le seul instant ou le refus d'un tour peut etre solde : la
  // trace est publiee par 'session.append' ('dsh-session/lib/index.js:1473'),
  // appelee SYNCHRONEMENT dans le 'finally' de 'runTurn'
  // ('dsh-agent-loop/lib/index.js:1027') — donc AVANT que 'kick' ne ramene la
  // phase a 'idle' ('dsh-agent-loop/lib/index.js:892-899'). A cet instant precis
  // l'agent est encore 'running' et 'runMaintenance' leverait (« already has
  // active work »). La garde attend donc l'inactivite OBSERVEE avant d'appeler
  // 'compactNow', qui prend lui-meme l'agent en maintenance.
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

  const compactAfterTurn = async (id) => {
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
      journal({ step: 'fork-compacted', id: safeKey(id), idle, compacted: result != null })
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
    // Une compaction PAR TOUR, jamais deux : le drapeau est consomme ici, et ne
    // peut etre repose que par un refus du tour SUIVANT.
    if (!refusedThisTurn.delete(id)) return
    track(compactAfterTurn(id))
  })

  return controller
}
