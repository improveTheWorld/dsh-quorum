// The FIRST tests this package has ever had. Until now the directory held none,
// and `node --test` reported "# tests 0" and exited 0 — a green that proved
// nothing, for the one command an operator runs exactly when nothing else
// answers: the agent is blocked inside a long tool call, and a "steer" would only
// be queued for the next turn.
//
//   node --test test/status.test.mjs
//
// The cases below are the ones that decide whether the command can be trusted:
//
//   1. the REGISTRATION — the exact name the UI dispatches on, and a description
//      the palette can show. `boost-status` misspelled is a command that does not
//      exist, and nothing else in this repository would have said so;
//   2. the DEFERRED form (`ctx.inject(['commands'], ...)`) together with an EMPTY
//      module `inject`. With no service at all, `apply()` must COMPLETE and
//      register nothing. A hard `inject: ['commands']` fails the FIBER before
//      `apply()` runs, and reading `ctx.commands` undeclared throws on the
//      property GET in cordis ("cannot get property \"commands\" without inject") —
//      the blindness the detached-jobs row already paid for twice;
//   3. every service the report reads (`subagents`, `agents`,
//      `sessionProjections`, `tokenMeter`) is OPTIONAL. `ctx.get(name)` returns
//      undefined rather than throwing (`cordis/lib/index.js:755-765`), so an absent
//      service must be a LINE in a successful report: not a thrown error, and not
//      a value invented from nothing;
//   4. the handler ALWAYS returns a result — success or error — because the
//      command plane has no other way to show the operator what happened.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject, name } from '../lib/index.js'

/**
 * A context where reading an undeclared service THROWS, exactly as cordis does,
 * so a case that passes here cannot be passing because the plugin read a service
 * it never injected.
 */
function strictContext(services) {
  return new Proxy(services, {
    get(target, key) {
      if (typeof key === 'symbol' || key === 'then' || key === 'constructor' || key === 'inspect') return undefined
      if (Object.hasOwn(target, key)) return target[key]
      throw new Error('cannot get property "' + String(key) + '" without inject')
    },
  })
}

/**
 * Mount the plugin over the services a deployment has, and hand back the
 * commands service stub it registered into.
 * @param services - the services present; anything else throws on read.
 */
function mount(services = {}) {
  const registered = []
  const requested = []
  const commandCtx = strictContext({
    commands: { register: (spec) => { registered.push(spec); return () => {} } },
  })
  const ctx = strictContext({
    ...services,
    // cordis' tolerant accessor: it answers undefined for a service that was
    // never provided, which is what makes the plugin's optional reads possible.
    get: (serviceName) => services[serviceName],
    inject: (deps, callback) => {
      requested.push(deps)
      // cordis runs the callback only once the declared service is available.
      if (deps.includes('commands')) callback(commandCtx)
    },
  })
  return { ctx, registered, requested }
}

const SESSION = { id: 'session-517ee069-bbfb-410f-bc1b-3e036d8a2663', header: { cwd: 'C:\\CodeSource' } }

/** Invoke the one registered command the way the command plane does. */
async function invoke(harness, agent, rawInput = '') {
  const command = harness.registered[0]
  assert.ok(command !== undefined, 'nothing was registered: the command cannot be invoked')
  return await command.handler({ agent, rawInput })
}

test('the command registers under the exact name the UI dispatches on', () => {
  const harness = mount()
  apply(harness.ctx)
  assert.equal(name, 'boost-status-command', 'the row identity the patch mounts')
  assert.deepEqual(harness.requested, [['commands']], 'the command service is requested, deferred')
  assert.equal(harness.registered.length, 1, 'exactly one command is registered')
  const command = harness.registered[0]
  assert.equal(command.name, 'boost-status')
  assert.equal(typeof command.description, 'string')
  assert.ok(command.description.trim().length > 0, 'a command with no description is invisible in the palette')
  assert.equal(typeof command.handler, 'function')
})

test('with no service at all, apply() completes and registers nothing eagerly', () => {
  // The deferred form is the whole reason this row mounts in every composition.
  // An eager read of `ctx.commands` throws on the property GET, and a hard
  // `inject = ['commands']` fails the fiber before apply() ever runs.
  assert.deepEqual(inject, [], 'a hard dependency would fail the fiber, not degrade')
  const requested = []
  const ctx = strictContext({ inject: (deps) => { requested.push(deps) } })
  assert.doesNotThrow(() => apply(ctx))
  assert.deepEqual(requested, [['commands']])
})

test('an agent with no session is answered, not thrown at', async () => {
  const harness = mount()
  apply(harness.ctx)
  const result = await invoke(harness, undefined)
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('aucun agent lié à cette session'))
})

