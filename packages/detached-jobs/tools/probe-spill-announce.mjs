// Does the REAL job registry announce the recovery file of a detached job?
//
//   node tools/probe-spill-announce.mjs [harness-node-modules] [plugin-entry]
//
// Why this exists next to `test/*.test.mjs`: those tests drive the producer and the
// retention policy, and `probe-profile-import.mjs` proves the module the host resolves
// still activates — but that probe mounts the plugin over a STUB `jobs` service
// (`{ start: (spec) => … }`), so it can say nothing about what the registry does with the
// spec this plugin hands it. The property under test lives in the registry's own code:
// `job.spillPaths[]` is filled ONLY by the pump's sink
// (`dsh-jobs-local/lib/index.js:483-485`), and the pump exists ONLY for a NON-EMPTY
// `spec.output` array (line 479). A job with `output: []` therefore had no full-output
// path at all: when the ring evicted the head, the model's dropped-output notice ended in
// `full output: (unavailable)` while the complete file sat on disk, uncited.
//
// So this probe mounts the REAL `@deepseek-ai/dsh-jobs-local` registry on a minimal real
// cordis application, mounts this plugin on top of it, drives the installed `run_detached`
// tool through one real PowerShell job, waits for settlement with the registry's own
// `wait()` and its `settled` event, then reads `output.spillPaths` off the projection —
// the exact field `dsh-tool-jobs` renders (`dsh-tool-jobs/lib/index.js:217` passes it to
// `renderModelDelta`, whose notice is `full output: ${spillPaths.join(', ')}`).
//
// Exit 0 only when the announced path is non-empty, exists on disk, and holds more than
// zero bytes. No dependencies beyond Node's builtins and the harness's own modules;
// scratch state lives in the OS temp dir and is removed on the way out.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

/** The session whose headers the root resolution reads; the job is driven as its root. */
const ROOT_SESSION = 'session-root'
/** A delegated child of that root, so the store has the shape resolution walks. */
const CHILD_SESSION = 'session-child'
/** Where the job's command runs. Any real directory will do. */
const JOB_CWD = 'C:\\CodeSource'
/** The command decides the OUTPUT, so the recovery file has a known content. */
const COMMAND = 'Write-Output "PROBE-OK"'

const harnessModules = process.argv[2] ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
const cordisEntry = join(harnessModules, '@deepseek-ai', 'cordis', 'lib', 'index.js')
const registryEntry = join(harnessModules, '@deepseek-ai', 'dsh-jobs-local', 'lib', 'index.js')
// The plugin under test: this checkout's entry, or the module named on the command
// line — which is how a variant (`output: []`, the pre-fix spec) is made to run through
// the SAME probe, so the probe's verdict is shown to follow the line under test.
const pluginEntry = process.argv[3] !== undefined
  ? pathToFileURL(resolve(process.argv[3]))
  : new URL('../lib/index.js', import.meta.url)

/** A throwaway session store: one independent zstd frame per record, header first. */
const scratch = mkdtempSync(join(tmpdir(), 'dsh-probe-spill-'))
const frame = (record) => zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n', 'utf8'))
for (const record of [{ id: ROOT_SESSION }, { id: CHILD_SESSION, parentSession: ROOT_SESSION }]) {
  const dir = join(scratch, 'sessions', 'ws', record.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame({ type: 'session', ...record }), frame({ type: 'turn/start' })]))
}
// BEFORE the plugin is imported: it captures its session directory and its journal path
// at import time, so a store set later would not be the one it reads.
process.env.DSH_HOME = scratch

const failures = []
const say = (label, value) => console.log('PROBE-' + label + ': ' + value)
/** Every fiber this probe creates, disposed in reverse on the way out. */
const fibers = []

