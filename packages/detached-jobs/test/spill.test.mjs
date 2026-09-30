// Unit tests for the RECOVERY FILE of a detached job and the pointer line the
// producer appends at settlement. Zero dependencies: `node --test`.
//
//   node --test test/spill.test.mjs
//
// The defect these cases fix, measured on 2026-09-29: a detached job whose output
// outgrew the registry's ring lost the HEAD of it with no way back —
//
//   job_output → 625 956 bytes, starting at "LIGNE-1412" (1411 lines evicted)
//   notice     → [some output was dropped from memory; full output: (unavailable)]
//
// — because this producer PUSHES (`output: []`) and the registry only ever
// advertises a spill file that a pull source reported
// (`dsh-jobs-local/lib/index.js:483-485`). Two things now cover that hole, and
// every case below is about one of them:
//
//   - the recovery file at `$DSH_HOME/plugin-data/dsh-detached-jobs/<job id>-<6 hex>.log`,
//     and the `[sortie complète : …]` line appended to the stream BEFORE `done`
//     resolves — the newest chunk, so it survives the eviction that took the rest;
//   - the failure paths — an unwritable store, and a file that reaches its ceiling
//     — which must leave the job itself exactly as it was.
//
// This suite runs the command from the report itself: 5000 lines of ~70 bytes,
// comfortably past the registry's 256 KiB ring.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { candidateExists, resolveShell, spawnProducer } from '../lib/index.js'

/** The registry's default ring retention (`dsh-jobs-local/lib/index.js:341`). */
const RING_BYTES = 256 * 1024

/** The heavy output from the measurement: 5000 lines, ~365 KB. */
const BIG_OUTPUT = '1..5000 | ForEach-Object { "LIGNE-" + $_ + " " + ("x" * 60) }'

/**
 * The same output, reconstructed here.
 *
 * The file is compared to THIS and not to the producer's own outcome: a test that
 * checks a producer against its own claim proves only that it agrees with itself.
 * 5000 lines of "LIGNE-<n> " + 60 x's + CRLF is exactly 363,893 bytes.
 */
const EXPECTED = Array.from({ length: 5000 }, (_, index) => 'LIGNE-' + (index + 1) + ' ' + 'x'.repeat(60)).join('\r\n') + '\r\n'

const shell = resolveShell()
const available = process.platform === 'win32' ? candidateExists(shell) : true
const skip = available ? false : 'no PowerShell at ' + shell

const homes = []
/** A fresh `$DSH_HOME`, removed when the file is done with it. */
function newHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-detached-spill-'))
  homes.push(home)
  return home
}
test.after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }) })

/** The store directory of one `$DSH_HOME`. */
function storeOf(home) {
  return join(home, 'plugin-data', 'dsh-detached-jobs')
}

/**
 * Every recovery file of `jobId`, found by PREFIX.
 *
 * The name ends in a random six-hex-character token now, so the test cannot guess it —
 * which is the property the token exists for. Guessing here would test the test's
 * arithmetic instead of the module's naming rule.
 */
function spillPathsOf(home, jobId) {
  return readdirSync(storeOf(home))
    .filter((name) => name.startsWith(jobId + '-') && name.endsWith('.log'))
    .map((name) => join(storeOf(home), name))
    .sort()
}

/** The ONE recovery file of `jobId`: an ambiguous answer fails instead of guessing. */
function spillPathOf(home, jobId) {
  const found = spillPathsOf(home, jobId)
  assert.equal(found.length, 1, 'expected exactly one recovery file for ' + jobId + ', found ' + JSON.stringify(found))
  return found[0]
}

/**
 * One stub job: the registry's ring, reduced to the rules that decide these cases.
 *
 * Whole chunks at absolute byte offsets, and head eviction that drops the OLDEST
 * chunk first (`dsh-jobs-local/lib/index.js:224-241`); a producer chunk landing
 * after settlement is dropped, exactly as `appendRing` does it
 * (`dsh-jobs-local/lib/index.js:664-672`).
 */
function makeJob(id, cap) {
  const job = {
    id,
    chunks: [],
    retainedBytes: 0,
    total: 0,
    earliest: 0,
    terminal: false,
    dropped: [],
    append(text) {
      if (job.terminal) { job.dropped.push(text); return }
      if (text.length === 0) return
      const bytes = Buffer.byteLength(text, 'utf8')
      job.chunks.push({ at: job.total, text, bytes })
      job.total += bytes
      job.retainedBytes += bytes
      while (job.retainedBytes > cap && job.chunks.length > 1) {
        const oldest = job.chunks.shift()
        job.retainedBytes -= oldest.bytes
      }
      job.earliest = job.chunks[0]?.at ?? job.total
    },
    updateProgress() {},
    /** What `job_output` renders from cursor 0: the retained tail, lossy when the head went. */
    delta() {
      return { text: job.chunks.map((chunk) => chunk.text).join(''), lossy: job.earliest > 0 }
    },
  }
  return job
}

