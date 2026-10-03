// Unit tests for the relay's OWNER RESOLUTION — WHO receives the notice.
//   node --test test/owner.test.mjs
//
// The rule, measured (relay journal, 2026-10-02; the same correction on the sibling line is
// documented at packages/detached-jobs/lib/index.js:1128-1152, and the channel carries it at
// packages/boost-channel/lib/index.js:836-847):
//
//   THE OWNER = the highest LIVING ancestor of the parent chain,
//               or the caller itself when no ancestor is alive.
//
// The case that broke it: a session CONTINUED after a restart is a seeded fork
// (`isSeeded: true`, `delegationDepth: 0`) whose parent — the session of the previous
// process — is no longer alive. The durable-header walk resolves to that DEAD session, so
// `ctx.agents.get(rootId)` returned undefined and the relay bailed: the live parent, the only
// agent that could act on the output, was told nothing.
//
// `rootOf` is UNCHANGED and stays the path (`listDescendants` never sees a forked session,
// and `agents.list()` is documented as intermittent). What these cases pin is the fallback
// that ARBITRATES with the live registry only when the header root is not alive.
//
// MEASURED 2026-10-03 (18 491 journal records, 2 days), two rules changed under these cases:
//   - a `producer` settlement whose owner is RUNNING is now ABSTAINED ON
//     (`{step:'bail', why:'owner-already-notified'}`). 52 of the 53 relayed notices were
//     `producer` and 100 % of those carried `ownerState: running` — the owner receives that
//     settlement natively, and the relay was sending it one labelled "treat this one as a
//     duplicate". T-U1 and T-U3 asserted that delivery and are INVERTED here, on purpose.
//     "Alive" is narrowed to `running`, the only state the measurement observed: an `idle`
//     owner still receives the notice (the live `pwsh-1` of 2026-10-02 was relayed to an
//     `idle` session), which is why T-U4 and T-U5 set the owner `idle` and not `running`.
//   - the fallback can address a session that is NOT the job's owner, and the notice text now
//     branches on that identity (see notice.test.mjs T-V4).
// A fixture that keeps the OWNER out of the live registry is the ordinary relay case — the
// worker returned — and remains the case in which a notice is owed.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

const home = mkdtempSync(join(tmpdir(), 'dsh-relay-owner-'))
const frame = (record) => zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n', 'utf8'))

/** One durable session log, header first — the only record `headers()` reads. */
function writeSession(id, parentSession) {
  const dir = join(home, 'sessions', 'ws', id)
  mkdirSync(dir, { recursive: true })
  const header = parentSession === undefined ? { type: 'session', id } : { type: 'session', id, parentSession }
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame(header), frame({ type: 'turn/start' })]))
}

// T-U1 — the non-regression shape: one hop, and the durable root is live.
writeSession('session-t1-root')
writeSession('session-t1-child', 'session-t1-root')
// T-U2 — THE UNREADABLE LINK: 'session-t2-ghost' is named by an existing header but has NO log
// of its own, so `rootOf` returns an id the headers know NOTHING about. The highest LIVE
// ancestor is 'session-t2-mid'; the job's own owner 'session-t2-child' is not live at all (the
// worker returned — the ordinary relay case).
writeSession('session-t2-mid', 'session-t2-ghost')
writeSession('session-t2-child', 'session-t2-mid')
// T-U3 — the continued session: every header exists, the durable root is DEAD, the middle lives.
writeSession('session-t3-dead')
writeSession('session-t3-mid', 'session-t3-dead')
writeSession('session-t3-leaf', 'session-t3-mid')
// T-U4 — a dead durable root and NO live ancestor anywhere above the owner.
writeSession('session-t4-dead')
writeSession('session-t4-leaf', 'session-t4-dead')

// The relay resolves its harness dependency from the host's own argv[1] anchor, which does not
// exist under `node --test`; DSH_PROFILE_DIR is the documented fallback. DSH_HOME decides the
// session store AND the journal path, and must be set BEFORE the import.
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
 * A live registry holding exactly the given agents.
 * @param spec - `{ id: { status, parent } }`; `parent` is the LIVE session's own header link,
 *   which is what a real Agent carries (`agent.session.header.parentSession`).
 */
