// Unit tests for the relay's NOTICE POLICY — who gets told, and what the message claims.
//   node --test test/notice.test.mjs
//
// Two defects were measured in this path on 2026-09-29:
//
//   1. the relay ignored `event.awaited`, the registry's own discriminant for "the
//      owner already collected this" (`dsh-jobs/lib/types/types.d.ts:192-202`:
//      "a completion reporter treats an awaited settlement as already delivered and
//      reports only the unawaited ones"). 135 notices had been relayed, seven of them
//      in three minutes for `node --version`, `git status` and `Get-ChildItem` — the
//      one useful `exit code: 1` diluted by six `exit code: 0`;
//   2. the message asserted "the subagent had already returned when it settled"
//      unconditionally, while the caller held `ownerState` — the measurement that
//      contradicted it. Refuted live: a notice claimed the verifier had returned while
//      `list_agents` showed it running, waiting on the very job being announced.
//
// The cases below fix both. The teardown case guards the notice this plugin exists for,
// and the last case guards the fence that keeps it quiet about the root's own jobs.
//
// A SECOND campaign, measured 2026-10-03 on 18 491 journal records / 2 days, found the
// same redundancy in the case that rule left open:
//   53 notices relayed — 52 `producer`, and 100 % of those carried `ownerState: running`;
//   action rate 6/52 = 11.5 %, one of the six reads refused ("belongs to another session").
// The relay already abstains when the notice would be redundant (15 × `owner-is-the-root`),
// yet it sent one it labelled itself "treat this one as a duplicate". T-V1 applies the
// existing doctrine to that second case; T-V2/T-V3 pin what is still notified (the
// expensive case, and the owner nothing else can reach); T-V6 guards the shape where the
// fallback lands on the owner itself.
//
// T-V4 pins the OTHER defect the same campaign exposed: the notice text branched on the
// OWNER's state but never on WHO the recipient is. When the fallback designates another
// agent, "it receives this notice itself" and "Read its output with job_output" are both
// false — the second one MEASURED refused (`job_output(pwsh-238)` → "belongs to another
// session"). T-V5 is the non-regression of that branch: the recipient that IS the owner
// still reads the text unchanged.
//
// NOT ADAPTED SILENTLY — the two pre-existing cases below whose assertion was INVERTED,
// and why:
//   - 'an unawaited settlement from a running owner is relayed, and says it was running'
//     encoded exactly the behaviour the 2026-10-03 measurement condemned. It now asserts
//     the abstention (T-V1), keeping its original job/label/detail so the change is
//     visible rather than a case quietly reworded.
//   - T-U1 in owner.test.mjs, 'a LIVE durable root is the owner', asserted the delivery of
//     a `producer` settlement to a RUNNING root. Same redundancy, same inversion; it now
//     asserts the bail and the journal record that carries its motive.
// Owner cases whose fixture only keeps the owner alive are updated to keep the OWNER
// OUT of the live registry (the ordinary relay case: the worker returned), which is the
// only situation in which a notice is still owed.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

const home = mkdtempSync(join(tmpdir(), 'dsh-relay-'))
const frame = (record) => zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n', 'utf8'))

/**
 * One durable session log under the temp store, header first — the only record
 * `headers()` reads. `parentSession` absent makes the session its own root.
 */
function writeSession(id, parentSession) {
  const dir = join(home, 'sessions', 'ws', id)
  mkdirSync(dir, { recursive: true })
  const header = parentSession === undefined ? { type: 'session', id } : { type: 'session', id, parentSession }
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame(header), frame({ type: 'turn/start' })]))
}

for (const record of [{ id: 'session-root' }, { id: 'session-child', parentSession: 'session-root' }]) {
  writeSession(record.id, record.parentSession)
}

