/**
 * dsh-boost-channel — le canal de retour du mode Boost.
 *
 * Specification : docs/CANAL.md (six regles anti-brouillage, retrogradation §6,
 * metrique de sante §7) et docs/DECISIONS.md (D8 kind declare / etat derive,
 * D9 les niveaux servent a reveiller, D11 la retrogradation, D12 la metrique
 * definie avant la premiere ligne, D13 structurer l'enveloppe jamais la charge
 * utile).
 *
 * Ce que ce plugin fait, et ce qu'il refuse de faire :
 *   - il STOCKE une enveloppe structuree par message, dans
 *     '$DSH_HOME/plugin-data/dsh-boost-channel/<racine>.jsonl' — un fichier par
 *     ARBRE, donc l'adressage est une propriete du stockage, pas d'un filtre ;
 *   - il ne transporte JAMAIS la charge utile : 'payloadRef' est un CHEMIN, et
 *     le destinataire tire ce qu'il veut (regle 1, « tirer, pas pousser ») ;
 *   - il borne par construction : plafond dur de 2000 caracteres par resume avec
 *     troncature VISIBLE, 50 derniers messages par emetteur, rotation a 8 Mio,
 *     deduplication par identite ('<de>:<seq>'), jamais par texte ;
 *   - il ne reveille QUE ce que l'etat justifie, et cette decision est prise a
 *     l'ARRET de l'emetteur, jamais au depot : un enfant qui poste une question
 *     pendant son tour n'attend pas encore, il continue son tour — il n'attend
 *     qu'a la fin de celui-ci. Un message eligible ('question', 'resultat', ou
 *     un etat 'failed') est donc STOCKE avec 'wake_pending: true' et ne reveille
 *     personne tant qu'aucun arret de son emetteur n'a ete observe (regle §6,
 *     retrogradation prononcee AU POINT DE DECISION) ;
 *   - il n'adresse pas : 'channel_read' ne rend a un appelant que ce qui lui est
 *     adresse ('to'). Un enfant de l'arbre qui appelle l'outil obtient une page
 *     vide et 'read_refused' — jamais les resumes des autres (principe 3).
 *
 * Le montage est une ligne HOTE dont les outils sont installes PAR AGENT sur
 * 'agent/created' — le motif mesure de 'packages/detached-jobs/lib/index.js'.
 * La raison et la mesure sont dans 'README.md' (question de montage) et dans le
 * probe 'tools/probe-mount.mjs'.
 *
 * Compteurs de sante (regle 12 / §7), exposes par channel.stats() sur le service
 * 'boostChannel' ET ecrits dans le journal du plugin
 * ('plugin-data/dsh-boost-channel/decisions.jsonl') :
 *   posted, read, read_refused, delivered, wake_sent, wake_refused,
 *   wake_pending (jauge : messages en attente d'arret), truncated, deduped.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-boost-channel'
export const inject = ['agents']

/** Plafond DUR du resume, en caracteres. Au-dela : troncature visible. */
export const SUMMARY_MAX_CHARS = 2000
/** Nombre de messages conserves par emetteur et par arbre. */
export const KEEP_PER_SENDER = 50
/** Plafond d'enveloppes rendues par un channel_read. */
export const READ_LIMIT = 10
/** Les kinds que l'appelant DECLARE. L'etat, lui, se derive. */
export const KINDS = ['decouverte', 'avancement', 'question', 'resultat']
/** Fenetre du limiteur de cadence. */
export const WAKE_WINDOW_MS = 120000
/** Au plus UN reveil par enfant et par fenetre. */
export const MAX_WAKES_PER_CHILD = 1
/** Au plus TROIS reveils par arbre et par fenetre. */
export const MAX_WAKES_PER_TREE = 3
/** Plafond du fichier d'un arbre, et du journal. */
export const LOG_MAX_BYTES = 8 * 1024 * 1024
/** Un payloadRef est un chemin : au-dela, ce n'est plus un chemin. */
export const PAYLOAD_REF_MAX_CHARS = 4096

/**
 * Plafond effectif d'un fichier, en octets.
 *
 * 8 Mio par defaut, la meme valeur que le journal du relais ; la couture
 * 'DSH_BOOST_CHANNEL_LOG_MAX_BYTES' permet d'exercer la frontiere en kilo-octets
 * dans un test, sur EXACTEMENT le meme chemin de code qu'en production.
 */
export function channelMaxBytes() {
  const override = Number.parseInt(process.env.DSH_BOOST_CHANNEL_LOG_MAX_BYTES ?? '', 10)
  return Number.isInteger(override) && override > 0 ? override : LOG_MAX_BYTES
}

/** Racine du harnais, relue a chaque appel (un test peut la rediriger). */
export function dshHome() {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
}

/** Repertoire du magasin du canal. */
export function storeDir(home = dshHome()) {
  return join(home, 'plugin-data', name)
}

/** Journal du plugin : compteurs et decisions, jamais de charge utile. */
export function journalPath(home = dshHome()) {
  return join(storeDir(home), 'decisions.jsonl')
}

