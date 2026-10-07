/**
 * Shield Quorum sessions from Agent Teams usurpation.
 *
 * Why this exists:
 * `@deepseek-ai/dsh-experimental-agent-team` declares every root session to be a
 * Team Lead (`tryMembership()` returns `{ role: 'lead' }` for any session lacking
 * a subagent descriptor, `dsh-experimental-agent-team/lib/index.js:420-426`).
 * `@deepseek-ai/dsh-experimental-tool-agent-team` then hooks `agent/created` at
 * the Host level and registers nine tools into `agent.ctx`, including
 * `send_message`, `list_agents`, and `interrupt_agent`.
 *
 * In a Quorum root session, those scoped registrations shadow the preset's
 * `tool-subagent-control` tools with incompatible signatures (`target: name` vs
 * `agent_id: uuid`), breaking the Quorum orchestrator's ability to communicate
 * with its role workers.
 *
 * This shield intercepts `ctx.agentTeams` when present:
 * 1. It wraps `tryMembership()` on both `ctx.agentTeams` and its internal `roster`
 *    so any agent running a `quorum-*` or legacy `boost` preset returns `undefined`.
 *    This prevents `tool-agent-team` from installing ANY of its nine tools on Quorum agents,
 *    leaving Quorum's `tool-subagent-control` unmasked.
 * 2. It preserves normal Agent Teams behavior for all non-Quorum sessions.
 * 3. On `agent/created`, if any `spawn_teammate` or `team_task_*` tools exist in the
 *    agent's view, it restricts them from Quorum agents as a second-line defense.
 * 4. If Agent Teams is not present in the runtime, this module is completely inert.
 *
 * @module @local/dsh-guard-surrogate/agent-teams-shield
 */

/**
 * Determine whether an Agent belongs to the Quorum preset family.
 *
 * Checks three Seams in order:
 * 1. Durable session header `agentPreset` (creation fact)
 * 2. `sessionProjections` state of `agentPreset` (for resumed or migrated sessions)
 * 3. `agentPresets` service bound preset (live Cordis composition)
 *
 * @param {object} agent - candidate live Agent
 * @param {object} ctx - Host or scoped context
 * @returns {boolean} true if the agent is running a Quorum or legacy Boost preset
 */
export function isQuorumAgent(agent, ctx) {
  if (!agent) return false
  try {
    const headerPreset = agent.session?.header?.agentPreset
    if (typeof headerPreset === 'string' && (headerPreset.startsWith('quorum-') || headerPreset === 'boost')) {
      return true
    }
    const session = agent.session
    if (session && ctx?.sessionProjections && typeof ctx.sessionProjections.stateOf === 'function') {
      const projected = ctx.sessionProjections.stateOf(session, 'agentPreset')
      if (typeof projected === 'string' && (projected.startsWith('quorum-') || projected === 'boost')) {
        return true
      }
    }
    const agentCtx = agent.ctx
    if (agentCtx && ctx?.agentPresets && typeof ctx.agentPresets.composedPreset === 'function') {
      const composed = ctx.agentPresets.composedPreset(agentCtx)
      if (typeof composed === 'string' && (composed.startsWith('quorum-') || composed === 'boost')) {
        return true
      }
    }
  } catch {
    // Fail-safe: never throw from a membership probe
  }
  return false
}

/**
 * Intercept `agentTeams` if mounted in the host runtime, protecting Quorum agents.
 *
 * @param {object} ctx - Host Cordis context
 */
export function shieldAgentTeams(ctx) {
  if (typeof ctx?.inject !== 'function') return

  // Only fires when @deepseek-ai/dsh-experimental-agent-team is mounted
  ctx.inject(['agentTeams'], (teamCtx) => {
    const teams = teamCtx.agentTeams
    if (!teams) return

    function patchMethod(target, method) {
      if (!target || typeof target[method] !== 'function') return
      const original = target[method].bind(target)
      target[method] = function (agent) {
        if (isQuorumAgent(agent, teamCtx)) {
          return undefined
        }
        return original(agent)
      }
    }

    // Shield 1: Prevent tool-agent-team from installing tools on Quorum agents
    patchMethod(teams, 'tryMembership')
    if (teams.roster) {
      patchMethod(teams.roster, 'tryMembership')
    }

    // Shield 2: Second-line defense on agent/created — restrict any leaked team tools
    ctx.on('agent/created', ({ agent }) => {
      if (!isQuorumAgent(agent, ctx)) return
      try {
        const tools = ctx.tools
        if (!tools || typeof tools.restrict !== 'function' || !agent.ctx) return
        const view = tools.view?.(agent.ctx)
        const restrictable = view?.restrictableNames ?? new Set()
        const teamToolNames = [
          'spawn_teammate',
          'wait_agent',
          'team_task_create',
          'team_task_list',
          'team_task_get',
          'team_task_update',
        ]
        const toDeny = teamToolNames.filter((toolName) => restrictable.has(toolName))
        if (toDeny.length > 0) {
          agent.ctx.tools.restrict({ deny: toDeny })
        }
      } catch {
        // Safe: non-blocking
      }
    })
  })
}
