/**
 * Guard against unpaired UTF-16 surrogates in a tool result.
 *
 * One lone surrogate inside a tool result poisons every FOLLOWING request: the
 * provider answers HTTP 400 INVALID_REQUEST, the broken text stays in the
 * reconstructed history, and the session never recovers. Measured on 2026-09-30:
 * of the 182 session logs present at that moment (the corpus reached 188 by the
 * end of that evening), 3 held a lone surrogate, and all 3 sessions died;
 * 0 counter-examples.
 *
 * The anchor is the tools/post-execute waterfall
 * (dsh-tools/lib/types/index.d.ts:70):
 *
 *   (exec, result, next) => Promise<PostToolDecision>
 *
 * It is UPSTREAM of the session log: dsh-agent-loop/lib/index.js:570-571 runs
 * await finalize(...) and only then appendToolResult(...). A listener that
 * returns an accept decision carrying replacement content therefore replaces
 * the logged copy as a first-class outcome (dsh-tools/lib/index.js:3527-3531),
 * with no redispatch and no replay. The log and deriveMessages() then carry the
 * repaired text, so the request-reconstruction invariant
 * (dsh-agent-loop/lib/invariant.js:26-27) is SATISFIED rather than neutralised.
 *
 * This listener never short-circuits: it always awaits next() first and repairs
 * the decision that comes back, exactly like dsh-spill-policy
 * (dsh-spill-policy/lib/index.js:237-255), whose ordering with the rest of the
 * chain is the measured precedent.
 *
 * Both decision kinds that carry model-facing text are covered: an accept
 * decision (its content) and a block decision (its feedback). A poisoned
 * feedback produced by another listener reaches the log by the same path as a
 * poisoned tool result, so it is repaired by the same walker and journalled the
 * same way.
 *
 * A throwing listener is contained upstream: finalizeScheduledExecution
 * (dsh-tools/lib/index.js:3359-3372) turns it into an error result, so this
 * guard cannot kill the session even when everything goes wrong.
 *
 * @module @local/dsh-guard-surrogate
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { repairContent, textLength } from './walker.js'

/** Cordis companion plugin name. */
const name = 'guard-surrogate'

/**
 * The standard global install of the harness, as a resolvable anchor.
 *
 * The three anchors above are all runtime facts: they exist when the row is
 * loaded by a running harness, a profile, or a checkout. A plain test process -
 * and any process that drops DSH_PROFILE_DIR - has none of them, which used to
 * degrade the switch silently. The global npm prefix is the one location a
 * harness installation always occupies on this platform, so it is the fallback
 * of last resort, used only when the directory actually exists.
 *
 * @returns the harness package.json path, or undefined when there is no global
 *   install at the standard location.
 */
function globalInstallAnchor() {
  const appData = typeof process.env.APPDATA === 'string' && process.env.APPDATA !== ''
    ? process.env.APPDATA
    : join(homedir(), 'AppData', 'Roaming')
  const prefix = join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh')
  return existsSync(prefix) ? join(prefix, 'package.json') : undefined
}

/**
 * Resolve a Harness package from the running installation.
 *
 * A profile-linked bundle lives outside the profile's and the installation's
 * node_modules, so a bare specifier fails with ERR_MODULE_NOT_FOUND - the same
 * measured constraint dsh-boost-relay documents for @deepseek-ai/dsh-llm.
 * process.argv[1] is the harness entry point and is the anchor that resolves;
 * the profile directory and the working directory follow, and the standard
 * global install closes the list.
 *
 * @param specifier - the package to resolve.
 * @returns the resolved entry path, or undefined when no anchor resolves it.
 */
export function resolveHarnessModule(specifier) {
  const anchors = []
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') anchors.push(process.argv[1])
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') anchors.push(join(process.env.DSH_PROFILE_DIR, 'package.json'))
  anchors.push(join(process.cwd(), 'package.json'))
  const globalAnchor = globalInstallAnchor()
  if (globalAnchor !== undefined) anchors.push(globalAnchor)
  for (const anchor of anchors) {
    try {
      return createRequire(anchor).resolve(specifier)
    } catch {
      // Anchor outside the installation: try the next one.
    }
  }
  return undefined
}

/**
 * Schemastery, when the running installation exposes it.
 *
 * Without it the row still mounts and still repairs; only the switch loses its
 * volatile (hot) update and needs a restart, which is a documented degradation
 * rather than a dead guard.
 */