/** Cle de fichier d'un arbre : l'id de la racine, rendu sur. */
export function safeKey(rootId) {
  return String(rootId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

/** Fichier JSONL des messages d'un arbre. */
export function channelFile(rootId, home = dshHome()) {
  return join(storeDir(home), safeKey(rootId) + '.jsonl')
}

/** Fichier des marques de lecture d'un arbre (necessaire a only_unread). */
export function readMarkerFile(rootId, home = dshHome()) {
  return join(storeDir(home), safeKey(rootId) + '.read.jsonl')
}

/**
 * Tronque un resume a 'max' CARACTERES, jamais a un index UTF-16.
 *
 * 'text.slice(0, n)' coupe une paire de substituts en deux quand un caractere
 * astral tombe sur la frontiere, et un substitut isole dans un resultat d'outil
 * tue la session (mesure : 3 journaux sur 182, HTTP 400 INVALID_REQUEST).
 * 'Array.from' compte les points de code, donc la coupe est sure.
 *
 * @param value - le resume, de longueur quelconque.
 * @param max - le plafond, en points de code.
 * @returns '{ summary, truncated }' — la troncature est VISIBLE, jamais muette.
 */
export function clipSummary(value, max = SUMMARY_MAX_CHARS) {
  const text = typeof value === 'string' ? value : ''
  const chars = Array.from(text)
  if (chars.length <= max) return { summary: text, truncated: false }
  return { summary: chars.slice(0, max).join(''), truncated: true }
}

/**
 * L'etat DERIVE — jamais declare par l'appelant (D8).
 *
 * Trois faits seulement, tous constates par le runtime :
 *   - 'failed'  : le dernier resultat d'outil de l'emetteur est en erreur
 *                 (« un enfant en echec a un tool/result en erreur », CANAL §3) ;
 *   - 'done'    : l'emetteur n'est plus vivant dans le registre — il ne produira
 *                 plus rien ;
 *   - 'blocked' : vivant mais pas en cours — il a cesse de produire ;
 *   - 'running' : tout le reste, c'est-a-dire un tour ouvert.
 *
 * @param facts - '{ live, status, failed }' tel que le runtime les constate.
 * @returns l'un des quatre etats derives.
 */
export function deriveState(facts = {}) {
  if (facts.failed === true) return 'failed'
  if (facts.live !== true) return 'done'
  if (facts.status === 'running') return 'running'
  return 'blocked'
}

/**
 * La politique de reveil — le seul enjeu (§4).
 *
 * 'wake'   : ouvre un tour du proprietaire (l'evenement cher).
 * 'inject' : livre dans le contexte du proprietaire, sans reveiller le driver.
 * 'refuse' : la retrogradation (§6) — le message est STOCKE, et rien n'est
 *            appele : ni reveil, ni injection.
 *
 * @param kind - le kind DECLARE.
 * @param state - l'etat DERIVE.
 * @returns 'wake', 'inject' ou 'refuse'.
 */
export function wakePolicy(kind, state) {
  if (state === 'failed') return 'wake'
  if (kind === 'resultat' && state === 'done') return 'wake'
  if (kind === 'question' && state === 'blocked') return 'wake'
  // §6 : une question dont l'etat ne justifie pas le reveil ne reveille pas,
  // et n'est pas injectee non plus — le declaratif ne force rien.
  if (kind === 'question') return 'refuse'
  return 'inject'
}

/**
 * Les kinds dont le reveil peut dependre de l'ARRET de l'emetteur.
 *
 * Un 'avancement' ou une 'decouverte' n'attend rien : il se livre par injection
 * et ne reveille jamais. Une 'question' et un 'resultat', eux, n'ont de sens
 * qu'une fois l'emetteur arrete — c'est pourquoi leur reveil se decide la, et
 * pas au depot.
 */
export const WAKE_KINDS = ['question', 'resultat']

/**
 * Le message est-il eligible a un reveil DIFFERE ?
 *
 * Eligible veut dire : sa depose ne decide rien, et le reveil sera re-evalue a
 * l'arret de l'emetteur. Un kind qui demande ('question', 'resultat'), ou un
 * emetteur dont le dernier resultat d'outil est en erreur — l'echec ne se
 * declare pas, il se constate (CANAL §3).
 *
 * @param kind - le kind DECLARE.
 * @param state - l'etat DERIVE au moment du depot.
 * @returns vrai si le message doit porter 'wake_pending'.
 */
export function isWakeEligible(kind, state) {
  return state === 'failed' || WAKE_KINDS.includes(kind)
}

/**
 * L'etat derive A L'ARRET de l'emetteur — le point de decision du §4.
 *
 * C'est 'deriveState' prive de sa branche 'running', et ce n'est pas un oubli :
 * un arret observe EST la preuve que l'emetteur a cesse de produire pour ce
 * tour. Lire 'status' a cet instant serait un pari — la bascule 'idle' peut
 * suivre l'enregistrement 'turn/end' — donc le fait constate est l'arret lui-meme.
 *
 * @param facts - '{ live, failed }' tel que le runtime les constate.
 * @returns 'failed', 'done' ou 'blocked'.
 */
export function stoppedState(facts = {}) {
  if (facts.failed === true) return 'failed'
  if (facts.live !== true) return 'done'
  return 'blocked'
}

/**
 * Limiteur de cadence : au plus perChild reveil par enfant et perTree par arbre,
 * dans une fenetre glissante de windowMs.
 */
export class WakeLimiter {
  constructor({ now = () => Date.now(), windowMs = WAKE_WINDOW_MS, perChild = MAX_WAKES_PER_CHILD, perTree = MAX_WAKES_PER_TREE } = {}) {
    this.now = now
    this.windowMs = windowMs
    this.perChild = perChild
    this.perTree = perTree
    this.children = new Map()
    this.trees = new Map()
  }

  /** Fenetre courante d'une cle, purgee de ce qui en est sorti. */
  window_(map, key) {
    const now = this.now()
    const kept = (map.get(key) ?? []).filter((at) => now - at < this.windowMs)
    map.set(key, kept)
    return kept
  }

  /**
   * @returns '{ ok: true }' quand le reveil est accorde (et consomme la place),
   *   '{ ok: false, why }' sinon — la raison est journalisee, jamais devinee.
   */
  allow(childId, treeId) {
    const child = this.window_(this.children, childId)
    if (child.length >= this.perChild) return { ok: false, why: 'child-rate' }
    const tree = this.window_(this.trees, treeId)
    if (tree.length >= this.perTree) return { ok: false, why: 'tree-rate' }
    child.push(this.now())
    tree.push(this.now())
    return { ok: true }
  }
}

/**
 * Magasin append-only d'un arbre, borne par construction.
 *
 * Le chemin rapide APPEND une ligne. Quand l'emetteur depasse 'keep' messages,
 * les plus anciens du MEME emetteur sont retires et le fichier est reecrit —
 * c'est la seule reecriture, et elle est exigee par la borne « N derniers par
 * emetteur ». La rotation a maxBytes garde une generation ('<fichier>.1').
 */
export class ChannelStore {
  constructor({ file, maxBytes = LOG_MAX_BYTES, keep = KEEP_PER_SENDER }) {
    this.file = file
    this.maxBytes = maxBytes
    this.keep = keep
  }

  /** Les enveloppes du fichier actif, dans l'ordre d'ecriture. */
  load() {
    let text
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return []
    }
    const out = []
    for (const line of text.split('\n')) {
      if (line === '') continue
      try {
        const row = JSON.parse(line)
        if (row !== null && typeof row === 'object' && typeof row.id === 'string') out.push(row)
      } catch {
        // Une ligne dechiree (ecriture concurrente, disque plein) est ignoree :
        // un journal illisible ne doit pas rendre le canal muet.
      }
    }
    return out
  }

  /** Rotation AVANT l'ecriture, jamais apres : une generation, et rien de perdu. */
  rotateIfFull(incoming) {
    try {
      const size = statSync(this.file).size
      if (size === 0 || size + incoming <= this.maxBytes) return
      rmSync(this.file + '.1', { force: true })
      renameSync(this.file, this.file + '.1')
    } catch {
      // Une rotation impossible coute une generation d'historique, jamais le message.
    }
  }

  appendLine(entry) {
    mkdirSync(dirname(this.file), { recursive: true })
    const line = JSON.stringify(entry) + '\n'
    this.rotateIfFull(Buffer.byteLength(line, 'utf8'))
    appendFileSync(this.file, line, 'utf8')
  }

  /** Reecriture bornee : le fichier ne contient que ce qui est garde. */
  writeAll(entries) {
    mkdirSync(dirname(this.file), { recursive: true })
    const body = entries.map((entry) => JSON.stringify(entry) + '\n').join('')
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, body, 'utf8')
    rmSync(this.file + '.1', { force: true })
    renameSync(tmp, this.file)
  }

  /**
   * Ajoute une enveloppe, ou constate qu'elle est deja la.
   *
   * La deduplication est par IDENTITE (entry.id), jamais par texte (regle 4).
   * @returns '{ entries, duplicate, evicted }'.
   */
  append(entry) {
    const entries = this.load()
    if (entries.some((row) => row.id === entry.id)) return { entries, duplicate: true, evicted: 0 }
    entries.push(entry)
    const mine = entries.filter((row) => row.from === entry.from)
    if (mine.length > this.keep) {
      const drop = new Set(mine.slice(0, mine.length - this.keep).map((row) => row.id))
      const kept = entries.filter((row) => !drop.has(row.id))
      this.writeAll(kept)
      return { entries: kept, duplicate: false, evicted: drop.size }
    }
    this.appendLine(entry)
    return { entries, duplicate: false, evicted: 0 }
  }

  /**
   * Reecrit UNE enveloppe : c'est la consommation d'un reveil differe.
   *
   * Le marqueur 'wake_pending' et l'etat re-derive A L'ARRET sont ecrits dans le
   * meme enregistrement que le message — un redemarrage ne peut donc pas
   * re-evaluer ce qui l'a deja ete. Une enveloppe evincee entre-temps rend null.
   *
   * @param id - l'identite du message (jamais son texte).
   * @param changes - les champs a poser.
   * @returns l'enveloppe reecrite, ou null si elle n'est plus stockee.
   */
  patch(id, changes) {
    const entries = this.load()
    const index = entries.findIndex((row) => row.id === id)
    if (index < 0) return null
    entries[index] = { ...entries[index], ...changes }
    this.writeAll(entries)
    return entries[index]
  }
}