// T-V4 — the chain of the measured case, per the real headers decoded on disk. It is NOT
// a two-hop fixture: the fallback picks the HIGHEST live ancestor, and the difference
// between a chain of two and a chain of four is exactly what the notice must say.
//   session-018354d9 (root, dead) → session-7fa9e670 (live) → session-d8c1740e (dead)
//   → 949882e3 (the job's owner, returned)
writeSession('session-018354d9')
writeSession('session-7fa9e670', 'session-018354d9')
writeSession('session-d8c1740e', 'session-7fa9e670')
writeSession('949882e3', 'session-d8c1740e')
// T-V6 — the measured `pwsh-1` shape (2026-10-02: owner 7fa9e670, headerRoot 018354d9,
// liveOwner 7fa9e670). The owner's parent header EXISTS and is DEAD, so the header walk
// resolves to a session that no longer answers and the fallback has to arbitrate. Without
// that parent header the chain ends at the owner, the fallback is vacuous, and the case
// proves nothing — measured while writing it.
writeSession('session-t6-root')
writeSession('session-t6-owner', 'session-t6-root')
// T-V5 — the honest fixture for "the recipient IS the owner": a session that is its own
// header root, so no fallback runs and the delivery lands on the owner. The two-hop
// fixture ('session-child' under 'session-root') is NOT that case: once the child returns,
// the recipient is the root, a different session — which is precisely fix A.
writeSession('session-v5-solo')
// `session-t6-owner` has a parent header and is itself alive — so it is only reachable
// through the fallback, never as the header root.

// The relay resolves its harness dependency from the host's own argv[1] anchor, which
// does not exist under `node --test`; DSH_PROFILE_DIR is the documented fallback.
process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = join(homedir(), '.dsh', 'profiles', 'web')
const relay = await import('../lib/index.js')

const JOURNAL = join(home, 'plugin-data', 'dsh-boost-relay', 'decisions.jsonl')

test.after(() => rmSync(home, { recursive: true, force: true }))

