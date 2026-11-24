/**
 * Host entry of the xl-build plugin: declarative sub-agent definitions,
 * workflow topology, and the durable run engine.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, SessionId } from '@deepseek-ai/dsh-session'
import { createActivationGate } from './agents/gate.ts'
import { createMentionStepHandler } from './agents/mention-step.ts'
import { createAgentRegistry, resolveBuiltInAgentsDir, type AgentRegistry } from './agents/registry.ts'
import { createAgentRunner, type AgentRunner } from './agents/run.ts'
import { createAgentListTool, createAgentRunTool } from './agents/tool.ts'
import { createCatalogPublisher } from './catalog.ts'
import { createWorkflowCommand } from './commands/workflow.ts'
import { Config } from './config.ts'
import { XL_EVENTS, type NodeEndPayload, type NodeErrorPayload } from './events.ts'
import { createXlBuildProjection } from './projection.ts'
import { loadWorkflowDirectory } from './workflow/loaders.ts'
import { createMemoryCurator, readMemory, runDigestText, type MemoryCurator } from './workflow/memory.ts'
import { createRunArtifactStore, runNoticeText, startWorkflowRun, type WorkflowRunLimits, type WorkflowRunRuntime, type WorkflowRunServices } from './workflow/run.ts'
import { createShellScriptExecutor } from './workflow/script-exec.ts'

export { Config }

/** Host plugin name registered with the Cordis loader. */
export const name = 'dsh-xl-build'

/** Host services this plugin requires before it may load. */
export const inject = ['tools', 'commands', 'sessionProjections', 'subagents', 'agentLoop', 'shell']

/** Inputs the workflow run runtime needs from the host wiring. */
interface WorkflowRunRuntimeInputs {
  readonly ctx: Context
  readonly config: Config
  readonly registry: AgentRegistry
  readonly runner: AgentRunner<Agent>
  readonly workflowsDir: string
  readonly runsDir: string
  readonly memoryDir: string
  readonly curator: MemoryCurator<Agent>
}

/**
 * The `/workflow run` executor: each request grows one dormant run-root
 * session whose journal carries the run records, and reports the outcome
 * back to the initiating session as a notice.
 * @param inputs - host services and resolved configuration.
 * @returns the runtime the workflow command hands run requests to.
 */
function createWorkflowRunRuntime(inputs: WorkflowRunRuntimeInputs): WorkflowRunRuntime {
  const { ctx, config, registry, runner, workflowsDir, runsDir, memoryDir, curator } = inputs
  const limits: WorkflowRunLimits = {
    maxConcurrentNodes: config.maxConcurrentNodes,
    maxSteps: config.maxSteps,
    runTimeoutMs: config.runTimeoutMs,
    scriptTimeoutMs: config.scriptTimeoutMs,
    allowedScriptRuntimes: config.allowedScriptRuntimes,
    retryableToolErrors: config.retryableToolErrors,
  }
  return {
    startRun: async ({ document, inputs: runInputs, selfNodeId }, initiator) => {
      const runId = randomUUID()
      const nodeEvents: string[] = []
      const runRoot = await ctx.agentLoop.create(
        SessionId(randomUUID()),
        {
          provider: config.runRootProvider,
          ...(config.runRootModel !== undefined ? { model: config.runRootModel } : {}),
        },
      )
      const services: WorkflowRunServices<Agent> = {
        runner,
        parent: runRoot,
        initiatorParent: initiator,
        resolveAgent: (id) => {
          const spec = registry.resolveAgent(id)
          if (spec === undefined) throw new Error(`unknown agent "${id}"`)
          return spec
        },
        record: async (recordName, payload) => {
          if (recordName === XL_EVENTS.nodeEnd) {
            const ended = payload as NodeEndPayload
            nodeEvents.push(`[node ${ended.nodeId}] ${ended.status}`)
          } else if (recordName === XL_EVENTS.nodeError) {
            const failed = payload as NodeErrorPayload
            nodeEvents.push(`[node ${failed.nodeId}] ${failed.class}: ${failed.message}`)
          }
          appendPluginRecord(runRoot.session, recordName, payload)
          await ctx.sessions.flush(runRoot.session)
        },
        artifacts: createRunArtifactStore({
          runsDir,
          runId,
          persistRuns: config.persistRuns,
          sessionId: runRoot.id,
          cwd: process.cwd(),
        }),
        loadSubworkflow: (id) => {
          const found = loadWorkflowDirectory(workflowsDir).find(
            (candidate) => candidate.status === 'valid' && candidate.document.id === id,
          )
          if (found?.status !== 'valid') throw new Error(`workflow "${id}" is not saved in ${workflowsDir}`)
          return found.document
        },
        runScript: createShellScriptExecutor(ctx.shell, process.cwd()),
        readMemory: (workflowId) => readMemory(workflowId, {
          memoryDir,
          memoryEnabled: config.memoryEnabled,
          memoryMaxBytes: config.memoryMaxBytes,
        }),
      }
      const handle = startWorkflowRun<Agent>({
        document,
        inputs: runInputs,
        runId,
        ...(selfNodeId !== undefined ? { selfNodeId } : {}),
        limits,
        services,
      })
      void handle.outcome.then((summary) => {
        initiator.followup(createUserMessage({
          content: [{ type: 'text', text: runNoticeText(summary, runsDir) }],
          source: { kind: 'xl-build', form: 'notice', summary: `xl-build run ${summary.outcome}` },
        }))
        // Curation is a post-run maintenance pass: it must not change the
        // settled result, so its failures only surface as memory-updated records.
        void curator.curate({
          runId: summary.runId,
          workflowId: summary.workflowId,
          runDigest: runDigestText(summary, nodeEvents),
          parent: runRoot,
          record: async (payload) => {
            appendPluginRecord(runRoot.session, XL_EVENTS.memoryUpdated, payload)
            await ctx.sessions.flush(runRoot.session)
          },
          resolveCurator: () => registry.resolveAgent(config.memoryCurator),
        })
      })
      return { runId: handle.runId }
    },
  }
}

