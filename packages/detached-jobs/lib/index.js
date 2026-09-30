/**
 * Detached jobs — a background job that belongs to the SESSION ROOT, not to the
 * agent that started it.
 *
 * The defect this removes, measured rather than assumed. A background job is a
 * scope-owned resource: `JobSpec.owner` is fenced to a session, and "the owner's
 * live Agent must be the one currently registered under that id: its disposal
 * cancels and awaits the job" (`dsh-jobs/lib/types/types.d.ts:122-128`). The pwsh
 * tool sets that owner to the CALLING agent (`dsh-tool-pwsh/lib/index.js:366-369`),
 * so a job started by a one-shot worker dies with the worker. Observed live:
 *
 *   19:32:57 registered job=pwsh-1   ← a worker starts a 60 s job
 *   19:33:00 stopping   job=pwsh-1   ← the worker settles
 *   19:33:00 settled    job=pwsh-1   cause=teardown
 *   19:33:00 removed    job=pwsh-1
 *
 * Three consequences, all of them bad: the work never ran, its output is gone,
 * and the orchestrator — who believes a campaign is in flight — is told nothing
 * and cannot even read the job (`job_output` is fenced by the owner, so the
 * parent gets "unknown job").
 *
 * The root cause is not the teardown; that guarantee is deliberate and correct,
 * because it is what keeps a dead session from leaving orphan processes behind.
 * The root cause is the OWNER CHOICE. A job that is meant to outlive the agent
 * that requested it must be owned by the session that will still be there.
 *
 * Why this works from here: the registry's own documentation says registrations
 * made from an UNSCOPED context serve every owner (`dsh-jobs/lib/index.js:102-104`).
 * This plugin is mounted at the host level, so it can start a job owned by any
 * session. The owner is resolved by walking `parentSession` through the durable
 * session headers, which is the only source that answered correctly every time it
 * was asked — `ctx.agents.list()` is intermittently empty, `agent/created` never
 * replays for an agent that pre-existed the mount, and `listDescendants` walks the
 * delegated-child catalog only, so it cannot see a forked session.
 *
 * The result is not a workaround: the job survives, the root owns it so it can
 * read the output itself, and the root receives the ordinary job settlement
 * notice — no relay, no notice, no rule to remember.
 *
 * LIMITS, written here so they are read rather than discovered:
 *   - the retention pass (`pruneSpillDir`) runs ONLY when a job starts, so a host that
 *     never starts another detached job keeps its residue. No timer and no background
 *     work are owned by this module, deliberately;
 *   - a CAPPED recovery file is never advertised as the job's full output. It holds the
 *     HEAD of the stream while the ring holds the TAIL, so the harness reports
 *     `full output: (unavailable)` for such a job — degraded, and honest about it.
 * A `pwshPath` configured on the shell row IS followed, through the deferred `shell`
 * injection, with `resolveShell()` as the explicit and journalled fallback.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-detached-jobs'
// `jobs` only — and this cost five rounds of wrong theory, so it is written down.
//
// A HARD dependency the row's scope cannot satisfy fails the fiber, and the failure
// is invisible from outside: `fiberPhase: "failed"`, no error anywhere, and `apply()`
// never runs — so none of my own tracing could say why. The row sat `failed` while I
// theorised about tool *visibility*, twice blaming a mounting level that was never
// the problem.
//
// Two diagnoses were wrong before the journal existed, so they are not re-derived
// here. Importing the module through the profile junction succeeds, so loading was
// never the fault: the row was `failed` because `trace` was missing from this file,
// then because of an undeclared `ctx.agents` access, then because the tool declared
// no `output`. All three had one shape — a failure with no observer.
//
// Hence the deferred form: `ctx.inject([...], cb)` waits for a service instead of
// failing the fiber when it is absent, whereas `inject = [...]` demands it
// immediately. `jobs` is the one hard dependency, because the tool cannot exist
// without it; the per-agent installation and the agent enumeration are deferred.
export const inject = ['jobs']

/** zstd frame magic: a session log is a concatenation of frames. */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSIONS_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
const HEADER_TTL_MS = 5_000
let cache = { at: 0, byId: new Map() }

/** One session header, decoded from the first frame only — the header is written first. */
function headerOf(logPath) {
  const buffer = readFileSync(logPath)
  const first = buffer.indexOf(FRAME_MAGIC)
  if (first === -1) return undefined
  const second = buffer.indexOf(FRAME_MAGIC, first + FRAME_MAGIC.length)
  const text = zstdDecompressSync(buffer.subarray(first, second === -1 ? buffer.length : second)).toString('utf8')
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line)
      if (record.type === 'session') return record
    } catch {
      // A partial tail frame: keep looking inside what did decode.
    }
  }
  return undefined
}