/** The journal as parsed records; `[]` when nothing was ever written. */
function records() {
  if (!existsSync(JOURNAL)) return []
  return readFileSync(JOURNAL, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

/**
 * Mount the relay on a fake host holding exactly the given live agents.
 * @param statuses - `{ id: status }`; an id left out is ABSENT from the live registry —
 *   the ordinary case where the worker has already returned.
 * @returns the handler its subscriptions received, and every message actually delivered,
 *   tagged with the session it went to.
 */
function mount(statuses) {
  const seen = { filters: [], delivered: [], handler: undefined }
  const agents = { list: () => [], get: undefined }
  agents.get = (id) => {
    const status = statuses[id]
    if (status === undefined) return undefined
    return {
      id,
      status,
      session: { id },
      inject: (message) => seen.delivered.push({ to: id, message }),
      followup: (message) => seen.delivered.push({ to: id, message }),
    }
  }
  const ctx = {
    jobs: { events: { subscribe: (filter, handler) => { seen.filters.push(filter); seen.handler = handler; return () => {} } } },
    agents,
    on: () => {},
    effect: (run) => { run() },
    inject: () => {},
  }
  relay.apply(ctx)
  assert.equal(typeof seen.handler, 'function', 'the relay must subscribe to job events')
  return seen
}

/** Mount, settle one event, and report what was delivered and what was journalled. */
async function settle(event, statuses) {
  // Cleared BEFORE the mount delivers the event: the relay drops an event object it has
  // already handled (`handled` WeakSet), so a test that reuses a literal event would be
  // silently skipped and read as "nothing delivered" — measured while writing these cases.
  rmSync(JOURNAL, { force: true })
  const seen = mount(statuses)
  seen.handler(event)
  await new Promise((resolve) => setTimeout(resolve, 150))
  return { delivered: seen.delivered, journal: records() }
}

/**
 * Drive one settlement through the relay's subscription.
 * @param event - the registry event the host would deliver.
 * @param childStatus - the owner agent's status, or undefined when it is gone.
 */
async function relayOne(event, childStatus) {
  const statuses = { 'session-root': 'idle' }
  if (childStatus !== undefined) statuses['session-child'] = childStatus
  const seen = mount(statuses)
  seen.handler(event)
  await new Promise((resolve) => setTimeout(resolve, 150))
  return { ...seen, messages: seen.delivered.map((entry) => entry.message) }
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

function textOf(message) {
  const content = message?.content
  if (Array.isArray(content)) return content.map((block) => block?.text ?? '').join('')
  return typeof message?.text === 'string' ? message.text : JSON.stringify(message)
}

test('an awaited settlement is not relayed: the owner already received it', async () => {
  const seen = await relayOne(jobEvent({ awaited: true }), 'running')
  assert.deepEqual(seen.messages, [], 'an awaited settlement must produce no notice')
})

// CHANGED, and the change is the point (see the header). This case used to assert that the
// relay sent a notice to a RUNNING owner, and that the text said so — the exact 52/53
// shape the 2026-10-03 measurement condemned: the owner receives that settlement itself.
test('T-V1 a producer settlement whose owner is ALIVE produces no notice, and the bail is journalled', async () => {
  const seen = await settle(jobEvent({ awaited: false }), { 'session-root': 'idle', 'session-child': 'running' })
  assert.deepEqual(seen.delivered, [], 'a running owner gets its own notice natively: relaying would duplicate it')
  const gate = seen.journal.find((record) => record.step === 'bail' && record.why === 'owner-already-notified')
  assert.ok(gate !== undefined, 'the abstention must be journalled — an unmotivated silence is indistinguishable from a breakdown')
  assert.equal(gate.job, 'pwsh-1')
  assert.equal(gate.owner, 'child')
  assert.equal(gate.ownerState, 'running', 'the record carries the measurement the decision rests on')
  assert.equal(gate.root, 'root')
  assert.equal(seen.journal.some((record) => record.step === 'relayed'), false, 'nothing may be relayed on this path')
})

test('T-V2 a teardown is notified even with the owner alive — the case this plugin exists for', async () => {
  const seen = await settle(
    jobEvent({ awaited: false, cause: 'teardown', job: { id: 'pwsh-1', kind: 'pwsh', label: 'une commande', owner: 'session-child', status: 'failed' } }),
    { 'session-child': 'running' },
  )
  assert.equal(seen.delivered.length, 1, 'a job that died with its worker must be announced')
  assert.equal(seen.delivered[0].to, 'session-child')
  assert.match(textOf(seen.delivered[0].message), /terminated when that subagent settled/)
  assert.equal(seen.journal.some((record) => record.step === 'bail' && record.why === 'owner-already-notified'), false)
})

test('T-V3 a producer settlement whose owner is ABSENT from the live registry is notified', async () => {
  // The owner returned: no agent can receive the settlement natively, so the notice is owed.
  const seen = await settle(jobEvent({ awaited: false }), { 'session-root': 'idle' })
  assert.equal(seen.delivered.length, 1, 'an owner the registry cannot produce is exactly when the notice matters')
  assert.equal(seen.delivered[0].to, 'session-root')
  const gate = seen.journal.find((record) => record.step === 'bail' && record.why === 'owner-already-notified')
  assert.equal(gate, undefined, 'the gate must not fire when there is no live owner to notify')
  assert.equal(seen.journal.find((record) => record.step === 'settled').ownerState, 'absent')
})

// CHANGED in the same way as T-V1: an owner that is gone is still reported as gone, but the
// assertion now goes through the settle helper so the delivered message is the one the
// recipient actually received.
test('an owner that is gone is reported as gone', async () => {
  const seen = await relayOne(jobEvent({ awaited: false }), undefined)
  assert.equal(seen.messages.length, 1)
  const text = textOf(seen.messages[0])
  assert.match(text, /no longer running/)
  assert.doesNotMatch(text, /still RUNNING/)
})

test('a teardown is relayed even when it was awaited — that notice is why this plugin exists', async () => {
  const seen = await relayOne(jobEvent({ awaited: true, cause: 'teardown' }), undefined)
  assert.equal(seen.messages.length, 1)
  assert.match(textOf(seen.messages[0]), /terminated when that subagent settled/)
})

test('a job owned by the root itself is never relayed back to it', async () => {
  const seen = await relayOne(jobEvent({ job: { id: 'pwsh-2', kind: 'pwsh', label: 'x', owner: 'session-root', status: 'completed' } }), 'running')
  assert.deepEqual(seen.messages, [])
})

/**
 * The measured event, reproduced as the registry delivered it on 2026-10-03:
 *   owner 949882e3 (the worker, still running), job pwsh-238, cause producer.
 * The old code relayed it to 7fa9e670 — a session that is NOT the owner.
 */
function measuredEvent(cause = 'producer') {
  return {
    type: 'settled',
    job: { id: 'pwsh-238', kind: 'pwsh', label: 'mesure', owner: '949882e3', status: 'completed', detail: 'exit code: 0' },
    cause,
    awaited: false,
  }
}

// T-V4 — fix A. The text branches on the RECIPIENT's identity, not only on the owner's state.
test('T-V4 the fallback designates a NON-owner: the text names the real owner and promises no job_output', async () => {
  // The owner RETURNED (absent from the registry) — the only way a fallback can elect a
  // session other than the owner. Live: session-7fa9e670 (running, mid-chain).
  const { delivered, journal } = await settle(measuredEvent(), { 'session-7fa9e670': 'running' })
  assert.equal(delivered.length, 1, 'the notice must still be delivered — silently dropping it is the other failure')
  assert.equal(delivered[0].to, 'session-7fa9e670', 'the recipient is the highest LIVE ancestor, and it is not the owner')
  const text = textOf(delivered[0].message)
  assert.match(text, /pwsh-238/)
  assert.match(text, /subagent 949882e3/, 'the REAL owner must be named')
  assert.match(text, /you are not that session/, 'and the recipient must be told that identity, not left to guess')
  assert.doesNotMatch(text, /Read its output with/, 'MEASURED impossible from there: "job pwsh-238 belongs to another session" — do not promise a read the recipient cannot make')
  assert.doesNotMatch(text, /receives this notice itself/, 'the owner is not the recipient: that sentence is false here')
  assert.doesNotMatch(text, /treat this one as a duplicate/, 'that sentence presupposes the recipient owns the notice; it must not reappear here')
  assert.doesNotMatch(text, /still RUNNING/, 'the owner was gone, so the running sentence is not the one that applies')
  const relayed = journal.find((record) => record.step === 'relayed')
  assert.equal(relayed.recipientIsOwner, false, 'the journal must carry the identity the text branched on')
  assert.equal(relayed.root, '7fa9e670')
})

// T-V4b — the identity branch of the TEARDOWN text, which is a separate string. A teardown is
// notified while the owner is still running, but then the fallback elects the owner itself
// (it is live), so the non-owner teardown text is only reachable with the owner GONE. That
// is the shape of a worker destroyed together with the job it launched.
test('T-V4b the teardown text branches on identity too: the non-owner variant names the owner', async () => {
  const { delivered, journal } = await settle(measuredEvent('teardown'), { 'session-7fa9e670': 'running' })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].to, 'session-7fa9e670', 'the ancestor is the only live session left to tell')
  const text = textOf(delivered[0].message)
  assert.match(text, /terminated when that subagent settled/)
  assert.match(text, /subagent 949882e3/)
  assert.match(text, /you are not that session/)
  assert.match(text, /`job_output` is not available from here/, 'the read is impossible from the ancestor: say it rather than promise it')
  assert.doesNotMatch(text, /Read its output with/, 'nothing may instruct the ancestor to read the job output')
  assert.doesNotMatch(text, /start a long job from THIS session/, "the owner's remedies are not the ancestor's")
  assert.equal(journal.find((record) => record.step === 'relayed').recipientIsOwner, false)
})

// T-V5 — non-regression of A. The recipient IS the owner: the text is the original one,
// and `recipientIsOwner` is DIFFERENT from "a fallback ran". A fallback that elects the
// owner itself is case 1, not case 2: the recipient is the session the job belongs to.
//
// A `kill` is used to reach the delivery: with a `producer` cause this shape is exactly
// T-V6, and with an owner that is its own header root the `owner-is-the-root` fence
// correctly suppresses the notice (a session that started the job receives it natively),
// so neither of those reaches the text under test.
test('T-V5 the owner-as-recipient text is unchanged: no owner naming, no identity sentence', async () => {
  const event = {
    type: 'settled',
    job: { id: 'pwsh-v5', kind: 'pwsh', label: 'une commande', owner: 'session-t6-owner', status: 'completed', detail: 'exit code: 0' },
    cause: 'kill',
    awaited: false,
  }
  const { delivered, journal } = await settle(event, { 'session-t6-owner': 'idle' })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].to, 'session-t6-owner', 'the fallback elected the owner: it is the recipient')
  const text = textOf(delivered[0].message)
  assert.match(text, /^\[boost-relay\] Background job pwsh-v5 \(pwsh: une commande\) launched inside subagent t6-owner finished \[status: completed, kill\] — exit code: 0\./)
  assert.match(text, /That job belongs to the subagent, which is no longer running — so its report predates this output\. If the result matters: `send_message` to that subagent/)
  assert.doesNotMatch(text, /you are not that session/, 'the identity sentence belongs to the fallback-to-ANOTHER-session branch only')
  assert.doesNotMatch(text, /it receives this notice itself/, 'and the duplicate warning must not reappear for an owner that is not running')
  assert.equal(journal.some((record) => record.step === 'owner-fallback'), true, 'the fallback did run — and still elected the owner')
  assert.equal(journal.find((record) => record.step === 'relayed').recipientIsOwner, true)
})