test('invoking the handler answers with a non-empty report naming the session', async () => {
  const harness = mount()
  apply(harness.ctx)
  const result = await invoke(harness, { status: 'running', session: SESSION })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.trim().length > 0, 'the command plane must never receive an empty answer')
  assert.ok(result.text.includes('Boost — état temps réel'))
  assert.ok(result.text.includes('517ee069'), 'the session is identified by its short id')
  assert.ok(result.text.includes(SESSION.header.cwd), 'the report prints the session cwd')
})

test('a deployment without subagents degrades to a line instead of failing', async () => {
  const harness = mount()
  apply(harness.ctx)
  const result = await invoke(harness, { status: 'idle', session: SESSION })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('service indisponible'), 'the absence is stated, never hidden')
})

test('a subagents registry that throws is a line in the report, not an exception', async () => {
  // This is the case the command exists for: it must answer from the command
  // plane even when the registry it reads is broken.
  const harness = mount({ subagents: { listDescendants: () => { throw new Error('registre indisponible') } } })
  apply(harness.ctx)
  const result = await invoke(harness, { status: 'idle', session: SESSION })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('lecture impossible : registre indisponible'))
})

test('an unexpected shape after the guarded call yields an error result, never a rejection', async () => {
  const harness = mount({ subagents: { listDescendants: () => null } })
  apply(harness.ctx)
  const result = await invoke(harness, { status: 'idle', session: SESSION })
  assert.equal(result.kind, 'error', 'the command plane must always receive a result')
  assert.ok(result.text.startsWith('boost-status a échoué :'), 'and it must say what failed')
})

test('children are listed running-first, with depth, label and the depth warning', async () => {
  const rows = [
    { id: 'session-idle-1', kind: 'child', activity: 'idle', depth: 1, mode: 'one-shot', label: 'Fix power tool' },
    { id: 'session-run-1', kind: 'child', activity: 'running', depth: 1, mode: 'continuable', label: 'Verify report', hasChildren: true },
    { id: 'session-diag-1', kind: 'diagnostic', reason: 'descripteur illisible' },
  ]
  const harness = mount({ subagents: { listDescendants: () => rows } })
  apply(harness.ctx)
  const result = await invoke(harness, { status: 'running', session: SESSION })
  const lines = result.text.split('\n')
  const runningAt = lines.findIndex((line) => line.includes('RUN '))
  const idleAt = lines.findIndex((line) => line.includes('idle '))
  assert.ok(runningAt !== -1 && idleAt !== -1, 'both activities are printed')
  assert.ok(runningAt < idleAt, 'a running child is printed before an idle one')
  assert.ok(result.text.includes('enfants    2 au total, 1 en cours'))
  assert.ok(result.text.includes('continuable'))
  assert.ok(result.text.includes('A DES ENFANTS'), 'a depth-1 child with children is the risk this line watches')
  assert.ok(result.text.includes('DIAG') && result.text.includes('descripteur illisible'))
  assert.ok(result.text.includes('attendre : 1 sous-agent(s) en cours'))
})

test('the token line comes from a projection and is never invented', async () => {
  const subagents = { listDescendants: () => [] }
  const measured = mount({
    subagents,
    sessionProjections: {
      snapshot: () => ({
        values: {
          tokenUsage: { uncachedInputTokens: 1_000_000, cacheReadTokens: 240_000, outputTokens: 42_100 },
          contextPressure: { projectedTokens: 180_300, contextWindow: 1_000_000 },
        },
      }),
    },
  })
  apply(measured.ctx)
  const withTokens = await invoke(measured, { status: 'idle', session: SESSION })
  assert.ok(withTokens.text.includes('tokens cumulés in=1.24M'), 'the cumulative input is summed, not copied')
  assert.ok(withTokens.text.includes('cacheRead=240.0k'))
  assert.ok(withTokens.text.includes('contexte=180.3k/1.00M'))

  const bare = mount({ subagents })
  apply(bare.ctx)
  const withoutTokens = await invoke(bare, { status: 'idle', session: SESSION })
  assert.ok(!withoutTokens.text.includes('tokens '), 'no meter, no token line: an absent measure is not a zero')
})

test('the "all" input adds the local timestamp, the bare input omits it', async () => {
  const harness = mount({ subagents: { listDescendants: () => [] } })
  apply(harness.ctx)
  const bare = await invoke(harness, { status: 'idle', session: SESSION }, '')
  assert.ok(!bare.text.includes('horodatage local'))
  const full = await invoke(harness, { status: 'idle', session: SESSION }, 'all')
  assert.ok(full.text.includes('horodatage local : '))
})