/** Marques de lecture d'un arbre : ce que le proprietaire a deja tire. */
export class ReadMarkers {
  constructor(file) {
    this.file = file
  }

  /** Ensemble des ids deja rendus par un channel_read de cet arbre. */
  ids() {
    const seen = new Set()
    let text
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return seen
    }
    for (const line of text.split('\n')) {
      if (line === '') continue
      try {
        const row = JSON.parse(line)
        if (Array.isArray(row?.ids)) for (const id of row.ids) if (typeof id === 'string') seen.add(id)
      } catch {
        // Idem : une marque illisible rend un message deja lu a nouveau lu.
      }
    }
    return seen
  }

  /** Marque un lot comme lu. Le fichier est borne : au-dela, il est replie. */
  mark(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return
    mkdirSync(dirname(this.file), { recursive: true })
    const line = JSON.stringify({ at: new Date().toISOString(), ids }) + '\n'
    appendFileSync(this.file, line, 'utf8')
    try {
      if (statSync(this.file).size > 1024 * 1024) {
        const folded = JSON.stringify({ at: new Date().toISOString(), ids: [...this.ids()] }) + '\n'
        writeFileSync(this.file, folded, 'utf8')
      }
    } catch {
      // Borner les marques n'est pas une condition de fonctionnement.
    }
  }
}