// The fence, unchanged and still correct: a session that started the job itself receives the
// settlement natively, so nothing is relayed back to it — even when it is the only session
// there is. T-V5 deliberately does NOT use this shape, because it cannot reach the text.
test('T-V5c an owner that is its own root is still fenced off, notice or not', async () => {
  const event = {
    type: 'settled',
    job: { id: 'pwsh-v5c', kind: 'pwsh', label: 'x', owner: 'session-v5-solo', status: 'completed' },
    cause: 'producer',
    awaited: false,
  }
  const { delivered, journal } = await settle(event, { 'session-v5-solo': 'idle' })
  assert.deepEqual(delivered, [], 'the root owns the job: the registry notice is its own')
  assert.equal(journal.some((record) => record.step === 'bail' && record.why === 'owner-is-the-root'), true)
})

// The two-hop fixture, where the owner RETURNED: the recipient is the root, a DIFFERENT
// session. The upstream text was written as if the reader owned the job — fix A must catch
// this case too, and this case pins that it does.
test("T-V5b a root receiving a returned child's notice is told it is not the owner", async () => {
  const seen = await settle(jobEvent({ awaited: false }), { 'session-root': 'idle' })
  assert.equal(seen.delivered.length, 1)
  assert.equal(seen.delivered[0].to, 'session-root')
  const text = textOf(seen.delivered[0].message)
  assert.match(text, /subagent child/)
  assert.match(text, /you are not that session/)
  assert.doesNotMatch(text, /Read its output with/, 'the root cannot read a job its child owned')
  assert.equal(seen.journal.find((record) => record.step === 'relayed').recipientIsOwner, false)
})