try {
  for (const [label, file] of [['cordis', cordisEntry], ['jobs registry', registryEntry], ['plugin', fileURLToPath(pluginEntry)]]) {
    if (!existsSync(file)) throw new Error(`the ${label} module is not installed here: ${file} does not exist`)
  }
  const { Context } = await import(pathToFileURL(cordisEntry).href)
  const registryModule = await import(pathToFileURL(registryEntry).href)
  const Registry = registryModule.LocalJobRegistry ?? registryModule.default
  say('registry-module', `${registryEntry}  (exports: ${Object.keys(registryModule).join(', ')})`)

  const root = new Context()
  const registered = []
  let agent
  const agents = {
    get: (id) => (id === ROOT_SESSION ? agent : undefined),
    list: () => (agent === undefined ? [] : [agent]),
  }
  // `register` installs the tool; `get(name, scope)` is the registry's view API the
  // OWNERSHIP PREDICATE reads on the root's ctx. This probe attaches a controller to the REAL
  // registry just below, so the owner genuinely can collect — the three names are answered for.
  const collection = new Set(['job_output', 'job_kill', 'job_list'])
  const tools = {
    register: (tool) => { registered.push(tool) },
    get: (name) => (collection.has(name) ? { name } : undefined),
  }

  // The two capabilities the harness composes around the registry — the agent registry
  // (ownership resolution) and the tools service (the per-agent surface). Both are REAL
  // cordis services, provided on the root scope, so every deferred `ctx.inject` in the
  // plugin resolves exactly as it does in a composition. Only the tools REGISTRY is a
  // recorder: what it records is the object the plugin installs.
  fibers.push(await root.plugin({ name: 'probe-agents', apply: (ctx) => { ctx.provide('agents', agents) } }))
  fibers.push(await root.plugin({ name: 'probe-tools', apply: (ctx) => { ctx.provide('tools', tools) } }))

  // THE REAL REGISTRY — nothing here is a stub. Config is passed explicitly rather than
  // left to the schema defaults, so a schema this build renames fails loudly right here.
  const registryFiber = await root.plugin(Registry, {
    maxConcurrentJobsPerOwner: 10,
    retainBytes: 256 * 1024,
    settledRetainBytes: 16 * 1024,
    pumpPollMs: 50,
  })
  fibers.push(registryFiber)
  const jobs = registryFiber.ctx.jobs
  if (jobs === undefined) throw new Error('the real registry did not register ctx.jobs')
  say('registry', `${jobs.constructor.name}  start=${typeof jobs.start} read=${typeof jobs.read} wait=${typeof jobs.wait} attachController=${typeof jobs.attachController}`)
  // The controller each collector attaches (`dsh-tool-jobs/lib/index.js:256`); without
  // one, `servesOwner` is false and the registry refuses to start ANY work.
  jobs.attachController('probe-spill-announce')

  // The owner the plugin resolves: a live agent context, because the registry attaches
  // the owner's cleanup as an effect of exactly this context
  // (`dsh-jobs-local/lib/index.js:762-769`), and its scope decides controller reach.
  const agentFiber = await root.plugin({ name: 'probe-owner-scope', apply: () => {} })
  fibers.push(agentFiber)
  agent = { id: ROOT_SESSION, session: { id: ROOT_SESSION }, ctx: agentFiber.ctx }

  // The registry's OWN announcement, captured as the registry emits it — the projection
  // a completion reporter sees, not one this probe reconstructed.
  const announced = []
  jobs.events.subscribe({ owner: ROOT_SESSION }, (event) => { announced.push(event) })

  const detached = await import(pluginEntry.href)
  say('plugin', `${fileURLToPath(pluginEntry)}  inject=${JSON.stringify(detached.inject)}`)
  fibers.push(await root.plugin(detached))

  // The documented per-agent installation path (`agent/created` → `agent.ctx.inject(['tools'])`).
  root.emit('agent/created', { agent, source: 'spawn' })
  for (let tick = 0; tick < 400 && registered.length === 0; tick++) await new Promise((resolve) => setTimeout(resolve, 10))
  if (registered.length === 0) throw new Error('the plugin installed no tool on the agent surface: tools.register was never called')
  const installed = registered[registered.length - 1]
  say('tool', `${installed.name}  calls=${registered.length}  output.render=${typeof installed.output?.render}`)

  const value = await installed.execute(
    { command: COMMAND, cwd: JOB_CWD },
    { agent: { session: { id: ROOT_SESSION } }, cwd: JOB_CWD },
  )
  say('started', JSON.stringify(value))

  // Settlement is awaited through the registry's own API, never by polling a file.
  const settled = await jobs.wait(value.job_id, 30000, ROOT_SESSION)
  const spillPaths = settled.output?.spillPaths ?? []
  say('job', `${settled.id}  status=${settled.status}  detail=${String(settled.detail)}  owner=${String(settled.owner)}`)
  say('output', `total=${settled.output?.total} earliest=${settled.output?.earliest}`)
  say('spillPaths', JSON.stringify(spillPaths))
  const settlement = announced.find((event) => event.type === 'settled' && event.job.id === settled.id)
  if (settlement === undefined) failures.push(`the registry emitted no settled event for ${value.job_id}`)
  else say('settled-event-spillPaths', JSON.stringify(settlement.job.output.spillPaths ?? []))

  if (spillPaths.length === 0) {
    failures.push('the registry announced NO spill file: output.spillPaths is empty, which is the "full output: (unavailable)" case')
  } else {
    const announcedPath = spillPaths[0]
    const exists = existsSync(announcedPath)
    const bytes = exists ? statSync(announcedPath).size : 0
    say('spill.path', announcedPath)
    say('spill.inside-throwaway-store', announcedPath.startsWith(scratch) ? 'yes' : 'NO — the announced path is outside this probe\'s $DSH_HOME')
    say('spill.exists', String(exists))
    say('spill.bytes', String(bytes))
    say('spill.content', exists ? JSON.stringify(readFileSync(announcedPath, 'utf8')) : '(no file at that path)')
    if (!exists) failures.push(`the announced path does not exist on disk: ${announcedPath}`)
    else if (bytes <= 0) failures.push(`the announced path is empty (0 bytes): ${announcedPath}`)
  }
} catch (error) {
  // The exact failure, kept verbatim: a probe that cannot mount the real registry must
  // say where it broke rather than fall back to a substitute that proves nothing.
  failures.push('MOUNT/DRIVE FAILED — ' + String(error?.stack ?? error))
} finally {
  for (const fiber of fibers.reverse()) {
    try { await fiber.dispose() } catch { /* teardown must never mask the verdict */ }
  }
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* the OS reclaims the temp dir anyway */ }
}

if (failures.length > 0) {
  console.log('PROBE-FAIL — ' + failures.join(' ; '))
  process.exit(1)
}
console.log('PROBE-PASS — the real registry announces the recovery file, and the announced file exists with more than zero bytes')
