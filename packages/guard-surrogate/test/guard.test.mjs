// Tests for the isolated-surrogate guard on tools/post-execute.
// Zero dependencies beyond the plugin itself: run "node --test" from the
// repository root.
//
// Each case below is one that decided the design, and each one can fail:
//
//   a/c  a valid astral pair must survive bit for bit: a filter that walks code
//        units instead of pairs turns every emoji into U+FFFD at the model;
//   b/c  the two halves of the actual defect, an unpaired HIGH and an unpaired
//        LOW, must both leave the outbound content;
//   d    a clean content has to come back as the SAME decision object, because
//        rebuilding it would rewrite a result for no reason;
//   e/f/g  the guard must be inert on every shape it does not recognise, and a
//        value decision must pass through untouched;
//   l1/l2  the properties a mutation would otherwise not catch: a repaired
//        decision keeps its additionalContexts, and a REJECTING next() is not
//        swallowed by the catch that makes every other failure inert;
//   m1-m3  a block decision's feedback is repaired by the same walker (it
//        reaches the log by the same path as a result): poisoned feedback is
//        repaired and journalled, clean feedback keeps its identity, a
//        non-array feedback is inert;
//   h    a throwing shape must still return the original decision, never throw:
//        finalizeScheduledExecution would contain the throw, but a contained
//        throw is still a wrong result;
//   i    the switch;
//   j    the journal, the only way an inert guard becomes visible after a
//        harness update moves the waterfall;
//   k    the test that matters: with the REAL dsh-tools mounted, the content the
//        agent loop would log (the value finalize() returns) must be the
//        repaired text, and the same fixture must come back poisoned when the
//        guard is absent. Without that control, k could pass on a fixture that
//        never had a lone surrogate in the first place.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { Config, apply, isEnabled, journalPath, name, resolveHarnessModule, schemaResolved } from '../lib/index.js'
import { hasSurrogate, repairContent, repairText } from '../lib/walker.js'

/** One unpaired HIGH surrogate: the shape that killed 3 of the 182 sessions of 2026-09-30. */
const LONE_HIGH = '\uD83D'
/** One unpaired LOW surrogate. */
const LONE_LOW = '\uDE00'
/** A valid astral pair (U+1F600), which must survive untouched. */
const PAIR = '\uD83D\uDE00'
/** What an unpaired half becomes. */
const REPLACEMENT = '\uFFFD'

/** A call identity good enough for a listener that only reads exec.name. */
const EXEC = { callId: 'call-1', name: 'grep', arguments: { pattern: 'x' } }

// One journal per test run, so the counter assertions count THIS run's lines.
const home = mkdtempSync(join(tmpdir(), 'dsh-guard-surrogate-'))
process.env.DSH_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

