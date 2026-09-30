// Unit tests for the detached-jobs plugin. Zero dependencies: `node --test`.
//
//   node --test test/root.test.mjs
//
// The functions under test decide WHO OWNS a background job, and getting that
// wrong is not a cosmetic bug: a job owned by the wrong session is destroyed the
// moment that session settles, silently — the exact failure this bundle exists to
// remove. So the cases below are the ones that actually decided the design:
//
//   - the FORK case (`origin` unset, `delegationDepth` 0, but carrying a
//     `parentSession`), which defeated `subagents.listDescendants()` in production
//     and left the relay unable to find the owner's root;
//   - multi-hop chains, because a session root is found by walking, not by asking;
//   - a missing parent, a cycle and a truncated tail, because a host plugin that
//     hangs or throws while resolving a root would take the job registry with it.
//
// The module reads `DSH_HOME` at import time, so the fixture store is built first
// and the module is imported dynamically afterwards.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const home = mkdtempSync(join(tmpdir(), 'dsh-detached-'))
const sessions = join(home, 'sessions')

/**
 * Write one synthetic session log: a header frame, then a second frame, so the
 * reader is exercised on a real multi-frame file rather than on a single blob.
 */
function writeSession(slug, id, header, options = {}) {
  const dir = join(sessions, slug, id)
  mkdirSync(dir, { recursive: true })
  const frames = [
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id, ...header })}\n`, 'utf8')),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', data: { turn: 1 } })}\n`, 'utf8')),
  ]
  if (options.truncateTail === true) {
    const tail = frames[1]
    frames[1] = tail.subarray(0, Math.floor(tail.length / 2))
  }
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
}

const WS = '--C-CodeSource--'
writeSession(WS, 'session-root', { agentPreset: 'boost', origin: 'root' })
writeSession(WS, 'session-child', { agentPreset: 'boost', parentSession: 'session-root', delegationDepth: 1, origin: 'subagent' })
writeSession(WS, 'session-grandchild', { agentPreset: 'boost', parentSession: 'session-child', delegationDepth: 2, origin: 'subagent' })
// The fork: a parent link but no delegation origin and depth 0, which is what a
// `subagent_fork` produces and what the delegated-child catalog cannot see.
writeSession(WS, 'session-fork', { agentPreset: 'cordis', parentSession: 'session-root' })
writeSession(WS, 'session-truncated', { agentPreset: 'boost', parentSession: 'session-root', delegationDepth: 1 }, { truncateTail: true })
// A cycle, to prove the hop bound terminates instead of hanging the host.
writeSession(WS, 'session-cycle-a', { parentSession: 'session-cycle-b' })
writeSession(WS, 'session-cycle-b', { parentSession: 'session-cycle-a' })
// A dangling parent: the parent's log is gone, the link is not.
writeSession(WS, 'session-orphan', { parentSession: 'session-vanished' })
// A zero-byte log, which must be skipped rather than thrown on.
mkdirSync(join(sessions, WS, 'session-empty'), { recursive: true })
writeFileSync(join(sessions, WS, 'session-empty', 'session.v4.jsonl.zstd'), Buffer.alloc(0))

process.env.DSH_HOME = home
const { rootOf } = await import('../lib/index.js')

test.after(() => rmSync(home, { recursive: true, force: true }))

test('a session without a parent is its own root', () => {
  assert.equal(rootOf('session-root'), 'session-root')
})

test('one hop resolves to the root', () => {
  assert.equal(rootOf('session-child'), 'session-root')
})

test('a multi-hop chain resolves to the topmost root', () => {
  assert.equal(rootOf('session-grandchild'), 'session-root')
})

test('a FORK resolves through its parent link', () => {
  // The production case: `origin` unset, depth 0, parentSession set. The delegated
  // catalog reported no descendant here, which is why ownership resolution no
  // longer asks a catalog.
  assert.equal(rootOf('session-fork'), 'session-root')
})

test('a truncated tail frame does not prevent resolution', () => {
  // The header lives in the first frame, so a log caught mid-write still resolves.
  assert.equal(rootOf('session-truncated'), 'session-root')
})

test('an unknown session resolves to nothing rather than guessing', () => {
  assert.equal(rootOf('session-absent-from-store'), undefined)
})

test('a dangling parent link is returned as the root, not dropped', () => {
  // A missing log is not evidence of a missing relation: the link is data, and
  // returning it lets the caller decide. Returning undefined would be a silent loss.
  assert.equal(rootOf('session-orphan'), 'session-vanished')
})

test('a cycle terminates within the hop bound', () => {
  const resolved = rootOf('session-cycle-a')
  assert.ok(resolved === 'session-cycle-a' || resolved === 'session-cycle-b', `unexpected ${resolved}`)
})

test('a zero-byte log is skipped without throwing', () => {
  assert.equal(rootOf('session-empty'), undefined)
})

test('resolution is stable across repeated calls (cache path)', () => {
  // `headers()` caches for a TTL, so the second call takes the cached branch.
  assert.equal(rootOf('session-grandchild'), 'session-root')
  assert.equal(rootOf('session-fork'), 'session-root')
})
