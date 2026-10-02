// Unit tests for the ACTIVATION of the detached-jobs plugin: what happens when the
// host mounts the row. Zero dependencies: `node --test`.
//
//   node --test test/apply.test.mjs
//
// `root.test.mjs` covers ownership resolution. This file covers the half that had NO
// test, and which therefore failed in production four times, silently:
//
//   1. `apply()` raised `ReferenceError: trace is not defined` — the tracing helper was
//      missing from the module — and the catch block that exists precisely to report an
//      activation failure called the same helper, so it raised again and escaped. Both
//      rows sat at `fiberPhase: "failed"` with an empty journal across several restarts.
//   2. `apply()` then raised `cannot get property "agents" without inject`: the module
//      read a service it never declared. Optional chaining does not soften it — the
//      throw happens on the property GET.
//   3. The tool registered, and the registry refused it: `tool "run_detached" must
//      declare output { schema, render, presentationMeta? }`. The row reads `active`
//      and the tool is absent from every surface.
//   4. Earlier still, `register-failed: detachedTool is not defined` — the tool object
//      was declared inside `apply()` while the module-level installer used it.
//
// So the cases below are the ones that decided this design, and the harness is built to
// reproduce the failure mode rather than to accommodate the code:
//
//   - the stub context is STRICT. Services are reachable only when declared, and an
//     undeclared one throws on the property GET, exactly as cordis does. The first
//     version of this file used a plain object, which answered `ctx.agents` happily —
//     so the undeclared access passed here and failed in production instead;
//   - the tool is checked against the registry's own output contract, taken from
//     `dsh-tools/lib/types/index.js:459-466` and `lib/index.js:3616`;
//   - every case reads the JOURNAL the module appends to, because "the row mounted"
//     and "the tool registered" are exactly the facts that were unobservable.
//
// The module reads `DSH_HOME` at import time, so each fixture store is built first and
// the module is imported dynamically afterwards, once per scenario — a distinct query
// string gives each scenario its own module instance, hence its own captured jobs
// service and its own journal.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

/** One zstd frame, the unit a session log is made of. */
const frame = (record) => zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n', 'utf8'))

/** A durable session store holding `records`, each written as its own log file. */
function seedSessions(home, records) {
  for (const record of records) {
    const dir = join(home, 'sessions', 'ws', record.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'session.v4.jsonl.zstd'),
      Buffer.concat([frame({ type: 'session', ...record }), frame({ type: 'turn/start' })]),
    )
  }
}