/** Journal lines written by this run, parsed. An absent file reads as no lines. */
function journal() {
  try {
    return readFileSync(journalPath(), 'utf8')
      .split(String.fromCharCode(10))
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/**
 * Mount the guard on the smallest context cordis would give it and return the
 * registered listener plus a dispatcher for it.
 */
function mount(config = { enabled: true }) {
  let listener
  let registration
  const warnings = []
  const ctx = {
    on(event, callback, options) {
      registration = { event, options }
      listener = callback
    },
    logger: { warn: (message) => warnings.push(message) },
  }
  apply(ctx, config)
  assert.equal(typeof listener, 'function', 'apply must register a tools/post-execute listener')
  const warningsAtMount = warnings.length
  if (!schemaResolved) {
    // Legitimate and expected on a machine where the schema package does not
    // resolve: the row degrades to a non-volatile switch and SAYS so. Any
    // other warning at mount time would be a defect.
    assert.equal(warningsAtMount, 1, 'exactly one mount warning when the schema is missing')
    assert.match(warnings[0], /schemastery/i, 'the mount warning must name what did not resolve')
  } else {
    assert.equal(warningsAtMount, 0, 'no warning when the schema resolved')
  }
  return {
    registration,
    warnings,
    warningsAtMount,
    listener,
    async run(exec, result, decision) {
      let nextCalls = 0
      const returned = await listener(exec, result, async () => {
        nextCalls += 1
        return decision
      })
      return { returned, nextCalls }
    },
  }
}

/** A content array holding one text block. */
function textBlock(text) {
  return [{ type: 'text', text }]
}

// ---------------------------------------------------------------------------
// a. / c. the valid pair.
// ---------------------------------------------------------------------------

test('a. a valid astral pair is preserved and the decision is not rebuilt', async () => {
  const decision = { kind: 'accept' }
  const result = { content: textBlock('ok ' + PAIR + ' done'), isError: false }
  const guard = mount()
  assert.deepEqual(guard.registration, { event: 'tools/post-execute', options: { prepend: true } })
  const { returned, nextCalls } = await guard.run(EXEC, result, decision)
  assert.equal(nextCalls, 1)
  assert.equal(returned, decision, 'a clean pair must return the identical decision object')
  assert.equal(result.content[0].text, 'ok ' + PAIR + ' done', 'the source block is never mutated')
  assert.equal([...result.content[0].text].length, 9)
})

// ---------------------------------------------------------------------------
// b. / c. the two halves.
// ---------------------------------------------------------------------------

test('b. a lone HIGH surrogate is replaced and the decision carries the repair', async () => {
  const decision = { kind: 'accept' }
  const result = { content: textBlock('a' + LONE_HIGH + 'b'), isError: false }
  const { returned, nextCalls } = await mount().run(EXEC, result, decision)
  assert.equal(nextCalls, 1)
  assert.notEqual(returned, decision)
  assert.equal(returned.kind, 'accept')
  assert.equal(returned.content[0].text, 'a' + REPLACEMENT + 'b')
  assert.equal(hasSurrogate(returned.content[0].text), false, 'no half may leave the guard')
  assert.equal(result.content[0].text, 'a' + LONE_HIGH + 'b', 'the original result is untouched')
})

test('c. a lone LOW surrogate is replaced and the decision carries the repair', async () => {
  const decision = { kind: 'accept' }
  const result = { content: textBlock(LONE_LOW + 'tail'), isError: false }
  const { returned } = await mount().run(EXEC, result, decision)
  assert.notEqual(returned, decision)
  assert.equal(returned.content[0].text, REPLACEMENT + 'tail')
  assert.equal(hasSurrogate(returned.content[0].text), false)
})

test('c2. a pair next to a lone half keeps the pair intact', async () => {
  const result = { content: textBlock(LONE_HIGH + 'x' + PAIR + 'y' + LONE_LOW), isError: false }
  const { returned } = await mount().run(EXEC, result, { kind: 'accept' })
  assert.equal(returned.content[0].text, REPLACEMENT + 'x' + PAIR + 'y' + REPLACEMENT)
  assert.equal([...returned.content[0].text].length, 5)
})

// ---------------------------------------------------------------------------
// d. identity on a clean content.
// ---------------------------------------------------------------------------

test('d. a clean content returns the IDENTICAL decision, and next() ran once', async () => {
  const decision = { kind: 'accept', additionalContexts: [] }
  const result = { content: textBlock('plain ascii, nothing to repair'), isError: false }
  const before = journal().length
  const { returned, nextCalls } = await mount().run(EXEC, result, decision)
  assert.equal(nextCalls, 1)
  assert.equal(returned, decision, 'same reference, not a copy')
  assert.equal(journal().length, before, 'a clean content writes no journal line')
})

test('d2. the decision content wins over the result content, as in dsh-spill-policy', async () => {
  const decision = { kind: 'accept', content: textBlock('decision ' + LONE_HIGH) }
  const result = { content: textBlock('result is ignored'), isError: false }
  const { returned } = await mount().run(EXEC, result, decision)
  assert.equal(returned.content[0].text, 'decision ' + REPLACEMENT)
})

// ---------------------------------------------------------------------------
// e. / f. / g. inertness and pass-through.
// ---------------------------------------------------------------------------

test('e. an unrecognised shape returns the original decision and never throws', async () => {
  const shapes = [
    { label: 'result.content undefined', result: { isError: false }, decision: { kind: 'accept' } },
    { label: 'result.content not an array', result: { content: 'text', isError: false }, decision: { kind: 'accept' } },
    { label: 'decision.content not an array', result: {}, decision: { kind: 'accept', content: null } },
    { label: 'block without a string text', result: { content: [{ type: 'text', text: 42 }], isError: false }, decision: { kind: 'accept' } },
    { label: 'block without a type', result: { content: [{ text: LONE_HIGH }], isError: false }, decision: { kind: 'accept' } },
    { label: 'unknown block type', result: { content: [{ type: 'image', text: LONE_HIGH }], isError: false }, decision: { kind: 'accept' } },
    { label: 'content is an array of null', result: { content: [null], isError: false }, decision: { kind: 'accept' } },
  ]
  for (const shape of shapes) {
    const guard = mount()
    const outcome = await guard.run(EXEC, shape.result, shape.decision)
    assert.equal(outcome.nextCalls, 1, shape.label)
    assert.equal(outcome.returned, shape.decision, shape.label + ': the decision must come back as the same object')
  }
})

test('e2. a non-text block is preserved by reference', async () => {
  const image = { type: 'image', source: 'ref' }
  const result = { content: [image, { type: 'text', text: LONE_HIGH }], isError: false }
  const { returned } = await mount().run(EXEC, result, { kind: 'accept' })
  assert.equal(returned.content[0], image, 'untouched blocks are not copied')
  assert.equal(returned.content[1].text, REPLACEMENT)
})

test('f. a block decision with clean feedback is returned untouched', async () => {
  const decision = { kind: 'block', feedback: textBlock('corrective, nothing to repair') }
  const result = { content: textBlock(LONE_HIGH), isError: false }
  const { returned, nextCalls } = await mount().run(EXEC, result, decision)
  assert.equal(nextCalls, 1)
  assert.equal(returned, decision, 'a clean block decision comes back as the same object')
  assert.equal(result.content[0].text, LONE_HIGH, 'the result content is not touched when the decision carries feedback')
})

test('g. a decision carrying value is returned untouched', async () => {
  const decision = { kind: 'accept', value: { any: 'json' } }
  const result = { content: textBlock(LONE_HIGH), isError: false }
  const { returned, nextCalls } = await mount().run(EXEC, result, decision)
  assert.equal(nextCalls, 1)
  assert.equal(returned, decision, 'a value re-renders the result, so content repairs would be discarded')
})

// ---------------------------------------------------------------------------
// h. an internal exception.
// ---------------------------------------------------------------------------

test('h. an exception inside the repair returns the original decision', async () => {
  const content = textBlock('poison ' + LONE_HIGH)
  Object.defineProperty(content, 0, {
    get() {
      throw new Error('exotic content')
    },
    enumerable: true,
    configurable: true,
  })
  const decision = { kind: 'accept' }
  const { returned, nextCalls } = await mount().run(EXEC, { content, isError: false }, decision)
  assert.equal(nextCalls, 1, 'the chain was entered exactly once')
  assert.equal(returned, decision, 'the original decision comes back, not a copy')
})

// ---------------------------------------------------------------------------
// i. the switch.
// ---------------------------------------------------------------------------

test('i. enabled: false returns the next() decision without repairing', async () => {
  const decision = { kind: 'accept' }
  const result = { content: textBlock(LONE_HIGH + LONE_LOW), isError: false }
  const before = journal().length
  const { returned, nextCalls } = await mount({ enabled: false }).run(EXEC, result, decision)
  assert.equal(nextCalls, 1, 'next() is always awaited, even when disarmed')
  assert.equal(returned, decision)
  assert.equal(result.content[0].text, LONE_HIGH + LONE_LOW, 'nothing was repaired')
  assert.equal(journal().length, before, 'a disarmed guard writes no journal line')
})

test('i2. the switch reads a volatile reference', async () => {
  const decision = { kind: 'accept' }
  const result = { content: textBlock(LONE_HIGH), isError: false }
  const { returned } = await mount({ enabled: { get: () => false } }).run(EXEC, result, decision)
  assert.equal(returned, decision)
  assert.equal(isEnabled({ enabled: { get: () => true } }), true)
  assert.equal(isEnabled({}), true, 'absent means armed')
})

test('i3. the row config declares a volatile enabled switch', () => {
  // Not skippable: a row whose switch is not volatile is a degraded row, and a
  // skip here is exactly the silent degradation this test exists to catch.
  assert.equal(
    schemaResolved,
    true,
    '@deepseek-ai/schemastery must resolve from the running installation (anchors: process.argv[1], '
    + 'DSH_PROFILE_DIR, cwd, the standard global install under %APPDATA%/npm). Install the harness globally '
    + '(npm i -g @deepseek-ai/dsh) or point DSH_PROFILE_DIR at a profile whose node_modules resolves it.',
  )
  assert.equal(Config['~standard'].vendor, 'schemastery')
  assert.equal(Config.dict.enabled.meta.volatile, true)
  assert.equal(isEnabled(Config({})), true)
  assert.equal(isEnabled(Config({ enabled: false })), false)
  assert.equal(typeof Config({ enabled: false }).enabled.get, 'function', 'the parsed field is a live reference')
})

// ---------------------------------------------------------------------------
// j. the journal.
// ---------------------------------------------------------------------------

test('j. one line per real repair, with counters only, and none otherwise', async () => {
  const before = journal().length
  const poisoned = 'x' + LONE_HIGH + 'y' + LONE_LOW + 'z'
  const result = { content: textBlock(poisoned), isError: false }
  const { returned } = await mount().run(EXEC, result, { kind: 'accept' })
  assert.equal(returned.content[0].text, 'x' + REPLACEMENT + 'y' + REPLACEMENT + 'z')
  const lines = journal()
  assert.equal(lines.length, before + 1, 'exactly one line for one repaired call')
  const line = lines[lines.length - 1]
  assert.deepEqual(Object.keys(line).sort(), ['after', 'at', 'before', 'blocks', 'repaired', 'tool'])
  assert.equal(line.tool, 'grep', 'the tool name is the only call identity recorded')
  assert.equal(line.repaired, 2)
  assert.equal(line.blocks, 1)
  assert.equal(line.before, poisoned.length)
  assert.equal(line.after, line.before, 'U+FFFD replaces one code unit with one code unit')
  assert.equal(typeof line.at, 'string')
  assert.equal(JSON.stringify(line).includes('x' + LONE_HIGH), false, 'no message content in the journal')
})

test('j2. an unwritable journal does not fail the repair', async () => {
  const blocked = mkdtempSync(join(tmpdir(), 'dsh-guard-surrogate-blocked-'))
  writeFileSync(join(blocked, 'plugin-data'), 'not a directory')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = blocked
  try {
    const result = { content: textBlock(LONE_HIGH), isError: false }
    const guard = mount()
    const outcome = await guard.run(EXEC, result, { kind: 'accept' })
    assert.equal(outcome.returned.content[0].text, REPLACEMENT, 'the repair still happens')
    assert.equal(
      guard.warnings.length,
      guard.warningsAtMount,
      'a failed journal write is silent: the run must add no warning (the Schemastery mount warning, when present, is legitimate and counted before the run)',
    )
  } finally {
    process.env.DSH_HOME = previous
    rmSync(blocked, { recursive: true, force: true })
  }
})

test('j3. the journal path is derived from DSH_HOME', () => {
  assert.equal(journalPath(), join(home, 'plugin-data', name, 'repairs.jsonl'))
})

// ---------------------------------------------------------------------------
// the walker, on its own.
// ---------------------------------------------------------------------------

test('w1. repairText is identity on a well-formed string and total elsewhere', () => {
  const clean = 'plain ' + PAIR
  const untouched = repairText(clean)
  assert.equal(untouched.text, clean)
  assert.equal(untouched.replaced, 0)
  assert.deepEqual(repairText(LONE_HIGH + LONE_HIGH), { text: REPLACEMENT + REPLACEMENT, replaced: 2 })
  assert.deepEqual(repairText(LONE_LOW), { text: REPLACEMENT, replaced: 1 })
  assert.deepEqual(repairText(''), { text: '', replaced: 0 })
  assert.deepEqual(repairText(PAIR + PAIR), { text: PAIR + PAIR, replaced: 0 })
  assert.deepEqual(repairText(LONE_HIGH + LONE_HIGH + LONE_LOW), { text: REPLACEMENT + PAIR, replaced: 1 },
    'the second high pairs with the following low')
})

test('w2. repairContent reports identity on an unchanged array', () => {
  const content = textBlock('clean')
  assert.equal(repairContent(content).content, content)
  const mixed = [null, { type: 'image' }, { type: 'text', text: LONE_HIGH }]
  const repaired = repairContent(mixed)
  assert.equal(repaired.changed, true)
  assert.equal(repaired.content[0], null)
  assert.equal(repaired.content[1], mixed[1])
  assert.equal(repaired.content[2].text, REPLACEMENT)
})

// ---------------------------------------------------------------------------
// l. / m. the properties a mutation would otherwise not catch.
// ---------------------------------------------------------------------------

test('l1. a repaired accept decision keeps its additionalContexts', async () => {
  const contexts = [{ id: 'ctx-1', source: { kind: 'tool' } }]
  const decision = { kind: 'accept', additionalContexts: contexts }
  const result = { content: textBlock(LONE_HIGH), isError: false }
  const { returned } = await mount().run(EXEC, result, decision)
  assert.notEqual(returned, decision, 'the repair happened')
  assert.equal(returned.content[0].text, REPLACEMENT)
  assert.equal(
    returned.additionalContexts,
    contexts,
    'same array, same entries: a decision rebuilt as { kind, content } silently drops the context the loop ferries to the next request',
  )
})

test('l2. a rejecting next() makes the listener REJECT', async () => {
  const guard = mount()
  const failure = new Error('the chain below refused')
  await assert.rejects(
    () => guard.listener(EXEC, { content: textBlock(LONE_HIGH), isError: false }, async () => {
      throw failure
    }),
    (error) => error === failure,
    'a next() rejection must propagate: containment belongs to dsh-tools, not to this guard',
  )
  assert.equal(guard.warnings.length, guard.warningsAtMount, 'and it must not warn on the way out')
})

test('m1. a block decision with poisoned feedback is repaired', async () => {
  const contexts = [{ id: 'ctx-block' }]
  const decision = { kind: 'block', feedback: textBlock('corrective ' + LONE_HIGH), additionalContexts: contexts }
  const result = { content: textBlock(LONE_HIGH), isError: false }
  const before = journal().length
  const { returned, nextCalls } = await mount().run(EXEC, result, decision)
  assert.equal(nextCalls, 1)
  assert.notEqual(returned, decision)
  assert.equal(returned.kind, 'block', 'the block survives as a block')
  assert.equal(returned.feedback[0].text, 'corrective ' + REPLACEMENT)
  assert.equal(hasSurrogate(returned.feedback[0].text), false, 'a poisoned feedback would kill the session by the same path')
  assert.equal(returned.additionalContexts, contexts, 'additionalContexts survive a repaired block too')
  assert.equal(journal().length, before + 1, 'one line per real repair, block or accept')
  assert.equal(journal().at(-1).tool, 'grep')
})

test('m2. a block decision with clean feedback keeps its identity', async () => {
  const decision = { kind: 'block', feedback: textBlock('ask the user first') }
  const before = journal().length
  const { returned } = await mount().run(EXEC, { isError: false }, decision)
  assert.equal(returned, decision, 'nothing to repair, so no copy')
  assert.equal(journal().length, before, 'and no journal line')
})

test('m3. a block decision whose feedback is not an array is inert', async () => {
  const decision = { kind: 'block', feedback: 'not an array' }
  const { returned, nextCalls } = await mount().run(EXEC, { isError: false }, decision)
  assert.equal(nextCalls, 1)
  assert.equal(returned, decision)
})

// ---------------------------------------------------------------------------
// k. the real thing.
// ---------------------------------------------------------------------------

/**
 * Mount the real harness stack: cordis, the prompt service, and the tool
 * registry. Resolution goes through the PLUGIN's own resolver, so this test
 * fails for the same reason the row would fail to arm its switch.
 *
 * @returns the loaded harness modules.
 */
async function loadHarness() {
  const cordisEntry = resolveHarnessModule('@deepseek-ai/cordis')
  const promptEntry = resolveHarnessModule('@deepseek-ai/dsh-system-prompt')
  const toolsEntry = resolveHarnessModule('@deepseek-ai/dsh-tools')
  if (cordisEntry === undefined || promptEntry === undefined || toolsEntry === undefined) {
    // Never a skip: an end-to-end case that quietly does not run is a failure
    // dressed as a pass.
    assert.fail(
      'the harness is not resolvable from this machine, so the end-to-end case cannot run: '
      + 'no anchor resolved @deepseek-ai/dsh-tools. Anchors tried: process.argv[1]=' + String(process.argv[1])
      + ', DSH_PROFILE_DIR=' + String(process.env.DSH_PROFILE_DIR)
      + ', cwd=' + process.cwd()
      + ', global install under %APPDATA%/npm/node_modules/@deepseek-ai/dsh. '
      + 'Install the harness globally (npm i -g @deepseek-ai/dsh) or set DSH_PROFILE_DIR to a profile that resolves it.',
    )
  }
  return {
    Context: (await import(pathToFileURL(cordisEntry).href)).Context,
    promptModule: await import(pathToFileURL(promptEntry).href),
    toolsModule: await import(pathToFileURL(toolsEntry).href),
  }
}

/**
 * Build a real harness stack: a cordis root context, the prompt service, and
 * the tool registry, all loaded from the running installation.
 *
 * @returns the settled context, the registry module, and a tick helper.
 */
async function mountStack() {
  const { Context, promptModule, toolsModule } = await loadHarness()
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25))
  const ctx = new Context()
  ctx.plugin(promptModule.default)
  ctx.plugin(toolsModule.ToolRuntime, { mode: 'native' })
  await settle()
  assert.equal(typeof ctx.tools, 'object', 'the real tool registry mounted')
  return { ctx, toolsModule, settle }
}

