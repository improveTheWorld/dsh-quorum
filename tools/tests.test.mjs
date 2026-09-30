// Unit tests for the trace tooling. Zero dependencies: `node --test`.
//
//   node --test tools/tests.test.mjs
//
// Every case here corresponds either to a defect that shipped, or to a property
// a report silently depends on. The three defects that motivated the suite:
//   1. a session log is a concatenation of zstd frames, and the stock one-shot
//      and streaming decoders both stop after the first — a naive read yields the
//      header alone, and an empty report that looks like a healthy one;
//   2. `tool/result` nests its call id under `data.message`, so reading it from
//      `data` matches nothing;
//   3. `subagent` is a prefix of its sibling role tools, so a substring count
//      invents generic delegations — and a later check reasoned on them.
//
// `tools/find-clock.mjs` was REMOVED from this directory, and this note is the only
// trace it leaves on purpose. A grep of every `.md` and every `.mjs` in the repository
// returned ZERO references to it outside its own usage line: no document cited it, no
// report imported it, and no case below covered it — so nothing could have noticed it
// drifting, which is the orphan shape this suite exists to prevent. Its question (which
// records carry a clock reading) is one invocation of the tool that IS cited and IS
// covered here:
//
//   node tools/find-text.mjs <session-prefix> "Time sampled"
//
// which searches a session tree for a literal needle and says which record type carries
// it, instead of being a second, untested copy of that same search.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import {
  ROLE_TOOLS,
  blocksToText,
  callIdOf,
  countRoleMentions,
  diffMs,
  firstUuid,
  fmtCount,
  fmtDuration,
  markersOf,
  parseJobNotice,
  parseSubagentNotice,
  shortId,
} from './parse.mjs'
import { buildTree, decodeFrames, headerOf, listSessionDirs, readSessionDir } from './session-log.mjs'

/** One frame per flush, exactly how DSH writes a session log. */
function frame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

function logOf(...lines) {
  return Buffer.concat(lines.map((line) => frame(`${line}\n`)))
}

// --------------------------------------------------------------------------
// decodeFrames — the read path everything else depends on
// --------------------------------------------------------------------------

test('decodeFrames: an empty buffer is not an error', () => {
  const result = decodeFrames(Buffer.alloc(0))
  assert.deepEqual(result.records, [])
  assert.equal(result.frames, 0)
})

test('decodeFrames: a single frame', () => {
  const result = decodeFrames(logOf('{"type":"session"}'))
  assert.equal(result.records.length, 1)
  assert.equal(result.frames, 1)
  assert.equal(result.skipped, 0)
})

test('decodeFrames: several concatenated frames are all read', () => {
  // The regression: Node's one-shot zstdDecompressSync returns only frame 0.
  const result = decodeFrames(logOf('{"n":1}', '{"n":2}', '{"n":3}'))
  assert.deepEqual(result.records, [{ n: 1 }, { n: 2 }, { n: 3 }])
  assert.equal(result.frames, 3)
})

test('decodeFrames: many frames, none lost', () => {
  const lines = Array.from({ length: 50 }, (_, index) => `{"n":${index}}`)
  const result = decodeFrames(logOf(...lines))
  assert.equal(result.records.length, 50)
  assert.equal(result.records[49].n, 49)
})

test('decodeFrames: one frame may carry several JSONL lines', () => {
  const result = decodeFrames(frame('{"a":1}\n{"a":2}\n'))
  assert.deepEqual(result.records, [{ a: 1 }, { a: 2 }])
  assert.equal(result.frames, 1)
})