/** The decisions the plugin appended, parsed. An absent journal reads as no decisions. */
function journalOf(home) {
  const path = join(home, 'plugin-data', 'dsh-boost-relay', 'decisions.jsonl')
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/**
 * A context shaped like the one cordis hands to `apply()`: a service is reachable
 * only where it was injected, and an undeclared one throws on the property GET.
 * Symbol and well-known introspection keys answer `undefined` so the proxy stays
 * transparent to the runtime.
 */
function makeContext(services) {
  return new Proxy(services, {
    get(target, key) {
      if (typeof key === 'symbol') return undefined
      if (key === 'then' || key === 'constructor' || key === 'toJSON' || key === 'inspect') return undefined
      if (Object.hasOwn(target, key)) return target[key]
      throw new Error('cannot get property "' + String(key) + '" without inject')
    },
    has: (target, key) => Object.hasOwn(target, key),
    ownKeys: (target) => Reflect.ownKeys(target),
    getOwnPropertyDescriptor: (target, key) => Object.getOwnPropertyDescriptor(target, key),
  })
}

/**
 * The agent registry as a composition provides it: `list()` for the mount, and `get(id)`
 * for the live lookup the ownership predicate makes. Modelled after
 * `dsh-agent/lib/index.js:594-614`, where `get` answers only for a LIVE agent — which is
 * why a fixture that wants "the root is not here" simply leaves it out of `live`.
 * @param live - the agents currently registered.
 */
function makeAgents(live = []) {
  return {
    list: () => [...live],
    get: (id) => live.find((agent) => agent?.session?.id === id),
  }
}

/**
 * A context as the loader hands one to `apply`.
 * @param options.jobs - `null` means "this scope has no jobs service".
 * @param options.onThrows - makes the mount fail at its first subscription.
 * @param options.existingAgents - agents that already exist when the row mounts.
 * @param options.shell - the shell service, when the deployment has a shell row.
 */
function makeCtx(options = {}) {
  const agents = makeAgents(options.existingAgents ?? [])
  const state = { started: [], registered: [], commands: [], injected: [], events: [], created: undefined }
  const jobs = options.jobs === null
    ? undefined
    : (options.jobs ?? { start: (spec) => { state.started.push(spec); return 'pwsh-test-1' } })
  const services = {
    // `on` and `inject` belong to every context, not to a service.
    on: (event, handler) => {
      if (options.onThrows === true) throw new Error('boom: this scope has no on()')
      state.events.push(event)
      if (event === 'agent/created') state.created = handler
    },
    inject: (deps, cb) => {
      state.injected.push(deps)
      // A deferred injection whose service never arrives NEVER calls back — that is what
      // "deferred" means, and it is the case the "no shell service" scenario models. A
      // context that answered a shell request without the service would model something
      // cordis does not produce.
      if (deps.includes('shell') && options.shell === undefined) return () => {}
      const child = {}
      if (deps.includes('agents')) child.agents = agents
      if (deps.includes('commands')) child.commands = { register: (command) => state.commands.push(command) }
      if (deps.includes('tools')) child.tools = { register: (tool) => state.registered.push(tool) }
      if (deps.includes('jobs') && jobs !== undefined) child.jobs = jobs
      if (deps.includes('shell') && options.shell !== undefined) child.shell = options.shell
      cb(makeContext(child))
      return () => {}
    },
  }
  // Always present, even when undefined: `jobs: null` models a DECLARED service that
  // resolved to nothing, which is the branch the tool's guard exists for. Omitting the
  // key would model a scope that never declared it, and cordis would then refuse the
  // mount before `apply()` ran — a different case, the one the hard `inject` list covers.
  services.jobs = jobs
  return { ctx: makeContext(services), state }
}

/**
 * One Agent whose own scope provides the tools service, and nothing else.
 *
 * The ownership predicate reads the ROOT's surface through `ctx.get('tools')` and
 * `tools.get(name, scope)` (the registry's own view API, `dsh-tools/lib/types/index.js:615`),
 * so each fixture declares which names ITS surface resolves. `knows` is held by reference
 * on purpose: a case can withdraw a name and watch the verdict follow.
 *
 * @param sessionId - this agent's session id.
 * @param registered - receives the tools registered into this agent's surface.
 * @param options.knows - the tool names this agent's surface can resolve.
 * @param options.withoutToolsService - the agent has a ctx, but no tools service reaches it.
 */
function makeAgent(sessionId, registered, options = {}) {
  const service = {
    register: (tool) => registered.push(tool),
    // The real per-scope view is a function of the SCOPE too; a fixture only has to answer
    // whether this surface knows the name it is asked about.
    get: (name) => (options.knows?.has(name) === true ? { name } : undefined),
  }
  return {
    session: { id: sessionId },
    ctx: makeContext({
      get: (name) => (name === 'tools' && options.withoutToolsService !== true ? service : undefined),
      inject: (deps, cb) => {
        if (!deps.includes('tools') || options.withoutToolsService === true) return () => {}
        cb(makeContext({ tools: service }))
        return () => {}
      },
    }),
  }
}

const homeA = mkdtempSync(join(tmpdir(), 'dsh-detached-a-'))
const homeB = mkdtempSync(join(tmpdir(), 'dsh-detached-b-'))
const homeC = mkdtempSync(join(tmpdir(), 'dsh-detached-c-'))
const homeD = mkdtempSync(join(tmpdir(), 'dsh-detached-d-'))
// Scenario E: the shell service. TWO homes, because the tool is registered by the FIRST
// mount of a module instance and its `shellProbe` is captured there — "with a shell row"
// and "without one" cannot be two mounts of one instance, and two mounts sharing a journal
// could not be told apart anyway.
const homeE = mkdtempSync(join(tmpdir(), 'dsh-detached-e-'))
const homeF = mkdtempSync(join(tmpdir(), 'dsh-detached-f-'))
// Every scenario that registers the tool needs a durable root to resolve — including C,
// whose subject is the journal: without the store the predicate refuses before it can write.
for (const home of [homeA, homeB, homeC, homeE, homeF]) {
  seedSessions(home, [
    { id: 'session-root' },
    { id: 'session-child', parentSession: 'session-root' },
  ])
}
// T1..T4: the OWNERSHIP PREDICATE. Four independent module instances, because each one
// needs a different root surface and the predicate is read once per agent at registration.
const homeG = mkdtempSync(join(tmpdir(), 'dsh-detached-g-'))
const homeH = mkdtempSync(join(tmpdir(), 'dsh-detached-h-'))
const homeI = mkdtempSync(join(tmpdir(), 'dsh-detached-i-'))
const homeJ = mkdtempSync(join(tmpdir(), 'dsh-detached-j-'))
for (const home of [homeG, homeH, homeI, homeJ]) {
  seedSessions(home, [
    { id: 'session-root' },
    { id: 'session-child', parentSession: 'session-root' },
    // A second child of the same root: T3 needs two workers whose own surfaces differ.
    { id: 'session-sibling', parentSession: 'session-root' },
  ])
}

// ---------------------------------------------------------------------------------------
// T-S1..T-S5: the OWNER FALLBACK — a session CONTINUED after a restart.
//
// The parent such a session inherits from the durable headers is the session of the PREVIOUS
// process: it is seeded (`isSeeded`, `delegationDepth: 0`) and that parent will never come
// back. The header walk is right about the shape of the tree and wrong about the owner, so
// every device that walked to it fell. Measured, relay journal, 2026-10-02 19:31 and 19:34:
//
//   {"step":"register-skipped","why":"root-agent-unknown","id":"7fa9e670","root":"018354d9"}
//   {"step":"register-skipped","why":"root-agent-unknown","id":"00ce339d","root":"018354d9"}
//
// `7fa9e670` is the continued session (the user's), `00ce339d` the child it had just created,
// and `018354d9` the dead session both descend from — so `run_detached` was refused at the root
// itself, and no test covered it. FIVE homes, because the fallback reads the LIVE registry,
// which is module-level state: two scenarios cannot share a module instance.
// ---------------------------------------------------------------------------------------
const homeS1 = mkdtempSync(join(tmpdir(), 'dsh-detached-s1-'))
const homeS2 = mkdtempSync(join(tmpdir(), 'dsh-detached-s2-'))
const homeS3 = mkdtempSync(join(tmpdir(), 'dsh-detached-s3-'))
const homeS4 = mkdtempSync(join(tmpdir(), 'dsh-detached-s4-'))
const homeS5 = mkdtempSync(join(tmpdir(), 'dsh-detached-s5-'))
// T-S1: a LIVE header root — the non-regression case. The CALLER is live too, so a resolution
// that took the nearest live agent instead of the highest would answer `child` and be caught.
seedSessions(homeS1, [
  { id: 'session-root' },
  { id: 'session-child', parentSession: 'session-root' },
])
// T-S2: the measured shape — the continued session itself, whose header parent is dead.
seedSessions(homeS2, [
  { id: 'session-dead' },
  { id: 'session-alive', parentSession: 'session-dead' },
])
// T-S3: a chain of three, dead root, MIDDLE alive — the shape `00ce339d` measured.
seedSessions(homeS3, [
  { id: 'session-dead' },
  { id: 'session-middle', parentSession: 'session-dead' },
  { id: 'session-leaf', parentSession: 'session-middle' },
])
// T-S4: BOTH paths in ONE journal — a live root and a dead one — so 'the fallback is
// journalled' and 'a normal resolution writes no such line' are read off the same file.
seedSessions(homeS4, [
  { id: 'session-root' },
  { id: 'session-child', parentSession: 'session-root' },
  { id: 'session-dead' },
  { id: 'session-orphan', parentSession: 'session-dead' },
])
// T-S5: the dead root with NO live agent anywhere — the behaviour must not have moved.
seedSessions(homeS5, [
  { id: 'session-dead' },
  { id: 'session-orphan', parentSession: 'session-dead' },
])

// Scenario C: the journal path exists and is NOT writable, because it is a directory.
mkdirSync(join(homeC, 'plugin-data', 'dsh-boost-relay', 'decisions.jsonl'), { recursive: true })

process.env.DSH_HOME = homeA
const A = await import('../lib/index.js?scenario=primary')
process.env.DSH_HOME = homeB
const B = await import('../lib/index.js?scenario=no-jobs-service')
process.env.DSH_HOME = homeC
const C = await import('../lib/index.js?scenario=dead-journal')
process.env.DSH_HOME = homeD
const D = await import('../lib/index.js?scenario=failing-mount')
process.env.DSH_HOME = homeE
const E = await import('../lib/index.js?scenario=shell-service')
process.env.DSH_HOME = homeF
const F = await import('../lib/index.js?scenario=no-shell-service')
process.env.DSH_HOME = homeG
const G = await import('../lib/index.js?scenario=t1-owner-can-collect')
process.env.DSH_HOME = homeH
const H = await import('../lib/index.js?scenario=t2-owner-cannot-collect')
process.env.DSH_HOME = homeI
const I = await import('../lib/index.js?scenario=t3-owner-decides')
process.env.DSH_HOME = homeJ
const J = await import('../lib/index.js?scenario=t4-owner-unfindable')
process.env.DSH_HOME = homeS1
const S1 = await import('../lib/index.js?scenario=ts1-live-root')
process.env.DSH_HOME = homeS2
const S2 = await import('../lib/index.js?scenario=ts2-dead-root')
process.env.DSH_HOME = homeS3
const S3 = await import('../lib/index.js?scenario=ts3-middle-alive')
process.env.DSH_HOME = homeS4
const S4 = await import('../lib/index.js?scenario=ts4-fallback-journal')
process.env.DSH_HOME = homeS5
const S5 = await import('../lib/index.js?scenario=ts5-nothing-live')

test.after(() => {
  for (const home of [homeA, homeB, homeC, homeD, homeE, homeF, homeG, homeH, homeI, homeJ, homeS1, homeS2, homeS3, homeS4, homeS5]) {
    rmSync(home, { recursive: true, force: true })
  }
})

let primaryMount
/** The one and only first mount of instance A, shared by the cases that need one. */
function primary() {
  if (primaryMount === undefined) {
    const made = makeCtx()
    A.apply(made.ctx, undefined)
    primaryMount = made
  }
  return primaryMount
}

let rootOfA
/**
 * The ROOT agent of this scenario, announced once.
 *
 * It has to be announced for ANY surface to receive the tool: the ownership predicate reads
 * the root's own surface, so a scenario that never announces a root exercises the
 * fail-closed branch and nothing else (T4 does exactly that, deliberately).
 */
function rootAgent() {
  if (rootOfA === undefined) {
    rootOfA = makeAgent('session-root', [], { knows: new Set(['job_kill']) })
    primary().state.created({ agent: rootOfA, source: 'startup' })
  }
  return rootOfA
}

let toolOfA
/** `run_detached` as installed into an Agent's surface, through the agent/created envelope. */
function installedTool() {
  if (toolOfA === undefined) {
    rootAgent()
    const registered = []
    primary().state.created({ agent: makeAgent('session-child', registered), source: 'spawn' })
    toolOfA = registered[0]
  }
  return toolOfA
}

let toolOfB

test('a first mount completes against a strict context', () => {
  // The production failures were a missing helper, an undeclared service read, and a
  // tool object out of the installer's scope. All three are loud here.
  assert.doesNotThrow(() => { primary() })
})

test('the journal names the mount and the capture: the row is no longer silent', () => {
  primary()
  const lines = journalOf(homeA)
  const captures = lines.filter((line) => line.step === 'capture')
  assert.equal(captures.length, 1, 'exactly one mount may capture the unscoped service')
  assert.equal(captures[0].via, 'first-mount')
  assert.equal(lines.filter((line) => line.step === 'apply-complete').length, 1)
  assert.equal(lines.filter((line) => line.step === 'mount').length, 1)
  // The deferred agent enumeration: the request and its answer are both recorded, so
  // a service that never arrives is visible instead of silent.
  assert.equal(lines.filter((line) => line.step === 'agents-inject-requested').length, 1)
  assert.equal(lines.filter((line) => line.step === 'agents-ready').length, 1)
})

test('the tool is installed into an Agent surface through the agent/created envelope', () => {
  const tool = installedTool()
  assert.ok(tool !== undefined, 'no tool reached the agent surface')
  assert.equal(tool.name, 'run_detached')
  assert.equal(typeof tool.execute, 'function')
  assert.deepEqual(tool.parameters.required, ['command'])
  const registered = journalOf(homeA).filter((line) => line.step === 'registered' && line.id === 'child')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].root, 'root', 'the line names the OWNER the verdict was formed for')
  assert.equal(registered[0].via, 'owner-can-collect')
})