/** id → durable header, refreshed at most once per TTL. */
function headers() {
  if (Date.now() - cache.at <= HEADER_TTL_MS) return cache.byId
  const byId = new Map()
  try {
    for (const slug of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (!slug.isDirectory()) continue
      for (const entry of readdirSync(join(SESSIONS_DIR, slug.name), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const logPath = join(SESSIONS_DIR, slug.name, entry.name, 'session.v4.jsonl.zstd')
        try {
          if (statSync(logPath).size === 0) continue
          const header = headerOf(logPath)
          if (header?.id !== undefined) byId.set(header.id, header)
        } catch {
          // A session mid-write, or a layout this build does not know.
        }
      }
    }
    cache = { at: Date.now(), byId }
  } catch {
    // Keep the previous cache rather than losing resolution entirely.
  }
  return cache.byId
}

/**
 * The root session of `sessionId`, by walking `parentSession` upwards.
 * Bounded to 16 hops so a malformed store cannot hang the host.
 */
export function rootOf(sessionId) {
  const byId = headers()
  let current = byId.get(sessionId)
  if (current === undefined) return undefined
  for (let hop = 0; hop < 16; hop++) {
    const parent = current.parentSession
    if (parent === undefined || parent === null) return current.id
    current = byId.get(parent) ?? { id: parent }
  }
  return current.id
}

/**
 * Start one background process and answer its hooks.
 *
 * This producer PUSHES: the job spec passes `output: []`, so no pull source feeds
 * the ring and `job.append` is the only writer. That choice has a consequence the
 * module had to learn the hard way — the registry advertises a spill file only for
 * a `JobOutputSource` read that carried one (`dsh-jobs-local/lib/index.js:483-485`),
 * so a pushed job has NO full-output path and the harness's drop notice ends in
 * `full output: (unavailable)` exactly when the head was evicted. The recovery
 * file below, and the pointer line it appends at settlement, are the answer; the
 * push itself is kept, because it is what makes the output live rather than polled.
 */
/**
 * The PowerShell executable to spawn, resolved the way this deployment's shell
 * owner resolves it.
 *
 * This module cannot borrow `ctx.shell`: the whole point of the job is to outlive
 * the agent scope that would own that handle. So it spawns its own process — and
 * that makes the executable ITS decision, which it got wrong:
 *
 *   background job pwsh-3 (pwsh: test-detached) finished [status: failed,
 *   spawn pwsh ENOENT]                                      — measured, 21:04:22Z
 *
 * `pwsh` (PowerShell 7) is not installed on that host (`Get-Command pwsh` →
 * ABSENT; only `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`),
 * which is why the harness's own tool worked and this one did not: the tool
 * delegates to `ctx.shell`, which RESOLVES the executable instead of naming it.
 *
 * The order below is copied from the one resolution definition this build ships,
 * `dsh-pwsh-local/lib/types/resolve.js:23-65`, including its `lstat` probe — a
 * Store-alias install is a symlink and must be found, a real directory must not
 * match. `env`, `platform` and the probe are parameters, so the rule stays a pure
 * function of its inputs and is testable off Windows.
 *
 * The `pwshPath` a deployment configures on `pwsh-local` used to be unreachable from
 * here — that config reaches the shell service, not this row — and the gap was recorded
 * as an open point. It is CLOSED in `apply()`: a deferred `shell` injection reads the
 * RESOLVED `pwshPath` at call time, and the resolution below is what runs when that
 * service is absent, disabled, or carries no such getter.
 */
export function pwshCandidates(env = process.env) {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const candidates = [join(programFiles, 'PowerShell', '7', 'pwsh.exe')]
  for (const entry of (env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    candidates.push(join(trimmed, 'pwsh.exe'))
  }
  candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  return candidates
}

/** Whether a candidate can be spawned — the probe of `resolve.js:42-49`. */
export function candidateExists(candidate) {
  try {
    const stat = lstatSync(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

/** The executable this module spawns: first existing well-known location, else `pwsh`. */
export function resolveShell(env = process.env, platform = process.platform, exists = candidateExists) {
  if (platform === 'win32') {
    for (const candidate of pwshCandidates(env)) if (exists(candidate)) return candidate
  }
  return 'pwsh'
}

/**
 * UTF-8 output pinning, verbatim from `dsh-pwsh-local/lib/index.js:100`.
 *
 * Windows PowerShell 5.1 — the executable this host actually has — writes the
 * console code page by default, which garbles non-ASCII output. This module's
 * output is read by a person, in French as often as not, so the pinning rides on
 * line 1 after a `; ` separator exactly as the executor does it.
 */
const ENCODING_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/**
 * Byte ceiling for one job's recovery file: 32 MiB.
 *
 * The number arbitrates between the two things this file has to do. It must be far
 * larger than the ring, which retains 256 KiB by default
 * (`dsh-jobs-local/lib/index.js:341`): the file exists because the ring evicts the
 * HEAD of a long output, so it has to hold whole jobs — the heavy case that was
 * measured, a 5000-line dump, is ~350 KB. And it must be bounded, because this is
 * the one artifact of a detached job that nothing deletes: an endless job
 * (`while ($true) { … }`) would otherwise fill `$DSH_HOME`, where the session logs
 * themselves live. 32 MiB caps one job's residue at 128× the ring's retention.
 *
 * The file keeps the HEAD and the ring keeps the TAIL — eviction only ever removes
 * the oldest bytes — so a ceiling may STOP the writing instead of rotating it: the
 * two ends still cover the stream together, and the cut is announced inside the file.
 */
const SPILL_MAX_BYTES = 32 * 1024 * 1024

/** Process-local ordinal for the fallback name of a job handle with no id (unit stubs). */
let spillOrdinal = 0

/**
 * The directory holding one recovery file per detached job: this plugin's own
 * directory under the store the relay journal already uses — `$DSH_HOME`, falling
 * back to `~/.dsh`. Read at CALL time rather than at import, so a deployment or a
 * test that sets `DSH_HOME` later still lands in the right store.
 */
function spillDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-data', 'dsh-detached-jobs')
}

/**
 * Retention policy for the recovery files: the three numbers, fixed here rather
 * than configurable.
 *
 * WHY it exists at all. `openRecoveryFile` writes one file per detached job and
 * nothing ever removed one, so the store grew without bound — up to 32 MiB per job,
 * in the user's own $DSH_HOME, beside the session logs. The file is a recovery aid
 * for a RECENT job; past a week it is residue.
 *
 *   - `SPILL_TTL_MS` (7 days) — a file whose mtime is older than the TTL goes. The
 *     age is the MTIME, never the name: the name is the job id, and ids like
 *     `pwsh-1` repeat from session to session.
 *   - `SPILL_MAX_FILES` (20) — a ceiling on the COUNT, applied after the TTL pass,
 *     oldest first, until 20 `*.log` files remain.
 *   - `SPILL_MIN_AGE_MS` (60 minutes) — a file younger than this is NEVER removed,
 *     cap or no cap. This is what protects a job that is still running: its file is
 *     being appended to right now, and it is exactly the file whose loss would
 *     matter. The TTL pass cannot reach such a file (7 days is far more than an
 *     hour), so the floor exists for the CAP pass, which must be stopped by it
 *     explicitly — a young file is under the TTL and over the count at the same
 *     time whenever enough jobs run in one hour.
 */
const SPILL_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SPILL_MAX_FILES = 20
const SPILL_MIN_AGE_MS = 60 * 60 * 1000

/**
 * Remove the recovery files in `dir` that the policy retires.
 *
 * Pure with respect to the environment: the directory is a PARAMETER, so this never
 * reads `DSH_HOME` and the suite can drive it without mounting the plugin.
 *
 * Every I/O error is swallowed, and the answer stays HONEST about it: a path lands in
 * `removed` only once `unlinkSync` has returned, so a caller may cite `removed` as
 * files that are really gone. A file that could not be removed — held open, or a
 * DIRECTORY named `x.log` — is left alone and reported among `kept`, because it is
 * still there. An entry whose age cannot be read at all is neither touched nor
 * claimed: an undecidable age is not guessed.
 *
 * Only `*.log` entries directly in `dir`: no recursion. The file of a job that is
 * running right now is one of them, which is why `except` exists.
 *
 * @param dir - the spill directory to prune.
 * @param options.except - full path of the running job's own file: never removed,
 *   whichever pass would otherwise take it.
 * @param options.now - the clock, for the suite. Defaults to `Date.now()`.
 * @returns `{ removed, kept }` as full paths: `removed` in the order the passes took
 *   them (TTL pass first, then the cap, each oldest first), `kept` oldest first.
 */
export function pruneSpillDir(dir, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const except = typeof options.except === 'string' ? options.except : undefined
  const removed = []
  const gone = new Set()
  /** Remove one candidate, recording only what really went. */
  const remove = (candidate) => {
    try {
      unlinkSync(candidate.path)
      removed.push(candidate.path)
      gone.add(candidate.path)
    } catch {
      // Read-only, held open, or not a plain file at all: it stays, and it is reported.
    }
  }
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // No store yet, or nothing readable there: nothing to prune, nothing to say.
    return { removed, kept: [] }
  }
  const candidates = []
  for (const entry of entries) {
    // The TYPE is not filtered here, deliberately: an entry named `*.log` that is not
    // a file is still a name to be told about, and `unlinkSync` refuses it below.
    if (!entry.name.endsWith('.log')) continue
    const path = join(dir, entry.name)
    try {
      // `lstat`, not `stat`: an entry is dated on what it IS, and a link is never
      // followed out of this directory.
      candidates.push({ path, mtimeMs: lstatSync(path).mtimeMs })
    } catch {
      // Vanished between the listing and the probe: undecidable, so untouched.
    }
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)
  const survivors = []
  for (const candidate of candidates) {
    if (candidate.path === except || now - candidate.mtimeMs <= SPILL_TTL_MS) survivors.push(candidate)
    else remove(candidate)
  }
  // The count ceiling, oldest first — and the age floor stops it: a job that is still
  // writing has a young file, and the ceiling is not allowed to take that one.
  for (let index = 0; survivors.length > SPILL_MAX_FILES && index < survivors.length;) {
    const candidate = survivors[index]
    if (candidate.path === except || now - candidate.mtimeMs < SPILL_MIN_AGE_MS) {
      index++
      continue
    }
    survivors.splice(index, 1)
    remove(candidate)
  }
  const kept = candidates.filter((candidate) => !gone.has(candidate.path)).map((candidate) => candidate.path)
  return { removed, kept }
}

/**
 * The recovery file of ONE job: `<spill dir>/<job id>.log`.
 *
 * The NAME comes from the job — `job.id`, sanitised, plus a random token — so two
 * jobs never share a file, whatever the store already holds. A handle without an id
 * (the unit stubs) falls back to a process-local name, never to anything read from
 * the environment.
 *
 * Computed BEFORE the file is opened, because this path is also what the retention
 * pass is told to SPARE: a job must never prune the file it is about to write.
 *
 * THE RANDOM TOKEN IS NOT DECORATION — it removes a MEASURED class of collision. The
 * store outlives the process; the job ids do not. `pwsh-1` is a per-process counter,
 * and the file was opened 'w', so after a restart a new `pwsh-1` TRUNCATED the file
 * an older session log still cited. While that path existed only as a line of text the
 * collision was theoretical; now that the path is what the registry advertises as the
 * job's FULL OUTPUT, reading the old path would hand back the output of a DIFFERENT
 * job. The DETERMINISTIC overwrite is gone for good: two jobs of the same id no longer
 * name the same file. What remains is a residual probability, not a guarantee — three
 * random bytes give 16 777 216 tokens, so a given PAIR collides with probability 2^-24.
 *
 * The job id keeps its own sanitisation: the token is additive, never a substitute.
 *
 * @param jobId - the `JobHandle.id` of the job, or whatever a stub passed.
 * @returns the full path of this job's recovery file.
 */
function recoveryPathOf(jobId) {
  const name = typeof jobId === 'string' && jobId !== ''
    ? jobId.replace(/[^A-Za-z0-9._-]/g, '_')
    : `producer-${process.pid}-${++spillOrdinal}`
  return join(spillDir(), `${name}-${randomBytes(3).toString('hex')}.log`)
}

/**
 * Open ONE job's recovery file: its complete output, byte for byte, so the head the
 * ring evicts has somewhere to be read from.
 *
 * Best-effort end to end, deliberately. A directory that cannot be created or a file
 * that cannot be opened returns `undefined`, and a failed write closes and removes
 * the file, because an incomplete file must never be cited as the complete output —
 * and because a diagnostic must never break the job it observes.
 *
 * @param path - the file to open, from `recoveryPathOf`.
 * @param maxBytes - ceiling for the file, its own truncation notice included.
 * @returns the writer, or `undefined` when no file could be opened.
 */
function openRecoveryFile(path, maxBytes) {
  const dir = dirname(path)
  // The notice is written INSIDE the ceiling, so a capped file always ends by saying
  // that it was cut.
  const notice = `\n[sortie tronquée au plafond de ${maxBytes} octets ; le registre conserve la fin du flux]\n`
  const noticeBytes = Buffer.byteLength(notice, 'utf8')
  let fd
  try {
    mkdirSync(dir, { recursive: true })
    fd = openSync(path, 'w', 0o600)
  } catch {
    return undefined
  }
  let bytes = 0
  let capped = false
  /** Discard a file that is no longer a complete-output candidate. */
  const drop = () => {
    try {
      if (fd !== undefined) closeSync(fd)
    } catch {
      // The descriptor is gone already; the file still has to be removed.
    }
    fd = undefined
    try {
      unlinkSync(path)
    } catch {
      // Never created, or already removed.
    }
  }
  return {
    path,
    /**
     * Append one chunk of process output.
     * @returns `false` once this writer is dead and the caller must forget it.
     */
    write(piece) {
      if (fd === undefined) return false
      if (capped) return true
      const chunk = Buffer.from(piece, 'utf8')
      // A chunk that would not fit WHOLE is not written at all: the ceiling stays hard
      // and no code point is ever cut in half. What that chunk held is not lost
      // either — the ring holds the end of the stream by construction.
      if (bytes + chunk.length + noticeBytes > maxBytes) {
        try {
          writeSync(fd, notice)
        } catch {
          drop()
          return false
        }
        capped = true
        return true
      }
      try {
        writeSync(fd, chunk)
      } catch {
        drop()
        return false
      }
      bytes += chunk.length
      return true
    },
    /**
     * Close the file and answer what the stream may cite.
     * @returns the path and whether the ceiling cut it, or `undefined` when no file survived.
     */
    seal() {
      if (fd === undefined) return undefined
      try {
        closeSync(fd)
      } catch {
        // A close that fails may have lost the tail: withdraw the path.
        fd = undefined
        return undefined
      }
      fd = undefined
      return { path, capped }
    },
  }
}

/**
 * Exported for the suite, which drives it with a stub job handle: a resolution
 * rule that is correct but not wired to the spawn would pass every unit case and
 * still fail in production — which is exactly what happened.
 *
 * @param spillMaxBytes - ceiling for this job's recovery file. A parameter so the
 * suite can drive the capped branch without producing 32 MiB of output.
 * @param onRecovery - called with this job's recovery path when the file OPENS, and
 *   again at settlement: the path when that file is a COMPLETE output, `undefined`
 *   when it is not (capped, or never created). This is how the registry learns the
 *   path it may advertise — and how it learns to withdraw it. A capped file holds the
 *   HEAD of the stream while the ring holds the TAIL, so advertising it as "a file
 *   holding the complete stream" would be a lie the harness repeats to the reader.
 */
export function spawnProducer(command, cwd, shell = resolveShell(), spillMaxBytes = SPILL_MAX_BYTES, onRecovery = () => {}) {
  return (job) => {
    let text = ''
    let settled
    const done = new Promise((resolve) => { settled = resolve })
    // Retention, before this job adds its own file to the pile.
    //
    // Best-effort twice over: `pruneSpillDir` swallows its own I/O errors, and the
    // call is wrapped anyway, because maintenance must never be able to fail the work
    // it maintains. `except` is this job's own path — deleting it here would delete
    // the file the next line opens.
    const path = recoveryPathOf(job?.id)
    try {
      pruneSpillDir(spillDir(), { except: path })
    } catch {
      // A purge that fails leaves the store exactly as it was; the job still runs.
    }
    // The complete output, on disk, before the ring can evict its head. Opened
    // before the spawn so the very first byte is already covered; absent when the
    // store refuses it, in which case the job simply runs as it did before.
    let recovery = openRecoveryFile(path, spillMaxBytes)
    // Announced as soon as the file exists, so a reader that looks MID-JOB already has
    // the path instead of waiting for settlement.
    onRecovery(recovery?.path)
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${ENCODING_PREAMBLE}${command}`], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const absorb = (chunk) => {
      const piece = chunk.toString('utf8')
      text += piece
      job.append(piece)
      if (recovery !== undefined && recovery.write(piece) === false) recovery = undefined
    }
    /**
     * Settle the job, citing the recovery file first when one survived.
     *
     * WHERE this append happens is a contract question, not a style one.
     * `JobHandle` is documented as valid for the job's whole life, and its writes are
     * dropped only after settlement — the producer's own outcome, a kill, or a
     * registry-forced teardown end (`dsh-jobs/lib/types/types.d.ts:71-77`); the
     * registry implements exactly that by dropping a producer chunk only once
     * `isTerminal(job.status)` (`dsh-jobs-local/lib/index.js:664-672`), and status
     * turns terminal in `settle()`, which that registry runs inside
     * `producerDone.then(...)` — a microtask AFTER `done` resolves
     * (`dsh-jobs-local/lib/index.js:487-490`). So a synchronous append here is still
     * inside the job's life: it is accepted, retained, and — being the NEWEST chunk —
     * it survives the eviction that took everything before it.
     */
    const finish = (outcome) => {
      const file = recovery?.seal()
      recovery = undefined
      // What the registry may advertise, decided HERE: a capped file is withdrawn,
      // because it holds the head and not the stream, and a file that never opened was
      // announced as absent already. Before the pointer line and before `settled(...)`,
      // so the two can never disagree about what the reader is about to be told.
      onRecovery(file !== undefined && file.capped !== true ? file.path : undefined)
      if (file !== undefined) {
        const separator = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
        job.append(file.capped
          ? `${separator}[sortie tronquée au plafond de ${spillMaxBytes} octets ; début conservé : ${file.path}]`
          : `${separator}[sortie complète : ${file.path}]`)
      }
      // The complete text, for the reader, ONLY when no recovery file survived.
      //
      // The registry delivers a terminal `result` once, on the first read after
      // settlement (`dsh-jobs-local/lib/index.js:601-602`) — and this producer also
      // PUSHES every chunk into the ring. Both at once is the output delivered TWICE:
      // measured live, a 3000-line job (~219 KB) read back as 436 KB, with the pointer
      // line buried in the middle of its own stream instead of ending it. So `result`
      // is the fallback of a degraded store, not the normal path — with a file on disk
      // the reader has the complete output by construction. The harness's own `pwsh`
      // tool settles without a `result` for the same reason.
      settled(file === undefined ? { ...outcome, result: text } : outcome)
    }
    child.stdout.on('data', absorb)
    child.stderr.on('data', absorb)
    child.on('error', (error) => {
      text += `\n[launch failed] ${String(error?.message ?? error)}`
      job.updateProgress('échec du lancement')
      finish({ status: 'failed', detail: String(error?.message ?? error) })
    })
    child.on('close', (code, signal) => {
      const status = code === 0 ? 'completed' : signal !== null ? 'killed' : 'failed'
      finish({
        status,
        detail: signal !== null ? `signal ${signal}` : `exit code: ${code}`,
      })
    })
    return {
      cancel(reason) {
        job.updateProgress(reason === undefined ? 'arrêt demandé' : `arrêt : ${reason}`)
        try {
          child.kill()
        } catch {
          // The process is already gone; `close` settles the record.
        }
      },
      done,
    }
  }
}

/**
 * The UNSCOPED jobs service, captured by the host-level row.
 *
 * Two mounts of this same file exist, and Node's ESM cache hands both the same
 * module instance, so this slot is how the preset-scoped tool reaches a service
 * that may serve any owner.
 *
 * Why it must be the unscoped one: `jobs.start` refuses work when no attached
 * controller serves the spec's owner, and "registrations made from an unscoped
 * context serve every owner, and registrations made under an agent [serve that
 * agent]" (`dsh-jobs/lib/index.js:102-104`). A preset row is composed under the
 * agent, so its own `ctx.jobs` can only ever own jobs for that agent — using it
 * would silently recreate the exact defect this plugin removes.
 */
let unscopedJobs

/**
 * The Agents this mount has been told about, by session id.
 *
 * The ownership predicate below reads the ROOT's tool surface, and the root is an AGENT —
 * not a session id — so the tool objects have to be kept. Both disclosure paths feed this
 * map: `agent/created` (recorded before the verdict is formed) and the deferred `agents`
 * injection's `list()`.
 */
const seenAgents = new Map()

/**
 * The live agent registry, captured by the deferred `agents` injection in `apply()`.
 *
 * The predicate asks IT for the root, before falling back to the announced map: the
 * registry's own definition of an owner is "the live Agent currently registered under that
 * id" (`dsh-jobs/lib/types/types.d.ts:122-128`), and a stale announcement is not that.
 */
let agentsService

/** Trace lines emitted before a mount has its own state (capture happens at mount). */
const bootState = { decisions: [] }

/**
 * Where decisions are recorded: the SAME journal the relay appends to.
 *
 * One file, deliberately. This module spent six rounds reporting nothing at all,
 * and the only question that mattered was "did the row mount?". A second journal
 * would make that question a two-file search.
 */
const LOG_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-data', 'dsh-boost-relay', 'decisions.jsonl')

/**
 * Append one decision, including the silent ones.
 *
 * Best-effort by construction, and here that is load-bearing rather than tidy:
 * the catch below reports an activation failure THROUGH this function, so a
 * `trace` that can throw would replace the real error with its own and leave the
 * row failed with nothing written. That is not hypothetical — this helper was
 * missing from the file entirely, so `trace(...)` raised ReferenceError at the
 * first call, the catch raised it a second time, `apply()` never returned, and
 * both rows sat at `fiberPhase: "failed"` with an empty journal. The unit test
 * that calls `apply()` is what makes that class of defect loud instead of silent.
 */
function trace(state, entry) {
  let line
  try {
    line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  } catch {
    return
  }
  state.decisions.push(line)
  if (state.decisions.length > 200) state.decisions.shift()
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    appendFileSync(LOG_FILE, `${line}\n`, 'utf8')
  } catch {
    // A diagnostic that can break what it observes is worse than no diagnostic.
  }
}

export function apply(ctx, config) {
  // Which mount this is, decided and RECORDED before anything in the body runs.
  //
  // The count of `mount` lines is the only way to tell whether the composition
  // still carries two rows for this module — the bundle's include row and the
  // profile patch row — because a second mount is silent by design.
  const firstMount = unscopedJobs === undefined
  trace(bootState, { step: 'mount', first: firstMount, pid: process.pid })
  try {
  // Which mount is the unscoped one, decided by ORDER rather than by inspection.
  //
  // The host row is created by `install_bundle` and lands in the profile's include
  // layer, whose config this plugin cannot edit; so `config.share` cannot be relied
  // on to mark it. Boot order can: profile rows load at startup, preset rows mount
  // later when a session composes, so the FIRST mount is the host one, and its
  // `ctx` is the unscoped one that may serve any owner. An explicit
  // `config.share: true` still wins when a deployment can set it.
  //
  // Capturing a scoped service would silently produce worker-owned jobs — the exact
  // defect this plugin removes — so the capture is traced and the tool refuses to
  // run when no capture exists, rather than falling back.
  if (config?.share === true || firstMount) {
    unscopedJobs = ctx.jobs
    trace(bootState, {
      step: 'capture',
      via: config?.share === true ? 'config.share' : 'first-mount',
      pid: process.pid,
      share: config?.share === true,
    })
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'detached-jobs',
        description: 'État du lanceur de jobs détachés (propriété de la racine)',
        handler: () => ({
          kind: 'success',
          text: [
            'Jobs détachés — propriété de la session racine',
            `service non scopé capturé : ${unscopedJobs === undefined ? 'NON' : 'oui'}`,
            `capturé par : ${config?.share === true ? 'config.share' : 'premier montage'}`,
            // The sentence below used to claim the OPPOSITE of what this module does
            // ("Le montage du preset enregistre l'outil ; ce montage fournit la portée").
            // The comment on the tool object below — "It is deliberately NOT registered
            // from this row's own context: that reached the tools service but never an
            // agent's composed surface (measured twice — host row and preset row)",
            // lib/index.js:722-724 — says why that was false, and
            // `packages/boost-mode/cordis.patch.yml:369-384` records the same
            // measurement: "run_detached n'est PAS déclaré ici". The truth is the other way
            // round: THIS host mount captures the unscoped service AND installs the tool
            // into each Agent's surface from its agent/created listener; the preset row
            // registers nothing.
            // `run_detached` est donc installé par agent depuis CE montage hôte, et non
            // depuis la portée d'une ligne : le montage du preset n'enregistre rien.
            'outil run_detached : installé par agent sur agent/created, jamais déclaré depuis la portée de cette ligne.',
          ].join('\n'),
        }),
      })
    })
  }
  // The tool object, installed per Agent further down. It is deliberately NOT
  // registered from this row's own context: that reached the tools service but
  // never an agent's composed surface (measured twice — host row and preset row).
  const detachedTool = {
      name: 'run_detached',
      description: 'Run a shell command as a background job owned by the SESSION ROOT instead of by you. '
        + 'Use this for any long job a worker would otherwise leave behind: a job owned by a one-shot worker '
        + 'is destroyed the moment that worker settles, and its output is then unreadable by the orchestrator. '
        + 'A detached job survives, its output is readable by the root with job_output, and the root receives the '
        + 'ordinary settlement notice. Returns the job id.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run in the background.' },
          label: { type: 'string', description: 'Short model-facing label for the job.' },
          cwd: { type: 'string', description: 'Working directory; defaults to the session cwd.' },
        },
        required: ['command'],
      },
      // `output` is not decoration. The registry REFUSES a tool that omits it —
      // "tool \"run_detached\" must declare output { schema, render, presentationMeta? }"
      // (`dsh-tools/lib/types/index.js:459-466`) — and the refusal is one
      // `register-failed` line: the row reads `active`, and the tool is absent from
      // every surface. Measured at 20:58:55Z, in the same run that recorded the
      // missing helper.
      //
      // The shapes are the registry's own: `execute` returns the VALUE, `render`
      // turns it into content blocks, and a failure is THROWN — the pipeline wraps a
      // throw into `{content, isError: true}` itself (`dsh-tools/lib/index.js:3616`),
      // so returning an `isError` object by hand reports a malformed value instead.
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            job_id: { type: 'string', description: 'Id of the job that was started.' },
            owner: { type: 'string', description: 'Session that owns the job — the root, never the caller.' },
            text: { type: 'string', description: 'Model-facing summary.' },
          },
          required: ['job_id', 'owner', 'text'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => {
        const caller = exec?.agent?.session?.id
        const rootId = caller === undefined ? undefined : rootOf(caller)
        if (rootId === undefined) {
          throw new Error('run_detached: could not resolve the session root from the durable session headers, '
            + 'so the job was not started. Refusing to start a job whose owner would be wrong.')
        }
        // No fallback to this scope's own service, deliberately.
        //
        // This scope is composed under the calling agent, so a job started here
        // would be owned by that agent and destroyed with it — precisely the
        // failure this tool exists to remove. A silent fallback would look like a
        // success and reproduce the bug, so the tool refuses and says why.
        const jobs = unscopedJobs
        if (jobs === undefined) {
          throw new Error('run_detached: the unscoped jobs service is not available, so a root-owned job cannot '
            + 'be started from here. Refusing rather than starting a job owned by the caller, which would be '
            + 'destroyed when the caller settles.')
        }
        const label = typeof args.label === 'string' && args.label !== '' ? args.label : String(args.command).slice(0, 80)
        // A pull source whose ONLY product is the path of the recovery file.
        //
        // WHY it exists: the registry advertises `job.spillPaths[]` from its pump's sink,
        // and the pump exists only when `spec.output` is a NON-EMPTY array
        // (`dsh-jobs-local/lib/index.js:479`). `output: []` was therefore the SINGLE cause
        // of `full output: (unavailable)` — measured when the ring had evicted the head of
        // a long job while the complete file sat on disk, uncited.
        //
        // WHY it cannot corrupt the measured property: `text` is ALWAYS empty, so the pump
        // never reaches `sink.append` (`dsh-jobs-local/lib/index.js:131`) and the ring is
        // not touched — "a settled stream is delivered exactly once" stands. No `channel`:
        // there is no text to attribute. And the registry never READS the file, it stores
        // the string, so there is no concurrency with our `writeSync`.
        let recoveryPath
        const recoverySource = {
          read: (fromByte) => ({
            text: '',
            nextOffset: fromByte,
            lossy: false,
            ...(recoveryPath !== undefined ? { spillPath: recoveryPath } : {}),
          }),
        }
        const jobId = jobs.start({
          kind: 'pwsh',
          label,
          // The whole point: the ROOT owns it, so the worker's disposal cannot cancel it.
          owner: rootId,
          output: [recoverySource],
          // The shell is resolved at CALL time, never captured: a configured `pwshPath` is
          // a live getter that re-probes, so a hot config change must reach the next job.
          run: spawnProducer(
            String(args.command),
            typeof args.cwd === 'string' ? args.cwd : exec?.cwd,
            shellProbe?.() ?? resolveShell(),
            SPILL_MAX_BYTES,
            (path) => { recoveryPath = path },
          ),
        })
        const own = rootId === caller ? 'this session' : `the session root (${String(rootId).replace(/^session-/, '').slice(0, 8)})`
        // Who can read a root-owned job depends on WHO is asking, so the sentence does too. It
        // used to be constant, and it told the orchestrator — the one caller that CAN read a
        // root-owned job — that the job was unreadable from its session.
        const tail = rootId === caller
          ? 'It outlives this turn: read it with job_output, where wait: true blocks until it settles.'
          : 'It will keep running after you finish, and it is NOT readable from your session — pass the id '
            + 'back so the owner can read it with job_output. Do not wait for it.'
        return {
          job_id: jobId,
          owner: rootId,
          text: `Started ${jobId} as a detached job owned by ${own}. ${tail}`,
        }
      },
  }

  // Per-Agent installation, the documented pattern. Every Agent whose ROOT can collect
  // gets the tool in its OWN surface, so the orchestrator and each worker can call it —
  // and the registration dies with the Agent, which is what the practice note promises.
  // An agent whose root cannot collect gets NOTHING, and the refusal is journalled: a
  // visible tool that always fails is worse than an absent one.
  // The per-Agent installation belongs to the FIRST mount as well, for the same
  // reason as the capture: a second mount would register the same tool name into
  // the same agent surface again, which is a duplicate registration or a
  // `register-failed` line — a silent defect in the composition either way. The
  // skip is traced so the duplicate row is visible instead of merely harmless.
  const installOne = (agent) => {
    if (firstMount) return registerForAgent(agent, detachedTool)
    const id = agent?.session?.id
    trace(bootState, {
      step: 'install-skipped',
      why: 'not-the-first-mount',
      id: typeof id === 'string' ? id.replace(/^session-/, '').slice(0, 8) : null,
    })
  }
  ctx.on('agent/created', (payload) => installOne(payload?.agent ?? payload))
  // Agents that already existed when this row mounted are covered too, so a
  // resumed session is not silently left without the tool.
  //
  // Deferred rather than declared, and this is a measured decision, not a style:
  // reading a service the module does not declare makes cordis throw on the
  // property GET — optional chaining does not soften it —
  //
  //   {"step":"apply-failed","error":"cannot get property \"agents\" without inject",
  //    "where":"at new apply (…/lib/index.js:375:27)"}          — measured, pid 22180
  //
  // Declaring `agents` in `inject` would satisfy that, but a HARD dependency the
  // scope cannot satisfy fails the FIBER: `apply()` never runs and nothing is
  // traced, which is the blindness this module was rewritten to end. The deferred
  // form keeps the row mounting when the service is absent, and records both the
  // request and the answer so the absence is visible instead of silent.
  trace(bootState, { step: 'agents-inject-requested' })
  ctx.inject(['agents'], (agentCtx) => {
    // Captured for the ownership predicate: `agents.get(id)` is the registry's own notion
    // of "the live Agent registered under that id", which is exactly who must be able to
    // collect a root-owned job.
    agentsService = agentCtx.agents
    const known = agentCtx.agents.list()
    trace(bootState, { step: 'agents-ready', count: known.length })
    for (const agent of known) installOne(agent)
  })
  // The configured PowerShell executable, when the deployment has a shell row.
  //
  // DEFERRED, never a hard dependency, and never a bare `ctx.shell` read — both forms
  // were paid for already: `inject = ['shell']` fails the FIBER before `apply()` runs
  // when the scope cannot satisfy it (the blindness this module exists to end), and
  // reading the service undeclared throws on the property GET,
  //
  //   "cannot get property \"shell\" without inject"
  //
  // The deferred form keeps the row mounting in every composition and records whether
  // the service arrived, so its absence is a journal line and not a silence.
  //
  // `pwshPath` is the RESOLVED value and re-probes on every read, so it is read at CALL
  // time rather than captured here. The getter can still throw, or answer nothing
  // useful, on a deployment that does not carry it — hence the guard, and hence the
  // explicit fallback to `resolveShell()` in `execute`.
  let shellProbe
  ctx.inject(['shell'], (shellCtx) => {
    shellProbe = () => {
      try {
        const value = shellCtx.shell.pwshPath
        return typeof value === 'string' && value !== '' ? value : undefined
      } catch {
        return undefined
      }
    }
    trace(bootState, { step: 'shell-ready', pwshPath: shellProbe() ?? null })
  })
  trace(bootState, { step: 'apply-complete' })
  } catch (error) {
    // A row that fails to activate is invisible from the outside: `fiberPhase`
    // reads "failed" and nothing anywhere says why. That blindness cost three
    // rounds of wrong hypotheses about tool visibility, so the error is written
    // where it can be read. Instrument before concluding.
    trace(bootState, {
      step: 'apply-failed',
      error: String(error?.message ?? error),
      where: String(error?.stack ?? '').split('\n')[1]?.trim() ?? null,
    })
  }
}

/**
 * Install the tool into ONE agent's own tool surface.
 *
 * This is the pattern the harness documents, and three earlier attempts failed
 * because they did not use it:
 *
 *   "Register per-agent behavior on `agent.ctx`, obtained in an `agent/created`
 *    listener, so it is removed when that agent is disposed."
 *    — dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:19
 *
 * What was measured instead:
 *   1. a host-level row with `tools.register` succeeded, and the tool was absent
 *      from every surface — the orchestrator did not see it, and a worker reported
 *      its absence rather than faking the call;
 *   2. mounting the same plugin as a ROW INSIDE the boost preset did not help
 *      either: the Boost orchestrator still reported a registry of 33 tools with no
 *      `run_detached`, because a row's `ctx` reaches the tools service, not the
 *      agent's composed surface.
 *
 * The registration is also announced, so a future deployment can tell whether the
 * hook fired for each agent instead of inferring it from an absence.
 *
 * THE REGISTRATION IS NOW CONDITIONAL ON THE OWNER, and that is not a refinement — it
 * removes a MEASURED dead tool. In a composition with no preset (`tool-jobs` is
 * `disabled: true` at the base and raised by a preset,
 * `dsh-web-app/cordis.patch.yml:456-467`) the tool sat on every surface and EVERY call
 * failed:
 *
 *   Error: background jobs unavailable: no job controller serves this agent
 *          (load @deepseek-ai/dsh-tool-jobs in its composition)
 *
 * A visible tool that cannot work is the failing silence this project refuses: it costs
 * prompt budget on every turn, and the caller learns about it only by failing. So the
 * predicate asks whether the ROOT — the owner, never this agent — can collect a job: the
 * root is the session that will still be there, and the only one that can read the output
 * or kill the job.
 *
 * @param agent - the Agent announced by `agent/created`.
 * @param tool - the `run_detached` definition to install into that Agent's surface.
 */
function registerForAgent(agent, tool) {
  const id = agent?.session?.id
  trace(bootState, { step: 'agent-created', id: shortId(id) })
  // Recorded BEFORE the verdict, whatever the verdict: the root of some LATER agent is
  // looked up here, and a root announced under a name this module did not keep could not
  // be found at all.
  if (typeof id === 'string' && id !== '') seenAgents.set(id, agent)
  const target = agent?.ctx
  if (target === undefined) {
    trace(bootState, { step: 'register-skipped', why: 'agent-has-no-ctx', id: typeof id === 'string' ? id.slice(0, 20) : null })
    return
  }
  const owner = ownerVerdict(id)
  if (owner.collectable !== true) {
    // Traced ALWAYS, and this line is the point of the change: a tool withdrawn without a
    // line would be one more silence, in a module whose history is six rounds of wrong
    // theory built on exactly such silences. `why` names the one condition that decided.
    trace(bootState, {
      step: 'register-skipped',
      why: owner.why,
      id: shortId(id),
      ...(owner.root === undefined ? {} : { root: shortId(owner.root) }),
      ...(owner.error === undefined ? {} : { error: owner.error }),
    })
    return
  }
  target.inject(['tools'], (toolCtx) => {
    try {
      toolCtx.tools.register(tool)
      trace(bootState, {
        step: 'registered',
        id: shortId(id),
        root: shortId(owner.root),
        // Named once, at registration: this is the evidence that the surface was gated on
        // the OWNER, and which agent's collection capability admitted it.
        via: 'owner-can-collect',
      })
    } catch (error) {
      trace(bootState, { step: 'register-failed', error: String(error?.message ?? error) })
    }
  })
}

/** The short id this journal uses everywhere, or null for anything that is not one. */
function shortId(value) {
  return typeof value === 'string' ? value.replace(/^session-/, '').slice(0, 8) : null
}

/**
 * The live Agent registered under `id`.
 *
 * The live registry answers first — `get(id)` is the registry's own "the live Agent
 * registered under that id", the notion ownership is defined by — and the announced map is
 * the fallback for a deployment whose `agents` row is absent or has not resolved yet.
 *
 * @param id - the session id to look up.
 * @returns the Agent, or undefined when no live or announced agent carries that id.
 */
function agentById(id) {
  const getter = agentsService?.get
  if (typeof getter === 'function') {
    try {
      const live = getter.call(agentsService, id)
      if (live !== undefined) return live
    } catch {
      // A registry that throws on lookup answers nothing; the announced map still may.
    }
  }
  return seenAgents.get(id)
}

/**
 * Can the OWNER of `sessionId` collect a job started for it?
 *
 * THE PREDICATE IS ABOUT THE OWNER, NEVER ABOUT THE CALLER, and the whole design rests on
 * that: the root is the session that outlives the caller, so the root is who must be able
 * to read the job with `job_output` and stop it with `job_kill`. An agent that can collect
 * for ITSELF proves nothing — the suite pins both directions (a worker whose own surface
 * lacks `job_kill` still gets the tool when the ROOT has it, and a worker that has it does
 * NOT get the tool when the root lacks it).
 *
 * WHY "SEES `job_kill`" MEANS "CAN COLLECT". In every shipped deployment the one provider
 * of a job controller (`dsh-tool-jobs/lib/index.js:256`) is ALSO the only provider of the
 * three collection tools (`:298`, `:348`, `:368`), so a root that can see `job_kill` is
 * a root served by a controller. There is no public API to ask the question directly:
 * `servesOwner` is private and has zero occurrences in the published contract.
 *
 * WHY THE SCOPE ARGUMENT IS THE AGENT OBJECT. Measured against the real registry on a real
 * cordis app, with `job_kill` registered from a preset scope exactly as `dsh-tool-jobs`
 * registers it:
 *
 *   tools.get('job_kill')                     -> undefined   (this is the GLOBAL layer only)
 *   tools.get('job_kill', scopeOf(agent.ctx)) -> the definition
 *   tools.get('job_kill', agent)              -> the definition
 *
 * The first line is why the no-scope form the issue proposed was NOT kept: it reads the
 * global layer, so a preset-scoped `job_kill` is invisible to it and the tool would have
 * been withheld in the very composition where it works. The agent OBJECT is that scope —
 * the harness's own call sites pass it (`dsh-tools/lib/types/index.js:784`), the agent loop
 * mints its scope with the agent as the key (`dsh-agent-loop/lib/index.js:778`), and
 * `scopeOf(agent.ctx) === agent` was measured true — so this is `scopeOf` WITHOUT importing
 * `@deepseek-ai/dsh-scope`, a package this plugin deliberately has no dependency on.
 *
 * @param sessionId - the session of the agent being registered, whose ROOT decides.
 * @returns `{ collectable, root?, why?, error? }`; `why` names the condition when false.
 */
function ownerVerdict(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return { collectable: false, why: 'caller-has-no-session-id' }
  const root = rootOf(sessionId)
  if (root === undefined) return { collectable: false, why: 'root-not-resolved' }
  const owner = agentById(root)
  if (owner === undefined) return { collectable: false, why: 'root-agent-unknown', root }
  const ownerCtx = owner.ctx
  if (ownerCtx === undefined) return { collectable: false, why: 'root-has-no-ctx', root }
  // `ctx.get` and not `ctx.tools`: the latter throws on the property GET without an
  // `inject` declaration, and this read is opportunistic by design — it must answer
  // "no service here" rather than fail the registration path it guards.
  let tools
  try {
    tools = typeof ownerCtx.get === 'function' ? ownerCtx.get('tools') : undefined
  } catch {
    return { collectable: false, why: 'root-tools-unavailable', root }
  }
  if (tools === undefined || typeof tools.get !== 'function') {
    return { collectable: false, why: 'root-tools-unavailable', root }
  }
  let definition
  try {
    definition = tools.get('job_kill', owner)
  } catch (error) {
    return { collectable: false, why: 'owner-check-failed', root, error: String(error?.message ?? error) }
  }
  if (definition === undefined) return { collectable: false, why: 'owner-cannot-collect', root }
  return { collectable: true, root }
}
