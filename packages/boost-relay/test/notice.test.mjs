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
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

const home = mkdtempSync(join(tmpdir(), 'dsh-relay-'))
const frame = (record) => zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n', 'utf8'))
for (const record of [{ id: 'session-root' }, { id: 'session-child', parentSession: 'session-root' }]) {
  const dir = join(home, 'sessions', 'ws', record.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame({ type: 'session', ...record }), frame({ type: 'turn/start' })]))
}

// The relay resolves its harness dependency from the host's own argv[1] anchor, which
// does not exist under `node --test`; DSH_PROFILE_DIR is the documented fallback.
process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = join(homedir(), '.dsh', 'profiles', 'web')
const relay = await import('../lib/index.js')

test.after(() => rmSync(home, { recursive: true, force: true }))

/**
 * Drive one settlement through the relay's subscription.
 * @param event - the registry event the host would deliver.
 * @param childStatus - the owner agent's status, or undefined when it is gone.
 */
async function relayOne(event, childStatus) {
  const seen = { filters: [], messages: [], handler: undefined }
  const agents = {
    'session-root': { id: 'session-root', status: 'idle', inject: (m) => seen.messages.push(m), followup: (m) => seen.messages.push(m) },
  }
  if (childStatus !== undefined) agents['session-child'] = { id: 'session-child', status: childStatus }
  const ctx = {
    jobs: { events: { subscribe: (filter, handler) => { seen.filters.push(filter); seen.handler = handler; return () => {} } } },
    agents: { list: () => [], get: (id) => agents[id] },
    on: () => {},
    effect: (run) => { run() },
    inject: () => {},
  }
  relay.apply(ctx)
  assert.equal(typeof seen.handler, 'function', 'the relay must subscribe to job events')
  seen.handler(event)
  await new Promise((resolve) => setTimeout(resolve, 150))
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

function textOf(message) {
  const content = message?.content
  if (Array.isArray(content)) return content.map((block) => block?.text ?? '').join('')
  return typeof message?.text === 'string' ? message.text : JSON.stringify(message)
}

test('an awaited settlement is not relayed: the owner already received it', async () => {
  const seen = await relayOne(jobEvent({ awaited: true }), 'running')
  assert.deepEqual(seen.messages, [], 'an awaited settlement must produce no notice')
})

test('an unawaited settlement from a running owner is relayed, and says it was running', async () => {
  const seen = await relayOne(jobEvent({ awaited: false }), 'running')
  assert.equal(seen.messages.length, 1)
  const text = textOf(seen.messages[0])
  assert.match(text, /still RUNNING/, 'the sentence must come from the measured owner state')
  assert.doesNotMatch(text, /had already returned/, 'and must not assert what was not measured')
  assert.match(text, /exit code: 0/)
})

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
