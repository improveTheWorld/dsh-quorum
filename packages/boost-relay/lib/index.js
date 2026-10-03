/**
 * Boost job relay — a job started inside a subagent stops being observable to
 * the session that owns the tree.
 *
 * Why this exists (measured, not theorised): a background job belongs to the
 * session that started it (`JobRegistry.list(caller)` is fenced by the owner's
 * session id, and the settlement subscription in `dsh-tool-jobs` targets
 * `{ owners: 'scope' }`). So when a foreground, one-shot worker returns while a
 * job it launched is still running, that job settles with **no notice anywhere**:
 * the worker is gone, and the orchestrator cannot even list the job, let alone
 * read its output. In a real boost run the verifier left 5 such jobs
 * (pwsh-95/106/113/117/118) that the orchestrator could only observe as files
 * appearing on disk — which is why it ended up sleeping in 4-minute timeboxes
 * with "no clue about blocking".
 *
 * What this plugin does: subscribes to the job registry with `{ owners: 'all' }`
 * from the host scope, and when a job settles whose owner is a *descendant* of a
 * live root session and whose owner is no longer running, it injects — or, when
 * the root is idle, wakes it with — a completion notice naming the job and the
 * worker that launched it.
 *
 * Deliberate choices:
 * - The notice reuses the `tool-jobs` source discriminant. A plugin cannot
 *   declare a new member of that union at runtime, and reusing it is accurate:
 *   this IS a background-job notice.
 * - Wakes are budgeted per root (MAX_WAKES_PER_ROOT) because a woken turn may
 *   start the work whose completion wakes it again; past the budget the notice
 *   is injected into the next step instead of opening a turn.
 * - Nothing is relayed while the owner agent is `running` for a `producer`
 *   settlement: that agent receives the notice natively in its next step, so
 *   relaying would only duplicate it. That is the existing
 *   `owner-is-the-root` doctrine applied to the second case, not a new policy:
 *   the relay already abstains when the notice would be redundant, and a
 *   notice it labels itself `duplicate` is the same redundancy uncovered.
 *   (`teardown`, `kill`, and an owner the registry cannot produce are the cases
 *   where nothing else can carry the notice — see the bail in `deliver`.)
 * - A notice names whoever it is really addressed to. The `owner-fallback`
 *   below can hand the notice to a session that is NOT the job's owner, and the
 *   text then must not claim the recipient already has the job — nor promise
 *   `job_output` on it, which that session cannot call.
 *
 * Read-only with respect to the workspace: it observes registry events and
 * writes one inbox message. It never starts, stops, or mutates a job.
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

/** zstd frame magic: every session log is a concatenation of frames. */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export const name = 'boost-job-relay'
export const inject = ['jobs', 'agents']
/** Turns one root session may be woken before notices degrade to injection. */
const MAX_WAKES_PER_ROOT = 3

/** How long a root's descendant set is reused before the catalog is read again. */
const DESC_TTL_MS = 5000

/**
 * Resolve a Harness package from the running installation.
 *
 * A profile-linked bundle lives outside the profile's (and the installation's)
 * `node_modules`, so a bare specifier fails with ERR_MODULE_NOT_FOUND — verified
 * on this deployment. The harness entry point is always available as
 * `process.argv[1]`, which is the anchor that resolves.
 */
function resolveHarnessModule(specifier) {
  const anchors = []
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') anchors.push(process.argv[1])
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') {
    anchors.push(join(process.env.DSH_PROFILE_DIR, 'package.json'))
  }
  anchors.push(join(process.cwd(), 'package.json'))
  for (const anchor of anchors) {
    try {
      return createRequire(anchor).resolve(specifier)
    } catch {
      // Anchor outside the installation: try the next one.
    }
  }
  return undefined
}

const llmEntry = resolveHarnessModule('@deepseek-ai/dsh-llm')
if (llmEntry === undefined) {
  // Fail loud: an inert relay that silently relays nothing is worse than a row
  // that refuses to activate and says why in the plugin inventory.
  throw new Error(
    'boost-job-relay: cannot resolve @deepseek-ai/dsh-llm from the running installation '
    + `(anchors tried from argv[1]=${process.argv[1] ?? '(none)'}). A profile-linked bundle resolves no bare `
    + 'specifier, so this row fails here rather than activating as an inert relay.',
  )
}
const { createUserMessage } = await import(pathToFileURL(llmEntry).href)
if (typeof createUserMessage !== 'function') {
  throw new Error('boost-job-relay: @deepseek-ai/dsh-llm resolved but exports no createUserMessage')
}

/**
 * Where decisions are recorded, so a silent relay can be interrogated later.
 *
 * Deliberately outside the workspace and outside any session log: the harness's
 * own plugin-data area is the one place a diagnostic may write without touching
 * what it is measuring.
 */
