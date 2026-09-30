// Unit tests for the relay's JOURNAL POLICY — what it writes, and how large it may grow.
//   node --test test/journal.test.mjs
//
// Measured on 2026-09-30, C:\Users\bilel\.dsh\plugin-data\dsh-boost-relay\decisions.jsonl:
// 43 639 064 bytes / 585 840 records, of which `step=event,type=output` alone was
// 341 171 records / 22 176 361 bytes — 51 % of the file, carrying no decision, and the
// unbounded growth is what made reading it in PowerShell take minutes.
//
// Falsifiability, re-measured against the ONLY prior revision this repository actually
// has (`HEAD~1`, commit 4abd4de), on a throwaway copy: 7 of the 9 cases fail — a, c, e, f,
// g, h, i — while b and d PASS, because that revision already carried the paths they
// exercise. An intermediate revision (journal policy without the topology fix) was used
// during development but was never committed, so its behaviour is NOT reproducible from
// here and is not claimed:
//   a. an `output` (or `progress`) event writes NO record, while a raw event that IS a
//      decision (`registered`) keeps its record byte-identical;
//   b. a DECISION event still writes one, with its fields;
//   c. past the ceiling the file is renamed `<name>.1` and a fresh one starts, `.1`
//      holding the OLDEST generation in write order;
//   d. a rotation that cannot happen (the `.1` path held by a DIRECTORY) neither throws
//      nor stops the record being written;
//   e. a record larger than the ceiling is written once — it cannot loop the rotation;
//   f. a settlement reaches the ONE subscription that owns it exactly once, plus the
//      catch-all, and no other (delivery counter through the registry's own guard).
//   g. a subscription whose owner does not match is NOT delivered — while an event with
//      no owner still reaches every subscription, and is still handled once;
//   h. the same agent id seen twice creates ONE subscription;
//   i. one settlement writes 3 records unawaited, 1 awaited — once, not once per
//      subscription. The triplet is ONE of the outcomes, not the rule: a settlement with NO
//      owner writes a single `skip:unowned-job`, and a settlement of a job already relayed
//      writes a single `skip:already-relayed` (both measured against the real registry).
//
// The ceiling is driven to 2 KiB through `DSH_BOOST_RELAY_LOG_MAX_BYTES` (the documented
// test seam): the boundary is the same one production uses at 8 MiB, and the test stays
// readable. `node --test <file>` only — `node --test test/` fails with MODULE_NOT_FOUND.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const CEILING = 2048
const home = mkdtempSync(join(tmpdir(), 'dsh-relay-journal-'))
process.env.DSH_HOME = home
// The relay resolves its harness dependency from the host's own argv[1] anchor, which does
// not exist under `node --test`; DSH_PROFILE_DIR is the documented fallback.
process.env.DSH_PROFILE_DIR = join(homedir(), '.dsh', 'profiles', 'web')
process.env.DSH_BOOST_RELAY_LOG_MAX_BYTES = String(CEILING)
const relay = await import('../lib/index.js')

const JOURNAL = join(home, 'plugin-data', 'dsh-boost-relay', 'decisions.jsonl')
const ROTATED = `${JOURNAL}.1`

test.after(() => rmSync(home, { recursive: true, force: true }))

/** Apply the relay to a fake host, returning the handler its subscriptions received. */
function mount() {
  const seen = { filters: [], handler: undefined }
  const ctx = {
    jobs: { events: { subscribe: (filter, handler) => { seen.filters.push(filter); seen.handler = handler; return () => {} } } },
    agents: { list: () => [], get: () => undefined },
    on: () => {},
    effect: (run) => { run() },
    inject: () => {},
  }
  relay.apply(ctx)
  assert.equal(typeof seen.handler, 'function', 'the relay must subscribe to job events')
  return seen
}

function jobEvent(overrides = {}) {
  return {
    type: 'settled',
    job: { id: 'pwsh-1', kind: 'pwsh', label: 'une commande', owner: 'session-child', status: 'completed', detail: 'exit code: 0' },
    cause: 'producer',
    awaited: false,
    ...overrides,
  }
}