/** Journal du plugin : append-only, rotation, et JAMAIS d'echec remonte. */
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
    if (size > 0 && size + Buffer.byteLength(line, 'utf8') + 1 > channelMaxBytes()) {
      rmSync(file + '.1', { force: true })
      renameSync(file, file + '.1')
    }
    appendFileSync(file, line + '\n', 'utf8')
  } catch {
    // Un diagnostic qui peut casser ce qu'il observe est pire que pas de diagnostic.
  }
}

/** Le dernier resultat d'outil de chaque session : la seule source de failed. */
export function trackToolResult(lastFailed, exec, result, decision) {
  const id = exec?.agent?.session?.id
  if (typeof id !== 'string' || id === '') return
  const failed = result?.isError === true || decision?.kind === 'block'
  lastFailed.set(id, failed === true)
}

/** Un resume d'une ligne, borne : c'est tout ce qui est POUSSE (§2). */
export function noticeText(envelope, max = 200) {
  const who = String(envelope.from).replace(/^session-/, '').slice(0, 8)
  const clipped = clipSummary(typeof envelope.summary === 'string' ? envelope.summary : '', max)
  return '[canal] ' + envelope.kind + '/' + envelope.state + ' de ' + who
    + ' : ' + clipped.summary.replace(/\s+/g, ' ').trim()
    + ' (id ' + envelope.id + ' — lis avec channel_read)'
}

/** Le dernier maillon d'une chaine d'ancre qui resout un paquet du harnais. */
export function resolveHarnessModule(specifier) {
  const anchors = []
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') anchors.push(process.argv[1])
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') {
    anchors.push(join(process.env.DSH_PROFILE_DIR, 'package.json'))
  }
  anchors.push(join(process.cwd(), 'package.json'))
  for (const anchor of anchors) {
    try {
      return createRequire(anchor).resolve(specifier)
    } catch {
      // Ancre hors de l'installation : on essaie la suivante.
    }
  }
  return undefined
}

let createUserMessage

/** Charge la fabrique du harnais une fois, sans jamais faire echouer le montage. */
export async function loadMessageFactory() {
  if (typeof createUserMessage === 'function') return createUserMessage
  const entry = resolveHarnessModule('@deepseek-ai/dsh-llm')
  if (entry === undefined) return undefined
  try {
    const mod = await import(pathToFileURL(entry).href)
    if (typeof mod.createUserMessage === 'function') createUserMessage = mod.createUserMessage
  } catch {
    // Le repli de defaultMessage prend le relais.
  }
  return createUserMessage
}

/**
 * Fabrique de message par defaut.
 *
 * Le harnais ne publie pas de UserMessage valide a la main : on resout
 * createUserMessage depuis l'installation qui tourne, exactement comme
 * 'packages/boost-relay/lib/index.js'. Un repli litteral existe pour les tests
 * et pour le cas ou la resolution echoue ; il est journalise, jamais silencieux.
 */
export function defaultMessage(envelope) {
  const content = [{ type: 'text', text: noticeText(envelope) }]
  const source = { kind: 'boost-channel', form: 'relay', summary: 'canal ' + envelope.id }
  if (typeof createUserMessage === 'function') return createUserMessage({ content, source })
  return { id: 'boost-channel:' + envelope.id, role: 'user', content, source }
}

/** Le parent durable d'un agent vivant, marche a la racine. Borne a 16 sauts. */
export function liveRootOf(agents, id, maxHops = 16) {
  let current = id
  for (let hop = 0; hop < maxHops; hop++) {
    const parent = agents?.get?.(current)?.session?.header?.parentSession
    if (typeof parent !== 'string' || parent === '' || parent === current) return current
    if (agents?.get?.(parent) === undefined) return parent
    current = parent
  }
  return current
}

/** Le prochain '<de>:<seq>' de cet emetteur, seq strictement croissant. */
export function nextId(from, entries) {
  let max = 0
  const prefix = from + ':'
  for (const row of entries) {
    if (typeof row?.id !== 'string' || !row.id.startsWith(prefix)) continue
    const seq = Number.parseInt(row.id.slice(prefix.length), 10)
    if (Number.isInteger(seq) && seq > max) max = seq
  }
  return prefix + (max + 1)
}

/** Un payloadRef est un CHEMIN : jamais la charge utile (D13). */
export function normalisePayloadRef(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new Error('channel: payloadRef must be a path string')
  if (value.length > PAYLOAD_REF_MAX_CHARS) throw new Error('channel: payloadRef is not a path (too long)')
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error('channel: payloadRef must be a PATH, never the payload itself (a path has no line break)')
  }
  return value
}