test('the tool carries the registry output contract, whose absence is a register-failed line', () => {
  // dsh-tools/lib/types/index.js:459-466 refuses a definition whose `output` is not
  // `{ schema, render, presentationMeta? }`; the row then reads `active` while the
  // tool is missing from every surface.
  const tool = installedTool()
  assert.equal(typeof tool.output, 'object')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.output.schema, 'object')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.deepEqual([...tool.output.schema.required].sort(), ['job_id', 'owner', 'text'])
  // `render` is what the native surface shows; the value passes through unchanged.
  const blocks = tool.output.render({}, { job_id: 'j', owner: 'o', text: 'hello' })
  assert.deepEqual(blocks, [{ type: 'text', text: 'hello' }])
})

test('the installed tool starts a job owned by the ROOT, never by the calling worker', async () => {
  const mount = primary()
  const before = mount.state.started.length
  const result = await installedTool().execute(
    { command: 'Start-Sleep -Seconds 40; Write-Output "DETACHED-OK"', label: 'test-detached' },
    { agent: { session: { id: 'session-child' } }, cwd: 'C:\\CodeSource' },
  )
  assert.equal(mount.state.started.length, before + 1, 'exactly one job must be started')
  const spec = mount.state.started[mount.state.started.length - 1]
  assert.equal(spec.owner, 'session-root')
  assert.notEqual(spec.owner, 'session-child')
  assert.equal(spec.kind, 'pwsh')
  assert.equal(spec.label, 'test-detached')
  assert.equal(typeof spec.run, 'function')
  // The value `execute` returns is what the PTC surface sees, so the id must be in it.
  assert.equal(result.job_id, 'pwsh-test-1')
  assert.equal(result.owner, 'session-root')
  assert.match(result.text, /pwsh-test-1/)
  // The caller here is a WORKER: a root-owned job is not readable from its session, so the
  // id must be handed back. The opposite case has its own test below.
  assert.match(result.text, /NOT readable from your session/)
  assert.deepEqual([...Object.keys(result)].sort(), ['job_id', 'owner', 'text'])
})

