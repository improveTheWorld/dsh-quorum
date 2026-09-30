// THE OWNER GATE, measured end to end in a composition built like the real one.
//
//   node tools/probe-owner-gate.mjs [harness-node-modules] [plugin-entry]
//
// Why this exists next to `test/apply.test.mjs`: those cases drive the predicate with STUB
// surfaces, so they prove the CODE and nothing about the composition. `probe-spill-announce`
// mounts the real registry with a stub tools service, and `probe-profile-import` proves the
// module the host resolves still activates — neither answers the question this change was made
// for: in a composition where the owner CAN collect, does `run_detached` reach an agent's
// surface, and in one where it CANNOT, is it really absent instead of dead?
//
// So this probe mounts the REAL tools registry on a real cordis app, mounts the REAL
// `@deepseek-ai/dsh-tool-jobs` row INSIDE A PRESET SCOPE (the shape
// `dsh-web-app/cordis.patch.yml:456-467` composes, where `tool-jobs` is `disabled: true` at
// the base and raised by a preset), binds the agent scopes to that preset as
// `dsh-agent-preset-registry` binds them, mounts THIS plugin as the HOST row, announces a
// worker, and reads `tools.get('run_detached', worker)` — the registry's own per-scope view.
// It then runs the SAME composition with the preset row omitted, which is the composition the
// defect was measured in.
//
// Exit 0 only when the tool is on the worker's surface in the first composition AND absent,
// with a `register-skipped` line naming the reason, in the second. No dependencies beyond
// Node's builtins and the harness's own modules; scratch state lives in the OS temp dir.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const harnessModules = process.argv[2] ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
const entries = {
  cordis: join(harnessModules, '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  tools: join(harnessModules, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
  toolJobs: join(harnessModules, '@deepseek-ai', 'dsh-tool-jobs', 'lib', 'index.js'),
  scope: join(harnessModules, '@deepseek-ai', 'dsh-scope', 'lib', 'index.js'),
}
// The plugin under test: this checkout's entry, or the module named on the command line —
// which is how a variant is made to run through the SAME probe.
const pluginEntry = process.argv[3] !== undefined
  ? resolve(process.argv[3])
  : fileURLToPath(new URL('../lib/index.js', import.meta.url))
const say = (key, value) => console.log('PROBE-' + key + ': ' + value)
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const frame = (record) => zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n', 'utf8'))

async function scenario(label, withPresetRow, ordinal) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-detached-e2e-'))
  for (const record of [{ id: 'session-root' }, { id: 'session-child', parentSession: 'session-root' }]) {
    const dir = join(scratch, 'sessions', 'ws', record.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame({ type: 'session', ...record }), frame({ type: 'turn/start' })]))
  }
  // The plugin reads $DSH_HOME at import time, so the store comes first and each scenario
  // gets its own module instance through the query string.
  process.env.DSH_HOME = scratch
  const { Context } = await import(pathToFileURL(entries.cordis).href)
  const { createScope } = await import(pathToFileURL(entries.scope).href)
  const ToolRuntime = (await import(pathToFileURL(entries.tools).href)).default
  const toolJobs = await import(pathToFileURL(entries.toolJobs).href)
  const plugin = await import(pathToFileURL(pluginEntry).href + '?e2e=' + ordinal)

  const root = new Context()
  const jobs = {
    attachController: () => {},
    events: { subscribe: () => () => {} },
    list: () => [],
    start: () => 'job-e2e',
  }
  await root.plugin({ name: 'probe-services', apply: (ctx) => {
    ctx.provide('jobs', jobs)
    ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 })
  } })
  const toolsFiber = await root.plugin(ToolRuntime, { mode: 'native' })

  // The preset generation scope, and — when this scenario models the shipped web-app
  // composition — the REAL dsh-tool-jobs row inside it.
  const presetKey = {}
  const preset = createScope(root, presetKey)
  if (withPresetRow) {
    await preset.ctx.plugin(
      { name: toolJobs.name, inject: toolJobs.inject, apply: toolJobs.apply },
      { waitTimeoutMs: 30000, maxWaitTimeoutMs: 600000, completionDelivery: 'quiet' },
    )
  }
  await tick(60)

  const rootAgent = { id: 'session-root', session: { id: 'session-root' } }
  const rootScope = createScope(preset.ctx, rootAgent, { parent: presetKey })
  rootAgent.ctx = rootScope.ctx
  const worker = { id: 'session-child', session: { id: 'session-child' } }
  const workerScope = createScope(preset.ctx, worker, { parent: presetKey })
  worker.ctx = workerScope.ctx

  // The live agent registry, answering for the ROOT only — the case where the tool is
  // admitted without the root ever being announced through agent/created.
  await root.plugin({ name: 'probe-agents', apply: (ctx) => ctx.provide('agents', {
    list: () => [],
    get: (id) => (id === 'session-root' ? rootAgent : undefined),
  }) })

  // The HOST row: the plugin under test, mounted where the profile mounts it.
  await root.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
  await tick(60)
  root.emit('agent/created', { agent: worker, source: 'spawn' })
  await tick(200)

  const collectable = toolsFiber.ctx.tools.get('job_kill', rootAgent) !== undefined
  const visible = toolsFiber.ctx.tools.get('run_detached', worker) !== undefined
  say(label, 'preset row mounted: ' + String(withPresetRow === true))
  say(label, 'the OWNER can collect (tools.get("job_kill", <root agent>)): ' + (collectable ? 'yes' : 'no'))
  say(label, 'run_detached visible on the WORKER surface: ' + (visible ? 'YES' : 'NO'))
  let journal = []
  try {
    journal = readFileSync(join(scratch, 'plugin-data', 'dsh-boost-relay', 'decisions.jsonl'), 'utf8')
      .trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
  } catch {
    // No journal at all is itself a finding, and the verdict below reports it.
  }
  const decisions = journal.filter((line) => line.step === 'register-skipped' || line.step === 'registered')
  say(label, 'registration decisions: '
    + decisions.map((line) => line.step + (line.why === undefined ? '' : '(' + line.why + ')')).join(', '))
  try { await root.dispose?.() } catch { /* teardown must never mask the verdict */ }
  rmSync(scratch, { recursive: true, force: true })
  return { visible, collectable, decisions }
}

