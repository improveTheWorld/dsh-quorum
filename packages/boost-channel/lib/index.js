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
 *   - il ne reveille que ce que l'etat justifie. Un enfant qui declare
 *     'question' alors que son etat derive est 'running' est STOCKE et
 *     RETROGRADE : ni reveil, ni injection (regle §6).
 *
 * Le montage est une ligne HOTE dont les outils sont installes PAR AGENT sur
 * 'agent/created' — le motif mesure de 'packages/detached-jobs/lib/index.js'.
 * La raison et la mesure sont dans 'README.md' (question de montage) et dans le
 * probe 'tools/probe-mount.mjs'.
 *
 * Compteurs de sante (regle 12 / §7), exposes par channel.stats() sur le service
 * 'boostChannel' ET ecrits dans le journal du plugin
 * ('plugin-data/dsh-boost-channel/decisions.jsonl') :
 *   posted, read, delivered, wake_sent, wake_refused, truncated, deduped.
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
  const stats = { posted: 0, read: 0, delivered: 0, wake_sent: 0, wake_refused: 0, truncated: 0, deduped: 0 }

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
    journal({ step: 'stats', ...stats })
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
   * wake est le verdict REEL : sent · injected · refused · refused:<pourquoi> · no-owner · self.
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
    const envelope = {
      id,
      from,
      at: new Date(now()).toISOString(),
      kind,
      state,
      to: root,
      target: typeof input.target === 'string' && input.target !== '' ? input.target : null,
      revision: typeof input.revision === 'string' && input.revision !== '' ? input.revision : null,
      verdict: typeof input.verdict === 'string' && input.verdict !== '' ? input.verdict : null,
      summary: clipped.summary,
      payloadRef,
      payloadChars: payloadCharsOf(payloadRef),
      truncated: clipped.truncated,
    }
    const appended = store.append(envelope)
    if (appended.duplicate) {
      stats.deduped++
      counters('post', { id, duplicate: true })
      return { id, state, duplicate: true, wake: 'none' }
    }
    stats.posted++
    if (clipped.truncated) stats.truncated++

    const policy = wakePolicy(kind, state)
    let wake = 'none'
    if (envelope.to === envelope.from) {
      wake = 'self'
    } else if (policy === 'refuse') {
      stats.wake_refused++
      wake = 'refused'
    } else {
      const owner = agents?.get?.(envelope.to)
      if (owner === undefined) {
        stats.wake_refused++
        wake = 'no-owner'
      } else if (policy === 'inject') {
        if (deliver(owner, 'inject', envelope)) {
          stats.delivered++
          wake = 'injected'
        } else {
          stats.wake_refused++
          wake = 'inject-failed'
        }
      } else {
        const gate = limiter.allow(envelope.from, envelope.to)
        if (!gate.ok) {
          stats.wake_refused++
          wake = 'refused:' + gate.why
        } else if (deliver(owner, 'send', envelope)) {
          stats.delivered++
          stats.wake_sent++
          wake = 'sent'
        } else {
          stats.wake_refused++
          wake = 'wake-failed'
        }
      }
    }
    counters('post', { id, kind, state, to: envelope.to, wake, truncated: clipped.truncated, chars: Array.from(clipped.summary).length })
    return { id, state, duplicate: false, wake }
  }

  /**
   * Tire au plus readLimit enveloppes de CET arbre — jamais celles d'un autre.
   * Rend les plus recentes qui correspondent, et les marque lues.
   */
  function read(input = {}) {
    const from = input.from ?? input.root
    if (typeof from !== 'string' || from === '') throw new Error('channel: read without a reading session')
    const root = typeof input.root === 'string' && input.root !== '' ? input.root : (rootOf(from) ?? from)
    const store = storeFor(root)
    let entries = store.load()
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
    stats.read += page.length
    counters('read', { root: safeKey(root), n: page.length })
    return page.map((row) => ({ ...row }))
  }

  return {
    post,
    read,
    stats: () => ({ ...stats }),
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
        + 'une question ne reveille le proprietaire que si l etat derive est blocked (tu t es arrete) — sinon '
        + 'elle est stockee et retrogradee. Rend l id du message.',
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
            wake: { type: 'string', description: 'Verdict du reveil : sent | injected | refused | no-owner | self.' },
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
      description: 'Tire les messages adresses a TON arbre (jamais ceux d un autre). Rend au plus 10 enveloppes, '
        + 'les plus recentes, et les marque lues. Chaque enveloppe porte l id, l emetteur, le kind declare, l etat '
        + 'derive, la cible et la revision du verdict, le resume borne, le CHEMIN de la charge utile et sa taille. '
        + 'Le contenu n est jamais transporte : ouvre payloadRef toi-meme.',
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
  return channel
}