/**
 * One real dispatch through the registry, at the stage the agent loop drives.
 *
 * @param ctx - the mounted context.
 * @param name - the registered tool name.
 * @param callId - a distinct call identity per execution.
 * @returns the final result, the object the loop would append.
 */
function callTool(ctx, name, callId) {
  return ctx.tools.execute({ callId, name, arguments: {}, signal: new AbortController().signal })
}

test('k. with the real dsh-tools mounted, the logged content is the repaired text', async () => {
  const { ctx, toolsModule, settle } = await mountStack()
  const poisoned = 'PREFIX ' + LONE_HIGH + ' SUFFIX'
  ctx.tools.register(toolsModule.defineContentToolFixture({
    name: 'surrogate-fixture',
    description: 'returns one text block holding an unpaired high surrogate',
    parameters: {},
    async execute() {
      return [{ type: 'text', text: poisoned }]
    },
  }))

  // Control first: without the guard, the very content the loop would log is
  // poisoned. This is what makes the second half a measurement and not a hope.
  const unguarded = await callTool(ctx, 'surrogate-fixture', 'call-unguarded')
  assert.equal(unguarded.isError, false)
  assert.equal(unguarded.content[0].text, poisoned, 'control: the fixture really carries the lone surrogate')
  assert.equal(hasSurrogate(unguarded.content[0].text), true)

  const before = journal().length
  ctx.plugin({ name, apply, Config }, { enabled: true })
  await settle()

  const guarded = await callTool(ctx, 'surrogate-fixture', 'call-guarded')
  assert.equal(guarded.isError, false, 'the guard must not turn the call into an error')
  assert.equal(guarded.content[0].text, 'PREFIX ' + REPLACEMENT + ' SUFFIX')
  assert.equal(hasSurrogate(guarded.content[0].text), false, 'the content the loop logs holds no half')
  assert.deepEqual(guarded.value, unguarded.value, 'the structured value is forwarded unchanged; only the content is repaired')
  const lines = journal()
  assert.equal(lines.length, before + 1, 'the real dispatch wrote one journal line')
  assert.equal(lines[lines.length - 1].tool, 'surrogate-fixture')
  assert.equal(lines[lines.length - 1].repaired, 1)
})