/** Taille du fichier pointe, ou null : le lecteur sait ce que le tir coutera. */
export function payloadCharsOf(payloadRef) {
  if (payloadRef === null) return null
  try {
    return statSync(payloadRef).size
  } catch {
    return null
  }
}

/**
 * Le canal. Toutes les dependances sont injectables : c'est ce qui rend chaque
 * regle testable sans harnais, et ce qui rend les falsifications possibles.
 *
 * @param deps - '{ home, agents, rootOf, factsOf, now, makeMessage, limiter, journal, maxBytes, keep, readLimit }'.
 */
export function createChannel(deps = {}) {
  const home = deps.home ?? dshHome()
  const agents = deps.agents
  const now = deps.now ?? (() => Date.now())
  const rootOf = deps.rootOf ?? ((id) => id)
  const factsOf = deps.factsOf ?? (() => ({}))
  const makeMessage = deps.makeMessage ?? defaultMessage
  const journal = deps.journal ?? ((entry) => writeJournal(home, entry))
  const limiter = deps.limiter ?? new WakeLimiter({ now })
  const maxBytes = deps.maxBytes ?? channelMaxBytes()
  const keep = deps.keep ?? KEEP_PER_SENDER
  const readLimit = deps.readLimit ?? READ_LIMIT
  const stores = new Map()
  const markers = new Map()
  const stats = { posted: 0, read: 0, read_refused: 0, delivered: 0, wake_sent: 0, wake_refused: 0, truncated: 0, deduped: 0 }
  /**
   * Les reveils EN ATTENTE D'ARRET : emetteur -> (id du message -> arbre).
   *
   * L'index est en memoire ; le marqueur 'wake_pending' est, lui, ecrit dans
   * l'enregistrement stocke, donc la consommation survit a un redemarrage. En
   * revanche un processus neuf ne re-evalue pas les attentes laissees par un
   * processus precedent : c'est la limite multi-process deja declaree.
   */
  const pending = new Map()

  function markPending(from, id, root) {
    let mine = pending.get(from)
    if (mine === undefined) pending.set(from, (mine = new Map()))
    mine.set(id, root)
  }

  function forgetPending(from, id) {
    const mine = pending.get(from)
    if (mine === undefined) return
    mine.delete(id)
    if (mine.size === 0) pending.delete(from)
  }

  /** Jauge : combien de messages attendent un arret, maintenant. */
  function pendingCount() {
    let total = 0
    for (const mine of pending.values()) total += mine.size
    return total
  }

  /** L'instantane des compteurs, jauge comprise. */
  function snapshot() {
    return { ...stats, wake_pending: pendingCount() }
  }

  function storeFor(root) {
    const key = String(root)
    let store = stores.get(key)
    if (store === undefined) {
      store = new ChannelStore({ file: channelFile(key, home), maxBytes, keep })
      stores.set(key, store)
    }
    return store
  }

  function markersFor(root) {
    const key = String(root)
    let marker = markers.get(key)
    if (marker === undefined) {
      marker = new ReadMarkers(readMarkerFile(key, home))
      markers.set(key, marker)
    }
    return marker
  }

  function counters(step, extra) {
    journal({ step, ...extra })
    journal({ step: 'stats', ...snapshot() })
  }

  /** Livre au proprietaire. Un echec de livraison ne perd jamais le message. */
  function deliver(owner, method, envelope) {
    try {
      const fn = owner?.[method]
      if (typeof fn !== 'function') return false
      const message = makeMessage(envelope)
      if (method === 'send') fn.call(owner, message, 'next-step', true)
      else fn.call(owner, message)
      return true
    } catch (error) {
      journal({ step: 'deliver-failed', method, id: envelope.id, error: String(error?.message ?? error) })
      return false
    }
  }

  /**
   * Depose un message. Rend '{ id, state, duplicate, wake }'.
   *
   * 'wake' est le verdict REEL du depot, et il n'y en a que deux qui decident :
   *   - 'pending' : le message est ELIGIBLE au reveil differe. Aucune decision
   *     n'est prise ici — ni reveil, ni injection, ni retrogradation. Elle le
   *     sera a l'ARRET de l'emetteur (channel.stopped) ;
   *   - 'injected' | 'no-owner' | 'self' : un message qui n'attend rien
   *     ('decouverte', 'avancement') est livre dans le contexte du proprietaire,
   *     sans ouvrir de tour.
   * Le depot ne consomme JAMAIS le limiteur de cadence : le limiteur mord a la
   * re-evaluation, pas ici.
   *
   * @param input - '{ from, kind, summary, root?, to?, target?, revision?, verdict?, payloadRef?, id?, facts? }'.
   */
  function post(input = {}) {
    const from = input.from
    if (typeof from !== 'string' || from === '') throw new Error('channel: post without an emitting session')
    const kind = input.kind
    if (!KINDS.includes(kind)) {
      throw new Error('channel: kind must be one of ' + KINDS.join(' | ') + ', got ' + JSON.stringify(kind))
    }
    const root = typeof input.root === 'string' && input.root !== '' ? input.root : (rootOf(from) ?? from)
    const store = storeFor(root)
    const entries = store.load()
    const id = typeof input.id === 'string' && input.id !== '' ? input.id : nextId(from, entries)
    const clipped = clipSummary(input.summary)
    const state = deriveState({ kind, ...(input.facts ?? factsOf(from, kind)) })
    const payloadRef = normalisePayloadRef(input.payloadRef)
    // Le destinataire : la racine de l'arbre par defaut, ou une session nommee
    // ('to'). L'adressage est une propriete du message, donc la lecture peut le
    // controler (un enfant ne lit que ce qui lui est adresse).
    const to = typeof input.to === 'string' && input.to !== '' ? input.to : root
    const eligible = to !== from && isWakeEligible(kind, state)
    const envelope = {
      id,
      from,
      at: new Date(now()).toISOString(),
      kind,
      state,
      to,
      target: typeof input.target === 'string' && input.target !== '' ? input.target : null,
      revision: typeof input.revision === 'string' && input.revision !== '' ? input.revision : null,
      verdict: typeof input.verdict === 'string' && input.verdict !== '' ? input.verdict : null,
      summary: clipped.summary,
      payloadRef,
      payloadChars: payloadCharsOf(payloadRef),
      truncated: clipped.truncated,
      // Le marqueur n'existe QUE sur un message eligible : c'est la liste des
      // reveils a re-evaluer, et rien d'autre.
      ...(eligible ? { wake_pending: true } : {}),
    }
    const appended = store.append(envelope)
    if (appended.duplicate) {
      stats.deduped++
      counters('post', { id, duplicate: true })
      return { id, state, duplicate: true, wake: 'none' }
    }
    stats.posted++
    if (clipped.truncated) stats.truncated++

    let wake = 'none'
    if (eligible) {
      // AUCUNE decision de reveil ici : l'emetteur travaille encore. Le message
      // attend son arret (channel.stopped), et jusque-la il ne reveille personne.
      markPending(from, id, root)
      wake = 'pending'
    } else if (envelope.to === envelope.from) {
      wake = 'self'
    } else {
      const owner = agents?.get?.(envelope.to)
      if (owner === undefined) {
        stats.wake_refused++
        wake = 'no-owner'
      } else if (deliver(owner, 'inject', envelope)) {
        stats.delivered++
        wake = 'injected'
      } else {
        stats.wake_refused++
        wake = 'inject-failed'
      }
    }
    counters('post', { id, kind, state, to: envelope.to, wake, truncated: clipped.truncated, chars: Array.from(clipped.summary).length })
    return { id, state, duplicate: false, wake }
  }

  /**
   * L'ARRET DE L'EMETTEUR — le point de decision du §4.
   *
   * Appelee quand le runtime constate que l'emetteur a cesse de produire : la
   * fin de son tour (enregistrement 'turn/end' de sa session, feed
   * 'session/event') ou sa sortie du registre ('agent/disposed'). C'est ICI, et
   * nulle part ailleurs, que la table du §4 est appliquee — sur l'etat
   * RE-DERIVE a cet instant.
   *
   * Trois issues, et elles sont distinctes :
   *   - 'wake'   : le reveil part (sous le limiteur de cadence) et le message est
   *                consomme — il ne sera plus jamais re-evalue (idempotence) ;
   *   - 'refuse' : la retrogradation AU POINT DE DECISION. Le message est
   *                consomme, 'wake_refused' l'enregistre, rien n'est appele ;
   *   - 'inject' : l'etat n'est pas encore celui que le §4 exige ('resultat' dont
   *                l'emetteur s'arrete sans quitter le registre). Le message
   *                RESTE 'wake_pending' : un arret ulterieur — la sortie du
   *                registre, qui derive 'done' — le decidera.
   *
   * @param from - l'emetteur qui vient de s'arreter.
   * @param meta - '{ why }' : l'evenement constate, journalise tel quel.
   * @returns '{ from, why, state, evaluated, wake_sent, wake_refused, still_pending }'.
   */
  function stopped(from, meta = {}) {
    const why = typeof meta.why === 'string' && meta.why !== '' ? meta.why : 'stop'
    const mine = pending.get(from)
    if (typeof from !== 'string' || from === '' || mine === undefined || mine.size === 0) {
      return { from, why, state: null, evaluated: 0, wake_sent: 0, wake_refused: 0, still_pending: 0 }
    }
    // L'etat RE-DERIVE a l'arret : c'est le seul instant ou 'blocked' et 'done'
    // sont distinguables pour un meme kind.
    const state = stoppedState(factsOf(from, null))
    let evaluated = 0
    let sent = 0
    let refused = 0
    for (const [id, root] of [...mine]) {
      const store = storeFor(root)
      const row = store.load().find((entry) => entry.id === id)
      if (row === undefined || row.wake_pending !== true) {
        // Evince par la borne par emetteur, ou deja consomme ailleurs.
        forgetPending(from, id)
        continue
      }
      const policy = wakePolicy(row.kind, state)
      if (policy === 'inject') continue
      // Idempotence : consomme ici veut dire jamais re-evalue.
      evaluated++
      forgetPending(from, id)
      let wake = 'refused'
      if (policy === 'wake') {
        const owner = agents?.get?.(row.to)
        if (owner === undefined) {
          wake = 'no-owner'
        } else {
          const gate = limiter.allow(from, row.to)
          if (!gate.ok) {
            wake = 'refused:' + gate.why
          } else if (deliver(owner, 'send', { ...row, state, wake_pending: false })) {
            stats.delivered++
            stats.wake_sent++
            sent++
            wake = 'sent'
          } else {
            wake = 'wake-failed'
          }
        }
      }
      if (wake !== 'sent') {
        stats.wake_refused++
        refused++
      }
      store.patch(id, { state, wake_pending: false })
      journal({ step: 'wake-reeval', id, from, kind: row.kind, to: row.to, state, why, wake })
    }
    counters('stop', { from, why, state, evaluated, wake_sent: sent, wake_refused: refused, pending: pendingCount() })
    return { from, why, state, evaluated, wake_sent: sent, wake_refused: refused, still_pending: pending.get(from)?.size ?? 0 }
  }

  /**
   * Tire au plus readLimit enveloppes de CET arbre — jamais celles d'un autre.
   * Rend les plus recentes qui correspondent, et les marque lues.
   *
   * L'ADRESSAGE EST APPLIQUE ICI, pas seulement au stockage (principe 3) :
   *   - 'input.from' present : le controle porte sur l'APPELANT. Le proprietaire
   *     de l'arbre ('from === root') voit ce qui est adresse a la racine ; tout
   *     autre appelant ne voit QUE ce qui lui est adresse ('row.to === from').
   *     Comme un enfant depose avec 'to: <racine>', un enfant obtient une page
   *     vide — et une page vide pour un non-proprietaire est une lecture REFUSEE :
   *     'read_refused' l'enregistre, aucun marqueur de lecture n'est ecrit, donc
   *     le message reste 'only_unread' VRAI pour le proprietaire ;
   *   - 'input.from' absent : la voie du SERVICE INTERNE ('{ root }'), pour les
   *     tests et l'outillage. Aucun filtre de destinataire n'y est applique.
   *
   * @param input - '{ from?, root?, kinds?, since?, only_unread? }'.
   */
  function read(input = {}) {
    const caller = typeof input.from === 'string' && input.from !== '' ? input.from : null
    const scoped = typeof input.root === 'string' && input.root !== '' ? input.root : null
    if (caller === null && scoped === null) throw new Error('channel: read without a reading session')
    const root = scoped ?? (rootOf(caller) ?? caller)
    const owner = caller === null || caller === root
    const store = storeFor(root)
    let entries = store.load()
    // L'adresse du proprietaire est la RACINE ; celle de tout autre appelant est
    // sa propre session. Un message adresse a un enfant n'est donc rendu qu'a
    // lui — pas au proprietaire, qui l'a ecrit, ni a ses freres.
    const recipient = owner ? root : caller
    entries = entries.filter((row) => row.to === recipient)
    if (Array.isArray(input.kinds) && input.kinds.length > 0) {
      const wanted = new Set(input.kinds)
      entries = entries.filter((row) => wanted.has(row.kind))
    }
    if (typeof input.since === 'string' && input.since !== '') {
      const index = entries.findIndex((row) => row.id === input.since)
      if (index >= 0) entries = entries.slice(index + 1)
      else {
        const cutoff = Date.parse(input.since)
        if (Number.isFinite(cutoff)) entries = entries.filter((row) => Date.parse(row.at) > cutoff)
        else journal({ step: 'read-since-unparsable', since: input.since })
      }
    }
    if (input.only_unread === true) {
      const seen = markersFor(root).ids()
      entries = entries.filter((row) => !seen.has(row.id))
    }
    const page = entries.slice(-readLimit)
    if (page.length > 0) markersFor(root).mark(page.map((row) => row.id))
    if (!owner && page.length === 0) {
      // Un refus silencieux serait indistinguable d'un canal vide.
      stats.read_refused++
      journal({ step: 'read-refused', from: caller, root: safeKey(root), why: 'not-addressee', n: page.length })
    }
    stats.read += page.length
    counters('read', { root: safeKey(root), n: page.length, caller: caller === null ? null : safeKey(caller), owner })
    return page.map((row) => ({ ...row }))
  }

  return {
    post,
    read,
    stopped,
    stats: () => snapshot(),
    storeFor,
    markersFor,
    limiter,
  }
}