/**
 * Run one command through the REAL producer against a stub job.
 *
 * The stub turns terminal in the registry's own place — a microtask after `done`
 * resolves (`dsh-jobs-local/lib/index.js:487-490`) — so a pointer line appended
 * after that boundary would be dropped, and every case here would see it missing.
 */
async function produce(command, options = {}) {
  const home = options.home ?? newHome()
  process.env.DSH_HOME = home
  const job = makeJob(options.jobId ?? 'pwsh-spill-1', options.cap ?? RING_BYTES)
  /** Every `onRecovery` call, in order: what the registry would have been told. */
  const calls = []
  const handle = spawnProducer(command, process.cwd(), shell, options.spillMaxBytes, (path) => { calls.push(path) })(job)
  handle.done.then(() => { job.terminal = true }, () => { job.terminal = true })
  const outcome = await handle.done
  await Promise.resolve()
  return { home, job, outcome, calls }
}

test('the recovery file holds the complete output of a job that outgrows the ring', { skip }, async () => {
  const { home, job, outcome } = await produce(BIG_OUTPUT, { jobId: 'pwsh-big' })
  assert.equal(outcome.status, 'completed', String(outcome.detail))
  // The case only means something if the ring really did evict the head.
  const delta = job.delta()
  assert.equal(delta.lossy, true, 'the ring must have dropped bytes')
  assert.equal(delta.text.includes('LIGNE-5000'), true, 'the ring keeps the tail')
  assert.equal(delta.text.includes('LIGNE-1 '), false, 'the first line must be gone from the ring')
  // And the file holds what the ring lost, byte for byte.
  const path = spillPathOf(home, 'pwsh-big')
  assert.equal(existsSync(path), true, 'no recovery file at ' + path)
  const file = readFileSync(path, 'utf8')
  assert.equal(file.includes('LIGNE-1 '), true, 'the file must hold the evicted head')
  assert.equal(file.includes('LIGNE-5000'), true, 'the file must hold the last line too')
  assert.equal(file, EXPECTED, 'the file must be the complete output, not a tail')
})

test('the pointer line survives in what job_output returns, and cites a complete file', { skip }, async () => {
  const { home, job, outcome } = await produce(BIG_OUTPUT, { jobId: 'pwsh-pointer' })
  const delta = job.delta()
  const path = spillPathOf(home, 'pwsh-pointer')
  // The line is IN the stream the model reads, not in a side channel...
  assert.equal(delta.text.includes('[sortie complète : ' + path + ']'), true, 'pointer line missing from the retained delta')
  // ...and it is the NEWEST chunk, which is why eviction cannot take it.
  assert.equal(job.chunks.at(-1).text.includes(path), true, 'the pointer must be the last chunk')
  assert.deepEqual(job.dropped, [], 'a chunk appended before settled(...) must never be dropped')
  // The cited file exists, holds more than the ring kept, and is intact.
  assert.equal(statSync(path).size > RING_BYTES, true, 'the cited file must hold more than the ring does')
  assert.equal(readFileSync(path, 'utf8'), EXPECTED)
})

test('a settled stream is delivered once, never twice: no terminal result when a file survived', { skip }, async () => {
  // Measured live on 2026-09-29: pushed chunks AND a terminal `result` made a 3000-line
  // job read back as 436 KB for ~219 KB of output, pointer line in the middle. The
  // registry delivers a terminal result once (`dsh-jobs-local/lib/index.js:601-602`),
  // and this producer already pushes every chunk — so the two together duplicate it.
  const { job, outcome } = await produce(BIG_OUTPUT, { jobId: 'pwsh-once' })
  assert.equal(outcome.result, undefined, 'a pushed stream must not be repeated by the terminal result')
  assert.equal(job.delta().text.includes('LIGNE-5000'), true, 'the stream itself still carries the output')
  assert.equal(job.chunks.at(-1).text.includes('[sortie complète : '), true, 'the pointer still ends the stream')
})

test('the file is named after the job, not after the environment', { skip }, async () => {
  const { home, job } = await produce('Write-Output NAMED', { jobId: 'pwsh-named-7' })
  const marker = '[sortie complète : '
  const text = job.delta().text
  const at = text.indexOf(marker)
  assert.notEqual(at, -1, 'no pointer line to check')
  const cited = text.slice(at + marker.length).split(']')[0]
  assert.match(basename(cited), /^pwsh-named-7-[0-9a-f]{6}\.log$/)
  assert.equal(cited, spillPathOf(home, 'pwsh-named-7'))
})