const schemastery = (() => {
  const entry = resolveHarnessModule('@deepseek-ai/schemastery')
  if (entry === undefined) return undefined
  try {
    const loaded = createRequire(entry)(entry)
    return loaded?.default ?? loaded
  } catch {
    return undefined
  }
})()

/** Runtime schema for the row config; enabled is volatile so it toggles hot. */
export const Config = schemastery === undefined ? undefined : schemastery.object({
  enabled: schemastery.boolean().default(true).volatile(),
})

/** Whether the schema resolved from the running installation. */
export const schemaResolved = schemastery !== undefined

/**
 * Read the live enabled switch.
 *
 * A volatile schemastery field parses to a stable reference, not to a boolean,
 * so the value is read through get() at every call; a plain config object (no
 * schema resolved) reads directly.
 *
 * @param config - the plugin config captured at mount.
 * @returns whether the guard is armed.
 */
export function isEnabled(config) {
  const value = config?.enabled
  if (value === null || typeof value !== 'object') return value !== false
  if (typeof value.get === 'function') return value.get() !== false
  return value.value !== false
}

/**
 * Root of the harness home; read at each write so a test can redirect it.
 * @returns the harness home directory.
 */
function dshHome() {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
}

/**
 * Path of the repair journal.
 * @returns the journal path.
 */
export function journalPath() {
  return join(dshHome(), 'plugin-data', name, 'repairs.jsonl')
}

/**
 * Append one counter-only line per REAL repair.
 *
 * Never throws: a read-only profile, a full disk, or a redirect that is a file
 * must not fail a call the guard exists to save. No message text is ever
 * recorded: the journal is meant to be readable next to a session log without
 * copying any of it.
 *
 * @param exec - the executed call, read only for its tool name.
 * @param before - total code-unit length of the text blocks before the repair.
 * @param after - total code-unit length after the repair.
 * @param repaired - halves replaced and blocks rebuilt.
 */
function trace(exec, before, after, repaired) {
  try {
    const path = journalPath()
    mkdirSync(join(path, '..'), { recursive: true })
    appendFileSync(path, JSON.stringify({
      at: new Date().toISOString(),
      tool: typeof exec?.name === 'string' ? exec.name : null,
      repaired: repaired.replaced,
      blocks: repaired.blocks,
      before,
      after,
    }) + String.fromCharCode(10))
  } catch {
    // Deliberately silent: the journal is a diagnostic, never a precondition.
  }
}

/**
 * Mount the guard.
 *
 * @param ctx - the cordis context of the row.
 * @param config - parsed plugin config; enabled: false disarms the guard.
 */
export function apply(ctx, config = {}) {
  if (!schemaResolved) {
    // Visible, not silent: without Schemastery the switch still works but is
    // read from the raw config, so toggling it needs a restart.
    ctx.logger?.warn('guard-surrogate: @deepseek-ai/schemastery did not resolve from the running installation; the row mounts and repairs, but its enabled switch is not volatile (a change needs a restart)')
  }
  ctx.on('tools/post-execute', async (exec, result, next) => {
    // Ordered first, always, and never short-circuited: the decision this chain
    // produces is the input of the repair, not a substitute for it.
    const decision = await next()
    try {
      if (!isEnabled(config)) return decision
      if (decision === null || typeof decision !== 'object') return decision
      if (decision.kind !== 'accept' && decision.kind !== 'block') return decision
      // A value re-renders the result and the content is ignored upstream
      // (dsh-tools/lib/index.js:3517-3525), so there is nothing to repair.
      if (decision.kind === 'accept' && Object.hasOwn(decision, 'value')) return decision
      // accept carries model-facing content, block carries the corrective
      // feedback the loop turns into an error result (dsh-tools/lib/index.js:3506-3513).
      // Both end up in the session log, so both are repaired.
      const content = decision.kind === 'block' ? decision.feedback : decision.content ?? result?.content
      if (!Array.isArray(content)) return decision
      const repaired = repairContent(content)
      if (!repaired.changed) return decision
      trace(exec, textLength(content), textLength(repaired.content), repaired)
      return decision.kind === 'block'
        ? { ...decision, kind: 'block', feedback: repaired.content }
        : { ...decision, kind: 'accept', content: repaired.content }
    } catch {
      // Inert on any unexpected shape: the ORIGINAL decision is returned
      // untouched. A blocked result is worse than a missed repair.
      return decision
    }
  }, { prepend: true })
}

export { name }
