// Tests for the Agent Teams shield in guard-surrogate.
// Protects Quorum sessions from tool shadowing when @deepseek-ai/dsh-experimental-agent-team is mounted.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isQuorumAgent, shieldAgentTeams } from '../lib/agent-teams-shield.js'

function makeAgent(id, headerPreset, opts = {}) {
  const scopeKey = Symbol(id)
  return {
    id,
    session: {
      header: {
        id,
        agentPreset: headerPreset,
      },
    },
    ctx: {
      [Symbol.for('cordis.scope')]: scopeKey,
      tools: opts.tools,
    },
  }
}

class MockTeamRoster {
  tryMembership(agent) {
    if (agent?.id?.startsWith('subagent-')) return undefined
    return {
      root: agent,
      id: 'team-' + agent.id,
      role: 'lead',
      name: 'lead',
    }
  }
  membership(agent) {
    const m = this.tryMembership(agent)
    if (m === undefined) {
      const err = new Error(`TEAM_NOT_MEMBER: agent "${agent?.id}" is not a member of an active Agent Team`)
      err.code = 'TEAM_NOT_MEMBER'
      throw err
    }
    return m
  }
}

class MockTeamService {
  constructor() {
    this.roster = new MockRoster()
  }
  tryMembership(agent) {
    return this.roster.tryMembership(agent)
  }
  membership(agent) {
    return this.roster.membership(agent)
  }
}

const MockRoster = MockTeamRoster

test('1. isQuorumAgent correctly identifies Quorum and legacy Boost presets from header', () => {
  assert.equal(isQuorumAgent(makeAgent('1', 'quorum-ptc')), true)
  assert.equal(isQuorumAgent(makeAgent('2', 'quorum-standard')), true)
  assert.equal(isQuorumAgent(makeAgent('3', 'quorum-shell')), true)
  assert.equal(isQuorumAgent(makeAgent('4', 'boost')), true)
  assert.equal(isQuorumAgent(makeAgent('5', 'standard')), false)
  assert.equal(isQuorumAgent(makeAgent('6', 'ptc')), false)
  assert.equal(isQuorumAgent(makeAgent('7', 'minimal')), false)
  assert.equal(isQuorumAgent(makeAgent('8', undefined)), false)
  assert.equal(isQuorumAgent(null), false)
  assert.equal(isQuorumAgent({}), false)
})

test('2. isQuorumAgent recognises projected preset from sessionProjections and composed preset', () => {
  const agentWithoutHeader = {
    id: 'proj-1',
    session: { header: { id: 'proj-1' } },
    ctx: {},
  }
  const mockCtxProjections = {
    sessionProjections: {
      stateOf(session, key) {
        return key === 'agentPreset' ? 'quorum-ptc' : null
      },
    },
  }
  assert.equal(isQuorumAgent(agentWithoutHeader, mockCtxProjections), true)

  const mockCtxComposed = {
    agentPresets: {
      composedPreset(ctx) {
        return 'quorum-standard'
      },
    },
  }
  assert.equal(isQuorumAgent(agentWithoutHeader, mockCtxComposed), true)
})

test('3. shieldAgentTeams is completely inert when agentTeams is absent', () => {
  let callbackRan = false
  const emptyCtx = {
    inject(keys, cb) {
      // In Cordis, inject only invokes the callback if the requested services are registered
      if (keys.includes('agentTeams') && this.agentTeams) {
        callbackRan = true
        cb(this)
      }
    },
    on() {},
  }
  shieldAgentTeams(emptyCtx)
  assert.equal(callbackRan, false, 'inject callback must not run if agentTeams is not present')
})

test('4. shieldAgentTeams wraps tryMembership so Quorum agents are rejected from Team Lead role', () => {
  const teams = new MockTeamService()
  const listeners = new Map()
  const ctx = {
    agentTeams: teams,
    inject(keys, cb) {
      if (keys.includes('agentTeams')) cb(this)
    },
    on(event, cb) {
      listeners.set(event, cb)
    },
  }

  const qAgent = makeAgent('q-1', 'quorum-ptc')
  const stdAgent = makeAgent('std-1', 'standard')

  // Before shield: both are usurped as Lead
  assert.equal(teams.tryMembership(qAgent)?.role, 'lead')
  assert.equal(teams.tryMembership(stdAgent)?.role, 'lead')

  // Apply shield
  shieldAgentTeams(ctx)

  // After shield: Quorum agent is excluded, Standard agent is preserved
  assert.equal(teams.tryMembership(qAgent), undefined, 'Quorum agent must not be a Team member')
  assert.equal(teams.roster.tryMembership(qAgent), undefined, 'Roster must also return undefined for Quorum agent')
  assert.throws(() => teams.membership(qAgent), /TEAM_NOT_MEMBER/)

  assert.equal(teams.tryMembership(stdAgent)?.role, 'lead', 'Standard agent must remain Team Lead')
  assert.equal(teams.roster.tryMembership(stdAgent)?.role, 'lead')
  assert.equal(teams.membership(stdAgent)?.role, 'lead')
})

test('5. shieldAgentTeams restricts leaked team tools on Quorum agents without throwing on unknown tools', () => {
  const teams = new MockTeamService()
  let agentCreatedListener = null
  const restrictions = []

  const mockTools = {
    view(scope) {
      return {
        // Suppose the environment mounted tool-agent-team, so these tools are known
        restrictableNames: new Set(['spawn_teammate', 'team_task_create', 'read', 'write', 'edit']),
      }
    },
    restrict(filter) {
      restrictions.push(filter)
    },
  }

  const ctx = {
    agentTeams: teams,
    tools: mockTools,
    inject(keys, cb) {
      if (keys.includes('agentTeams')) cb(this)
    },
    on(event, cb) {
      if (event === 'agent/created') agentCreatedListener = cb
    },
  }

  shieldAgentTeams(ctx)
  assert.ok(agentCreatedListener, 'agent/created listener must be attached')

  // Simulate Quorum agent creation
  const qAgent = makeAgent('q-root', 'quorum-standard', { tools: mockTools })
  agentCreatedListener({ agent: qAgent })

  assert.equal(restrictions.length, 1, 'Quorum agent must receive a restriction for present team tools')
  assert.deepEqual(restrictions[0], {
    deny: ['spawn_teammate', 'team_task_create'],
  })

  // Simulate Standard agent creation: must NOT receive team tool restrictions
  const stdAgent = makeAgent('std-root', 'standard', { tools: mockTools })
  agentCreatedListener({ agent: stdAgent })

  assert.equal(restrictions.length, 1, 'Standard agent must NOT be restricted from team tools')
})