/** Les deux outils du canal, construits sur un canal. */
export function buildTools(channel) {
  return [
    {
      name: 'channel_post',
      description: 'Poste une enveloppe structuree sur le canal de retour vers le proprietaire de ton arbre. '
        + 'Le kind est DECLARE (decouverte | avancement | question | resultat) ; l etat est DERIVE par le runtime. '
        + 'Le resume est borne a 2000 caracteres et tronque visiblement. Ne joins JAMAIS la charge utile : '
        + 'payloadRef est un CHEMIN que le proprietaire tirera s il le veut. Un avancement ne reveille personne ; '
        + 'une question ou un resultat ne reveille PAS au depot — tu travailles encore — mais a ton ARRET, quand '
        + 'ton tour se ferme : la reponse rendue vaut wake=pending, et le reveil se decide la. Rend l id du message.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KINDS, description: 'Ce que tu declares : decouverte | avancement | question | resultat.' },
          summary: { type: 'string', description: 'Texte court (2000 caracteres au plus, troncature visible au-dela).' },
          target: { type: 'string', description: 'La cible du verdict (chemin, artefact, session).' },
          revision: { type: 'string', description: 'La revision visee (commit, hash, version).' },
          verdict: { type: 'string', description: 'Ton verdict sur cette cible et cette revision.' },
          payloadRef: { type: 'string', description: 'Un CHEMIN vers la preuve brute — jamais son contenu.' },
        },
        required: ['kind', 'summary'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Id du message : <session>:<seq>.' },
            state: { type: 'string', description: 'Etat DERIVE par le runtime.' },
            duplicate: { type: 'boolean', description: 'Vrai si cet id etait deja stocke.' },
            wake: { type: 'string', description: 'Verdict du depot : pending (reveil differe a ton arret) | injected | no-owner | self.' },
          },
          required: ['id', 'state', 'duplicate', 'wake'],
        },
        render: (_args, value) => [{ type: 'text', text: 'channel_post ' + value.id + ' etat=' + value.state + ' reveil=' + value.wake }],
      },
      execute: async (args, exec) => {
        const from = exec?.agent?.session?.id
        if (typeof from !== 'string' || from === '') {
          throw new Error('channel_post: aucune session appelante — le message ne peut pas etre adresse.')
        }
        return channel.post({ ...args, from })
      },
    },
    {
      name: 'channel_read',
      description: 'Tire les messages QUI TE SONT ADRESSES, et rien dautre : le proprietaire de l arbre voit ce '
        + 'qui est adresse a la racine, et tout autre appelant ne voit que ce qui lui est adresse. Un enfant de '
        + 'l arbre obtient donc une page vide — la lecture est refusee, comptee, et ne marque RIEN comme lu. Rend '
        + 'au plus 10 enveloppes, les plus recentes, et les marque lues. Chaque enveloppe porte l id, l emetteur, '
        + 'le kind declare, l etat derive, la cible et la revision du verdict, le resume borne, le CHEMIN de la '
        + 'charge utile et sa taille. Le contenu n est jamais transporte : ouvre payloadRef toi-meme.',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'Un id deja lu, ou une date ISO : ne rend que ce qui suit.' },
          kinds: { type: 'array', items: { type: 'string', enum: KINDS }, description: 'Restreint aux kinds demandes.' },
          only_unread: { type: 'boolean', description: 'Ne rend que ce qui n a jamais ete rendu a cet arbre.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            count: { type: 'number', description: 'Nombre d enveloppes rendues (10 au plus).' },
            envelopes: { type: 'array', items: { type: 'object' }, description: 'Les enveloppes, de la plus ancienne a la plus recente.' },
          },
          required: ['count', 'envelopes'],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.envelopes, null, 1) }],
      },
      execute: async (args, exec) => {
        const from = exec?.agent?.session?.id
        if (typeof from !== 'string' || from === '') {
          throw new Error('channel_read: aucune session appelante.')
        }
        const envelopes = channel.read({ ...args, from })
        return { count: envelopes.length, envelopes }
      },
    },
  ]
}