/** The journal as parsed records; `[]` when nothing was ever written. */
function records(path = JOURNAL) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

/** Drop both generations, so a case observes only what it writes. */
function clearJournal() {
  rmSync(JOURNAL, { force: true })
  rmSync(ROTATED, { force: true, recursive: true })
}

test('a. an output (or progress) event writes no journal record', () => {
  const { handler } = mount()
  clearJournal()
  handler({ type: 'output', job: { id: 'pwsh-noise', kind: 'pwsh' } })
  handler({ type: 'progress', job: { id: 'pwsh-noise', kind: 'pwsh' } })
  assert.equal(existsSync(JOURNAL), false, 'a raw echo must not even create the journal')
  // A raw event that IS a decision keeps its record, and its fields, exactly as before.
  handler({ type: 'registered', job: { id: 'pwsh-noise', kind: 'pwsh' } })
  const lines = records()
  assert.equal(lines.length, 1, 'registered is a decision and must still be written')
  assert.deepEqual(Object.keys(lines[0]), ['at', 'step', 'type', 'job'])
  assert.equal(typeof lines[0].at, 'string')
  assert.equal(lines[0].step, 'event')
  assert.equal(lines[0].type, 'registered')
  assert.equal(lines[0].job, 'pwsh-noise')
})

test('b. a decision event still writes its record, with its fields', () => {
  const { handler } = mount()
  clearJournal()
  handler(jobEvent())
  const lines = records()
  assert.deepEqual(lines.map((r) => r.step), ['settled', 'resolve', 'bail'], 'the decision path must be untouched')
  assert.deepEqual(Object.keys(lines[0]), ['at', 'step', 'job', 'owner', 'cause', 'ownerState'])
  assert.equal(lines[0].job, 'pwsh-1')
  assert.equal(lines[0].owner, 'child', 'the owner is still short(ownerId)')
  assert.equal(lines[0].cause, 'producer')
  assert.equal(lines[0].ownerState, 'absent', 'no live agent was reachable from the fake host')
  assert.equal(lines[2].step, 'bail')
  assert.equal(lines[2].why, 'owner-absent-from-session-store')
  // The skip branch — a decision that ends in silence — is recorded too.
  clearJournal()
  handler(jobEvent({ awaited: true }))
  const skipped = records()
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].step, 'skip')
  assert.equal(skipped[0].why, 'awaited-by-owner')
  assert.equal(skipped[0].job, 'pwsh-1')
})

test('c. past the ceiling the journal becomes .1, and .1 holds the oldest generation', () => {
  const { handler } = mount()
  clearJournal()
  const ids = []
  // Each settlement writes three decision records (settled, resolve, bail), so the loop
  // stops on the first rotation and `.1` is exactly the first generation.
  while (!existsSync(ROTATED) && ids.length < 100) {
    const id = `pwsh-c${String(ids.length + 1).padStart(3, '0')}`
    ids.push(id)
    handler(jobEvent({ job: { id, kind: 'pwsh', label: 'une commande', owner: 'session-child', status: 'completed' } }))
  }
  assert.ok(existsSync(ROTATED), 'the journal must rotate once past the ceiling')
  const rotated = records(ROTATED)
  const current = records(JOURNAL)
  assert.ok(rotated.length > 0 && current.length > 0, 'both generations must hold records')
  assert.equal(rotated[0].job, ids[0], '.1 must start with the OLDEST record written')
  assert.equal(current.at(-1).job, ids.at(-1), 'the live file must end with the NEWEST record')
  const expected = ids.flatMap((id) => [['settled', id], ['resolve', id], ['bail', id]])
  assert.deepEqual([...rotated, ...current].map((r) => [r.step, r.job]), expected,
    'no record may be lost, duplicated or reordered by the rotation')
  assert.ok(statSync(ROTATED).size <= CEILING, `.1 must stay within the ceiling (${statSync(ROTATED).size} B)`)
  assert.ok(statSync(JOURNAL).size <= CEILING, `the live file must stay within the ceiling (${statSync(JOURNAL).size} B)`)
  assert.equal(existsSync(`${JOURNAL}.2`), false, 'one previous generation is the whole policy')
})

