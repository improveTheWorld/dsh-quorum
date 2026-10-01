// LA QUESTION DE MONTAGE, MESUREE.
//
//   node tools/probe-mount.mjs [harness-node-modules] [plugin-entry]
//
// Pourquoi ce probe existe. Un outil enregistre depuis la portee d'une LIGNE
// n'atteint jamais la surface composee d'un agent : c'est mesure deux fois et
// ecrit dans 'packages/boost-mode/cordis.patch.yml:369-384'. Le canal doit etre
// visible par les ENFANTS, donc la seule voie admissible dans ce perimetre est
// une ligne HOTE qui installe ses outils PAR AGENT sur 'agent/created' — le
// motif de 'packages/detached-jobs/lib/index.js:985-1026'.
//
// Deux choses restaient INCONNUES, et ce probe les mesure au lieu de les
// supposer, parce qu'un test unitaire a surface factice ne peut pas y repondre :
//
//   1. l'ORDRE entre ce listener et 'tools.restrict()'. 'applyChildComposition'
//      ('dsh-subagent/lib/types/child-agent.js:157-172') monte le preset PUIS
//      applique le filtre du role, dans le 'setup' de creation — donc AVANT
//      l'annonce 'agent/created' ('dsh-agent/lib/types/index.js:319-337'). Un
//      outil enregistre apres le filtre est-il encore visible ?
//   2. ce que la MEME composition donne quand le filtre du role est exprime en
//      'allow' au lieu de 'deny' : la reponse est le contre-exemple, et elle est
//      reportee comme telle, jamais tue.
//
// Le probe monte le VRAI registre d'outils ('@deepseek-ai/dsh-tools') sur une
// vraie application cordis, avec deux portees d'agents liees a une portee de
// preset, applique le filtre REEL, monte le plugin en ligne HOTE, annonce
// l'enfant, puis lit 'tools.get(<outil>, <agent>)' — la vue du registre lui-meme.
// Sortie 0 seulement si les deux outils sont sur la surface de l'enfant dans la
// composition a filtre 'deny', ABSENTS d'une lecture sans portee (le niveau
// hote), et si le contre-exemple 'allow' est constate.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harnessModules = process.argv[2]
  ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
const entries = {
  cordis: join(harnessModules, '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  scope: join(harnessModules, '@deepseek-ai', 'dsh-scope', 'lib', 'index.js'),
  tools: join(harnessModules, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
}
const pluginEntry = process.argv[3] !== undefined
  ? resolve(process.argv[3])
  : fileURLToPath(new URL('../lib/index.js', import.meta.url))
const TOOLS = ['channel_post', 'channel_read']
/** Les outils pre-existants du probe : ils servent a prouver que le filtre mord. */
const FIXTURES = ['write', 'edit', 'read', 'present', 'ask_user_question', 'todo_write', 'subagent']
const say = (key, value) => console.log('PROBE-' + key + ': ' + value)
const tick = (ms) => new Promise((done) => setTimeout(done, ms))

/** Le filtre d'un role tel que le preset l'ecrit : une liste de refus. */
const ROLE_DENY = { deny: ['write', 'edit', 'present', 'ask_user_question', 'todo_write', 'subagent'] }

async function scenario(label, filter, ordinal) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-channel-mount-'))
  process.env.DSH_HOME = scratch
  const { Context } = await import(pathToFileURL(entries.cordis).href)
  const { createScope } = await import(pathToFileURL(entries.scope).href)
  const ToolRuntime = (await import(pathToFileURL(entries.tools).href)).default
  const plugin = await import(pathToFileURL(pluginEntry).href + '?probe=' + ordinal)

  const root = new Context()
  const rootAgent = { id: 'session-root', session: { id: 'session-root', header: {} }, status: 'running' }
  const worker = { id: 'session-child', session: { id: 'session-child', header: { parentSession: 'session-root' } }, status: 'running' }
  await root.plugin({
    name: 'probe-agents',
    apply: (ctx) => {
      ctx.provide('agents', {
        get: (id) => (id === 'session-root' ? rootAgent : id === 'session-child' ? worker : undefined),
        list: () => [],
      })
      // 'ToolRuntime' declare 'inject: ["systemPrompt"]' : sans ce service, la
      // ligne ne s'active pas et le registre reste introuvable. C'est la meme
      // dependance que 'probe-owner-gate.mjs' fournit.
      ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 })
    },
  })
  const toolsFiber = await root.plugin(ToolRuntime, { mode: 'native' })
  // La vue du registre s'obtient en DECLARANT l'injection — la lecture par
  // propriete sans 'inject' est refusee, et c'est ce refus que le premier essai
  // de ce probe a rencontre.
  let registry
  await root.plugin({ name: 'probe-tools-view', inject: ['tools'], apply: (ctx) => { registry = ctx.tools } })
  // Les filtres d'un role nomment des outils qui EXISTENT : 'tools.restrict()'
  // refuse un nom global inconnu ("names unknown global tool"). Dans la
  // composition reelle ces noms viennent du preset ; ici ils sont enregistres,
  // sinon le filtre lui-meme echouerait et la mesure ne porterait sur rien.
  await root.plugin({
    name: 'probe-fixtures',
    inject: ['tools'],
    apply: (ctx) => {
      for (const fixture of FIXTURES) {
        ctx.tools.register({
          name: fixture,
          description: 'fixture du probe',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '' }] },
          execute: async () => ({}),
        })
      }
    },
  })
  await tick(30)

  // Les portees : une portee de preset, puis l'agent racine et l'enfant dedans —
  // la forme que 'dsh-agent-preset-registry' compose et que
  // 'applyChildComposition' filtre, dans cet ordre.
  const presetKey = {}
  const preset = createScope(root, presetKey)
  const rootScope = createScope(preset.ctx, rootAgent, { parent: presetKey })
  rootAgent.ctx = rootScope.ctx
  const workerScope = createScope(preset.ctx, worker, { parent: presetKey })
  worker.ctx = workerScope.ctx

  // 1. LE FILTRE DU ROLE, applique AVANT l'annonce — comme le fait le harnais.
  if (filter !== undefined) {
    // 'restrict()' exige une portee : on la prend comme le harnais la prend,
    // depuis un contexte monte SUR la portee de l agent, en declarant l injection.
    let scoped
    await workerScope.ctx.plugin({ name: 'probe-role-filter', inject: ['tools'], apply: (ctx) => { scoped = ctx.tools } })
    scoped.restrict(filter)
    say(label, 'filtre applique avant agent/created: ' + JSON.stringify(filter))
  }

  // 2. LA LIGNE HOTE : le plugin monte ou le profil le monte.
  await root.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
  await tick(30)

  // 3. L'ANNONCE de l'enfant, apres le filtre.
  root.emit('agent/created', { agent: worker, source: 'spawn' })
  await tick(150)

  if (registry === undefined) throw new Error('le registre d outils n a pas ete capture : la composition du probe est invalide')
  // Deux lectures, et la difference compte :
  //   - 'get(nom, agent)' dit si l enregistrement ATTEINT la portee de l agent ;
  //   - 'schemas(agent)' est la SURFACE MODELE, celle ou 'tools.restrict()'
  //     filtre ('view(scope)' applique les restrictions, 'get' ne les applique
  //     pas). Mesurer 'get' seul aurait fait passer un outil masque pour visible.
  const onWorker = TOOLS.filter((tool) => registry.get(tool, worker) !== undefined)
  const onRoot = TOOLS.filter((tool) => registry.get(tool, rootAgent) !== undefined)
  const unscoped = TOOLS.filter((tool) => registry.get(tool) !== undefined)
  const all = registry.schemas(worker).map((schema) => schema.name)
  const surface = TOOLS.filter((tool) => all.includes(tool))
  say(label, 'SURFACE COMPLETE de l enfant: ' + all.join(', '))
  say(label, 'outils ENREGISTRES pour l enfant (get): ' + (onWorker.join(', ') || '(aucun)'))
  say(label, 'outils sur la SURFACE MODELE de l enfant (schemas): ' + (surface.join(', ') || '(aucun)'))
  say(label, 'outils sur la surface de la RACINE: ' + (onRoot.join(', ') || '(aucun)'))
  say(label, 'outils visibles SANS portee (niveau hote): ' + (unscoped.join(', ') || '(aucun)'))
  try { await root.dispose?.() } catch { /* le teardown ne masque jamais le verdict */ }
  const hidden = FIXTURES.filter((fixture) => !all.includes(fixture))
  say(label, 'outils existants masques par le filtre: ' + (hidden.join(', ') || '(aucun)'))
  rmSync(scratch, { recursive: true, force: true })
  return { onWorker, onRoot, unscoped, surface, hidden, all }
}