test('a root that starts a detached job is told it can read it, not that it cannot', async () => {
  // The readability sentence used to be CONSTANT, so the orchestrator — the one caller that
  // CAN read a root-owned job — was told the job was unreadable from its session, which
  // invites it to abandon a job it owns. Measured live on job pwsh-11, which the root read
  // with job_output while the tool text claimed it could not.
  const mount = primary()
  const before = mount.state.started.length
  const result = await installedTool().execute(
    { command: 'Write-Output "ROOT-OWNED"', label: 'root-detached' },
    { agent: { session: { id: 'session-root' } }, cwd: 'C:\\CodeSource' },
  )
  assert.equal(mount.state.started.length, before + 1)
  assert.equal(result.owner, 'session-root', 'the root owns the job it starts')
  assert.match(result.text, /owned by this session/)
  assert.doesNotMatch(result.text, /NOT readable from your session/)
  assert.match(result.text, /job_output/)
})


test('an unresolvable root refuses instead of starting a job with the wrong owner', async () => {
  const mount = primary()
  const before = mount.state.started.length
  await assert.rejects(
    () => installedTool().execute({ command: 'echo hi' }, { agent: { session: { id: 'session-absent-from-the-store' } } }),
    /could not resolve the session root/,
  )
  assert.equal(mount.state.started.length, before, 'nothing may be started when the owner is unknowable')
})