test('d. a rotation that cannot happen neither throws nor blocks the record', () => {
  const { handler } = mount()
  clearJournal()
  mkdirSync(ROTATED, { recursive: true })
  writeFileSync(join(ROTATED, 'occupied'), 'not mine')
  const ids = []
  for (let n = 0; n < 30; n++) {
    const id = `pwsh-d${String(n).padStart(3, '0')}`
    ids.push(id)
    assert.doesNotThrow(
      () => handler(jobEvent({ job: { id, kind: 'pwsh', label: 'une commande', owner: 'session-child', status: 'completed' } })),
      'an impossible rotation must never surface as a relay failure',
    )
  }
  assert.ok(statSync(JOURNAL).size > CEILING, 'the journal must keep growing when it cannot rotate')
  const lines = records()
  assert.equal(lines.at(-1).job, ids.at(-1), 'the last record must be written even though the rotation failed')
  assert.equal(lines.length, ids.length * 3, 'every record must still be written')
  assert.equal(existsSync(join(ROTATED, 'occupied')), true, 'a failed rotation must not delete what occupies .1')
})

test('e. a record larger than the ceiling is written once and cannot loop the rotation', () => {
  const { handler } = mount()
  clearJournal()
  const huge = 'x'.repeat(4 * CEILING)
  // One awaited settlement writes exactly ONE record (skip), isolating the oversized write.
  handler(jobEvent({ awaited: true, job: { id: huge, kind: 'pwsh', label: 'huge', owner: 'session-child', status: 'completed' } }))
  assert.equal(records().length, 1, 'the oversized record must be durable, not dropped')
  assert.equal(existsSync(ROTATED), false, 'a record bigger than the ceiling must not be rotated against itself')
  assert.ok(statSync(JOURNAL).size > CEILING, 'the record itself is over the ceiling — unavoidable, it is one record')
  // The NEXT write rotates once: the oversized generation moves to .1 as a whole.
  handler(jobEvent({ awaited: true, job: { id: 'pwsh-e2', kind: 'pwsh', label: 'small', owner: 'session-child', status: 'completed' } }))
  assert.deepEqual(records(ROTATED).map((r) => r.job), [huge], '.1 must hold exactly the oversized record, once')
  assert.deepEqual(records().map((r) => r.job), ['pwsh-e2'], 'the live file must restart with the new record only')
  assert.equal(existsSync(`${JOURNAL}.2`), false, 'a bounded rotation keeps one generation')
})

/**
 * The registry's own fan-out, transcribed from the installed source
 * (`dsh-jobs-local/lib/index.js:71-81`): a subscription is skipped only when it carries
 * the SINGULAR `owner` key and the event's owner differs. Work with no owner
 * (`ownerId === undefined`) reaches every subscription — `types.d.ts:212-216`.
 */
function emit(subs, event, ownerId) {
  const delivered = []
  for (const { filter, handler } of subs) {
    if ('owner' in filter && ownerId !== undefined && ownerId !== filter.owner) continue
    handler(event)
    delivered.push(filter)
  }
  return delivered
}

/** Mount the relay against a host holding exactly the given live agents. */
function mountWith(liveIds) {
  const seen = { subs: [], agentEvents: new Map() }
  const ctx = {
    jobs: { events: { subscribe: (filter, handler) => { seen.subs.push({ filter, handler }); return () => {} } } },
    agents: { list: () => liveIds.map((id) => ({ session: { id } })), get: () => undefined },
    on: (name, cb) => seen.agentEvents.set(name, cb),
    effect: (run) => { run() },
    inject: () => {},
  }
  relay.apply(ctx)
  seen.created = (id) => seen.agentEvents.get('agent/created')({ agent: { session: { id } }, source: 'delegate' })
  return seen
}

