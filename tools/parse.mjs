/**
 * Pure parsing helpers shared by the trace tooling.
 *
 * These live in one module for two reasons. First, they are the parts that have
 * actually been wrong: a nested call id read at the wrong level, a role-substring
 * count that invented generic delegations, a final-text extractor that returned
 * reasoning. Second, they are pure, so they can be tested without a session log
 * — see tools/tests.test.mjs.
 */

/**
 * Role tools a boost orchestrator can call, longest name first so a prefix never
 * shadows a longer sibling during any naive scan.
 */
export const ROLE_TOOLS = [
  'subagent_investigate',
  'subagent_implement',
  'subagent_verify',
  'subagent_fork',
  'subagent',
  'workflow',
  'ralph',
]

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_RE = new RegExp(UUID_SOURCE, 'i')

/**
 * The call id of a `tool/result` record.
 *
 * The record nests the tool message, and `toolCallId` lives on that message —
 * reading it from the root of `data` silently matches nothing, which is how a
 * first version of the report showed zero delegations on a run that had two.
 * @param result - one `tool/result` record.
 * @returns the call id, or undefined when the record carries none.
 */
export function callIdOf(result) {
  return result?.data?.message?.toolCallId ?? result?.data?.toolCallId
}

/**
 * Flatten a content-block array to text.
 * @param content - block array, or a bare string.
 * @param options.onlyText - keep only `type: 'text'` blocks. Required whenever
 * the result is presented as what a session *said*: an assistant message also
 * carries `reasoning` blocks, and collecting those turns an answer into internal
 * monologue.
 * @returns newline-joined text.
 */
export function blocksToText(content, options = {}) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => (options.onlyText === true ? block?.type === 'text' : true))
    .map((block) => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}

/**
 * Cheap fingerprint of the composition that produced a system prompt.
 *
 * Independent of the session header, which goes stale when the preset is
 * switched while the session is still blank, and of the tool surface, which PTC
 * collapses to `run_code` alone.
 * @param text - accumulated system-message text.
 * @returns the markers found, in a stable order.
 */
export function markersOf(text) {
  const out = []
  if (typeof text !== 'string' || text === '') return out
  if (text.includes('boost orchestrator')) out.push('boost orchestrator')
  if (text.includes('Programmatic Tool Calling')) out.push('Programmatic Tool Calling')
  if (text.includes('cordis-plugin-development')) out.push('skills:cordis')
  if (text.includes('helpful software engineer assistant')) out.push('persona:minimal')
  if (text.includes('You are a coding agent')) out.push('persona:standard-like')
  if (text.includes('complete: ')) out.push('persona:complete')
  if (text.includes('blockedBy') || text.includes('spawn_teammate')) out.push('agent-teams')
  return out
}

/**
 * Count role-tool calls inside a PTC program.
 *
 * A plain substring count is wrong: `subagent` is a prefix of
 * `subagent_investigate`, `subagent_implement`, `subagent_verify` and
 * `subagent_fork`, so a program calling two investigators and one implementer
 * reported three *generic* delegations as well — which is what a first version
 * of the report printed, and what a check then reasoned on.
 * @param code - the program source.
 * @param roles - role tool names to count.
 * @returns a map of role name to occurrence count, omitting zeros.
 */
export function countRoleMentions(code, roles = ROLE_TOOLS) {
  const mentions = {}
  if (typeof code !== 'string' || code === '') return mentions
  for (const role of roles) {
    const count = (code.match(new RegExp(`${role}(?![A-Za-z0-9_])`, 'g')) ?? []).length
    if (count > 0) mentions[role] = count
  }
  return mentions
}

/**
 * Parse the subagent runtime's settlement notice.
 *
 * The notice PUSHES the child's report: `Background subagent <id> finished and
 * will do no further work unless you send it more. Its closing message: …`.
 * Nothing has to be collected with `job_output`, and a tool that compared a
 * child's *last* assistant message against the parent log instead concluded,
 * wrongly, that nine reports never arrived.
 * @param text - message text.
 * @returns the child id and whether the notice carries a closing message.
 */