function registryOf(spec) {
  const byId = new Map()
  const sent = []
  for (const [id, entry] of Object.entries(spec)) {
    byId.set(id, {
      id,
      status: entry.status,
      session: { id, header: entry.parent === undefined ? {} : { parentSession: entry.parent } },
      inject: (message) => sent.push({ to: id, message }),
      followup: (message) => sent.push({ to: id, message }),
    })
  }
  return { sent, list: () => [...byId.values()], get: (id) => byId.get(id) }
}

/** Mount the relay on a fake host, settle one job, and report what was sent and journalled. */
async function settle(ownerId, spec, options = {}) {
  const registry = options.noAgents === true ? undefined : registryOf(spec)
  const seen = { handler: undefined }
  const ctx = {
    jobs: { events: { subscribe: (filter, handler) => { seen.handler = handler; return () => {} } } },
    on: () => {},
    effect: (run) => { run() },
    inject: () => {},
    ...(registry === undefined ? {} : { agents: registry }),
  }
  relay.apply(ctx)
  assert.equal(typeof seen.handler, 'function', 'the relay must subscribe to job events')
  rmSync(JOURNAL, { force: true })
  seen.handler({
    type: 'settled',
    job: {
      id: options.jobId ?? 'pwsh-owner-1',
      kind: 'pwsh',
      label: 'une commande',
      owner: ownerId,
      status: 'completed',
      detail: 'exit code: 0',
    },
    cause: 'producer',
    awaited: false,
  })
  await new Promise((resolve) => setTimeout(resolve, 150))
  return { sent: registry === undefined ? [] : registry.sent, journal: records() }
}

// INVERTED (see the header): this case used to assert that a `producer` settlement of a
// RUNNING owner was delivered to a live root. That is the 52/53 redundancy measured on
// 2026-10-03 — the child receives the notice natively. The resolution itself is unchanged
// and is still asserted: no fallback record, and the root is the live durable one.
test('T-U1 a LIVE durable root with a RUNNING owner: the resolution holds, and the relay abstains', async () => {
  const { sent, journal } = await settle('session-t1-child', {
    'session-t1-root': { status: 'idle' },
    'session-t1-child': { status: 'running', parent: 'session-t1-root' },
  })
  assert.deepEqual(sent, [], 'a running owner collects its own settlement: the notice is not owed')
  assert.equal(journal.some((record) => record.step === 'owner-fallback'), false,
    'a normal resolution must not write a fallback record')
  const gate = journal.find((record) => record.step === 'bail' && record.why === 'owner-already-notified')
  assert.ok(gate !== undefined, 'the abstention is journalled, like every other decision')
  assert.equal(gate.ownerState, 'running', 'and carries the measurement it rests on')
  assert.equal(gate.root, 't1-root', 'the root resolution is the same one as before')
  assert.equal(journal.some((record) => record.step === 'relayed'), false)
})

test('T-U2 a parent ABSENT from the headers renders the LIVE ancestor, never the unknown id', async () => {
  const { sent, journal } = await settle('session-t2-child', {
    'session-t2-mid': { status: 'idle', parent: 'session-t2-ghost' },
  })
  assert.equal(sent.length, 1, 'the notice must be DELIVERED, not lost on an id nothing describes')
  assert.equal(sent[0].to, 'session-t2-mid', 'the owner is the highest LIVE ancestor')
  const fallback = journal.find((record) => record.step === 'owner-fallback')
  assert.ok(fallback !== undefined, 'the fallback must be journalled')
  assert.equal(fallback.headerRoot, 't2-ghost', 'the header walk stopped on an id it cannot describe')
  assert.equal(fallback.liveOwner, 't2-mid')
  assert.equal(journal.some((record) => record.step === 'relayed' && record.root === 't2-ghost'), false,
    'an id the headers know nothing about must never receive the notice')
})