test('decodeFrames: a truncated tail frame does not destroy earlier records', () => {
  const good = logOf('{"n":1}', '{"n":2}')
  const tail = frame('{"n":3}')
  const truncated = Buffer.concat([good, tail.subarray(0, Math.floor(tail.length / 2))])
  const result = decodeFrames(truncated)
  assert.deepEqual(result.records, [{ n: 1 }, { n: 2 }], 'earlier records survive intact')

  // A truncated frame is NOT an error to zstdDecompressSync: it returns the
  // prefix it could decode — often nothing — instead of throwing. So `skipped`
  // cannot be used to detect a partial write, and an empty final frame is the
  // only observable trace. This assertion is the reason `emptyTail` exists: a
  // live log caught mid-flush would otherwise lose its newest record silently,
  // and a report would read as complete.
  assert.equal(result.skipped, 0)
  assert.equal(result.emptyTail, true, 'a partial tail must be flagged, not assumed absent')
  assert.equal(result.frameCount, 3)
})

test('decodeFrames: a complete log is not flagged as truncated', () => {
  const result = decodeFrames(logOf('{"n":1}', '{"n":2}'))
  assert.equal(result.emptyTail, false)
  assert.equal(result.frameCount, 2)
})

test('decodeFrames: trailing garbage after a valid frame is survivable', () => {
  const result = decodeFrames(Buffer.concat([logOf('{"n":1}'), Buffer.from([0x00, 0x01, 0x02, 0x03])]))
  assert.deepEqual(result.records, [{ n: 1 }])
})

test('decodeFrames: an unparsable line counts as skipped, not as a record', () => {
  const result = decodeFrames(logOf('{"n":1}', 'not json'))
  assert.deepEqual(result.records, [{ n: 1 }])
  assert.equal(result.skipped, 1)
})

test('headerOf: finds the header record wherever it sits', () => {
  const records = [{ type: 'subagent/descriptor' }, { type: 'session', id: 'x' }]
  assert.equal(headerOf(records).id, 'x')
  assert.equal(headerOf([]), undefined)
})

// --------------------------------------------------------------------------
// on-disk layout: sessions root, delegation tree
// --------------------------------------------------------------------------

