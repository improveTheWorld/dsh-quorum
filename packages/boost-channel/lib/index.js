/**
 * dsh-boost-channel — le canal de retour du mode Boost.
 *
 * Specification : docs/CANAL.md (sept regles anti-brouillage, retrogradation §6,
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
 *   - il borne la LIVRAISON, jamais l'ECRITURE : deux bourses SEPAREES, celle du
 *     bruit (2 par emetteur ET 4 par arbre et par 300 s, kinds 'decouverte' et
 *     'avancement') et celle du SIGNAL (3 par arbre et par 300 s, kinds 'question',
 *     'resultat', 'echec') — l'ordinaire ne consomme JAMAIS la reservee, donc le
 *     bruit ne peut pas affamer le signal. Un message qui ne peut pas etre livre
 *     est STOCKE quand meme, marque 'throttled: true', et reste tirable par
 *     'channel_read' (regle 1 : tirer, pas pousser) ;
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
 *   wake_pending (jauge : messages en attente d'arret), truncated, deduped,
 *   throttled (messages livres a ZERO) et throttled_by_sender (par emetteur).
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
export const KINDS = ['decouverte', 'avancement', 'question', 'resultat', 'echec']
/**
 * Les cles que la SURFACE de 'channel_post' accepte — et rien d'autre.
 *
 * 'to' et 'root' sont des capacites du SERVICE INTERNE, jamais de la surface :
 * un enfant qui les fournit adresserait un frere, ecrirait dans le magasin d'un
 * autre arbre, et ouvrirait un tour du proprietaire de cet autre arbre (mesure).
 */
