// Unit tests for the RETENTION of the recovery files: `pruneSpillDir`, and the
// best-effort call the producer makes before it opens a job's own file. Zero
// dependencies: `node --test`.
//
//   node --test test/purge.test.mjs
//
// The defect these cases fix: `openRecoveryFile` wrote one recovery file per detached
// job and NOTHING ever removed one — up to 32 MiB each, in the user's own store
// (`$DSH_HOME/plugin-data/dsh-detached-jobs`), a directory that only grew.
//
// The numbers below are the LITERALS of the fixed policy (7 days, 20 files, 60
// minutes), not the module's constants, and deliberately so: importing the constants
// would make these cases agree with the module even if the module's numbers were
// wrong. Every case can therefore fail on a wrong constant, not just on a missing
// function.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { candidateExists, pruneSpillDir, resolveShell, spawnProducer } from '../lib/index.js'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TTL = 7 * DAY            // SPILL_TTL_MS
const MAX_FILES = 20           // SPILL_MAX_FILES
const MIN_AGE = HOUR           // SPILL_MIN_AGE_MS

const dirs = []
/** A fresh empty directory, removed when the file is done with it. */
function newDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-detached-purge-'))
  dirs.push(dir)
  return dir
}
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

/**
 * One recovery file, aged by its MTIME — the only age the purge can see.
 * @returns the full path, which is what the result must carry.
 */
function seed(dir, name, ageMs, content = name) {
  const path = join(dir, name)
  writeFileSync(path, content)
  const when = new Date(Date.now() - ageMs)
  utimesSync(path, when, when)
  return path
}

/** Basenames, sorted, for assertions that must not depend on listing order. */
function names(paths) {
  return paths.map((path) => basename(path)).sort()
}

/** `f00.log`, `f01.log`… numbered in age order, oldest first. */
function numbered(index) {
  return 'f' + String(index).padStart(2, '0') + '.log'
}

const shell = resolveShell()
const realShell = process.platform === 'win32' ? candidateExists(shell) : true
const skipRealJobs = realShell ? false : 'no PowerShell at ' + shell

/** The store the producer uses for one `$DSH_HOME`. */
function storeOf(home) {
  return join(home, 'plugin-data', 'dsh-detached-jobs')
}

/** The smallest honest `JobHandle`: retention needs no ring, only a sink. */
function stubJob(id) {
  const state = { text: '' }
  return {
    id,
    get text() { return state.text },
    append(chunk) { state.text += chunk },
    updateProgress() {},
  }
}

test('a: a file older than the TTL is removed and is not reported as kept', () => {
  const dir = newDir()
  const stale = seed(dir, 'pwsh-stale.log', TTL + DAY)
  const fresh = seed(dir, 'pwsh-fresh.log', TTL - DAY) // inside the TTL: must survive
  const result = pruneSpillDir(dir)
  assert.deepEqual(result.removed, [stale], 'the 8-day-old file must be the one removed')
  assert.deepEqual(result.kept, [fresh], 'the 6-day-old file is inside the TTL and must stay')
  assert.equal(existsSync(stale), false, 'the removed file must be gone from disk')
  assert.equal(existsSync(fresh), true)
})

test('b: a recent file survives', () => {
  const dir = newDir()
  const live = seed(dir, 'pwsh-live.log', MINUTE)
  const recent = seed(dir, 'pwsh-recent.log', 30 * MINUTE)
  const result = pruneSpillDir(dir)
  assert.deepEqual(result.removed, [], 'nothing here is old enough to be retired')
  assert.deepEqual(names(result.kept), ['pwsh-live.log', 'pwsh-recent.log'])
  assert.equal(existsSync(live), true)
  assert.equal(existsSync(recent), true)
})

test('c: the file of the running job (except) survives even as the oldest', () => {
  const dir = newDir()
  const current = seed(dir, 'pwsh-current.log', 9 * DAY)
  const other = seed(dir, 'pwsh-other.log', 8 * DAY)
  const result = pruneSpillDir(dir, { except: current })
  assert.deepEqual(result.removed, [other], 'only the file that is not the running job goes')
  assert.deepEqual(result.kept, [current], 'the running job keeps its file')
  assert.equal(existsSync(current), true)
  assert.equal(existsSync(other), false)
})

test('d: beyond 20 files the oldest are removed, until exactly 20 remain', () => {
  const dir = newDir()
  const seeded = []
  const count = MAX_FILES + 5
  for (let index = 0; index < count; index++) {
    // `index` 0 is the oldest by construction: an AGE is a distance into the past, so
    // the YOUNGEST file takes the largest offset. Every file here is older than the
    // age floor and inside the TTL, so only the count ceiling can retire one.
    seeded.push(seed(dir, numbered(index), 2 * HOUR + (count - 1 - index) * 2000))
  }
  const result = pruneSpillDir(dir)
  assert.deepEqual(result.removed, seeded.slice(0, 5), 'the five oldest, oldest first')
  assert.equal(result.kept.length, MAX_FILES, 'exactly the ceiling must remain')
  assert.deepEqual(result.kept, seeded.slice(5))
  for (const path of seeded.slice(0, 5)) assert.equal(existsSync(path), false, basename(path))
  for (const path of seeded.slice(5)) assert.equal(existsSync(path), true, basename(path))
})

