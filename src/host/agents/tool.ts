/**
 * Model-facing delegation tools over the agent registry: `xl_agent_list`
 * enumerates the declaratively defined agents, and `xl_agent_run` delegates
 * one task to a chosen agent through the shared runner.
 *
 * `xl_agent_list` exposes `id`, `name`, and `description` only — never the
 * prompt — so a model can choose an executor without leaking another agent's
 * instructions into its context. Invalid definition files are reported
 * alongside the usable agents so a broken YAML stays diagnosable from the
 * same call.
 *
 * `xl_agent_run` uses parent delivery: the tool returns the child id as soon
 * as the activation is accepted, and the host reports completion in this
 * session. Callers never await the child's result here.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AgentRegistry } from './registry.ts'
import type { AgentRunner } from './run.ts'

/** Tool name of the delegation entry point. */
export const XL_AGENT_RUN_NAME = 'xl_agent_run'

/** The listing a model receives: usable agents plus rejected files. */
export interface AgentListValue {
  agents: { id: string, name: string, description: string }[]
  invalid: { file: string, error: string }[]
}

/** Project the registry snapshot onto the model-visible listing. */
export function collectAgentList(registry: Pick<AgentRegistry, 'listAgents'>): AgentListValue {
  const agents: AgentListValue['agents'] = []
  const invalid: AgentListValue['invalid'] = []
  for (const entry of registry.listAgents()) {
    if (entry.status === 'valid') {
      agents.push({ id: entry.spec.id, name: entry.spec.name, description: entry.spec.description })
    } else {
      invalid.push({ file: entry.file, error: entry.error })
    }
  }
  return { agents, invalid }
}

/** Render the listing as one text block, one agent per line. */
function renderList(value: AgentListValue): string {
  const lines = value.agents.map((agent) => `- ${agent.id}: ${agent.name} — ${agent.description}`)
  if (value.invalid.length > 0) {
    lines.push('Invalid definition files:')
    for (const entry of value.invalid) lines.push(`- ${entry.file}: ${entry.error}`)
  }
  return lines.length > 0 ? lines.join('\n') : 'No agents are defined.'
}

/**
 * Read every usable agent id from the current registry snapshot.
 * @param registry - the live agent registry.
 * @returns the ids in registry order.
 */
export function listAgentIds(registry: Pick<AgentRegistry, 'listAgents'>): string[] {
  return collectAgentList(registry).agents.map((agent) => agent.id)
}

/**
 * Build the message shown when a requested agent id does not exist.
 * @param requested - the id the caller asked for.
 * @param available - the ids currently defined.
 * @returns a readable message naming the available ids.
 */
export function unknownAgentMessage(requested: string, available: readonly string[]): string {
  const shown = available.slice(0, 20)
  const rest = available.length - shown.length
  const listed = shown.length === 0 ? '(none)' : shown.join(', ')
  const suffix = rest > 0 ? ` and ${rest} more` : ''
  return `Unknown agent "${requested}". Available agents: ${listed}${suffix}.`
}

/**
 * Build the `xl_agent_list` tool over a live registry.
 * @param registry - agent definitions resolved at the moment of the call.
 * @returns the tool definition to register on `ctx.tools`.
 */
export function createAgentListTool(registry: Pick<AgentRegistry, 'listAgents'>): ToolDefinition {
  return defineTool({
    name: 'xl_agent_list',
    description: 'List the declaratively defined subagents available in this deployment, '
      + 'with each agent id, display name, and one-line description. '
      + 'Call this before delegating so you can choose an id for `xl_agent_run`. '
      + 'Invalid definition files are reported with their parse errors.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agents: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
              },
            },
          },
          invalid: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderList(value) }],
    },
    isConcurrencySafe: () => true,
    execute: async () => collectAgentList(registry),
  })
}

/**
 * Build the `xl_agent_run` tool over the live registry and shared runner.
 * @param deps - the agent registry and the runner both delegation entries share.
 * @returns the tool definition to register on `ctx.tools`.
 */
export function createAgentRunTool(deps: {
  registry: Pick<AgentRegistry, 'listAgents' | 'resolveAgent'>
  runner: AgentRunner<Agent>
}): ToolDefinition {
  return defineTool({
    name: XL_AGENT_RUN_NAME,
    description: 'Delegate one self-contained task to a named subagent and return immediately with its child id. '
      + 'The subagent starts with no memory of this conversation and cannot read its history or files it was not told about, '
      + 'so pass everything it needs in `task`. '
      + 'Use it when the work is independent and can be described completely in the task text. '
      + 'Do not use it for a step you can finish yourself in one action, for work that needs the details of this conversation, '
      + 'or to ask the subagent a question you must answer before continuing. '
      + 'Start several delegations in parallel in one message when the tasks are independent, and end your turn once only '
      + 'waiting for them instead of polling.',
    parameters: {
      agent: {
        type: 'string',
        required: true,
        description: 'Agent id returned by `xl_agent_list`.',
      },
      task: {
        type: 'string',
        required: true,
        description: 'The complete task for the subagent; it cannot see this conversation.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the child. Relative paths resolve against your current directory; '
          + 'omitted inherits the agent definition or your current directory.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started agent ${value.childId}` }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('xl_agent_run requires a calling agent')
      const spec = deps.registry.resolveAgent(args.agent)
      if (spec === undefined) {
        throw new Error(unknownAgentMessage(args.agent, listAgentIds(deps.registry)))
      }
      const cwd = args.cwd ?? spec.cwd
      const started = await deps.runner.start({
        spec,
        task: args.task,
        parent,
        signal: exec.signal,
        delivery: 'parent',
        ...cwd !== undefined ? { cwd } : {},
      })
      return { childId: started.childId }
    },
  })
}