test('the file stops at its ceiling, says so in the file, and keeps the job whole', { skip }, async () => {
  const cap = 128 * 1024
  const { home, job, outcome } = await produce(BIG_OUTPUT, { jobId: 'pwsh-capped', spillMaxBytes: cap })
  assert.equal(outcome.status, 'completed', String(outcome.detail))
  const path = spillPathOf(home, 'pwsh-capped')
  const file = readFileSync(path, 'utf8')
  assert.equal(statSync(path).size <= cap, true, 'the file must stay under its ceiling, got ' + statSync(path).size)
  // What the file kept is a verbatim PREFIX of the output...
  const kept = file.slice(0, file.indexOf('\n[sortie tronquée'))
  assert.equal(kept.length > 0, true, 'the file must keep the head')
  assert.equal(EXPECTED.startsWith(kept), true, 'the file must be a verbatim head of the output')
  // ...and it ends by announcing its own cut.
  assert.equal(file.includes('plafond de ' + cap + ' octets'), true, 'the file must announce its ceiling')
  assert.equal(file.includes('LIGNE-5000'), false, 'the file must stop at the ceiling')
  // The stream says the same, and the ring still holds the tail the file gave up.
  const delta = job.delta()
  assert.equal(delta.text.includes('[sortie tronquée au plafond de ' + cap + ' octets ; début conservé : ' + path + ']'), true)
  assert.equal(delta.text.includes('LIGNE-5000'), true, 'the ring keeps the tail')
})

test('an unwritable store does not touch the job it observes', { skip }, async () => {
  const home = newHome()
  // `plugin-data/dsh-detached-jobs` is a FILE here: the directory cannot be created.
  mkdirSync(join(home, 'plugin-data'), { recursive: true })
  writeFileSync(join(home, 'plugin-data', 'dsh-detached-jobs'), 'not a directory')
  const { job, outcome, calls } = await produce('Write-Output DETACHED-OK', { home, jobId: 'pwsh-blocked' })
  assert.equal(outcome.status, 'completed', String(outcome.detail))
  assert.deepEqual(calls, [undefined, undefined], 'a file that never opened must never be announced as a path')
  const delta = job.delta()
  assert.equal(delta.text.includes('DETACHED-OK'), true, 'the output must still reach the ring')
  assert.equal(delta.text.includes('[sortie complète'), false, 'a file that was not saved must never be advertised')
  assert.equal(delta.text.includes('[sortie tronquée'), false)
  assert.equal(String(outcome.result).includes('DETACHED-OK'), true)
})
test('two jobs sharing one id leave two files, and the first output survives the second', { skip }, async () => {
  // The defect this pins is MEASURED, not imagined: job ids are a per-process counter
  // (`pwsh-1`) while the store outlives the process, and the file was opened 'w'. After a
  // restart, a new `pwsh-1` TRUNCATED the file an older session log still cited — and now
  // that the path is advertised as the job's full output, reading it would hand back the
  // output of ANOTHER job.
  const home = newHome()
  const first = await produce('Write-Output PREMIER', { home, jobId: 'pwsh-collide' })
  assert.equal(first.outcome.status, 'completed', String(first.outcome.detail))
  const firstPath = spillPathOf(home, 'pwsh-collide')
  const second = await produce('Write-Output SECOND', { home, jobId: 'pwsh-collide' })
  assert.equal(second.outcome.status, 'completed', String(second.outcome.detail))
  const both = spillPathsOf(home, 'pwsh-collide')
  assert.equal(both.length, 2, 'two jobs with one id must leave two files, found ' + JSON.stringify(both))
  assert.equal(both.includes(firstPath), true, 'the first file must still be there')
  assert.notEqual(both[0], both[1])
  const firstText = readFileSync(firstPath, 'utf8')
  assert.equal(firstText.includes('PREMIER'), true, 'the first job output must survive the second job')
  assert.equal(firstText.includes('SECOND'), false, 'the second job must not have truncated the first file')
})

test('the producer announces the recovery path at open and keeps it at settlement', { skip }, async () => {
  const { home, calls, outcome } = await produce('Write-Output ANNOUNCED', { jobId: 'pwsh-announced' })
  assert.equal(outcome.status, 'completed', String(outcome.detail))
  const path = spillPathOf(home, 'pwsh-announced')
  assert.deepEqual(calls, [path, path], 'the path at open, then the same path once the file is sealed')
})

test('a capped file is withdrawn from the announcement: it is not the complete stream', { skip }, async () => {
  // The harness's contract for an advertised file is "a file holding the COMPLETE
  // stream". A capped file holds the HEAD while the ring holds the TAIL, so it is
  // withdrawn and the notice falls back to `(unavailable)` — degraded, and honest.
  const cap = 128 * 1024
  const { home, calls, outcome } = await produce(BIG_OUTPUT, { jobId: 'pwsh-capped-announce', spillMaxBytes: cap })
  assert.equal(outcome.status, 'completed', String(outcome.detail))
  const path = spillPathOf(home, 'pwsh-capped-announce')
  assert.deepEqual(calls, [path, undefined], 'announced as a candidate at open, withdrawn at settlement')
  // The file itself is still there, and the stream still cites it as a truncated head.
  assert.equal(statSync(path).size <= cap, true)
})