test('f. a settlement reaches the subscription that owns it exactly once', () => {
  const h = mountWith(['session-live1', 'session-live2', 'session-live3'])
  clearJournal()
  assert.equal(h.subs.length, 4, 'one catch-all + one per live agent')
  const event = jobEvent({ job: { id: 'pwsh-f1', kind: 'pwsh', label: 'x', owner: 'session-live2', status: 'completed' } })
  const delivered = emit(h.subs, event, 'session-live2')
  assert.equal(delivered.length, 2, 'the catch-all and the owner — not the other two')
  assert.deepEqual(delivered.filter((f) => 'owner' in f).map((f) => f.owner), ['session-live2'],
    'the owning subscription is delivered exactly once')
  assert.equal(h.subs.filter((s) => s.filter.owner === 'session-live2').length, 1, 'and it exists once')
  assert.deepEqual(records().map((rec) => rec.step), ['settled', 'resolve', 'bail'],
    'two deliveries, ONE decision path')
})

test('g. a subscription whose owner does not match is not delivered', () => {
  const h = mountWith(['session-live1', 'session-live2'])
  clearJournal()
  emit(h.subs, jobEvent({ job: { id: 'pwsh-g1', kind: 'pwsh', label: 'x', owner: 'session-live2', status: 'completed' } }), 'session-live2')
  const delivered = emit(h.subs, jobEvent({ job: { id: 'pwsh-g2', kind: 'pwsh', label: 'x', owner: 'session-live2', status: 'completed' } }), 'session-live2')
  assert.deepEqual(delivered.filter((f) => 'owner' in f).map((f) => f.owner), ['session-live2'],
    'live1 must not hear live2 settlements')
  assert.equal(h.subs.some((s) => s.filter.owner === 'session-live1'), true, 'the non-matching subscription does exist')
  // An event with NO owner is delivered to every subscription (`types.d.ts:212-216`) — and
  // must still be handled once: this is what the identity guard in `onEvent` buys.
  const before = records().length
  const unowned = emit(h.subs, jobEvent({ job: { id: 'pwsh-g3', kind: 'pwsh', label: 'x', status: 'completed' } }), undefined)
  assert.equal(unowned.length, 3, 'unowned work reaches all three subscriptions')
  assert.equal(records().length - before, 1, 'three deliveries, ONE skip record')
  assert.equal(records().at(-1).why, 'unowned-job')
})

test('h. the same agent id seen twice creates one subscription', () => {
  const h = mountWith(['session-live1', 'session-live2'])
  assert.equal(h.subs.length, 3, 'one catch-all + one per live agent')
  h.created('session-live1')
  assert.equal(h.subs.length, 3, 'an id already subscribed at mount adds nothing')
  h.created('session-live3')
  assert.equal(h.subs.length, 4, 'a NEW id adds exactly one subscription')
  h.created('session-live3')
  h.created('session-live3')
  assert.equal(h.subs.length, 4, 'and repeats of that id add nothing')
  assert.equal(h.subs.filter((s) => s.filter.owner === 'session-live3').length, 1)
})

test('i. one settlement writes 3 records unawaited, 1 awaited — once each', () => {
  const h = mountWith(['session-live1', 'session-live2'])
  clearJournal()
  emit(h.subs, jobEvent({ awaited: false, job: { id: 'pwsh-i1', kind: 'pwsh', label: 'x', owner: 'session-live2', status: 'completed' } }), 'session-live2')
  assert.deepEqual(records().map((rec) => rec.step), ['settled', 'resolve', 'bail'],
    'unawaited: settled + resolve + bail, not one set per subscription')
  clearJournal()
  emit(h.subs, jobEvent({ awaited: true, job: { id: 'pwsh-i2', kind: 'pwsh', label: 'x', owner: 'session-live2', status: 'completed' } }), 'session-live2')
  assert.deepEqual(records().map((rec) => rec.step), ['skip'], 'awaited: exactly one skip record')
  assert.equal(records()[0].why, 'awaited-by-owner')
})
