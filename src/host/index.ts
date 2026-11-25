/**
 * Host entry of the xl-build plugin: declarative sub-agent definitions,
 * workflow topology, and the durable run engine.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, SessionId } from '@deepseek-ai/dsh-session'
import { createActivationGate } from './agents/gate.ts'
import { createMentionStepHandler } from './agents/mention-step.ts'
import { createPresetReconciler } from './agents/presets.ts'
import { createAgentRegistry, resolveBuiltInAgentsDir, type AgentRegistry } from './agents/registry.ts'
import { createAgentRunner, type AgentRunner } from './agents/run.ts'
import { createAgentListTool, createAgentRunTool } from './agents/tool.ts'
import type { AgentSpec } from './agents/spec.ts'
import { createCatalogPublisher } from './catalog.ts'
import { createWorkflowCommand } from './commands/workflow.ts'
import { Config } from './config.ts'
import { XL_EVENTS, type NodeEndPayload, type NodeErrorPayload } from './events.ts'
import { createXlBuildProjection } from './projection.ts'
import { loadMergedWorkflowCatalog, resolveBuiltInWorkflowsDir, readBuiltInWorkflowCatalog } from './workflow/builtins.ts'
import { createMemoryCurator, readMemory, runDigestText, type MemoryCurator } from './workflow/memory.ts'
import { createRunArtifactStore, runNoticeText, startWorkflowRun, type WorkflowRunLimits, type WorkflowRunRuntime, type WorkflowRunServices } from './workflow/run.ts'
import { createShellScriptExecutor } from './workflow/script-exec.ts'

export { Config }

/** Host plugin name registered with the Cordis loader. */
export const name = 'dsh-xl-build'

/** Host services this plugin requires before it may load. */
export const inject = ['tools', 'commands', 'sessions', 'sessionProjections', 'subagents', 'agentLoop', 'agents', 'shell', 'agentPresets']