test('a second mount neither captures again nor installs the tool a second time', () => {
  const second = makeCtx()
  A.apply(second.ctx, undefined)
  assert.equal(journalOf(homeA).filter((line) => line.step === 'capture').length, 1)
  const registered = []
  assert.equal(typeof second.state.created, 'function')
  second.state.created({ agent: makeAgent('session-child', registered), source: 'spawn' })
  assert.equal(registered.length, 0, 'a duplicate mount must not register the same tool name twice')
  assert.ok(journalOf(homeA).some((line) => line.step === 'install-skipped' && line.why === 'not-the-first-mount'))
})

test('an Agent that already existed at mount time still gets the tool', () => {
  const registered = []
  const rootRegistered = []
  const mount = makeCtx({
    jobs: null,
    // The root is live at mount time, which is the shape of a resumed session — and it is
    // the root's surface that admits the tool, so it has to be here.
    existingAgents: [
      makeAgent('session-root', rootRegistered, { knows: new Set(['job_kill']) }),
      makeAgent('session-child', registered),
    ],
  })
  B.apply(mount.ctx, undefined)
  assert.equal(registered.length, 1, 'a resumed session must not be left without the tool')
  assert.equal(rootRegistered.length, 1, 'the root gets its own surface too')
  toolOfB = registered[0]
  assert.equal(toolOfB.name, 'run_detached')
  const ready = journalOf(homeB).filter((line) => line.step === 'agents-ready')
  assert.equal(ready.length, 1)
  assert.equal(ready[0].count, 2)
})

test('the tool refuses when no unscoped jobs service was captured — no silent fallback', async () => {
  await assert.rejects(
    () => toolOfB.execute({ command: 'echo hi' }, { agent: { session: { id: 'session-child' } } }),
    /not available/,
  )
})

test('a mount that throws records apply-failed and does not rethrow', () => {
  const mount = makeCtx({ onThrows: true })
  assert.doesNotThrow(() => D.apply(mount.ctx, undefined))
  const lines = journalOf(homeD)
  const steps = lines.map((line) => line.step)
  assert.ok(steps.includes('capture'), 'the capture happens before the failing step')
  const failed = lines.filter((line) => line.step === 'apply-failed')
  assert.equal(failed.length, 1)
  assert.match(failed[0].error, /boom/)
  assert.ok(steps.indexOf('capture') < steps.indexOf('apply-failed'))
})

test('a journal that cannot be written does not break the mount it observes', () => {
  const journalPath = join(homeC, 'plugin-data', 'dsh-boost-relay', 'decisions.jsonl')
  assert.ok(statSync(journalPath).isDirectory(), 'the fixture must make the journal unwritable')
  const mount = makeCtx({ existingAgents: [makeAgent('session-root', [], { knows: new Set(['job_kill']) })] })
  assert.doesNotThrow(() => C.apply(mount.ctx, undefined))
  const registered = []
  mount.state.created({ agent: makeAgent('session-child', registered), source: 'spawn' })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'run_detached')
})