// T-V6 — the measured `pwsh-1` of 2026-10-02: the fallback elected the OWNER ITSELF
// (owner 7fa9e670, liveOwner 7fa9e670). That is identity case 1, so the ordinary text and
// a real delivery — and it proves the gate does not confuse "fallback happened" with
// "the recipient is someone else".
test('T-V6 a fallback that elects the owner itself is treated as case 1: normal text, delivered', async () => {
  const event = {
    type: 'settled',
    job: { id: 'pwsh-1', kind: 'pwsh', label: 'mesure', owner: 'session-t6-owner', status: 'completed' },
    cause: 'producer',
    awaited: false,
  }
  const { delivered, journal } = await settle(event, { 'session-t6-owner': 'idle' })

  const fallback = journal.find((record) => record.step === 'owner-fallback')
  assert.ok(fallback !== undefined, 'the fallback must have run for this fixture')
  assert.equal(fallback.liveOwner, 't6-owner', 'and it elected the owner itself, as measured')
  assert.equal(delivered.length, 1, 'the owner is alive and idle: the notice is delivered')
  assert.equal(delivered[0].to, 'session-t6-owner')
  const text = textOf(delivered[0].message)
  assert.match(text, /That job belongs to the subagent, which is no longer running/)
  assert.doesNotMatch(text, /you are not that session/, 'the recipient IS the owner: the normal text stands')
  assert.equal(journal.find((record) => record.step === 'relayed').recipientIsOwner, true)
})
