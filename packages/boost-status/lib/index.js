/**
 * `/boost-status` — live delegation state for the session it is invoked in.
 *
 * Why a command and not a tool: a command runs on the UI command plane, so it
 * answers while the agent is blocked inside a long tool call, which is exactly
 * the situation it exists for. It also costs no model tokens — a command's
 * definition and its result never enter a request or the session history.
 * `/boost-status` reads registries and session projections only: it never
 * advances, steers, or mutates anything, so it is safe to run at any moment.
 *
 * Every service is read through `ctx.get(...)` inside the handler rather than
 * declared as an injection, so a deployment missing one degrades to a line in
 * the report instead of failing this plugin's activation.
 */

export const name = 'boost-status-command'
export const inject = []

export function apply(ctx) {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'boost-status',
      description: 'État temps réel de la session et de son arbre de sous-agents',
      input: { hint: '[tokens|children|all]' },
      handler: async ({ agent, rawInput }) => {
        try {
          return { kind: 'success', text: await report(ctx, agent, String(rawInput ?? '').trim()) }
        } catch (error) {
          return { kind: 'error', text: `boost-status a échoué : ${describe(error)}` }
        }
      },
    })
  })
}

async function report(ctx, agent, rawInput) {
  const session = agent?.session
  if (session === undefined) return 'boost-status : aucun agent lié à cette session.'
  const full = rawInput === 'all' || rawInput === 'children'
  const out = []
  const now = Date.now()

  out.push('Boost — état temps réel')
  out.push(`session    ${short(session.id)}  ${session.header?.cwd ?? ''}`)
  out.push(`agent      ${agent.status ?? '?'}${agent.status === 'running' ? '   (un tour est ouvert : il peut être bloqué dans un appel d\'outil)' : ''}`)

  const tokenLine = tokenSummary(ctx, session)
  if (tokenLine !== '') out.push(tokenLine)

  const subagents = ctx.get('subagents')
  const agents = ctx.get('agents')
  if (subagents === undefined) {
    out.push('subagents  service indisponible dans cette composition')
    return out.join('\n')
  }

  let rows = []
  try {
    rows = await subagents.listDescendants(session.id)
  } catch (error) {
    out.push(`subagents  lecture impossible : ${describe(error)}`)
    return out.join('\n')
  }

  const children = rows.filter((row) => row.kind === 'child')
  const diagnostics = rows.filter((row) => row.kind === 'diagnostic')
  const running = children.filter((row) => row.activity === 'running')

  out.push(`enfants    ${children.length} au total, ${running.length} en cours`)
  if (children.length === 0) out.push('  (aucun sous-agent lancé depuis cette session)')

  for (const child of sortChildren(children)) {
    const live = agents?.get?.(child.id)
    const parts = [
      `  ${child.activity === 'running' ? 'RUN ' : 'idle'} ${short(child.id)}`,
      `d${child.depth}`,
      child.mode === 'continuable' ? 'continuable' : child.mode,
      JSON.stringify(child.label ?? '(sans label)'),
    ]
    if (live?.status !== undefined) parts.push(`agent=${live.status}`)
    const childTokens = live?.session !== undefined ? tokenSummary(ctx, live.session) : ''
    if (childTokens !== '') parts.push(childTokens.replace(/^\S+\s+/, ''))
    if (child.hasChildren === true) parts.push('⚠ A DES ENFANTS (plafond de profondeur contourné ?)')
    out.push(parts.join('  '))
  }

  for (const row of diagnostics) out.push(`  DIAG ${short(row.id)}  ${row.reason}`)

  if (running.length > 0) {
    out.push('')
    out.push(`→ attendre : ${running.length} sous-agent(s) en cours. Le parent ne peut pas traiter un`)
    out.push('  message tant qu\'un appel d\'outil est en vol (un « steer » est mis en file pour le tour suivant).')
  }
  if (full) {
    out.push('')
    out.push(`horodatage local : ${new Date(now).toISOString()}`)
  }
  return out.join('\n')
}

function sortChildren(children) {
  return [...children].sort((a, b) => {
    if (a.activity !== b.activity) return a.activity === 'running' ? -1 : 1
    return a.depth - b.depth
  })
}

function tokenSummary(ctx, session) {
  const projections = ctx.get('sessionProjections')
  const values = projections?.snapshot?.(session, ['tokenUsage', 'contextPressure'])?.values
  const usage = values?.tokenUsage
  const pressure = values?.contextPressure
  const parts = []
  if (usage !== undefined && usage !== null) {
    const input = (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    parts.push(`tokens cumulés in=${fmt(input)} (cacheRead=${fmt(usage.cacheReadTokens ?? 0)}) out=${fmt(usage.outputTokens ?? 0)}`)
  }
  if (pressure?.projectedTokens !== undefined) {
    parts.push(`contexte=${fmt(pressure.projectedTokens)}${pressure.contextWindow !== undefined ? `/${fmt(pressure.contextWindow)}` : ''}`)
  }
  if (parts.length === 0) {
    const meter = ctx.get('tokenMeter')
    const measured = meter?.measure?.(session)
    if (measured?.totalTokens !== undefined) parts.push(`pression=${fmt(measured.totalTokens)}`)
  }
  return parts.length > 0 ? `tokens     ${parts.join('  ')}` : ''
}

function fmt(n) {
  const value = Number(n ?? 0)
  if (!Number.isFinite(value)) return '?'
  if (Math.abs(value) < 1000) return String(value)
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

function short(id) {
  return typeof id === 'string' ? id.replace(/^session-/, '').slice(0, 8) : String(id)
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