test('the started job carries a pull source that never yields a byte', async () => {
  // The registry advertises a full-output file only from a source it READ, and only while
  // its pump exists — i.e. only when `spec.output` is a NON-EMPTY array. The source exists
  // to carry the PATH: `text` is always empty, so the pump never reaches `sink.append`,
  // the ring is not touched, and the measured "delivered exactly once" property stands.
  const mount = primary()
  const before = mount.state.started.length
  await installedTool().execute(
    { command: 'echo hi', label: 'source' },
    { agent: { session: { id: 'session-child' } }, cwd: 'C:\\CodeSource' },
  )
  assert.equal(mount.state.started.length, before + 1)
  const spec = mount.state.started[mount.state.started.length - 1]
  assert.equal(Array.isArray(spec.output), true)
  assert.equal(spec.output.length, 1, 'a non-empty output is what makes the registry open its pump')
  const source = spec.output[0]
  // Before the producer has run there is no path yet — and there is never any text.
  assert.deepEqual(source.read(0), { text: '', nextOffset: 0, lossy: false })
  for (let offset = 0; offset < 1000; offset++) {
    assert.deepEqual(source.read(offset), { text: '', nextOffset: offset, lossy: false })
  }
  assert.equal(Object.hasOwn(source, 'channel'), false, 'no channel: there is no text to attribute')
})

test('a configured pwshPath is read from the shell service and journalled', async () => {
  const pwshPath = 'D:\\tools\\pwsh.exe'
  const mount = makeCtx({
    shell: { get pwshPath() { return pwshPath } },
    existingAgents: [makeAgent('session-root', [], { knows: new Set(['job_kill']) })],
  })
  E.apply(mount.ctx, undefined)
  const ready = journalOf(homeE).filter((line) => line.step === 'shell-ready')
  assert.equal(ready.length, 1, 'the deferred shell injection must be answered once')
  assert.equal(ready[0].pwshPath, pwshPath)
  // Deferred, never a hard dependency — the request is visible in the journal with it.
  assert.equal(mount.state.injected.some((deps) => deps.includes('shell')), true)
  // And a job still starts, so honouring the config did not replace the working path.
  const registered = []
  mount.state.created({ agent: makeAgent('session-child', registered), source: 'spawn' })
  assert.equal(registered.length, 1)
  const result = await registered[0].execute(
    { command: 'echo hi', label: 'shell-configured' },
    { agent: { session: { id: 'session-child' } }, cwd: 'C:\\CodeSource' },
  )
  assert.equal(mount.state.started.length, 1, 'a job must still be started')
  assert.equal(mount.state.started[0].owner, 'session-root')
  assert.equal(result.job_id, 'pwsh-test-1')
})

test('without a shell service the row still starts jobs, on the explicit fallback', async () => {
  // The injection never resolves here, which is what "this composition has no shell row"
  // means for a deferred dependency: there is no `shell-ready` line to read, and the job
  // must still start through `resolveShell()`.
  const mount = makeCtx({ existingAgents: [makeAgent('session-root', [], { knows: new Set(['job_kill']) })] })
  assert.doesNotThrow(() => F.apply(mount.ctx, undefined))
  assert.equal(journalOf(homeF).filter((line) => line.step === 'shell-ready').length, 0)
  const registered = []
  mount.state.created({ agent: makeAgent('session-child', registered), source: 'spawn' })
  assert.equal(registered.length, 1)
  const result = await registered[0].execute(
    { command: 'echo hi', label: 'shell-absent' },
    { agent: { session: { id: 'session-child' } }, cwd: 'C:\\CodeSource' },
  )
  assert.equal(mount.state.started.length, 1, 'the fallback must still start the job')
  assert.equal(result.job_id, 'pwsh-test-1')
})

// ---------------------------------------------------------------------------------------
// The ownership predicate. Its subject is the ROOT — the session that will still be there
// when the caller is gone, and the only one that can read the job — so T3 reads it from
// both directions, and each case has to be able to fail (the falsifications are recorded in
// the package README: inverting the predicate fails T1/T2/T3, removing the trace fails T2/T4).
// ---------------------------------------------------------------------------------------

test('T1 - the tool IS registered when the OWNER can collect', () => {
  const rootRegistered = []
  const mount = makeCtx({
    existingAgents: [makeAgent('session-root', rootRegistered, { knows: new Set(['job_kill']) })],
  })
  G.apply(mount.ctx, undefined)
  const registered = []
  mount.state.created({ agent: makeAgent('session-child', registered), source: 'spawn' })
  assert.equal(registered.length, 1, 'a worker whose root can collect must receive the tool')
  assert.equal(registered[0].name, 'run_detached')
  const lines = journalOf(homeG)
  assert.equal(lines.filter((line) => line.step === 'register-skipped').length, 0)
  const child = lines.filter((line) => line.step === 'registered' && line.id === 'child')
  assert.equal(child.length, 1)
  assert.equal(child[0].root, 'root')
  assert.equal(child[0].via, 'owner-can-collect')
})

