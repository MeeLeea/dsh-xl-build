/**
 * The single subagent execution path shared by `xl_agent_run` and the workflow
 * engine: prompt assembly, option mapping, per-activation timeout, and the
 * conversation-level concurrency gate.
 *
 * The parent is an opaque type parameter so the same runner serves the tool
 * path (parent: the calling `Agent`) and the engine path without depending on
 * agent construction; the composition root binds it to the real `Agent`.
 */
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ActivationGate, GatedActivation } from './gate.ts'
import type { AgentSpec } from './spec.ts'

/** Read-only declaration prefixed to a child's prompt (`plan.md` §5.2). */
export const READ_ONLY_PREFIX = 'Read-only mode: report findings and do not modify files, '
  + 'and do not run commands that change state.'

/** One activation request, structurally the host delegation request minus label/signal. */
export interface SubagentActivationRequest<P> {
  readonly prompt: SubagentStartRequest['prompt']
  readonly parent: P
  readonly cwd?: string
  readonly agentPreset?: string
  readonly agentOptions?: AgentOptions
  readonly outputSchema?: ObjectJsonSchema
}

/** One managed activation to start on a subagent provider. */
export interface SubagentActivationSpec<P> {
  readonly provider: string
  readonly label: string
  readonly request: SubagentActivationRequest<P>
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'
}

/** The subagent start face the runner consumes. */
export interface SubagentStartPort<P> {
  startActivation(spec: SubagentActivationSpec<P>): Promise<GatedActivation<SubagentResult>>
}

/** Inputs naming one agent execution. */
export interface AgentRunInput<P> {
  readonly spec: AgentSpec
  readonly task: string
  /** Explicit working directory; falls back to the spec's `cwd`, then the session directory. */
  readonly cwd?: string
  readonly parent: P
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'
}

/** One started activation: its child id and the promise of its terminal result. */
export interface AgentExecution {
  readonly childId: string
  /**
   * Settles with the provider result; never rejects on a child-level failure
   * (a failed child resolves with `stopReason: 'error'`), matching the
   * subagent seam's own settlement contract.
   */
  readonly result: Promise<SubagentResult>
}

/** The only entry point that starts an agent activation. */
export interface AgentRunner<P> {
  /**
   * Start one activation and return its child id without awaiting its result.
   * @param input - the agent, task, parent, and delivery policy.
   * @returns the started child's id and its result promise.
   */
  start(input: AgentRunInput<P>): Promise<AgentExecution>
  /** Dispose every activation this runner started whose result has not settled. */
  disposeAll(): Promise<void>
}

/**
 * Build the prompt blocks delivered to the child: the role prompt first (with
 * the read-only declaration prefixed when the spec asks for it), then the
 * task. `SubagentStartRequest` has no system-prompt channel, so the role
 * prompt travels inside the user message; only the preset path reaches
 * system-prompt level.
 * @param spec - the agent definition.
 * @param task - the task text supplied by the caller.
 * @returns the child's user message content.
 */
export function buildPromptBlocks(spec: AgentSpec, task: string): SubagentStartRequest['prompt'] {
  const role = spec.readOnly ? `${READ_ONLY_PREFIX}\n\n${spec.prompt}` : spec.prompt
  return [
    { type: 'text', text: role },
    { type: 'text', text: task },
  ]
}

/**
 * Map the spec's model fields onto child agent options. `provider` is an LLM
 * route, not the subagent backend, so it is never taken from the spec.
 * @param spec - the agent definition.
 * @returns the child options, or undefined when the spec sets none.
 */
export function buildAgentOptions(spec: AgentSpec): AgentOptions | undefined {
  const options: AgentOptions = {}
  if (spec.model !== undefined) options.model = spec.model
  if (spec.reasoningEffort !== undefined) options.reasoningEffort = ReasoningEffortId(spec.reasoningEffort)
  if (spec.maxTokens !== undefined) options.maxTokens = spec.maxTokens
  return Object.keys(options).length > 0 ? options : undefined
}

/**
 * Assemble the host delegation request for one activation.
 * @param spec - the agent definition.
 * @param task - the task text.
 * @param parent - the spawning agent.
 * @param cwd - the resolved working directory, when any.
 * @returns the request handed to the subagent provider.
 */
export function buildActivationRequest<P>(
  spec: AgentSpec,
  task: string,
  parent: P,
  cwd: string | undefined,
): SubagentActivationRequest<P> {
  const options = buildAgentOptions(spec)
  let outputSchema: ObjectJsonSchema | undefined
  if (spec.outputSchema !== undefined) {
    // The provider re-validates at start; fail early with the same readable violations.
    assertObjectJsonSchema(spec.outputSchema)
    outputSchema = spec.outputSchema
  }
  return {
    prompt: buildPromptBlocks(spec, task),
    parent,
    ...cwd !== undefined ? { cwd } : {},
    ...spec.agentPreset !== undefined ? { agentPreset: spec.agentPreset } : {},
    ...options !== undefined ? { agentOptions: options } : {},
    ...outputSchema !== undefined ? { outputSchema } : {},
  }
}

/**
 * Create the shared agent runner over a subagent start port and admission gate.
 * @param port - the `ctx.subagents` start face.
 * @param gate - conversation-level admission control.
 * @returns the runner used by the tools and the workflow engine.
 */
export function createAgentRunner<P>(port: SubagentStartPort<P>, gate: ActivationGate): AgentRunner<P> {
  const live = new Set<GatedActivation<SubagentResult>>()
  return {
    async start(input) {
      const request = buildActivationRequest(input.spec, input.task, input.parent, input.cwd)
      const activation = await gate.start(input.signal, async (release) => {
        const started = await port.startActivation({
          provider: input.spec.provider,
          label: input.spec.name,
          request,
          signal: input.signal,
          delivery: input.delivery,
        })
        live.add(started)
        void started.result.then(release, release)
        return started
      })
      // Plugin-owned timeout: dispose the exact activation; its result settles as aborted.
      const timer = setTimeout(() => { void activation.dispose() }, input.spec.timeoutMs)
      timer.unref()
      void activation.result.then(
        () => {
          clearTimeout(timer)
          live.delete(activation)
        },
        () => {
          clearTimeout(timer)
          live.delete(activation)
        },
      )
      return { childId: activation.childId, result: activation.result }
    },
    async disposeAll() {
      const pending = [...live]
      live.clear()
      await Promise.allSettled(pending.map(async (activation) => activation.dispose()))
    },
  }
}