export function parseSubagentNotice(text) {
  if (typeof text !== 'string') return undefined
  const match = new RegExp(`Background subagent (${UUID_SOURCE}) finished`).exec(text)
  if (match === null) return undefined
  return { childId: match[1], carriesClosing: text.includes('Its closing message:') }
}

/**
 * Parse the job registry's settlement notice.
 * @param text - message text.
 * @returns the job id and kind, or undefined.
 */
export function parseJobNotice(text) {
  if (typeof text !== 'string') return undefined
  const match = /background job ([\w-]+) \(([\w-]+)/.exec(text)
  if (match === null) return undefined
  return { id: match[1], kind: match[2] }
}

/** First UUID in a text, for correlating a delegation result with its child. */
export function firstUuid(text) {
  if (typeof text !== 'string') return undefined
  return UUID_RE.exec(text)?.[0]
}

/** Short, stable display form of a session id. */
export function shortId(id) {
  return typeof id === 'string' ? id.replace(/^session-/, '').slice(0, 8) : String(id)
}

/**
 * Runtime failure phrases, tight enough that a program merely *reporting* an
 * error is unlikely to match. Deliberately narrow: this pattern decides whether
 * a `run_code` result that exited cleanly still buried a failure.
 */
const BURIED_FAILURE = /code run failed \((?:timeout|exception|worker-exit|abort|invalid-output|output-limit)\)|ToolCallError:|exceeds maxDepth \d+|execution deadline reached \(\d+ms\)|has not been read — read the file/

/**
 * Every failure in one session's records, whichever shape it took.
 *
 * Three shapes exist, and a collector that reads only the first reports a run as
 * far healthier than it was. This was written after a torture run exposed the
 * blind spot: three of its scenarios were scored "not triggered" while the agent
 * had reproduced them exactly as documented.
 *
 *  1. `flagged-result` — a `tool/result` the runtime marked failed.
 *  2. `ptc-dispatch` — a failed `tool/ptc-dispatch`. The PTC runtime reports a
 *     dispatch fault on its own record type, which never surfaces as a result.
 *  3. `buried` — failure text inside an UNMARKED `run_code` result: a program
 *     that catches its inner error, prints it and returns normally exits 0, so
 *     the outer call is a success carrying a failure.
 *
 * @param records - one session's records.
 * @returns one entry per failure, with its shape, for confidence assessment.
 */
export function collectFailures(records) {
  const names = new Map()
  for (const record of records) if (record.type === 'tool/call') names.set(record.data.callId, record.data.name)
  const out = []
  for (const record of records) {
    const flagged = record.data?.error !== undefined || record.data?.message?.isError === true
    const text = blocksToText(record.data?.message?.content)
    const detail = text !== '' ? text : JSON.stringify(record.data?.error ?? record.data ?? {})
    if (record.type === 'tool/result' && flagged) {
      out.push({ shape: 'flagged-result', tool: names.get(callIdOf(record)) ?? '?', text: detail, time: record.time })
      continue
    }
    if (record.type === 'tool/ptc-dispatch' && flagged) {
      out.push({ shape: 'ptc-dispatch', tool: record.data?.name ?? '?', text: detail, time: record.time })
      continue
    }
    if (record.type === 'tool/result' && !flagged && names.get(callIdOf(record)) === 'run_code' && BURIED_FAILURE.test(text)) {
      out.push({ shape: 'buried', tool: 'run_code', text, time: record.time })
    }
  }
  return out
}

/** Compact token count: 1234 → 1.2k, 1234567 → 1.23M. */
export function fmtCount(n) {  const value = Number(n ?? 0)
  if (!Number.isFinite(value)) return '?'
  if (Math.abs(value) < 1000) return String(value)
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

/** Human duration from a millisecond delta. */
export function fmtDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '?'
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

/** Non-negative difference of two optional timestamps. */
export function diffMs(a, b) {
  return typeof a === 'number' && typeof b === 'number' ? Math.max(0, b - a) : undefined
}