test('T2 - an owner that cannot collect means NO tool, and the journal says why', () => {
  const mount = makeCtx({
    // The root has a tools service; it simply does not know `job_kill`, which is the shape
    // of a composition where `tool-jobs` never mounted.
    existingAgents: [makeAgent('session-root', [], { knows: new Set() })],
  })
  H.apply(mount.ctx, undefined)
  const registered = []
  mount.state.created({ agent: makeAgent('session-child', registered), source: 'spawn' })
  assert.equal(registered.length, 0, 'an owner that cannot collect must not be handed a dead tool')
  const skipped = journalOf(homeH).filter((line) => line.step === 'register-skipped' && line.id === 'child')
  assert.equal(skipped.length, 1, 'the withdrawal is journalled, never silent')
  assert.equal(skipped[0].why, 'owner-cannot-collect')
  assert.equal(skipped[0].root, 'root')
})

test("T3 - the verdict follows the OWNER, not the surface being registered", () => {
  // The root knows `job_kill`; this worker's OWN surface knows nothing at all.
  const knows = new Set(['job_kill'])
  const mount = makeCtx({ existingAgents: [makeAgent('session-root', [], { knows })] })
  I.apply(mount.ctx, undefined)
  const worker = []
  mount.state.created({ agent: makeAgent('session-child', worker), source: 'spawn' })
  assert.equal(worker.length, 1, 'the OWNER having the tool is what admits it, whoever is registering')
  // The mirror image, which is what makes the line above a measurement: the root loses the
  // tool, and a worker whose OWN surface HAS it must NOT be registered.
  knows.clear()
  const sibling = []
  mount.state.created({ agent: makeAgent('session-sibling', sibling, { knows: new Set(['job_kill']) }), source: 'spawn' })
  assert.equal(sibling.length, 0, "the caller's own surface must not decide")
  const skipped = journalOf(homeI).filter((line) => line.step === 'register-skipped' && line.id === 'sibling')
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].why, 'owner-cannot-collect')
})

test('T4 - an unfindable owner means NO tool, and the journal names which condition', () => {
  const mount = makeCtx()
  J.apply(mount.ctx, undefined)
  // (a) the caller's session is not in the durable store: no root resolves at all.
  const ghost = []
  mount.state.created({ agent: makeAgent('session-ghost', ghost), source: 'spawn' })
  assert.equal(ghost.length, 0, 'fail closed: an unknown owner is not a root')
  // (b) the root resolves from the headers, but no live — or announced — agent carries it.
  const orphan = []
  mount.state.created({ agent: makeAgent('session-child', orphan), source: 'spawn' })
  assert.equal(orphan.length, 0, 'fail closed: a root that is not here cannot be asked')
  const skipped = journalOf(homeJ).filter((line) => line.step === 'register-skipped')
  assert.deepEqual(skipped.map((line) => [line.id, line.why]), [
    ['ghost', 'root-not-resolved'],
    ['child', 'root-agent-unknown'],
  ])
})

// ---------------------------------------------------------------------------------------
// T-S1..T-S5: the owner fallback. Each case has to be able to FAIL, and the falsification is
// recorded in the package README: reverting the fallback (owner = the header root, always)
// turns T-S2, T-S3 and T-S4 red, and electing the NEAREST live agent instead of the highest
// turns T-S1 and T-S3 red. T-S5 is the fail-closed floor: it must stay green in both.
// ---------------------------------------------------------------------------------------

test('T-S1 - a LIVE header root stays the owner, and the fallback is not taken', async () => {
  const rootRegistered = []
  const childRegistered = []
  const mount = makeCtx({
    existingAgents: [
      makeAgent('session-root', rootRegistered, { knows: new Set(['job_kill']) }),
      // The caller is live too, which is the point: a resolution that preferred the NEAREST
      // live agent would name `session-child` here, and every assertion below catches that.
      makeAgent('session-child', childRegistered, { knows: new Set(['job_kill']) }),
    ],
  })
  S1.apply(mount.ctx, undefined)
  assert.equal(rootRegistered.length, 1)
  assert.equal(childRegistered.length, 1, 'the worker still receives the tool')
  const lines = journalOf(homeS1)
  assert.equal(
    lines.filter((line) => line.step === 'owner-fallback').length,
    0,
    'a LIVE root is resolved by the headers alone: no fallback line may be written',
  )
  assert.deepEqual(
    lines.filter((line) => line.step === 'registered').map((line) => [line.id, line.root]),
    [['root', 'root'], ['child', 'root']],
    'the owner is the ROOT, never the live caller',
  )
  const result = await childRegistered[0].execute(
    { command: 'echo hi', label: 's1' },
    { agent: { session: { id: 'session-child' } } },
  )
  assert.equal(result.owner, 'session-root', 'the job goes to the header root')
  assert.equal(mount.state.started.length, 1)
  assert.equal(mount.state.started[0].owner, 'session-root')
})