test('e: a file younger than the floor survives even when the ceiling is exceeded', () => {
  const dir = newDir()
  const old = seed(dir, 'pwsh-old.log', 2 * HOUR)
  const young = []
  for (let index = 0; index < 21; index++) young.push(seed(dir, 'y' + String(index).padStart(2, '0') + '.log', 2 * MINUTE + index * 2000))
  const result = pruneSpillDir(dir)
  assert.deepEqual(result.removed, [old], 'only the one file past the floor can go')
  assert.equal(result.kept.length, 21, 'the ceiling would take one more; the floor refuses it')
  assert.equal(result.kept.length > MAX_FILES, true, 'the case only means something if the cap was exceeded')
  for (const path of young) assert.equal(existsSync(path), true, basename(path))
})

test('f: a directory that does not exist is a silent no-op', () => {
  const missing = join(newDir(), 'never-created')
  assert.deepEqual(pruneSpillDir(missing), { removed: [], kept: [] })
})

test('g: an entry that cannot be removed is reported as kept and stops nothing', () => {
  const dir = newDir()
  // A DIRECTORY named `x.log`: `unlinkSync` cannot remove it (EPERM here, EISDIR on
  // Linux). Aged 8 days and therefore FIRST in the oldest-first order, so a purge that
  // gave up at the first failure would leave the two real files behind.
  const blocked = join(dir, 'blocked.log')
  mkdirSync(blocked)
  const when = new Date(Date.now() - (8 * DAY + 3000))
  utimesSync(blocked, when, when)
  const a = seed(dir, 'pwsh-a.log', 8 * DAY + 2000)
  const b = seed(dir, 'pwsh-b.log', 8 * DAY + 1000)
  const result = pruneSpillDir(dir)
  assert.equal(result.removed.includes(blocked), false, 'a name that was not removed must never be cited as removed')
  assert.deepEqual(result.removed, [a, b], 'the other two, oldest first')
  assert.equal(result.kept.includes(blocked), true, 'it is still there, so it is reported as staying')
  assert.equal(statSync(blocked).isDirectory(), true, 'the directory must be untouched')
  assert.equal(existsSync(a), false)
  assert.equal(existsSync(b), false)
})

test('only *.log entries of the directory itself: no recursion, no other names', () => {
  const dir = newDir()
  const nested = join(dir, 'nested')
  mkdirSync(nested)
  const inside = seed(nested, 'deep.log', 30 * DAY)
  const other = seed(dir, 'notes.txt', 30 * DAY)
  const old = seed(dir, 'pwsh-old.log', 8 * DAY)
  const result = pruneSpillDir(dir)
  assert.deepEqual(result.removed, [old], 'only the *.log entry of the directory itself')
  assert.deepEqual(result.kept, [])
  assert.equal(existsSync(inside), true, 'a nested file must never be reached')
  assert.equal(existsSync(other), true, 'a non-log name must never be touched')
})

test('h1: the producer prunes an aged file from the store when a job starts', { skip: skipRealJobs }, async () => {
  const home = newDir()
  process.env.DSH_HOME = home
  const store = storeOf(home)
  mkdirSync(store, { recursive: true })
  const stale = seed(store, 'pwsh-old-job.log', 8 * DAY)
  const job = stubJob('pwsh-purge-run')
  const outcome = await spawnProducer('Write-Output PURGE-OK', process.cwd(), shell)(job).done
  assert.equal(outcome.status, 'completed', String(outcome.detail))
  assert.equal(existsSync(stale), false, 'the aged file must be gone once a job has started')
  const own = readdirSync(store).filter((name) => name.startsWith('pwsh-purge-run-') && name.endsWith('.log'))
  assert.equal(own.length, 1, 'the running job keeps its own file')
  assert.equal(job.text.includes('PURGE-OK'), true)
})

test('h2: a store the purge cannot even read does not stop the job it observes', { skip: skipRealJobs }, async () => {
  const home = newDir()
  process.env.DSH_HOME = home
  const store = storeOf(home)
  // `plugin-data/dsh-detached-jobs` is a FILE here: the purge cannot list it, and no
  // recovery file can be created either.
  mkdirSync(join(home, 'plugin-data'), { recursive: true })
  writeFileSync(store, 'not a directory')
  const job = stubJob('pwsh-blocked-store')
  const outcome = await spawnProducer('Write-Output PURGE-OK', process.cwd(), shell)(job).done
  assert.equal(outcome.status, 'completed', String(outcome.detail))
  assert.equal(job.text.includes('PURGE-OK'), true, 'the output must still reach the ring')
  assert.equal(String(outcome.result).includes('PURGE-OK'), true, 'no file survived, so the text is the result')
  assert.equal(job.text.includes('[sortie complète'), false, 'a file that was not saved must never be advertised')
})