const LOG_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-data', 'dsh-boost-relay', 'decisions.jsonl')

/**
 * Raw job-event echoes that state no DECISION, and are therefore never journalled.
 *
 * Measured 2026-09-30 on this deployment's journal: `output` alone was 341 171 of
 * 585 840 records and 22 176 361 of 43 639 064 bytes — 51 % of the file, carrying no
 * decision, and the reason reading it in PowerShell took minutes. `progress` is the
 * same kind of echo. `registered`, `removed` and `stopping` are NOT noise: the
 * teardown analysis below was read out of them, so their records stay byte-identical.
 */
const NOISE_EVENT_TYPES = new Set(['output', 'progress'])

/**
 * Ceiling for the journal, in bytes, and the single generation it rotates into.
 *
 * 8 MiB, the top of the usable range: at the measured 74.5 bytes/record that is
 * ~112 000 records — a full day of decisions — while journal + `.1` can never exceed
 * 16 MiB, 38 % of the 43 639 064-byte file measured on 2026-09-30. Overridable for
 * tests (`DSH_BOOST_RELAY_LOG_MAX_BYTES`), so the boundary is exercised in kilobytes.
 */
const LOG_MAX_BYTES = (() => {
  const override = Number.parseInt(process.env.DSH_BOOST_RELAY_LOG_MAX_BYTES ?? '', 10)
  return Number.isInteger(override) && override > 0 ? override : 8 * 1024 * 1024
})()
const LOG_BACKUP = `${LOG_FILE}.1`

/**
 * Rotate the journal to `<name>.1` when the next record would cross the ceiling,
 * keeping exactly one previous generation.
 *
 * Runs on the write path — no timer, no retained handle — and NEVER throws: the
 * pending record must land even when the rotation cannot (a `.1` path held by a
 * directory, a locked file). `incoming` is counted BEFORE the rename, so a record
 * that would not fit triggers the rotation instead of crossing the ceiling; and a
 * record larger than the ceiling is written into whatever file is open and rotates
 * on the NEXT write, so one oversized record can never loop the rotation.
 *
 * @param incoming - bytes the pending record will add, newline included.
 */
function rotateIfFull(incoming) {
  try {
    let size
    try {
      size = statSync(LOG_FILE).size
    } catch {
      return // No journal yet: the append below creates it, empty, in one step.
    }
    if (size === 0 || size + incoming <= LOG_MAX_BYTES) return
    rmSync(LOG_BACKUP, { force: true })
    renameSync(LOG_FILE, LOG_BACKUP)
  } catch {
    // A rotation that cannot happen costs one generation of history, never the record.
  }
}

/**
 * Append one decision, including the silent ones.
 *
 * Best-effort by construction: a diagnostic that can break the thing it observes
 * is worse than no diagnostic, so every failure here is swallowed. Rotation is
 * attempted even when the directory cannot be created, and the append is attempted
 * even when the rotation failed — one failing must never cost the other.
 * @param state - per-application state holding the in-memory tail for the command.
 * @param entry - the decision to record.
 */
function trace(state, entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  state.decisions.push(line)
  if (state.decisions.length > 200) state.decisions.shift()
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    rotateIfFull(Buffer.byteLength(line, 'utf8') + 1)
  } catch {
    // Never let the diagnostic surface as a relay failure.
  }
  try {
    appendFileSync(LOG_FILE, `${line}\n`, 'utf8')
  } catch {
    // Same rule: a journal that cannot be written is not a relay failure.
  }
}

/**
 * Durable session headers, read straight from the session store.
 *
 * This is the fallback that ended the guesswork, and it is the only source that
 * answered correctly every time it was asked:
 *
 *  - `ctx.agents.list()` returned `[]` at mount AND at settlement in one process,
 *    while returning three agents in another, so it cannot be relied on to find a
 *    root;
 *  - `agent/created` does not replay for an Agent that already existed when this
 *    plugin mounted, so the root session — the one that most needs the notice —
 *    is invisible to it;
 *  - `subagents.listDescendants()` walks the delegated-child catalog only, so a
 *    FORKED session (`origin` unset, `delegationDepth` 0, but carrying a
 *    `parentSession`) is invisible to it. Measured: owner `94e2b3a0` carries
 *    `parentSession = 517ee069`, and the lookup still reported no descendant.
 *
 * The session header is written once, as the first record of the first zstd frame,
 * so only the head of each file is touched. Cost is bounded and cached.
 */
const SESSIONS_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
const HEADER_TTL_MS = 10_000
let headerCache = { at: 0, byId: new Map() }