/**
 * Register the xl-build host surface: the agent registry, the shared agent
 * runner with its two tools, the `xlBuild` Session projection, and the
 * workflow command backed by the run runtime.
 * @param ctx - host plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const builtInAgentsDir = resolveBuiltInAgentsDir()
  const registry = createAgentRegistry(ctx, config,
    ...(builtInAgentsDir !== undefined ? [{ dir: builtInAgentsDir }] : []))
  const runner = createAgentRunner<Agent>(
    ctx.subagents,
    createActivationGate(config.maxConcurrentAgentTools),
  )
  const workflowsDir = resolve(process.cwd(), config.workflowsDir)
  const runsDir = resolve(process.cwd(), config.runsDir)
  const memoryDir = resolve(process.cwd(), config.memoryDir)
  const catalog = createCatalogPublisher({ registry, workflowsDir })
  const curator = createMemoryCurator<Agent>({
    runner,
    curatorId: config.memoryCurator,
    memoryDir,
    memoryEnabled: config.memoryEnabled,
    memoryMaxBytes: config.memoryMaxBytes,
  })
  const runtime = createWorkflowRunRuntime({ ctx, config, registry, runner, workflowsDir, runsDir, memoryDir, curator })

  ctx.effect(() => {
    const dispose = ctx.sessionProjections.register(createXlBuildProjection(config))
    return () => dispose()
  })
  ctx.effect(() => {
    const dispose = ctx.tools.register(createAgentListTool(registry))
    return () => dispose()
  })
  ctx.effect(() => {
    const dispose = ctx.tools.register(createAgentRunTool({ registry, runner }))
    return () => dispose()
  })
  ctx.effect(() => ctx.commands.register(createWorkflowCommand({ workflowsDir, runtime })))
  ctx.effect(() => ctx.on('agent/pre-step', createMentionStepHandler<Agent>({
    mentionAgents: () => registry.listAgents().flatMap((entry) => entry.status === 'valid'
      ? [{ id: entry.spec.id, name: entry.spec.name }]
      : []),
    onStep: ({ agent }) => {
      catalog.ensure(agent.session, (payload) => {
        appendPluginRecord(agent.session, XL_EVENTS.catalog, payload)
      })
    },
    recorder: ({ agent }) => ({
      sessionKey: agent.session,
      resolved: (payload) => { appendPluginRecord(agent.session, XL_EVENTS.mentionResolved, payload) },
      unresolved: (payload) => { appendPluginRecord(agent.session, XL_EVENTS.mentionUnresolved, payload) },
    }),
  })))
  ctx.effect(() => () => {
    void runner.disposeAll()
  })
}