// INVERTED (see the header): with the owner RUNNING, the highest live ancestor is still
// resolved — the record proves it — but nothing is delivered, because the owner receives its
// own settlement. "Must not be silent" is now satisfied by the JOURNALLED gate, not by an
// injection: the resolution is still not allowed to vanish without a trace.
test('T-U3 a DEAD durable root with a live ancestor: resolved to the highest live one, and abstained on', async () => {
  const { sent, journal } = await settle('session-t3-leaf', {
    'session-t3-mid': { status: 'idle', parent: 'session-t3-dead' },
    'session-t3-leaf': { status: 'running', parent: 'session-t3-mid' },
  })
  assert.deepEqual(sent, [], 'the running owner is told natively; the relay would duplicate it')
  const fallback = journal.find((record) => record.step === 'owner-fallback')
  assert.equal(fallback?.headerRoot, 't3-dead')
  assert.equal(fallback?.liveOwner, 't3-mid', 'the middle of the chain is still the highest LIVE ancestor')
  const gate = journal.find((record) => record.step === 'bail' && record.why === 'owner-already-notified')
  assert.ok(gate !== undefined, 'the continued-session case must not be silent about its silence')
  assert.equal(gate.root, 't3-mid')
})

// The owner is `idle`, which the gate does NOT abstain on — a session between turns still
// has to be told about a job nothing else can report. The gate keys on `running` alone.
test('T-U4 a dead root and NO live ancestor gives the ownerId — and the notice IS delivered', async () => {
  const { sent, journal } = await settle('session-t4-leaf', {
    'session-t4-leaf': { status: 'idle', parent: 'session-t4-dead' },
  })
  assert.equal(sent.length, 1, 'with no live ancestor the owner itself is the owner, and it is told')
  assert.equal(sent[0].to, 'session-t4-leaf')
  const fallback = journal.find((record) => record.step === 'owner-fallback')
  assert.equal(fallback?.headerRoot, 't4-dead')
  assert.equal(fallback?.liveOwner, 't4-leaf')
  assert.equal(journal.some((record) => record.step === 'bail' && record.why === 'owner-is-the-root'), false,
    'the owner-is-the-root fence covers a LIVE durable root only')
})

test('T-U5 the fallback is JOURNALLED, and a normal resolution never writes it', async () => {
  // The OWNER is out of the live registry (it returned — the ordinary relay case); the root
  // stays live. `running` here would hit the new gate and prove nothing about the fallback.
  const normal = await settle('session-t1-child', {
    'session-t1-root': { status: 'running' },
    'session-t1-child': { status: 'stopped', parent: 'session-t1-root' },
  })
  assert.equal(normal.sent.length, 1, 'the normal path still delivers')
  assert.equal(normal.journal.some((record) => record.step === 'owner-fallback'), false,
    'a normal resolution must not claim a fallback')
  const fallen = await settle('session-t4-leaf', {
    'session-t4-leaf': { status: 'idle', parent: 'session-t4-dead' },
  }, { jobId: 'pwsh-owner-5' })
  const record = fallen.journal.find((entry) => entry.step === 'owner-fallback')
  assert.ok(record !== undefined, 'a silent fallback would be indistinguishable from a normal resolution')
  assert.deepEqual(Object.keys(record), ['at', 'step', 'job', 'owner', 'headerRoot', 'liveOwner'])
  assert.equal(record.job, 'pwsh-owner-5')
  assert.equal(record.owner, 't4-leaf')
})

test('T-U6 with no agents service the relay degrades in the journal instead of failing', async () => {
  const { sent, journal } = await settle('session-t1-child', {}, { noAgents: true, jobId: 'pwsh-owner-6' })
  assert.deepEqual(sent, [], 'with no live registry there is no handle to deliver to')
  assert.equal(journal.some((record) => record.step === 'degrade' && record.why === 'agents-service-absent'), true,
    'the degradation must be journalled, never silent')
  assert.equal(journal.some((record) => record.step === 'bail' && record.why === 'agents-service-absent'), true,
    'and the resolution must say it could not confirm a live root')
})