/** The session header of one log file, decoded from its first frame only. */
function headerOf(logPath) {
  const buffer = readFileSync(logPath)
  const firstMagic = buffer.indexOf(FRAME_MAGIC)
  if (firstMagic === -1) return undefined
  const secondMagic = buffer.indexOf(FRAME_MAGIC, firstMagic + FRAME_MAGIC.length)
  const frame = buffer.subarray(firstMagic, secondMagic === -1 ? buffer.length : secondMagic)
  const text = zstdDecompressSync(frame).toString('utf8')
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line)
      if (record.type === 'session') return record
    } catch {
      // A partial frame at the tail: keep looking inside what did decode.
    }
  }
  return undefined
}

/** id → durable header, refreshed at most once per TTL. */
function headers() {
  if (Date.now() - headerCache.at <= HEADER_TTL_MS) return headerCache.byId
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
          // A session being written, or a layout this version does not know.
        }
      }
    }
    headerCache = { at: Date.now(), byId }
  } catch {
    // Keep the previous cache rather than losing resolution entirely.
  }
  return headerCache.byId
}

/**
 * The root session an owner belongs to, by walking `parentSession` upwards.
 *
 * Bounded to 16 hops: a cycle in a malformed store must not hang a host plugin.
 *
 * The walk STOPS where the store stops. When the parent's header is missing it returns that
 * parent's ID, which the headers know nothing about — neither alive nor dead. That return is
 * kept (it is the only clue the store leaves), and it is exactly why this walk is no longer
 * the whole resolution: `chainOf` carries that id to the LIVE registry, which confirms it or
 * discards it. An id nothing describes is never handed a notice (see `deliver`, step 3).
 *
 * @returns the root session id, the last readable link's parent id, or undefined.
 */
function rootOf(ownerId) {
  const byId = headers()
  let current = byId.get(ownerId)
  if (current === undefined) return undefined
  for (let hop = 0; hop < 16; hop++) {
    const parent = current.parentSession
    if (parent === undefined || parent === null) return current.id
    const next = byId.get(parent)
    if (next === undefined) return parent
    current = next
  }
  return current.id
}

/**
 * The parent chain of `ownerId`, from the session ITSELF up to its durable root.
 *
 * Bounded to 16 hops, exactly like `rootOf`, whose answer is this chain's LAST element: the
 * two can never disagree about where a chain ends. The chain is what the live fallback walks,
 * and it is read from the headers for the reason `rootOf` is — the headers answered correctly
 * every time they were asked, while `ctx.agents.list()` returned `[]` at mount AND at
 * settlement in one measured process, and `subagents.listDescendants()` never sees a FORKED
 * session at all.
 *
 * A parent whose header is missing is CARRIED by its bare id (`{ id: parent }`) rather than
 * dropped: that unreadable link is precisely the one the live registry can still confirm, and
 * dropping it would abandon a live ancestor the store cannot describe.
 *
 * @returns the ids, caller first and root last; `[]` when the store does not know the owner.
 */
function chainOf(ownerId) {
  const byId = headers()
  let current = byId.get(ownerId)
  if (current === undefined) return []
  const chain = [current.id]
  for (let hop = 0; hop < 16; hop++) {
    const parent = current.parentSession
    if (parent === undefined || parent === null) return chain
    current = byId.get(parent) ?? { id: parent }
    chain.push(current.id)
  }
  return chain
}

/**
 * The line's LIVE agent registry, or undefined when the line did not receive one.
 *
 * `inject` declares `agents` (line 46), so a healthy mount always has it. A service that is
 * absent must DEGRADE, never fail: the resolution then keeps the durable headers alone,
 * journals the degradation, and delivers nothing rather than guessing at a live handle.
 */
function liveAgents(ctx) {
  const agents = ctx?.agents
  return agents !== null && typeof agents === 'object' && typeof agents.get === 'function'
    ? agents
    : undefined
}