const failures = []
try {
  for (const [label, file] of [...Object.entries(entries), ['plugin', pluginEntry]]) {
    if (!existsSync(file)) throw new Error('the ' + label + ' module is not installed here: ' + file + ' does not exist')
  }
  const withPreset = await scenario('with-preset', true, 1)
  if (!withPreset.collectable) failures.push('the preset composition did not make the owner collectable, so the first measurement proves nothing')
  else if (!withPreset.visible) failures.push('the tool is ABSENT from the worker surface although the owner can collect')
  else if (!withPreset.decisions.some((line) => line.step === 'registered')) failures.push('no registered line was journalled in the preset composition')

  const withoutPreset = await scenario('without-preset', false, 2)
  if (withoutPreset.collectable) failures.push('the no-preset composition still reports a collectable owner, so the second measurement proves nothing')
  else if (withoutPreset.visible) failures.push('the tool is STILL on the worker surface although the owner cannot collect — a dead tool')
  else if (!withoutPreset.decisions.some((line) => line.step === 'register-skipped' && line.why === 'owner-cannot-collect')) {
    failures.push('the refusal was not journalled with why=owner-cannot-collect')
  }
} catch (error) {
  failures.push('MOUNT/MEASURE FAILED — ' + String(error?.stack ?? error))
}

if (failures.length > 0) {
  console.log('PROBE-FAIL — ' + failures.join(' ; '))
  process.exit(1)
}
console.log('PROBE-PASS — the tool is mounted where the owner can collect, and withheld — with its reason journalled — where it cannot')