test('listSessionDirs + buildTree: reconstruct a delegation tree from headers', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-traces-'))
  try {
    const workspace = join(root, '--C-workspace--')
    const write = (name, lines) => {
      const dir = join(workspace, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session.v4.jsonl.zstd'), logOf(...lines))
    }
    write('root-session', [
      '{"type":"session","id":"root-session","createdAt":1,"cwd":"C:\\\\w"}',
      '{"type":"turn/start","data":{"turn":1}}',
    ])
    write('child-a', ['{"type":"session","id":"child-a","createdAt":2,"parentSession":"root-session","delegationDepth":1,"agentPreset":"boost"}'])
    write('child-b', ['{"type":"session","id":"child-b","createdAt":3,"parentSession":"child-a","delegationDepth":2,"agentPreset":"boost"}'])
    write('unrelated', ['{"type":"session","id":"unrelated","createdAt":4}'])

    const dirs = listSessionDirs(root)
    assert.equal(dirs.length, 4)

    const tree = buildTree('root-session', dirs)
    assert.equal(tree.root.id, 'root-session')
    assert.deepEqual(
      tree.nodes.map((node) => [node.id, node.depth]),
      [
        ['root-session', 0],
        ['child-a', 1],
        ['child-b', 2],
      ],
    )
    assert.equal(readSessionDir(join(workspace, 'child-a')).records.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------------------
// record shape — two shipped defects
// --------------------------------------------------------------------------

test('callIdOf: reads the nested call id, and tolerates the flat shape', () => {
  assert.equal(callIdOf({ data: { message: { toolCallId: 'nested' } } }), 'nested')
  assert.equal(callIdOf({ data: { toolCallId: 'flat' } }), 'flat')
  assert.equal(callIdOf({ data: {} }), undefined)
  assert.equal(callIdOf(undefined), undefined)
})

test('countRoleMentions: a role prefix never invents a generic delegation', () => {
  const code = 'await tools.subagent_investigate({a:1}); await tools.subagent_implement({b:2});'
  assert.deepEqual(countRoleMentions(code), { subagent_investigate: 1, subagent_implement: 1 })

  const verify = 'const v = await tools.subagent_verify({});'
  assert.deepEqual(countRoleMentions(verify), { subagent_verify: 1 })

  const generic = 'await tools.subagent({}); await tools.subagent({});'
  assert.deepEqual(countRoleMentions(generic), { subagent: 2 })

  assert.deepEqual(countRoleMentions('await tools.subagent_fork({});'), { subagent_fork: 1 })
  assert.deepEqual(countRoleMentions(''), {})
})

test('countRoleMentions: every role tool is counted on its own', () => {
  for (const role of ROLE_TOOLS) {
    const mentions = countRoleMentions(`tools.${role}({})`)
    assert.deepEqual(mentions, { [role]: 1 }, `${role} must count exactly once, alone`)
  }
})

test('blocksToText: reasoning blocks are excluded from what a session SAID', () => {
  const content = [
    { type: 'reasoning', text: 'internal monologue' },
    { type: 'text', text: 'the answer' },
    { type: 'tool-call', id: 'c1', name: 'read' },
  ]
  assert.equal(blocksToText(content, { onlyText: true }), 'the answer')
  // The prompt accumulator wants everything, so the default stays permissive.
  assert.equal(blocksToText(content), 'internal monologue\nthe answer')
  assert.equal(blocksToText('bare string'), 'bare string')
  assert.equal(blocksToText(undefined), '')
})

test('markersOf: recognises a boost composition', () => {
  assert.deepEqual(markersOf('You are a boost orchestrator … Programmatic Tool Calling …'), [
    'boost orchestrator',
    'Programmatic Tool Calling',
  ])
  assert.deepEqual(markersOf(''), [])
  assert.deepEqual(markersOf(undefined), [])
})

// --------------------------------------------------------------------------
// notices — push, not pull
// --------------------------------------------------------------------------

test('parseSubagentNotice: the notice carries the closing message', () => {
  const text = 'Background subagent 2b27ffe3-5a67-4d38-ad06-ddbd30e7be58 finished and will do no further work unless you send it more. Its closing message: Rapport livré.'
  const notice = parseSubagentNotice(text)
  assert.equal(notice.childId, '2b27ffe3-5a67-4d38-ad06-ddbd30e7be58')
  assert.equal(notice.carriesClosing, true)
})

test('parseSubagentNotice: a notice without a closing message is distinguishable', () => {
  const notice = parseSubagentNotice('Background subagent 11111111-2222-3333-4444-555555555555 finished and will do no further work unless you send it more.')
  assert.equal(notice.carriesClosing, false)
})

test('parseSubagentNotice: unrelated text is not a notice', () => {
  assert.equal(parseSubagentNotice('Background job x finished'), undefined)
  assert.equal(parseSubagentNotice(undefined), undefined)
})

test('parseJobNotice: reads the job id and kind from a registry notice', () => {
  const notice = parseJobNotice("background job pwsh-143 (pwsh: $env:X = 'secret' git -C 'C:\\w' checkout -- .) finished [status: exited]")
  assert.deepEqual(notice, { id: 'pwsh-143', kind: 'pwsh' })
  assert.equal(parseJobNotice('nothing here'), undefined)
})

test('firstUuid: extracts the child id from a delegation receipt', () => {
  assert.equal(firstUuid('started subagent ea37904b-fe9d-4f9c-887f-edab8f6848b0'), 'ea37904b-fe9d-4f9c-887f-edab8f6848b0')
  assert.equal(firstUuid('started subagent'), undefined)
})

// --------------------------------------------------------------------------
// formatting
// --------------------------------------------------------------------------

test('formatting helpers', () => {
  assert.equal(shortId('session-517ee069-bbfb-410f-bc1b-3e036d8a2663'), '517ee069')
  assert.equal(fmtCount(999), '999')
  assert.equal(fmtCount(1234), '1.2k')
  assert.equal(fmtCount(25_009_408), '25.01M')
  assert.equal(fmtDuration(468_000), '7m 48s')
  assert.equal(fmtDuration(0), '0 ms')
  assert.equal(fmtDuration(undefined), '?')
  assert.equal(diffMs(10, 30), 20)
  assert.equal(diffMs(undefined, 30), undefined)
  assert.equal(diffMs(30, 10), 0)
})