export function apply(ctx) {
  const relayed = new Set()
  const wakes = new Map()
  const descCache = new Map()
  const state = { relays: 0, wakes: 0, last: 'aucun', skipped: 0, events: 0, decisions: [] }
  trace(state, { step: 'mounted', pid: process.pid })

  /**
   * Events already handled in this process, by object identity.
   *
   * More than one subscription legitimately sees the same event: the catch-all below,
   * the owner's own subscription, and — for unowned work, which `{ owner }` also
   * receives (`dsh-jobs/lib/types/types.d.ts:212-216`) — every subscription at once.
   * The registry hands the SAME object reference to each listener
   * (`dsh-jobs-local/lib/index.js:82-88`), so identity is the exact key: one event,
   * one decision, one record, whatever the subscription topology looks like.
   */
  const handled = new WeakSet()
  const onEvent = (event) => {
    if (event !== null && typeof event === 'object') {
      if (handled.has(event)) return
      handled.add(event)
    }
    // Every decision is recorded, including the ones that end in silence.
    //
    // A relay that does nothing is indistinguishable from a relay that was never
    // called, and this one silently delivered nothing through two torture
    // campaigns: the scenario designed to exercise it reported no notice, and
    // neither the counters nor the log said which branch had bailed. The file is
    // the only place that can answer "was I even asked?".
    if (event.type !== 'settled') {
      // Every decision is recorded; a raw echo is not a decision.
      //
      // Measured 2026-09-30: `output` was 341 171 records / 22 176 361 bytes of a
      // 585 840-record, 43 639 064-byte journal — 51 % of it, answering no question
      // the journal exists to answer, and the read cost that made the file a burden.
      // `progress` is the same echo. `registered`, `removed` and `stopping` keep
      // their records untouched: they are the evidence the teardown rule below cites.
      if (!NOISE_EVENT_TYPES.has(event.type)) {
        trace(state, { step: 'event', type: event.type, job: event.job?.id })
      }
      return
    }
    state.events++
    const job = event.job
    const ownerId = job.owner
    if (ownerId === undefined) return trace(state, { step: 'skip', why: 'unowned-job', job: job.id })
    if (relayed.has(job.id)) return trace(state, { step: 'skip', why: 'already-relayed', job: job.id })
    // A teardown is relayed, NOT skipped.
    //
    // The original reason to skip was that a teardown is shutdown noise. The live
    // registry says otherwise, measured on 2026-09-29:
    //   19:32:57 event registered job=pwsh-1   ← a one-shot worker starts a 60 s job
    //   19:33:00 event stopping   job=pwsh-1   ← the worker settles
    //   19:33:00 skip why=teardown job=pwsh-1  ← the job is destroyed with it
    //   19:33:00 event removed    job=pwsh-1
    // The 60-second job never ran 60 seconds, and the orchestrator — believing a
    // campaign was in flight — was told nothing. That is the most expensive silent
    // failure in this mode, and skipping it made this plugin useless in the very
    // case it was written for.
    const teardown = event.cause === 'teardown'
    // A kill is the third and last member of `JobSettleCause`
    // (`dsh-jobs/lib/types/types.d.ts`: `'producer' | 'kill' | 'teardown'`). It is
    // NOT the producer's own settlement — something outside the owner decided to
    // end the job — so it is notified for the same reason a teardown is: the owner
    // may never learn it from the registry's own delivery.
    const kill = event.cause === 'kill'
    // An awaited settlement needs no notice, and the registry says so itself.
    //
    // `awaited` is part of the settled event (`dsh-jobs/lib/types/types.d.ts:192-202`):
    // "a completion reporter treats an awaited settlement as already delivered and
    // reports only the unawaited ones", set by `dsh-jobs-local/lib/index.js:753`
    // (`waitResolvers.length > 0`). A worker that WAITS for its job — a verifier
    // sampling a file, a worker reading its own result — receives that result as its
    // own, and this notice is then a duplicate by construction.
    //
    // Measured 2026-09-29, with the rule missing: 135 notices relayed in total, seven
    // of them in three minutes from three workers, for `node --version`, `git status`
    // and `Get-ChildItem` — six `exit code: 0` diluting the one `exit code: 1`.
    //
    // Teardown is exempt: the owner is being disposed, so "already delivered" is not
    // a promise the registry can keep — and that notice is this plugin's reason to
    // exist.
    if (event.awaited === true && !teardown) return trace(state, { step: 'skip', why: 'awaited-by-owner', job: job.id })
    // A running owner is NOT skipped here, and the reason lives one level down in
    // `deliver`: whether a running owner duplicates the notice depends on the
    // CAUSE, and only there are both facts in hand. A `producer` settlement of a
    // RUNNING owner is a duplicate (the relay used to send it anyway, labelled
    // "treat this one as a duplicate" — see the gate in `deliver`); a `teardown`
    // or `kill` is not, because the owner is being disposed and "already
    // delivered" is not a promise the registry can keep. Handling it here by
    // ownerState alone would either resurrect the duplicate or lose the teardown
    // notice that is this plugin's reason to exist.
    //
    // The live state of the job's OWNER, measured when the registry can answer and 'absent'
    // when the line received no registry at all (the degradation path must not throw here).
    const owner = liveAgents(ctx)?.get(ownerId)
    const ownerState = owner === undefined ? 'absent' : owner.status
    trace(state, { step: 'settled', job: job.id, owner: short(ownerId), cause: event.cause ?? 'normal', ownerState })
    void deliver(job, ownerId, event.cause, ownerState, teardown, kill)
  }

  // ONE catch-all, plus one per distinct live agent — in the shape the registry filters on.
  //
  // The filter union is `{ owner: SessionId } | { owners: 'all' | 'scope' }`
  // (`dsh-jobs/lib/types/types.d.ts:211-222`), and `JobEventHub.emit` skips an unscoped
  // subscription only when it carries the SINGULAR key:
  // `if ("owner" in filter && ownerId !== void 0 && ownerId !== filter.owner) continue`
  // (`dsh-jobs-local/lib/index.js:75`). The plural `{ owners: { owner: id } }` used before
  // is not a member of that union, so the key `emit` tests was absent, nothing was ever
  // filtered, and every subscription heard every event: measured 2026-09-30, the process
  // mounted at 22:36 posed 82 subscriptions and job pwsh-1808 wrote 82 identical `skip`
  // records.
  //
  // The catch-all is KEPT, and it is the load-bearing one: `ctx.agents.list()` returned
  // `[]` at mount in a MEASURED process while three agents were alive, so a per-owner
  // subscription can never be the only path to a settlement — dropping the catch-all
  // would trade a volume drop for lost notices. `{ owners: 'all' }` delivers everything
  // (`types.d.ts:216`); the per-owner subscriptions are the narrowing the registry
  // honours today, so a settlement is still seen if 'all' is ever narrowed.
  const disposers = []
  const subscribedOwners = new Set()
  const subscribeOwner = (ownerId) => {
    // One subscription per id, however often that id is announced: `agent/created`
    // fires again for a session already subscribed at mount.
    if (subscribedOwners.has(ownerId)) return
    subscribedOwners.add(ownerId)
    try {
      disposers.push(ctx.jobs.events.subscribe({ owner: ownerId }, onEvent))
      trace(state, { step: 'subscribed', filter: `owner=${short(ownerId)}` })
    } catch (error) {
      subscribedOwners.delete(ownerId)
      trace(state, { step: 'subscribe-failed', filter: `owner=${short(ownerId)}`, error: String(error?.message ?? error) })
    }
  }
  try {
    disposers.push(ctx.jobs.events.subscribe({ owners: 'all' }, onEvent))
    trace(state, { step: 'subscribed', filter: 'all' })
  } catch (error) {
    trace(state, { step: 'subscribe-failed', filter: 'all', error: String(error?.message ?? error) })
  }
  for (const agent of liveAgents(ctx)?.list() ?? []) {
    const id = agent.session?.id
    if (typeof id === 'string') subscribeOwner(id)
  }
  ctx.on('agent/created', (payload) => {
    // The payload is `{ agent, source, signal }`, NOT the agent.
    //
    // Documented at dsh-tool-cordis/lib/types/api-catalog.js:3642 as
    // `'agent/created'(this: Scoped<Agent>, payload: { agent: Agent; source; signal? })`.
    // Reading `session` off the envelope gave `undefined`, the guard below then
    // rejected every event, and no per-agent subscription was ever registered —
    // visible in the relay's own decision log as three `agent-created` lines with
    // `id: "undefined"`. The payload keys are now logged, so a future shape change
    // is self-diagnosing instead of silent.
    const agent = payload?.agent ?? payload
    const id = agent?.session?.id
    trace(state, { step: 'agent-created', id: short(id), keys: Object.keys(payload ?? {}).join(',') })
    if (typeof id === 'string') subscribeOwner(id)
  })
  if (typeof ctx.effect === 'function') ctx.effect(() => () => { for (const dispose of disposers) dispose() })

  /** Resolve the live root a job's owner descends from, then notify it. */
  async function deliver(job, ownerId, cause, ownerState, teardown = false, kill = false) {
    // `inject` no longer declares `subagents`: the resolution reads durable
    // headers, so a missing service must not short-circuit the relay. An earlier
    // version bailed here, which would have defeated the fix before it ran.
    // Resolution by DURABLE HEADERS, not by live-agent enumeration.
    //
    // Every live-source attempt failed in a different way, each measured:
    //   - `ctx.agents.list()` returned `[]` at mount and at settlement while two
    //     agents had been announced alive, and returned three in another process;
    //   - `agent/created` never fires for an Agent that pre-existed this mount, so
    //     the root session is invisible to it — precisely the session that needs
    //     the notice;
    //   - `subagents.listDescendants()` walks the delegated-child catalog only, so
    //     a FORKED session (`origin` unset, depth 0, but with a `parentSession`)
    //     is invisible: owner `94e2b3a0` carries `parentSession = 517ee069` and the
    //     lookup still reported no descendant.
    // The session header answered correctly every single time, so the parent chain
    // is walked there. The live handle is then fetched by id, which does work.
    //
    // The headers are step 1 below and stay the PATH; the live registry is step 3 and only
    // ARBITRATES a root the headers returned but that is no longer alive. A device that walked
    // the durable chain all the way to a DEAD session addressed its notices to an agent that no
    // longer existed — the shape of a session CONTINUED after a restart, whose parent (the
    // previous process's session) can never come back.
    // Step 1 — the DURABLE HEADERS resolve the root. Unchanged, and still the path.
    const headerRoot = rootOf(ownerId)
    const agents = liveAgents(ctx)
    const liveCount = agents === undefined ? 0 : agents.list().length
    trace(state, {
      step: 'resolve',
      job: job.id,
      owner: short(ownerId),
      ownerState,
      rootId: headerRoot === undefined ? null : short(headerRoot),
      liveCount,
      durable: headerRoot !== undefined,
    })
    if (headerRoot === undefined) {
      state.skipped++
      return trace(state, { step: 'bail', why: 'owner-absent-from-session-store', job: job.id, owner: short(ownerId) })
    }
    if (agents === undefined) {
      // Degraded, and JOURNALLED as such: with no live registry the root cannot be confirmed,
      // so step 3 runs on the headers alone and no handle can be fetched at all. The relay says
      // so rather than letting the degradation pass for a normal resolution.
      trace(state, { step: 'degrade', why: 'agents-service-absent', job: job.id, owner: short(ownerId) })
    }
    // Step 2 — the agent of that root is CONFIRMED LIVE: the owner IS that root. Unchanged, and
    // the only path a healthy tree ever takes.
    let ownerRootId = headerRoot
    let fallback = false
    let root = agents === undefined ? undefined : agents.get(headerRoot)
    if (root === undefined) {
      // Step 3 — the root the headers returned is GONE. That is the shape of a session
      // CONTINUED after a restart: a seeded fork (`isSeeded: true`, `delegationDepth: 0`) whose
      // parent is the session of the previous process, which will never come back. Resolution
      // by headers alone then addresses the notice to a dead session, and the live parent — the
      // only agent that can act on the output — is told nothing.
      //
      // The owner becomes the HIGHEST LIVE ANCESTOR of the chain, or this owner itself when
      // nothing above it is alive. The live registry ARBITRATES that choice; it never resolves
      // the chain, and it is asked PER CHAIN ID (`agents.get`) rather than through
      // `agents.list()`, which returned `[]` at mount AND at settlement in one measured
      // process while a lookup by id did work.
      fallback = true
      const chain = chainOf(ownerId)
      // Highest first: the chain is caller-first, so the last live element is the closest to
      // the root — which is the session that owns the tree.
      for (let index = chain.length - 1; index >= 0; index--) {
        const candidate = agents === undefined ? undefined : agents.get(chain[index])
        if (candidate === undefined) continue
        ownerRootId = chain[index]
        root = candidate
        break
      }
      // Nothing on the chain answers: the rule keeps the owner itself. `liveOwner` below is then
      // the id RETAINED, not a liveness measurement, and the bail underneath says why nothing was
      // delivered — the record never claims more than was measured.
      if (root === undefined) ownerRootId = ownerId
      trace(state, {
        step: 'owner-fallback',
        job: job.id,
        owner: short(ownerId),
        headerRoot: short(headerRoot),
        liveOwner: short(ownerRootId),
      })
    }
    if (root === undefined) {
      state.skipped++
      return trace(state, {
        step: 'bail',
        why: agents === undefined ? 'agents-service-absent' : 'no-live-handle-for-owner',
        job: job.id,
        root: short(ownerRootId),
        liveCount,
      })
    }
    // The fence covers a LIVE durable root only: that root started the job itself and receives
    // the settlement natively, so relaying it back would be a duplicate. A fallback owner is NOT
    // that case — it is the highest live ancestor of a chain whose root is dead, and it is the
    // only agent that will ever learn what the job produced.
    if (!fallback && ownerRootId === ownerId) {
      state.skipped++
      return trace(state, { step: 'bail', why: 'owner-is-the-root', job: job.id, root: short(ownerRootId) })
    }
    // B — a `producer` settlement whose owner is ALIVE is a duplicate, and is
    // abstained on here exactly as `owner-is-the-root` above abstains.
    //
    // Same redundancy, second case: `owner-is-the-root` says "the owner started
    // this job and receives it natively, so do not send it back"; a running owner
    // is the same situation one level down — it receives its own settlement
    // natively at its next step. That is precisely why the text below already
    // calls itself a duplicate, and measured 2026-10-03 the relay sent it anyway:
    // 53 notices relayed in two days, 52 of them `producer`, and 100 % of those
    // carried `ownerState: running`. Action rate 6/52 = 11.5 %, one of the six
    // reads refused ("job ... belongs to another session"). This is the existing
    // doctrine, extended — not a new policy.
    //
    // What is NOT a duplicate, and is still NOTIFIED: cause `teardown` (the job
    // died with its worker — the expensive case this plugin exists for) and cause
    // `kill` (a decision taken elsewhere); and any settlement whose owner is
    // ABSENT from the live registry, because then no other agent can carry the
    // notice at all.
    //
    // "Alive" is narrowed to `running`, which is the only state the measurement
    // ever observed here: of the 52 relayed `producer` notices, 100 % carried
    // `ownerState: running`. An `idle` owner is alive but between turns, and
    // abstaining on it was MEASURED to destroy the notices this plugin exists for:
    // the live `pwsh-1` of 2026-10-02 was relayed to `7fa9e670`, whose status was
    // `idle`, so a wider gate swallowed it. Running is the state in which the
    // owner is provably about to receive its own settlement.
    //
    // The cost is assumed and written down, not hidden: 4 useful reads out of 52
    // (8 %) disappear with this rule and the measurement says nothing about
    // whether they mattered.
    //
    // The abstention is JOURNALLED like every other decision. A silence without a
    // motive is indistinguishable from a breakdown.
    if (cause === 'producer' && !kill && ownerState === 'running') {
      state.skipped++
      return trace(state, {
        step: 'bail',
        why: 'owner-already-notified',
        job: job.id,
        owner: short(ownerId),
        ownerState,
        root: short(ownerRootId),
      })
    }
    {
      const entry = headers().get(ownerId)
      // Is the session receiving this notice the job's OWNER? Only the fallback can
      // answer no, and the text below branches on it (see `notice`).
      const ownerIsRecipient = ownerRootId === ownerId
      relayed.add(job.id)
      const message = createUserMessage({
        content: [{ type: 'text', text: notice(job, entry, cause, ownerState, teardown, ownerIsRecipient) }],
        source: { kind: 'tool-jobs', form: 'notice', summary: `relay ${job.id}` },
      })
      const spent = wakes.get(ownerRootId) ?? 0
      if (root.status === 'idle' && spent < MAX_WAKES_PER_ROOT) {
        wakes.set(ownerRootId, spent + 1)
        state.wakes++
        root.followup(message)
        state.last = `${job.id} → réveil de ${short(ownerRootId)}`
      } else {
        root.inject(message)
        state.last = `${job.id} → injection dans ${short(ownerRootId)}`
      }
      state.relays++
      // `recipientIsOwner` is journalled with the delivery: a false value here is the
      // only way the fallback's text differs, and a journal that hid it could not be
      // interrogated when a notice turns out to have misnamed its audience.
      trace(state, { step: 'relayed', job: job.id, owner: short(ownerId), root: short(ownerRootId), recipientIsOwner: ownerIsRecipient, via: root.status === 'idle' ? 'wake' : 'inject' })
      return
    }
  }

  /**
   * The descendant row for `ownerId` under `rootId`, or undefined.
   *
   * A catalog read per settled job per live root is not free: `listDescendants`
   * reads the durable child catalog of every reachable branch, so a 12-child tree
   * costs 12 reads. A settled batch would multiply that, hence the short cache —
   * short enough that a newly created child is still found, long enough that a
   * burst of settlements reuses one read.
   */
  async function descendantEntry(subagents, rootId, ownerId) {
    const lookup = async () => {
      let rows
      try {
        rows = await subagents.listDescendants(rootId)
      } catch {
        return undefined
      }
      return new Map(rows.filter((row) => row.kind === 'child').map((row) => [row.id, row]))
    }
    const cached = descCache.get(rootId)
    if (cached !== undefined && Date.now() - cached.at <= DESC_TTL_MS) {
      const hit = cached.byId.get(ownerId)
      if (hit !== undefined) return hit
    }
    const byId = await lookup()
    if (byId === undefined) return undefined
    if (descCache.size > 8) descCache.clear()
    descCache.set(rootId, { at: Date.now(), byId })
    return byId.get(ownerId)
  }

  /**
   * The notice text. It branches on TWO facts, and the second one is identity.
   *
   * `ownerState` is the state of the job's OWNER. `ownerIsRecipient` says whether
   * the session reading this text IS that owner. When the `owner-fallback` above
   * elected a higher live ancestor, it did not — and the text that ignored this
   * asserted two things that were false, measured on 2026-10-03 for `pwsh-238`
   * (owner `949882e3`, relayed to `7fa9e670`):
   *   - "it receives this notice itself, so treat this one as a duplicate": the
   *     recipient is not the owner, so it receives nothing of the kind;
   *   - "Read its output with `job_output`": MEASURED impossible from there —
   *     `job_output(pwsh-238)` answers "job pwsh-238 belongs to another session",
   *     because the job is fenced to the owner's session id.
   * A notice that promises an impossible read is worse than no notice: it sends
   * the agent straight into a failure. The owner is therefore NAMED, `job_output`
   * is not promised, and nothing calls the notice a duplicate.
   *
   * @param ownerIsRecipient - true when the session this notice is delivered to IS
   *   `entry.id`, the job's owner — the case where the original text stands unchanged.
   */
  function notice(job, entry, cause, ownerState, teardown = false, ownerIsRecipient = true) {
    const label = entry.label === undefined ? '' : ` (« ${entry.label} »)`
    const detail = job.detail ?? job.progress
    const who = `subagent ${short(entry.id)}${label}`
    // Unchanged whenever the recipient IS the owner, and only then.
    // The opening clause of the closing sentence. Identity, not state, decides it:
    // 'That job belongs to the subagent' is what a recipient that IS the owner reads,
    // and the original text stands unchanged in that case.
    const own = ownerIsRecipient
      ? 'That job belongs to the subagent'
      // Naming the owner is the whole point; the second sentence states only what is
      // measured — this session is live and is not the owner. The owner is not always
      // OFF that chain (it can be running above the chosen link), so nothing is claimed
      // about where it is.
      : `That job belongs to ${who} — and you are not that session. This notice reached you as the live session the fallback elected to carry it.`
    if (teardown) {
      // The expensive case, and the reason this plugin exists.
      return `[boost-relay] Background job ${job.id} (${job.kind}${job.label === '' ? '' : `: ${job.label}`}) started inside ${who} was **terminated when that subagent settled** — a background job dies with a one-shot worker. It did not run to completion, no result will ever arrive, and anything you were waiting for is not happening.\n`
        + (ownerIsRecipient
          ? 'This costs a whole campaign when it goes unnoticed. Two remedies: start a long job from THIS session (`run_in_background: true` here), where it survives the worker; or have the worker wait for its job instead of returning. Do not delegate a long job to a worker and let it go.'
          // The remedies are the owner's: neither session can read this job's output,
          // and the one above it can only re-delegate.
          : `${own} \`job_output\` is not available from here — it is fenced to the owner's session. What you can do is find out what that job was worth: \`send_message\` to ${who} when it is a continuable one, or re-delegate the work with this fact in the brief.`)
    }
    const base = `[boost-relay] Background job ${job.id} (${job.kind}${job.label === '' ? '' : `: ${job.label}`}) launched inside ${who} finished [status: ${job.status}${cause === undefined ? '' : `, ${cause}`}]${detail === undefined ? '' : ` — ${detail}`}.\n`
      // What the owner was doing is MEASURED — `ownerState` comes from the registry's
      // view of the live agent — and it decides the sentence. The previous text
      // asserted "the subagent had already returned when it settled" unconditionally,
      // while the caller held the measurement that could contradict it. Refuted live
      // on 2026-09-29: a notice claimed the verifier had returned, and `list_agents`
      // showed it running, waiting on the very job being announced.
      + (ownerState === 'running'
        ? `${own}, which was still RUNNING when the job settled`
        : `${own}, which is no longer running`)
    // The closing advice branches on the SAME identity. "it receives this notice
    // itself" and the duplicate warning are FALSE for a fallback recipient — only the
    // owner receives the notice the registry delivers — and `job_output` is not
    // offered there, because MEASURED it answers "job … belongs to another session".
    const advice = ownerIsRecipient
      ? (ownerState === 'running'
        // Teardown returned above, so this line is only ever read by the running owner.
        // The gate in `deliver` normally abstains before reaching here: this text is the
        // shape the notice had, kept for the paths the gate does not cover.
        ? ' — it receives this notice itself, so treat this one as a duplicate unless its report predates the job. If the result matters: `send_message` to that subagent (when it is a continuable one) or re-delegate the check with this output in the brief.'
        : ' — so its report predates this output. If the result matters: `send_message` to that subagent (when it is a continuable one) or re-delegate the check with this output in the brief.')
      : ' — so its report predates this output, if it ever wrote one. That output is not readable from here, and this is not a duplicate of anything you received: `send_message` to that subagent when it is a continuable one, or re-delegate the check with the job name in the brief.'
    return base + advice
  }

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'boost-relay',
      description: 'État du relais de settlements de jobs des sous-agents',
      handler: () => ({
        kind: 'success',
        text: [
          'Relais de jobs boost',
          `dépendance résolue  : oui — ${llmEntry}`,
          `relais effectués     : ${state.relays} (dont ${state.wakes} réveils)`,
          `settlements ignorés  : ${state.skipped}`,
          `événements de job vus: ${state.events}`,
          `journal des décisions: ${LOG_FILE}`,
          '',
          'dernières décisions :',
          ...(state.decisions.length === 0 ? ['  (aucune)'] : state.decisions.slice(-6).map((line) => `  ${line}`)),
          `jobs déjà relayés    : ${relayed.size}`,
          `dernier              : ${state.last}`,
        ].join('\n'),
      }),
    })
  })
}

function short(id) {
  return typeof id === 'string' ? id.replace(/^session-/, '').slice(0, 8) : String(id)
}
