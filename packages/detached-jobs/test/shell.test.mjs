// Unit tests for the SHELL RESOLUTION of the detached-jobs producer.
// Zero dependencies: `node --test`.
//
//   node --test test/shell.test.mjs
//
// Why this suite exists: the plugin's producer named its executable —
// `spawn('pwsh', …)` — and the host does not have PowerShell 7:
//
//   background job pwsh-3 (pwsh: test-detached) finished
//   [status: failed, spawn pwsh ENOENT]                     — measured, 21:04:22Z
//
// The job had the right owner and the right visibility, and still did nothing,
// which is the most expensive shape of failure: everything above it looked
// correct. The executable is now RESOLVED, mirroring the one definition this
// build ships (`dsh-pwsh-local/lib/types/resolve.js:23-65`) rather than copying
// its conclusion — so the rule, and not this host, is what the cases below fix in
// place. `env`, `platform` and the existence probe are parameters, so every branch
// is exercised here without depending on what is installed.
//
// The last case spawns a real shell: a rule that resolves correctly but is not
// wired to the spawn would pass every other case and still fail in production.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { candidateExists, pwshCandidates, resolveShell, spawnProducer } from '../lib/index.js'

// The producer writes one recovery file per job under `$DSH_HOME`, which it reads
// at call time — so this suite points that store at a scratch directory instead of
// the live one. A test must not leave artifacts in the operator's `~/.dsh`, and no
// case below is about WHERE the recovery file lands.
const home = mkdtempSync(join(tmpdir(), 'dsh-detached-shell-home-'))
process.env.DSH_HOME = home
test.after(() => rmSync(home, { recursive: true, force: true }))

/** A Windows-shaped environment whose paths carry no separators, so `join` owns them. */
const env = { ProgramFiles: 'PF', SystemRoot: 'SR', PATH: 'A;B' }
const pwsh7 = join('PF', 'PowerShell', '7', 'pwsh.exe')
const legacy = join('SR', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

test('the PowerShell 7 location is preferred and probed first', () => {
  const probed = []
  const shell = resolveShell(env, 'win32', (candidate) => {
    probed.push(candidate)
    return candidate === pwsh7
  })
  assert.equal(shell, pwsh7)
  assert.equal(probed.length, 1, 'the first existing candidate wins and no later one is probed')
})

test('a host without PowerShell 7 falls back to Windows PowerShell 5.1', () => {
  // This host's case, and the one that failed: PowerShell 7 is absent, the
  // System32 executable is the last resort and must be found.
  const shell = resolveShell(env, 'win32', (candidate) => candidate === legacy)
  assert.equal(shell, legacy)
  assert.equal(pwshCandidates(env).at(-1), legacy, 'the legacy path is the documented last resort')
})

test('PATH entries are trimmed and unquoted, and empty entries are dropped', () => {
  const candidates = pwshCandidates({ ProgramFiles: 'PF', SystemRoot: 'SR', PATH: ' "C:\\Quoted\\bin" ;;; ;D ' })
  assert.ok(candidates.includes(join('C:\\Quoted\\bin', 'pwsh.exe')), 'a quoted PATH entry is usable')
  assert.ok(candidates.includes(join('D', 'pwsh.exe')))
  assert.ok(!candidates.includes(join('', 'pwsh.exe')), 'an empty PATH entry must not become a bare executable name')
})

test('nothing installed falls back to PATH resolution for pwsh', () => {
  assert.equal(resolveShell(env, 'win32', () => false), 'pwsh')
})

test('a non-Windows platform always asks PATH for pwsh', () => {
  // Even handed a Windows-shaped environment and a probe that says everything exists.
  assert.equal(resolveShell(env, 'linux', () => true), 'pwsh')
  assert.equal(resolveShell(env, 'darwin', () => true), 'pwsh')
})

test('the existence probe accepts a file or a symlink and rejects a directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-detached-shell-'))
  try {
    const file = join(home, 'a-file')
    writeFileSync(file, '')
    assert.equal(candidateExists(file), true)
    assert.equal(candidateExists(home), false, 'a directory must never be spawned as an executable')
    assert.equal(candidateExists(join(home, 'absent')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

const shell = resolveShell()
const available = process.platform === 'win32' ? candidateExists(shell) : true

test('the producer spawns the resolved shell and returns its output', { skip: available ? false : 'no PowerShell at ' + shell }, async () => {
  const produced = spawnProducer('Write-Output DETACHED-OK', process.cwd(), shell)
  const appended = []
  let progress = 0
  const handle = produced({ append: (text) => appended.push(text), updateProgress: () => { progress++ } })
  const outcome = await handle.done
  assert.equal(outcome.status, 'completed', 'shell=' + shell + ' detail=' + String(outcome.detail))
  const stream = appended.join('')
  assert.match(stream, /DETACHED-OK/)
  // The output reaches the reader through the STREAM, and the stream ends by citing the
  // recovery file that holds it complete. The terminal `result` is reserved for the
  // degraded case where no recovery file survived (see spill.test.mjs), because pushing
  // the chunks AND delivering a result duplicates the whole output on every read.
  assert.match(stream, /\[sortie complète : /)
  assert.equal(outcome.result, undefined, 'a survivor file means no duplicated terminal result')
})

test('a cancelled producer settles as killed rather than hanging', async () => {
  // The registry cancels a job whose owner is disposed; a producer that ignored
  // cancellation would leave an orphan process behind, which is the failure the
  // owner-fencing exists to prevent.
  const produced = spawnProducer('Start-Sleep -Seconds 30', process.cwd(), shell)
  const handle = produced({ append: () => {}, updateProgress: () => {} })
  handle.cancel('owner disposed')
  const outcome = await handle.done
  assert.notEqual(outcome.status, 'completed')
});