test('k2. a tool body that THROWS a poisoned message is repaired too', async () => {
  // Measured correction to an earlier claim of this repository: a tool body
  // that throws is NOT a bypass. dispatchToolBody contains the body throw
  // (dsh-tools/lib/index.js:3313-3314) and answers kind: 'post-result'
  // (dsh-tools/lib/index.js:3341), so the waterfall runs on a thrown error and
  // the error text it produces is repaired like any other content. The
  // final-result bypass at dsh-tools/lib/index.js:3346 covers only failures
  // raised OUTSIDE the tool body.
  const { ctx, toolsModule, settle } = await mountStack()
  ctx.tools.register(toolsModule.defineContentToolFixture({
    name: 'thrower-fixture',
    description: 'throws with an unpaired high surrogate in its message',
    parameters: {},
    async execute() {
      throw new Error('kaboom ' + LONE_HIGH + ' end')
    },
  }))

  const unguarded = await callTool(ctx, 'thrower-fixture', 'throw-unguarded')
  assert.equal(unguarded.isError, true)
  assert.equal(unguarded.content[0].text, 'Error: kaboom ' + LONE_HIGH + ' end', 'control: the thrown message really is poisoned')
  assert.equal(hasSurrogate(unguarded.content[0].text), true)

  const before = journal().length
  ctx.plugin({ name, apply, Config }, { enabled: true })
  await settle()

  const guarded = await callTool(ctx, 'thrower-fixture', 'throw-guarded')
  assert.equal(guarded.isError, true, 'the failure is still a failure')
  assert.equal(guarded.content[0].text, 'Error: kaboom ' + REPLACEMENT + ' end')
  assert.equal(hasSurrogate(guarded.content[0].text), false)
  const lines = journal()
  assert.equal(lines.length, before + 1, 'the thrown result was journalled as a real repair')
  assert.equal(lines[lines.length - 1].tool, 'thrower-fixture')
})