export const POST_ARGUMENTS = ['kind', 'summary', 'target', 'revision', 'verdict', 'payloadRef']
/** Les cles que la SURFACE de 'channel_read' accepte — et rien d'autre. */
export const READ_ARGUMENTS = ['since', 'kinds', 'only_unread']
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
 * Fenetre des DEUX bourses de livraison, en millisecondes : 300 s.
 *
 * Cinq minutes, parce que c'est l'ordre de grandeur d'un tour d'enfant mesure
 * (p50 373 s de silence avant l'avis de reglement, CANAL §1). Plus courte, la
 * fenetre laisserait un enfant bavard revenir a plein regime DANS le meme tour
 * de son proprietaire ; plus longue, elle punirait un enfant qui reprend
 * legitimement la parole apres une pause.
 */
export const DELIVERY_WINDOW_MS = 300000

/**
 * Bourse ORDINAIRE ('decouverte', 'avancement'), borne par EMETTEUR : 2
 * livraisons par fenetre.
 *
 * Deux, parce que le proprietaire a besoin de savoir qu'un enfant AVANCE, pas de
 * lire chaque pas. Le troisieme battement du meme enfant dans la meme fenetre est
 * exactement le bruit que la mesure du defaut designe : 200 'avancement' du meme
 * enfant injectaient 200 lignes (~26 000 caracteres) dans le contexte partage.
 */
export const ORDINARY_PER_SENDER = 2

/**
 * Bourse ORDINAIRE, borne par ARBRE : 4 livraisons par fenetre.
 *
 * Quatre, soit DEUX fois la borne par emetteur : c'est la borne qui empeche un
 * seul enfant tres bavard de manger la bourse de ses freres (deux enfants qui
 * parlent saturer l'arbre avant lui). Les DEUX bornes s'appliquent et la plus
 * stricte mord — c'est la seule facon d'avoir a la fois « pas plus de deux
 * battements du meme enfant » et « pas plus de quatre battements dans l'arbre ».
 */
export const ORDINARY_PER_TREE = 4

/**
 * Bourse RESERVEE ('question', 'resultat', 'echec'), borne par ARBRE : 3
 * livraisons par fenetre.
 *
 * C'est la bourse du SIGNAL, et elle n'est JAMAIS consommee par l'ordinaire :
 * le bruit ne peut pas affamer le signal, et un enfant bloque atteint toujours
 * son proprietaire quels que soient les bavardages de ses freres. Trois, parce
 * que trois enfants bloques doivent pouvoir le dire dans la meme fenetre — et
 * parce que c'est deja l'ordre de grandeur du limiteur de reveil (3 reveils par
 * arbre et par 120 s). Les deux dispositifs sont SEPARES : celui-ci borne la
 * LIVRAISON, l'autre la CADENCE des reveils, et un reveil refuse par la cadence
 * ne consomme aucune place ici (et inversement).
 */
export const RESERVED_PER_TREE = 3

/**
 * Bourse RESERVEE, borne par EMETTEUR : AUCUNE — et c'est un choix.
 *
 * Un enfant bloque doit atteindre son proprietaire, et lui opposer une borne par
 * emetteur le punirait d'avoir souvent parle alors que le fait qui compte est
 * qu'il se soit ARRETE. La borne d'arbre (3) suffit a borner le signal : un
 * enfant seul ne peut donc pas depasser trois livraisons reservees par fenetre.
 */
export const RESERVED_PER_SENDER = Number.POSITIVE_INFINITY

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
  // 'echec' est le seul kind qui porte lui-meme l'urgence : une fois l'emetteur
  // arrete, il reveille — quel que soit l'etat constate.
  if (kind === 'echec') return 'wake'
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
 * et ne reveille JAMAIS. Une 'question', un 'resultat' et un 'echec', eux,
 * n'ont de sens qu'une fois l'emetteur arrete — c'est pourquoi leur reveil se
 * decide la, et pas au depot.
 */
export const WAKE_KINDS = ['question', 'resultat', 'echec']

/**
 * Le message est-il eligible a un reveil DIFFERE ?
 *
 * L'eligibilite depend du KIND SEUL, jamais de l'etat. C'est ce qui rend le
 * battement de coeur abordable : un 'avancement' ne reveille personne, MEME si
 * le dernier resultat d'outil de l'emetteur est en erreur (l'etat reste une
 * annotation, il ne promeut pas un kind). Un echec qui doit reveiller se
 * DECLARE, avec le kind 'echec' — il ne s'obtient pas en glissant un etat.
 *
 * @param kind - le kind DECLARE.
 * @returns vrai si le message doit porter 'wake_pending'.
 */
export function isWakeEligible(kind) {
  return WAKE_KINDS.includes(kind)
}

/**
 * La bourse d'un kind : le bruit et le signal ne partagent JAMAIS la meme.
 *
 * 'reserved' pour les kinds eligibles ('question', 'resultat', 'echec'),
 * 'ordinary' pour les autres ('decouverte', 'avancement'). La bourse est une
 * propriete du KIND, pas du chemin de livraison : un 'echec' adresse a soi-meme
 * ne consomme rien (rien n'est livre), mais il ne puise pas non plus dans la
 * bourse du bruit.
 *
 * @param kind - le kind DECLARE.
 * @returns 'reserved' ou 'ordinary' — le nom que le journal porte.
 */
export function deliveryPurseOf(kind) {
  return isWakeEligible(kind) ? 'reserved' : 'ordinary'
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
 * Une bourse de livraison : une fenetre glissante, deux bornes.
 *
 * Une PLACE se consomme quand une livraison a lieu, ou se RESERVE quand la
 * livraison est differee (un message eligible attend l'arret de son emetteur).
 * Une place reservee est RENDUE des que la livraison n'aura pas lieu : sans cela,
 * un message jamais livre gelerait la bourse d'un message qui, lui, compte.
 */
export class DeliveryPurse {
  constructor({ now = () => Date.now(), windowMs = DELIVERY_WINDOW_MS, perSender = 0, perTree = 0 } = {}) {
    this.now = now
    this.windowMs = windowMs
    this.perSender = perSender
    this.perTree = perTree
    this.senders = new Map()
    this.trees = new Map()
  }

  /** Fenetre courante d'une cle, purgee de ce qui en est sorti (motif du limiteur). */
  window_(map, key) {
    const now = this.now()
    const kept = (map.get(key) ?? []).filter((at) => now - at < this.windowMs)
    map.set(key, kept)
    return kept
  }

  /**
   * Places RESTANTES pour ce couple (emetteur, arbre) : la plus stricte des deux
   * bornes mord, donc c'est le minimum des deux restes.
   *
   * @returns un entier >= 0 (une borne infinie ne mord jamais).
   */
  remaining(sender, tree) {
    const mine = this.window_(this.senders, sender).length
    const all = this.window_(this.trees, tree).length
    return Math.max(0, Math.min(this.perSender - mine, this.perTree - all))
  }

  /**
   * Consomme une place (livraison faite, ou livraison RESERVEE).
   *
   * @returns l'instant consomme — 'refund' l'exige pour rendre CETTE place-la.
   */
  consume(sender, tree) {
    const at = this.now()
    this.window_(this.senders, sender).push(at)
    this.window_(this.trees, tree).push(at)
    return at
  }

  /** Rend UNE place : celle consommee a 'at'. Sans effet si la fenetre l'a purgee. */
  refund(sender, tree, at) {
    this.drop_(this.senders, sender, at)
    this.drop_(this.trees, tree, at)
  }

  /** Retire UNE seule occurrence du marqueur : deux places du meme instant valent deux. */
  drop_(map, key, at) {
    const kept = this.window_(map, key)
    const index = kept.indexOf(at)
    if (index >= 0) kept.splice(index, 1)
    map.set(key, kept)
  }
}

/**
 * Les DEUX bourses d'un arbre, separees par construction.
 *
 * C'est un dispositif DISTINCT du limiteur de reveil ('WakeLimiter') : celui-ci
 * borne la CADENCE des reveils, celui-la la LIVRAISON. Un message peut etre
 * livre sans reveiller personne (une injection), et un reveil peut etre refuse
 * par la cadence sans qu'aucune bourse ne soit touchee. Les fusionner ferait
 * dire a l'un des deux autre chose que ce qu'il dit.
 */
export class DeliveryBudget {
  constructor({
    now = () => Date.now(),
    windowMs = DELIVERY_WINDOW_MS,
    ordinaryPerSender = ORDINARY_PER_SENDER,
    ordinaryPerTree = ORDINARY_PER_TREE,
    reservedPerSender = RESERVED_PER_SENDER,
    reservedPerTree = RESERVED_PER_TREE,
  } = {}) {
    this.windowMs = windowMs
    this.ordinary = new DeliveryPurse({ now, windowMs, perSender: ordinaryPerSender, perTree: ordinaryPerTree })
    this.reserved = new DeliveryPurse({ now, windowMs, perSender: reservedPerSender, perTree: reservedPerTree })
  }

  /**
   * L'instantane VISIBLE, tel que 'channel_post' le rend et que le journal
   * l'ecrit : ce qu'il reste a CET appelant pour CET arbre. Un agent qui le voit
   * peut choisir de se taire ; celui qui l'ignore devient un chiffre.
   */
  snapshot(sender, tree) {
    return {
      ordinary: this.ordinary.remaining(sender, tree),
      reserved: this.reserved.remaining(sender, tree),
    }
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

/**
 * Le prochain id de cet emetteur dans CE magasin, seq strictement croissant.
 *
 * L'identite est `<de>:<seq>` — mais elle n'est unique que DANS le magasin ou on
 * la lit, et un emetteur peut ecrire dans deux magasins ('root' de la voie du
 * service interne). Dans ce cas seulement, l'id est qualifie par la racine :
 * `<racine>:<de>:<seq>`. Sans cela, deux messages distincts porteraient la meme
 * chaine dans deux fichiers, et un journal ne pourrait plus les distinguer.
 *
 * @param from - l'emetteur.
 * @param entries - les enveloppes DEJA presentes dans le magasin cible.
 * @param qualifier - la racine, quand le magasin n'est pas celui de l'emetteur.
 * @returns l'identite du prochain message.
 */
export function nextId(from, entries, qualifier = null) {
  let max = 0
  const prefix = (qualifier === null ? '' : qualifier + ':') + from + ':'
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
 * @param deps - '{ home, agents, rootOf, factsOf, now, makeMessage, limiter, budget, journal, maxBytes, keep, readLimit }'.
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
  // Les bourses de LIVRAISON, distinctes du limiteur de reveil (voir la classe).
  const budget = deps.budget ?? new DeliveryBudget({ now })
  const maxBytes = deps.maxBytes ?? channelMaxBytes()
  const keep = deps.keep ?? KEEP_PER_SENDER
  const readLimit = deps.readLimit ?? READ_LIMIT
  const stores = new Map()
  const markers = new Map()
  const stats = {
    posted: 0, read: 0, read_refused: 0, delivered: 0, wake_sent: 0, wake_refused: 0, truncated: 0, deduped: 0,
    // 'throttled' compte les messages livres a ZERO par une bourse epuisee, UNE
    // fois par message (le marqueur de l'enregistrement), et 'throttled_by_sender'
    // dit QUI a ete refuse : un total ne designe pas le brouilleur, un compte par
    // emetteur si.
    throttled: 0,
    throttled_by_sender: {},
  }
  /**
   * Les reveils EN ATTENTE D'ARRET : emetteur -> (id du message -> arbre).
   *
   * L'index est en memoire ; le marqueur 'wake_pending' est, lui, ecrit dans
   * l'enregistrement stocke, donc la consommation survit a un redemarrage. En
   * revanche un processus neuf ne re-evalue pas les attentes laissees par un
   * processus precedent : c'est la limite multi-process deja declaree.
   */
  const pending = new Map()

  /**
   * La cle d'une attente inclut la RACINE : `<de>` -> `<magasin>\u0000<id>`.
   *
   * '<de>:<seq>' n'est unique que dans un magasin ; indexer sur (de, id) faisait
   * donc disparaitre un message quand le meme emetteur en deposait un dans deux
   * magasins avec le meme id (mesure : le second ecrasait le premier, et le
   * message du magasin propre n'etait plus jamais decide). La racine fait partie
   * de l'identite de l'attente, exactement comme elle fait partie de celle du
   * message.
   */
  const pendingKey = (root, id) => String(root) + '\u0000' + String(id)

  function markPending(from, id, root, seat = {}) {
    let mine = pending.get(from)
    if (mine === undefined) pending.set(from, (mine = new Map()))
    // 'reserved' dit si ce message detient une place de la bourse RESERVEE, et
    // 'at' l'instant ou elle a ete consommee : c'est ce couple qui permet de la
    // RENDRE si la livraison n'a finalement pas lieu. 'to' est le destinataire,
    // garde ici pour rendre la place meme si l'enregistrement a ete evince
    // entre-temps par la borne par emetteur.
    mine.set(pendingKey(root, id), {
      id,
      root,
      to: seat.to ?? null,
      reserved: seat.reserved === true,
      at: seat.at ?? null,
    })
  }

  function forgetPending(from, id, root) {
    const mine = pending.get(from)
    if (mine === undefined) return
    mine.delete(pendingKey(root, id))
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

  /**
   * Le message ne peut pas etre LIVRE : il est STOCKE quand meme — marque, compte
   * et journalise. Jamais perdu, jamais muet.
   *
   * Le marqueur 'throttled' est pose dans l'enveloppe AVANT l'ecriture, donc ecrit
   * par la MEME append — jamais par une reecriture apres coup : une reecriture
   * ferait tomber la generation de rotation ('<fichier>.1') et couterait le
   * fichier entier pour un battement refuse. Mesure : le test de rotation a
   * echoue sur la premiere version de ce correctif, qui passait par 'patch'.
   *
   * @param envelope - l'enveloppe, deja stockee.
   * @param purse - la bourse epuisee : 'ordinary' ou 'reserved'.
   */
  function countThrottled(envelope, purse) {
    stats.throttled++
    stats.throttled_by_sender[envelope.from] = (stats.throttled_by_sender[envelope.from] ?? 0) + 1
    const remaining = budget.snapshot(envelope.from, envelope.to)
    journal({
      step: 'throttled',
      id: envelope.id,
      from: envelope.from,
      kind: envelope.kind,
      purse,
      remaining: purse === 'reserved' ? remaining.reserved : remaining.ordinary,
      budget: remaining,
    })
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
   * Depose un message. Rend '{ id, state, duplicate, wake, budget }'.
   *
   * 'wake' est le verdict REEL du depot, et il n'y en a que deux qui decident :
   *   - 'pending' : le message est ELIGIBLE au reveil differe. Aucune decision
   *     n'est prise ici — ni reveil, ni injection, ni retrogradation. Elle le
   *     sera a l'ARRET de l'emetteur (channel.stopped) ;
   *   - 'injected' | 'no-owner' | 'self' : un message qui n'attend rien
   *     ('decouverte', 'avancement') est livre dans le contexte du proprietaire,
   *     sans ouvrir de tour ;
   *   - 'throttled' : la bourse de son kind est epuisee. Le message est STOCKE et
   *     tirable, mais rien n'est appele — et le champ 'budget' dit pourquoi.
   * Le depot ne consomme JAMAIS le limiteur de cadence : le limiteur mord a la
   * re-evaluation, pas ici.
   *
   * LA LIVRAISON, ELLE, EST BORNEE — jamais l'ecriture. Une injection puise dans
   * la bourse ORDINAIRE ('decouverte', 'avancement') et un message eligible
   * RESERVE une place dans la bourse RESERVEE ('question', 'resultat', 'echec').
   * Bourse epuisee : le message est STOCKE quand meme, marque 'throttled: true',
   * compte une fois ('throttled', 'throttled_by_sender') et journalise — il reste
   * tirable par 'channel_read'. Le champ 'budget' rend le restant des DEUX bourses
   * apres ce depot, pour que l'appelant puisse choisir de se taire.
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
    const own = rootOf(from) ?? from
    const root = typeof input.root === 'string' && input.root !== '' ? input.root : own
    const store = storeFor(root)
    const entries = store.load()
    // L'id n'est qualifie par la racine que dans le seul cas ou l'identite locale
    // ne suffit plus : un depot dans un magasin qui n'est pas celui de l'emetteur.
    const id = typeof input.id === 'string' && input.id !== ''
      ? input.id
      : nextId(from, entries, root === own ? null : root)
    const clipped = clipSummary(input.summary)
    const state = deriveState({ kind, ...(input.facts ?? factsOf(from, kind)) })
    const payloadRef = normalisePayloadRef(input.payloadRef)
    // Le destinataire : la racine de l'arbre par defaut, ou une session nommee
    // ('to'). L'adressage est une propriete du message, donc la lecture peut le
    // controler (un enfant ne lit que ce qui lui est adresse).
    const to = typeof input.to === 'string' && input.to !== '' ? input.to : root
    const eligible = to !== from && isWakeEligible(kind)
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
    // Dedup par IDENTITE, et AVANT toute consommation de bourse : un doublon ne
    // depense ni ne reserve rien. Le controle est fait ici, et non par 'append',
    // pour que la decision de livraison puisse etre ecrite DANS l'enregistrement.
    if (entries.some((row) => row.id === id)) {
      stats.deduped++
      counters('post', { id, duplicate: true })
      return { id, state, duplicate: true, wake: 'none', budget: budget.snapshot(from, envelope.to) }
    }
    // LA LIVRAISON EST BORNEE ICI, L'ECRITURE NE L'EST JAMAIS : la decision est
    // prise AVANT l'append pour que 'throttled' soit ecrit par la MEME ecriture.
    const owner = agents?.get?.(envelope.to)
    let wake = 'none'
    let seat = null
    if (eligible) {
      // Une livraison DIFFEREE reserve sa place tout de suite : c'est ce qui rend
      // le champ 'budget' utile a l'appelant AU MOMENT ou il poste. La place est
      // RENDUE a l'arret si la livraison n'a pas lieu (channel.stopped).
      const reserved = budget.reserved.remaining(from, envelope.to) > 0
      seat = { to: envelope.to, reserved, at: reserved ? budget.reserved.consume(from, envelope.to) : null }
      if (!reserved) envelope.throttled = true
      wake = 'pending'
    } else if (envelope.to === envelope.from) {
      wake = 'self'
    } else if (owner === undefined) {
      stats.wake_refused++
      wake = 'no-owner'
    } else if (budget.ordinary.remaining(from, envelope.to) <= 0) {
      envelope.throttled = true
      wake = 'throttled'
    }
    // AUCUNE decision de reveil ici : l'emetteur travaille encore. Un message
    // eligible attend son arret (channel.stopped), et jusque-la il ne reveille
    // personne. Le marqueur 'wake_pending' est ecrit par la meme append.
    const appended = store.append(envelope)
    if (appended.duplicate) {
      // Defensif : la voie normale est deja passee par le controle ci-dessus.
      stats.deduped++
      if (seat?.reserved === true) budget.reserved.refund(from, seat.to, seat.at)
      counters('post', { id, duplicate: true })
      return { id, state, duplicate: true, wake: 'none', budget: budget.snapshot(from, envelope.to) }
    }
    stats.posted++
    if (clipped.truncated) stats.truncated++
    const throttled = envelope.throttled === true
    if (throttled) countThrottled(envelope, deliveryPurseOf(kind))
    if (eligible) {
      markPending(from, id, root, seat)
    } else if (wake === 'none') {
      // Bourse ORDINAIRE : la place se consomme par la livraison ELLE-MEME, donc
      // seule une livraison REELLEMENT faite la depense.
      if (deliver(owner, 'inject', envelope)) {
        stats.delivered++
        budget.ordinary.consume(from, envelope.to)
        wake = 'injected'
      } else {
        stats.wake_refused++
        wake = 'inject-failed'
      }
    }
    counters('post', { id, kind, state, to: envelope.to, wake, throttled, truncated: clipped.truncated, chars: Array.from(clipped.summary).length })
    return { id, state, duplicate: false, wake, budget: budget.snapshot(from, envelope.to) }
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
   * Quatre issues, et elles sont distinctes :
   *   - 'wake'   : le reveil part (sous le limiteur de cadence) et le message est
   *                consomme — il ne sera plus jamais re-evalue (idempotence) ;
   *   - 'refuse' : la retrogradation AU POINT DE DECISION. Le message est
   *                consomme, 'wake_refused' l'enregistre, rien n'est appele ;
   *   - 'throttled' : la bourse RESERVEE etait deja epuisee au depot. Le message
   *                reste stocke et tirable ; il est consomme ici, comme les autres,
   *                et compte dans 'wake_refused' — il a demande un reveil et ne l'a
   *                pas obtenu (metrique §7). 'throttled', lui, a deja compte le
   *                message une fois, au depot ;
   *   - 'inject' : l'etat n'est pas encore celui que le §4 exige ('resultat' dont
   *                l'emetteur s'arrete sans quitter le registre). Le message
   *                RESTE 'wake_pending' : un arret ulterieur — la sortie du
   *                registre, qui derive 'done' — le decidera.
   *
   * Une place RESERVEE que la livraison n'utilise pas est RENDUE a la bourse :
   * sans cela, un message jamais livre gelerait une place pour toute la fenetre,
   * et le bruit affamerait le signal par la bande.
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
    for (const seat of [...mine.values()]) {
      const { id, root } = seat
      const store = storeFor(root)
      const row = store.load().find((entry) => entry.id === id)
      // La place RESERVEE se rend des que la livraison n'aura pas lieu — et
      // seulement la : une place depensee par une livraison faite reste depensee.
      const release = () => {
        if (seat.reserved === true && seat.at !== null) budget.reserved.refund(from, seat.to, seat.at)
      }
      if (row === undefined || row.wake_pending !== true) {
        // Evince par la borne par emetteur, ou deja consomme ailleurs.
        release()
        forgetPending(from, id, root)
        continue
      }
      const policy = wakePolicy(row.kind, state)
      if (policy === 'inject') continue
      // Idempotence : consomme ici veut dire jamais re-evalue.
      evaluated++
      forgetPending(from, id, root)
      let wake = 'refused'
      if (policy === 'wake') {
        const owner = agents?.get?.(row.to)
        if (owner === undefined) {
          wake = 'no-owner'
          release()
        } else if (seat.reserved !== true) {
          // La bourse RESERVEE etait deja epuisee au DEPOT : ce message n'aura pas
          // de livraison. Il reste STOCKE et tirable par channel_read — il n'a pas
          // ete perdu, et il n'est pas compte deux fois dans 'throttled'.
          wake = 'throttled'
        } else {
          const gate = limiter.allow(from, row.to)
          if (!gate.ok) {
            wake = 'refused:' + gate.why
            release()
          } else if (deliver(owner, 'send', { ...row, state, wake_pending: false })) {
            stats.delivered++
            stats.wake_sent++
            sent++
            wake = 'sent'
          } else {
            wake = 'wake-failed'
            release()
          }
        }
      } else {
        // Retrogradation (§6) : la livraison n'aura pas lieu non plus.
        release()
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
    budget,
    journal,
  }
}

/**
 * Ne garde que les cles DECLAREES d'un appel d'outil, et journalise les autres.
 *
 * POURQUOI ICI, ET PAS DANS LE SCHEMA. Le harnais passe 'exec.arguments' tel quel
 * au corps de l'outil ('dsh-tools/lib/index.js:3310') et ne rejette une cle non
 * declaree que si le schema porte 'additionalProperties: false' ('dsh-tools'
 * :467-468). Fermer le schema casserait le tour d'un agent qui hallucine un
 * argument ; le filtrer ici rend l'argument SANS EFFET et le dit au journal.
 *
 * @param channel - le canal, pour le journal.
 * @param tool - le nom de l'outil, journalise tel quel.
 * @param args - les arguments recus, tels quels.
 * @param allowed - les seules cles que le corps a le droit de lire.
 * @returns les arguments declares, et eux seuls.
 */
export function declaredArguments(channel, tool, args, allowed) {
  const kept = {}
  const undeclared = []
  const source = args !== null && typeof args === 'object' ? args : {}
  for (const [key, value] of Object.entries(source)) {
    if (allowed.includes(key)) kept[key] = value
    else undeclared.push(key)
  }
  if (undeclared.length > 0) {
    // Journalise, jamais fatal : le tour de l'appelant continue.
    try {
      channel?.journal?.({ step: 'undeclared-argument', tool, keys: undeclared })
    } catch {
      // Un diagnostic qui casse ce qu'il observe est pire que pas de diagnostic.
    }
  }
  return kept
}

/** Les deux outils du canal, construits sur un canal. */
export function buildTools(channel) {
  return [
    {
      name: 'channel_post',
      description: 'Poste une enveloppe structuree sur le canal de retour vers le proprietaire de ton arbre. '
        + 'Le kind est DECLARE (decouverte | avancement | question | resultat | echec) ; l etat est DERIVE par le '
        + 'runtime. Le resume est borne a 2000 caracteres et tronque visiblement. Ne joins JAMAIS la charge utile : '
        + 'payloadRef est un CHEMIN que le proprietaire tirera s il le veut. Un avancement ou une decouverte ne '
        + 'reveille JAMAIS — meme si ton dernier outil a echoue : pour reveiller, declare le kind echec. Une question, '
        + 'un resultat ou un echec ne reveille PAS au depot — tu travailles encore — mais a ton ARRET, quand ton tour '
        + 'se ferme : la reponse rendue vaut wake=pending, et le reveil se decide la. Ta LIVRAISON est bornee, jamais '
        + 'ton ECRITURE : 2 avancements ou decouvertes par 300 s et par emetteur (4 par arbre), et 3 questions, resultats '
        + 'ou echecs par arbre et par 300 s. La reponse porte budget { ordinary, reserved } : lis-le, et tais-toi quand il '
        + 'tombe a 0 — un message non livre n est PAS perdu (il est stocke, marque throttled, et le proprietaire peut le '
        + 'tirer). Les seuls arguments lus sont '
        + 'kind, summary, target, revision, verdict, payloadRef ; tout autre est ignore et journalise. Rend l id.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KINDS, description: 'Ce que tu declares : decouverte | avancement | question | resultat | echec.' },
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
            id: { type: 'string', description: 'Id du message : <session>:<seq> dans ton arbre.' },
            state: { type: 'string', description: 'Etat DERIVE par le runtime.' },
            duplicate: { type: 'boolean', description: 'Vrai si cet id etait deja stocke.' },
            wake: { type: 'string', description: 'Verdict du depot : pending (reveil differe a ton arret) | injected | throttled (bourse epuisee : stocke, non livre) | no-owner | self | inject-failed | none (doublon).' },
            budget: {
              type: 'object',
              description: 'Restant des DEUX bourses de livraison apres ce depot : ordinary (decouverte, avancement) et reserved (question, resultat, echec). A 0, le prochain message de cette bourse sera stocke mais non livre.',
              properties: {
                ordinary: { type: 'number', description: 'Livraisons ordinaires encore disponibles pour toi dans cet arbre.' },
                reserved: { type: 'number', description: 'Livraisons reservees encore disponibles pour toi dans cet arbre.' },
              },
            },
          },
          required: ['id', 'state', 'duplicate', 'wake', 'budget'],
        },
        render: (_args, value) => [{
          type: 'text',
          text: 'channel_post ' + value.id + ' etat=' + value.state + ' reveil=' + value.wake
            + ' bourse ordinaire=' + (value.budget?.ordinary ?? '?') + ' reservee=' + (value.budget?.reserved ?? '?'),
        }],
      },
      execute: async (args, exec) => {
        const from = exec?.agent?.session?.id
        if (typeof from !== 'string' || from === '') {
          throw new Error('channel_post: aucune session appelante — le message ne peut pas etre adresse.')
        }
        // Le corps ne lit QUE les cles declarees : 'to' et 'root' ne sont pas de
        // la surface, et une cle hallucinee n'a aucun effet.
        return channel.post({ ...declaredArguments(channel, 'channel_post', args, POST_ARGUMENTS), from })
      },
    },
    {
      name: 'channel_read',
      description: 'Tire les messages QUI TE SONT ADRESSES, et rien dautre : le proprietaire de l arbre voit ce '
        + 'qui est adresse a la racine, et tout autre appelant ne voit que ce qui lui est adresse. Un enfant de '
        + 'l arbre obtient donc une page vide — la lecture est refusee, comptee, et ne marque RIEN comme lu. Rend '
        + 'au plus 10 enveloppes, les plus recentes, et les marque lues. Chaque enveloppe porte l id, l emetteur, '
        + 'le kind declare, l etat derive, la cible et la revision du verdict, le resume borne, le CHEMIN de la '
        + 'charge utile et sa taille. Le contenu n est jamais transporte : ouvre payloadRef toi-meme. Les seuls '
        + 'arguments lus sont since, kinds et only_unread ; tout autre est ignore et journalise.',
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
        // Meme frontiere : 'root' ne redirige pas la lecture, et 'from' ne fait
        // pas lire a la place d'un autre — le controle de destinataire tient.
        const envelopes = channel.read({ ...declaredArguments(channel, 'channel_read', args, READ_ARGUMENTS), from })
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
 *
 * Ce motif-la tient a la PORTEE DE L'ENREGISTREMENT ; la livraison des arrets, elle,
 * tient au TAG DE PORTEE — deux mecanismes distincts, mesures par deux probes
 * distincts ('probe-mount.mjs' et 'probe-stop.mjs', section 5).
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
  //
  // CE QUI DECIDE DE LA LIVRAISON N'EST PAS LE NIVEAU DE MONTAGE, MAIS LE TAG DE
  // PORTEE. Correction d'une affirmation fausse de la passe precedente : un
  // listener SANS tag est admis partout, et un listener TAGUE n'est admis que si
  // son tag est sur la chaine de la cle du porteur —
  // 'scopeTarget' ('dsh-scope/lib/index.js:327-337') admet tout contexte sans tag,
  // puis remonte 'scopeParents' depuis la cle. Le porteur du feed de session est
  // 'scopeTarget(session, scopeOf(this.ctx))' ('dsh-session/lib/index.js:1736'),
  // dont la cle est la portee du MAGASIN — aucune quand le magasin est a la
  // racine : un listener tague n'y est donc jamais admis (mesure : 2 contre 0).
  // Une LIGNE HOTE a la racine reste la bonne configuration (elle seule voit
  // 'agents' et tous les agents), mais la raison n'est pas un « niveau » : c'est
  // qu'une ligne montee dans une portee de preset est TAGUEE, et perd le feed.
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