/**
 * Monte le canal.
 *
 * LIGNE HOTE, et les outils sont installes PAR AGENT sur 'agent/created' : un
 * outil enregistre depuis la portee d'une ligne n'atteint jamais la surface
 * composee d'un agent (mesure deux fois, voir
 * 'packages/boost-mode/cordis.patch.yml:369-384'). Le motif qui fonctionne est
 * celui de 'packages/detached-jobs/lib/index.js:985-1026'.
 */
export function apply(ctx, config = {}) {
  const agents = ctx.agents
  const lastFailed = new Map()
  const journal = (entry) => writeJournal(config.home ?? dshHome(), entry)
  journal({ step: 'mounted', pid: process.pid, home: config.home ?? dshHome() })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      trackToolResult(lastFailed, exec, result, decision)
    } catch {
      // L'observation ne doit jamais changer la decision qu'elle observe.
    }
    return decision
  }, { prepend: true })

  const channel = createChannel({
    home: config.home,
    agents,
    rootOf: (id) => liveRootOf(agents, id),
    factsOf: (from) => ({
      live: agents?.get?.(from) !== undefined,
      status: agents?.get?.(from)?.status,
      failed: lastFailed.get(from) === true,
    }),
    makeMessage: config.makeMessage,
    maxBytes: config.maxBytes,
    keep: config.keep,
    readLimit: config.readLimit,
  })

  try {
    if (typeof ctx.provide === 'function') ctx.provide('boostChannel', channel)
  } catch (error) {
    journal({ step: 'provide-failed', error: String(error?.message ?? error) })
  }

  void loadMessageFactory()

  const tools = buildTools(channel)
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

  /** L'arret d'un emetteur, observe : jamais une exception remontee du feed. */
  const settle = (id, why) => {
    if (typeof id !== 'string' || id === '') return
    try {
      channel.stopped(id, { why })
    } catch (error) {
      journal({ step: 'stop-failed', id: safeKey(id), why, error: String(error?.message ?? error) })
    }
  }

  // DEUX arrets, et ils ne disent pas la meme chose (probe 'tools/probe-stop.mjs') :
  //   - 'turn/end' (feed 'session/event', @mode emit, sans veto) : l'emetteur a
  //     ferme son tour. Il est vivant, donc l'etat derive est 'blocked' — c'est
  //     l'arret d'un enfant qui RESTE ouvert, celui qui attend une reponse ;
  //   - 'agent/disposed' (@mode emit) : l'emetteur a quitte le registre, donc
  //     l'etat derive est 'done' — le seul arret ou un 'resultat' du §4 se decide.
  // 'turn/end' est indispensable : un enfant bloque n'est jamais dispose, et
  // 'agent/disposed' seul rendrait la ligne 'question' + 'blocked' inatteignable.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    settle(session?.id, 'turn/end')
  })
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent ?? payload
    settle(agent?.session?.id ?? agent?.id, 'agent/disposed')
  })
  return channel
}
