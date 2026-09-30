// Does the module the HOST loads still import and activate?
//
//   node tools/probe-profile-import.mjs [path-to-module.js]
//
// Why this exists next to `test/apply.test.mjs`: those tests import
// `../lib/index.js` and therefore prove the CODE. They cannot prove RESOLUTION —
// that the profile junction still points at this checkout, and that the loader
// still finds what it expects there. This deployment has been wrong on exactly
// that seam before, and the symptom was indistinguishable from a broken module:
// `fiberPhase: "failed"` and an empty journal.
//
// So this probe imports the module by the path the host resolves
// (`$DSH_HOME/profiles/<profile>/node_modules/@local/dsh-detached-jobs`), applies it
// to a STRICT stub scope over a throwaway session store — a service is readable only
// where it was injected, as cordis has it — and exits non-zero unless the mount
// completes, the tool is installed with the registry's output contract, and it starts
// a job owned by the ROOT rather than by the caller.
// No dependencies; scratch state lives in the OS temp dir.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profile = process.env.DSH_PROFILE ?? 'web'
const target = process.argv[2] ?? join(home, 'profiles', profile, 'node_modules', '@local', 'dsh-detached-jobs', 'lib', 'index.js')

const scratch = mkdtempSync(join(tmpdir(), 'dsh-detached-probe-'))
const frame = (record) => zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n', 'utf8'))
for (const record of [{ id: 'session-root' }, { id: 'session-child', parentSession: 'session-root' }]) {
  const dir = join(scratch, 'sessions', 'ws', record.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame({ type: 'session', ...record }), frame({ type: 'turn/start' })]))
}

/** A context where an undeclared service throws on the property GET, as cordis does. */
function makeContext(services) {
  return new Proxy(services, {
    get(target, key) {
      if (typeof key === 'symbol' || key === 'then' || key === 'constructor' || key === 'inspect') return undefined
      if (Object.hasOwn(target, key)) return target[key]
      throw new Error('cannot get property "' + String(key) + '" without inject')
    },
  })
}

process.env.DSH_HOME = scratch
const failures = []
try {
  const mod = await import(pathToFileURL(target).href + '?probe=' + Date.now())
  console.log('resolved : ' + target)
  console.log('name     : ' + mod.name + '   inject: ' + JSON.stringify(mod.inject))

  const started = []
  const registered = []
  let created
  const jobs = { start: (spec) => { started.push(spec); return 'pwsh-probe' } }
  // The tools surface, with the TWO methods the plugin now uses. `register` installs the
  // tool; `get(name, scope)` is the registry's own view API
  // (`dsh-tools/lib/types/index.js:615`) and it is what the OWNERSHIP PREDICATE reads on the
  // root's ctx. The three collection tools are answered for, because this probe models a
  // deployment where `dsh-tool-jobs` mounted — without them the tool is withheld by design
  // and the probe would be measuring the refusal instead of the install.
  const collection = new Set(['job_output', 'job_kill', 'job_list'])
  const tools = {
    register: (tool) => registered.push(tool),
    get: (name) => (collection.has(name) ? { name } : undefined),
  }
  /** One agent's own scope: the tools service is reachable only through the documented paths. */
  const agentCtx = () => makeContext({
    get: (name) => (name === 'tools' ? tools : undefined),
    inject: (deps, cb) => {
      if (deps.includes('tools')) cb(makeContext({ tools }))
      return () => {}
    },
  })
  // The live registry: BOTH agents, because the predicate asks it for the ROOT, and a root
  // that is absent is refused (fail-closed) rather than assumed collectable.
  const live = [{ session: { id: 'session-root' }, ctx: agentCtx() }]
  const ctx = makeContext({
    jobs,
    on: (event, handler) => { if (event === 'agent/created') created = handler },
    inject: (deps, cb) => {
      const child = {}
      if (deps.includes('agents')) {
        child.agents = {
          list: () => [...live],
          get: (id) => live.find((entry) => entry.session?.id === id),
        }
      }
      if (deps.includes('commands')) child.commands = { register: () => {} }
      cb(makeContext(child))
      return () => {}
    },
  })
  mod.apply(ctx, undefined)
  console.log('apply    : returned normally')

  const agent = { session: { id: 'session-child' }, ctx: agentCtx() }
  if (typeof created !== 'function') failures.push('no agent/created listener was registered')
  else created({ agent, source: 'spawn' })

  const installed = registered[0]
  if (installed === undefined) failures.push('no tool reached the agent surface')
  else {
    console.log('installed: ' + installed.name + '   output contract: '
      + (typeof installed.output?.render === 'function' && typeof installed.output?.schema === 'object' ? 'present' : 'MISSING'))
    if (typeof installed.output?.render !== 'function') failures.push('the tool declares no output.render')
    const value = await installed.execute({ command: 'echo probe', label: 'probe' }, { agent })
    const spec = started[started.length - 1]
    console.log('value    : ' + JSON.stringify(value))
    console.log('job spec : owner=' + (spec === undefined ? '(none)' : spec.owner))
    if (spec === undefined || spec.owner !== 'session-root') failures.push('the job is not owned by the session root')
    if (value === undefined || value.job_id === undefined) failures.push('execute returned no job id')
  }

  const lines = readFileSync(join(scratch, 'plugin-data', 'dsh-boost-relay', 'decisions.jsonl'), 'utf8').trim().split('\n')
  console.log('journal  : ' + lines.length + ' lines — ' + lines.map((line) => JSON.parse(line).step).join(','))
  for (const step of ['mount', 'capture', 'apply-complete', 'registered']) {
    if (!lines.some((line) => JSON.parse(line).step === step)) failures.push('no ' + step + ' line was written')
  }
  if (lines.some((line) => JSON.parse(line).step === 'apply-failed')) failures.push('the mount reported apply-failed')
} catch (error) {
  failures.push('the module did not activate: ' + String(error && error.message))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log('FAIL — ' + failures.join(' ; '))
  process.exit(1)
}
console.log('PASS — the module the host resolves imports, activates, and starts root-owned jobs')