const failures = []
try {
  for (const [label, file] of [...Object.entries(entries), ['plugin', pluginEntry]]) {
    if (!existsSync(file)) throw new Error('le module ' + label + ' n est pas installe ici : ' + file)
  }
  const noFilter = await scenario('sans-filtre', undefined, 1)
  if (noFilter.onWorker.length !== TOOLS.length) failures.push('sans filtre, les outils ne sont pas sur la surface de l enfant')

  const withDeny = await scenario('filtre-deny', ROLE_DENY, 2)
  // Le filtre a-t-il MORDU ? Sans ce controle, un filtre inerte ferait passer
  // toutes les mesures suivantes pour des preuves (regle : un controle qui
  // devine est pire qu'un controle qui s'abstient).
  const denyLive = withDeny.all.includes('read') && withDeny.hidden.includes('write') && withDeny.hidden.includes('subagent')
  say('filtre-deny', 'le filtre a mordu sur les outils existants: ' + (denyLive ? 'oui' : 'NON'))
  if (!denyLive) failures.push('le filtre deny est reste inerte : la mesure ne prouve rien')
  if (withDeny.surface.length !== TOOLS.length) {
    failures.push('avec le filtre REEL du preset (deny), un outil enregistre APRES restrict() disparait de la surface modele')
  }
  if (withDeny.unscoped.length !== 0) failures.push('un outil est visible SANS portee : la ligne hote aurait enregistre dans le registre global')

  const withAllow = await scenario('filtre-allow', { allow: ['read', 'write', 'edit'] }, 3)
  const allowLive = withAllow.all.includes('write') && withAllow.hidden.includes('subagent')
  say('filtre-allow', 'la liste allow a mordu sur les outils existants: ' + (allowLive ? 'oui' : 'NON'))
  say('observation', 'surface modele = ' + (withAllow.surface.join(', ') || '(aucun)')
    + ' · enregistres apres le filtre = ' + (withAllow.onWorker.join(', ') || '(aucun)'))
  if (!allowLive) failures.push('la liste allow est restee inerte : le contre-exemple ne prouve rien')
  if (withAllow.surface.length !== TOOLS.length) {
    say('observation', 'dans CETTE composition une liste allow masque aussi un enregistrement posterieur')
  }
} catch (error) {
  failures.push('MONTAGE/MESURE EN ECHEC — ' + String(error?.stack ?? error))
}

if (failures.length > 0) {
  console.log('PROBE-FAIL — ' + failures.join(' ; '))
  process.exit(1)
}
console.log('PROBE-PASS — la ligne HOTE installe ses outils PAR AGENT, ils survivent au tools.restrict() du preset (deny), aucun outil n est enregistre au niveau hote')