/** Inputs the workflow run runtime needs from the host wiring. */
interface WorkflowRunRuntimeInputs {
  readonly ctx: Context
  readonly config: Config
  readonly registry: AgentRegistry
  readonly runner: AgentRunner<Agent>
  readonly workflowsDir: string
  readonly builtInWorkflowsDir?: string
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
  const { ctx, config, registry, runner, workflowsDir, builtInWorkflowsDir, runsDir, memoryDir, curator } = inputs
  const limits: WorkflowRunLimits = {
    maxConcurrentNodes: config.maxConcurrentNodes,
    maxSteps: config.maxSteps,
    runTimeoutMs: config.runTimeoutMs,
    scriptTimeoutMs: config.scriptTimeoutMs,
    allowedScriptRuntimes: config.allowedScriptRuntimes,
    retryableToolErrors: config.retryableToolErrors,
  }
  const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)
  return {
    startRun: async ({ document, inputs: runInputs, selfNodeId }, initiator) => {
      const runId = randomUUID()
      const nodeEvents: string[] = []
      // `ctx.agents.create` returns an owned handle: the run-root agent and its
      // session are torn down with the run's post-run chain rather than
      // outliving the run.
      const runRootHandle = await ctx.agents.create({
        sessionId: SessionId(randomUUID()),
        agentOptions: {
          provider: config.runRootProvider,
          ...(config.runRootModel !== undefined ? { model: config.runRootModel } : {}),
        },
      })
      const runRoot = runRootHandle.agent
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
          const { entries } = loadMergedWorkflowCatalog(workflowsDir, builtInWorkflowsDir)
          const found = entries.find(
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
      // One contained continuation owns notice delivery, curation, and the
      // run-root teardown. `Agent.followup` is synchronous and can throw on a
      // disposed session, `handle.outcome` can reject, and `dispose` can fail:
      // each is contained here so nothing becomes an unhandled rejection.
      const settle = async (): Promise<void> => {
        try {
          const summary = await handle.outcome
          try {
            initiator.followup(createUserMessage({
              content: [{ type: 'text', text: runNoticeText(summary, runsDir) }],
              source: { kind: 'xl-build', form: 'notice', summary: `xl-build run ${summary.outcome}` },
            }))
          } catch (error) {
            // A failed notice must not skip curation.
            ctx.logger.warn(`xl-build run ${summary.runId}: completion notice failed: ${describe(error)}`)
          }
          // Curation is a post-run maintenance pass: it must not change the
          // settled result, and it never rejects by contract.
          await curator.curate({
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
        } catch (error) {
          ctx.logger.error(`xl-build run post-run continuation failed: ${describe(error)}`)
        } finally {
          try {
            await runRootHandle.dispose()
          } catch (error) {
            ctx.logger.error(`xl-build run ${runId}: run-root disposal failed: ${describe(error)}`)
          }
        }
      }
      void settle()
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
  const registry = createAgentRegistry(
    ctx,
    config,
    builtInAgentsDir !== undefined ? { dir: builtInAgentsDir } : undefined,
    (message) => ctx.logger.error(message),
  )
  const runner = createAgentRunner<Agent>(
    ctx.subagents,
    createActivationGate(config.maxConcurrentAgentTools),
  )
  const workflowsDir = resolve(process.cwd(), config.workflowsDir)
  // The shipped workflow directory is a packaging surface: one broken file
  // fails the load here instead of silently vanishing from the catalog.
  const builtInWorkflowsDir = resolveBuiltInWorkflowsDir()
  if (builtInWorkflowsDir !== undefined) readBuiltInWorkflowCatalog(builtInWorkflowsDir)
  const runsDir = resolve(process.cwd(), config.runsDir)
  const memoryDir = resolve(process.cwd(), config.memoryDir)
  const catalog = createCatalogPublisher({ registry, workflowsDir, ...(builtInWorkflowsDir !== undefined ? { builtInWorkflowsDir } : {}) })
  const curator = createMemoryCurator<Agent>({
    runner,
    curatorId: config.memoryCurator,
    memoryDir,
    memoryEnabled: config.memoryEnabled,
    memoryMaxBytes: config.memoryMaxBytes,
  })
  const runtime = createWorkflowRunRuntime({
    ctx, config, registry, runner, workflowsDir, runsDir, memoryDir, curator,
    ...(builtInWorkflowsDir !== undefined ? { builtInWorkflowsDir } : {}),
  })

  // Specs minus the memory curator: every remaining definition is also
  // registered as a dsh agent preset, so the model can select the role
  // directly through the delegation tool's `agent_preset` parameter.
  const promotableSpecs = (): AgentSpec[] => registry.listAgents().flatMap((entry) => entry.status === 'valid' && entry.spec.id !== config.memoryCurator
    ? [entry.spec]
    : [])
  const presetReconciler = createPresetReconciler({
    registrar: ctx.agentPresets,
    prefix: config.presetIdPrefix,
    logError: (message) => ctx.logger.error(message),
    logWarn: (message) => ctx.logger.warn(message),
    mountDelegationTool: (presetIds) => {
      const fiber = ctx.plugin(subagentTool, {
        provider: 'spawn',
        toolName: 'xl_subagent',
        allowedAgentPresets: [...presetIds],
      })
      return () => fiber.dispose()
    },
  })
  presetReconciler.reconcile(promotableSpecs())
  ctx.effect(() => registry.onChange(() => presetReconciler.reconcile(promotableSpecs())))
  ctx.effect(() => () => presetReconciler.dispose())
  ctx.effect(() => () => curator.dispose())

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
  ctx.effect(() => ctx.commands.register(createWorkflowCommand({
    workflowsDir, runtime,
    ...(builtInWorkflowsDir !== undefined ? { builtInWorkflowsDir } : {}),
  })))
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
  ctx.effect(() => () => runner.disposeAll())
}