test('T-S2 - a DEAD header root hands the tool AND the job to the LIVE caller', async () => {
  const registered = []
  const mount = makeCtx({
    existingAgents: [makeAgent('session-alive', registered, { knows: new Set(['job_kill']) })],
  })
  S2.apply(mount.ctx, undefined)
  assert.equal(registered.length, 1, 'the continued session must be MOUNTED, not refused')
  assert.equal(registered[0].name, 'run_detached')
  const lines = journalOf(homeS2)
  assert.equal(
    lines.filter((line) => line.step === 'register-skipped').length,
    0,
    'the measured failure was exactly this line, for exactly this id',
  )
  const fallback = lines.filter((line) => line.step === 'owner-fallback')
  assert.equal(fallback.length, 1, 'the fallback that SERVED is written, once')
  assert.deepEqual(
    [fallback[0].id, fallback[0].headerRoot, fallback[0].liveOwner],
    ['alive', 'dead', 'alive'],
    'the line must name the root the HEADERS returned and the owner that was elected',
  )
  assert.deepEqual(
    lines.filter((line) => line.step === 'registered').map((line) => [line.id, line.root, line.via]),
    [['alive', 'alive', 'owner-can-collect']],
  )
  // The gate and the job start must share ONE resolution: admitting the tool and then naming
  // the dead root in `owner:` would leave a job nobody can read.
  const result = await registered[0].execute(
    { command: 'echo hi', label: 's2' },
    { agent: { session: { id: 'session-alive' } } },
  )
  assert.equal(result.owner, 'session-alive')
  assert.equal(mount.state.started.length, 1)
  assert.equal(mount.state.started[0].owner, 'session-alive', 'never the dead `session-dead`')
  assert.match(result.text, /owned by this session/)
  assert.doesNotMatch(result.text, /NOT readable from your session/)
  assert.equal(
    journalOf(homeS2).filter((line) => line.step === 'owner-fallback').length,
    2,
    'the job start resolves the owner through the same rule, and journals it too',
  )
})

test('T-S3 - dead root, live MIDDLE: the highest live ancestor owns both descendants', () => {
  const registered = []
  const mount = makeCtx({
    existingAgents: [
      makeAgent('session-middle', registered, { knows: new Set(['job_kill']) }),
      makeAgent('session-leaf', registered, { knows: new Set(['job_kill']) }),
    ],
  })
  S3.apply(mount.ctx, undefined)
  assert.equal(registered.length, 2, 'both live agents are served')
  const lines = journalOf(homeS3)
  // `session-middle` is one hop below the dead root; `session-leaf` is two. Neither is the
  // header root, and the leaf is NOT owned by itself — that is the whole distinction.
  assert.deepEqual(
    lines.filter((line) => line.step === 'registered').map((line) => [line.id, line.root]),
    [['middle', 'middle'], ['leaf', 'middle']],
    'the HIGHEST live ancestor owns, never the nearest live one',
  )
  assert.deepEqual(
    lines.filter((line) => line.step === 'owner-fallback').map((line) => [line.id, line.headerRoot, line.liveOwner]),
    [['middle', 'dead', 'middle'], ['leaf', 'dead', 'middle']],
  )
})

test('T-S4 - the fallback is journalled, and a normal resolution writes no such line', () => {
  const mount = makeCtx({
    existingAgents: [
      makeAgent('session-root', [], { knows: new Set(['job_kill']) }),
      makeAgent('session-child', [], { knows: new Set(['job_kill']) }),
      makeAgent('session-orphan', [], { knows: new Set(['job_kill']) }),
    ],
  })
  S4.apply(mount.ctx, undefined)
  const lines = journalOf(homeS4)
  // TWO resolutions in ONE journal: `child` through its live root, `orphan` through the
  // fallback. A line written on every resolution — or on none — fails right here.
  assert.deepEqual(
    lines.filter((line) => line.step === 'registered').map((line) => [line.id, line.root]),
    [['root', 'root'], ['child', 'root'], ['orphan', 'orphan']],
  )
  const fallback = lines.filter((line) => line.step === 'owner-fallback')
  assert.equal(fallback.length, 1, 'exactly the one resolution that needed it')
  assert.deepEqual(
    [fallback[0].id, fallback[0].headerRoot, fallback[0].liveOwner],
    ['orphan', 'dead', 'orphan'],
  )
})

test('T-S5 - no live agent anywhere on the chain: unchanged refusal, journalled', () => {
  const mount = makeCtx()
  S5.apply(mount.ctx, undefined)
  const registered = []
  mount.state.created({ agent: makeAgent('session-orphan', registered), source: 'spawn' })
  assert.equal(registered.length, 0, 'fail closed: a chain with nothing alive mounts nothing')
  const lines = journalOf(homeS5)
  assert.equal(
    lines.filter((line) => line.step === 'owner-fallback').length,
    0,
    'a fallback that elects nobody is not a fallback that served: no line may claim one',
  )
  assert.deepEqual(
    lines.filter((line) => line.step === 'register-skipped').map((line) => [line.id, line.why, line.root]),
    [['orphan', 'root-agent-unknown', 'dead']],
    'the reason and the root are the ones this module already published',
  )
})
