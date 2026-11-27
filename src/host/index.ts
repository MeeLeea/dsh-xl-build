/**
 * Host entry of the xl-build plugin: declarative sub-agent definitions,
 * workflow topology, and the durable run engine.
 */
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { createActivationGate } from './agents/gate.ts'
import { createMentionStepHandler } from './agents/mention-step.ts'
import { createPresetReconciler } from './agents/presets.ts'
import { createAgentRegistry, resolveBuiltInAgentsDir, type AgentRegistry } from './agents/registry.ts'
import { createAgentRunner, type AgentRunner } from './agents/run.ts'
import { createAgentListTool, createAgentRunTool } from './agents/tool.ts'
import type { AgentSpec } from './agents/spec.ts'
import { createCatalogPublisher, type CatalogPublisher } from './catalog.ts'
import { createWorkflowCommand } from './commands/workflow.ts'
import { Config } from './config.ts'
import { XL_EVENTS, type NodeEndPayload, type NodeErrorPayload } from './events.ts'
import { createXlBuildProjection } from './projection.ts'
import { loadMergedWorkflowCatalog, resolveBuiltInWorkflowsDir, readBuiltInWorkflowCatalog } from './workflow/builtins.ts'
import { createMemoryCurator, readMemory, runDigestText, type MemoryCurator } from './workflow/memory.ts'
import { createRunArtifactStore, runNoticeText, startWorkflowRun, type AgentAskQuestion, type WorkflowRunLimits, type WorkflowRunRuntime, type WorkflowRunServices } from './workflow/run.ts'
import { createShellScriptExecutor } from './workflow/script-exec.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Narrow read of the host session-stats unit's state; the figures the live node preview shows. */
    sessionStats: { readonly steps: number, readonly llmMs: number }
    /** Narrow read of the host turn-outline unit's state; the drafting tail the preview shows. */
    turnOutline: { readonly draft: string }
  }
}

export { Config }

/** Host plugin name registered with the Cordis loader. */
export const name = 'dsh-xl-build'

/** Host services this plugin requires before it may load. */
export const inject = ['tools', 'commands', 'sessions', 'sessionProjections', 'subagents', 'agentLoop', 'agents', 'llm', 'shell', 'agentPresets']

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
  readonly catalog: CatalogPublisher
}

/**
 * The `/workflow run` executor: each request grows one dormant run-root
 * session whose journal carries the run records, and reports the outcome
 * back to the initiating session as a notice.
 * @param inputs - host services and resolved configuration.
 * @returns the runtime the workflow command hands run requests to.
 */
function createWorkflowRunRuntime(inputs: WorkflowRunRuntimeInputs): WorkflowRunRuntime {
  const { ctx, config, registry, runner, workflowsDir, builtInWorkflowsDir, runsDir, memoryDir, curator, catalog } = inputs
  const limits: WorkflowRunLimits = {
    maxConcurrentNodes: config.maxConcurrentNodes,
    maxSteps: config.maxSteps,
    runTimeoutMs: config.runTimeoutMs,
    scriptTimeoutMs: config.scriptTimeoutMs,
    allowedScriptRuntimes: config.allowedScriptRuntimes,
    retryableToolErrors: config.retryableToolErrors,
    // While an ask waits for the user, the run holds all new node starts.
    pauseWhileAsking: config.pauseWhileAsking,
    // The engine truncates preview snapshots to the same budget the wire
    // view applies, so journal and session records never grow past it.
    previewBudgetBytes: config.wirePreviewBytes,
  }
  const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)
  return {
    startRun: async ({ document, inputs: runInputs, selfNodeId }, initiator) => {
      const runId = randomUUID()
      const nodeEvents: string[] = []
      // The run-root is the delegation parent of every workflow child, and a
      // dormant agent never runs a step, so children inherit `runRoot.options`
      // verbatim (there is no request header to read). It must therefore carry
      // a real LLM route — provider AND model — or each child fails its first
      // step with "has no provider/model". Default to the initiating session's
      // own route; config overrides win when set.
      const route = {
        provider: config.runRootProvider ?? initiator.options.provider,
        model: config.runRootModel ?? initiator.options.model,
      }
      if (route.provider === undefined || route.provider === '' || route.model === undefined || route.model === '') {
        throw new Error(
          'xl-build: workflow agents have no LLM route. Set the plugin config '
          + 'runRootProvider and runRootModel, or start the run from a session '
          + 'that has a provider/model route.',
        )
      }
      // Fail before creating any session: an unknown adapter id surfaces here
      // as one readable run error instead of one opaque `ended (error)` per
      // workflow node.
      await ctx.llm.resolveModelInfo(route.provider, route.model)
      // `ctx.agents.create` returns an owned handle: the run-root agent and its
      // session are torn down with the run's post-run chain rather than
      // outliving the run. Narrowed copy: AgentOptions is optional-string
      // under exactOptionalPropertyTypes, so the guarded route is re-packed
      // into a fully-defined object.
      const agentOptions = { provider: route.provider, model: route.model }
      // The run-root carries the initiating session's cwd (the process cwd
      // as the fallback): the session list only lists persisted sessions
      // that have a cwd, the sidebar groups sessions by workspace, and the
      // post-run disposal turns the run-root into exactly such a cold row.
      const runRootCwd = await realpath(initiator.session.header.cwd ?? process.cwd()).catch(() => process.cwd())
      const runRootHandle = await ctx.agents.create({
        sessionId: SessionId(randomUUID()),
        agentOptions,
        meta: { cwd: runRootCwd },
      })
      const runRoot = runRootHandle.agent
      // The ask relay is structural: this plugin does not depend on the
      // user-questions package, so the service is discovered by name and the
      // ask port is only bound when the host actually provides one. A host
      // without it keeps the legacy pass-through ask behavior.
      const askService = ctx.get('userQuestions') as {
        ask(request: {
          readonly questions: readonly {
            readonly id: string
            readonly question: string
            readonly header?: string
            readonly options?: readonly { readonly label: string, readonly description?: string }[]
          }[]
          readonly agent: unknown
          readonly signal?: AbortSignal
        }): Promise<{ readonly answers: readonly { readonly id: string, readonly selected: readonly string[], readonly custom?: string }[] }>
      } | undefined
      // A dormant run-root never runs a step, so the pre-step catalog
      // handler never fires for it. Seed the catalog here so the `xlBuild`
      // projection carries a non-empty value from the first record onward
      // and the run-root is a full-fidelity wire source, not a blank row.
      catalog.ensure(runRoot.session, (payload) => {
        appendPluginRecord(runRoot.session, XL_EVENTS.catalog, payload)
      })
      await ctx.sessions.flush(runRoot.session)
      // Attach the run-root to the workspace owning its cwd so it sits
      // beside the initiating session in the sidebar, the way an ordinary
      // chat session is grouped. Attachment is best-effort: no registry,
      // an unregistered directory, or a failed attach never fails the run.
      try {
        const registry = ctx.get('workspaceRegistry')
        const workspace = registry === undefined ? undefined
          : registry.list().find((candidate: { readonly path: string }) => candidate.path === runRootCwd)
        await workspace?.attachSession(runRoot.session.id)
      } catch (error) {
        ctx.logger.warn(`xl-build run ${runId}: workspace attachment failed: ${describe(error)}`)
      }
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
        // Live progress for one agent child, from the sessionStats and
        // turnOutline units the host registers. A host without either unit
        // (or a disposed child) reads undefined and the engine skips live
        // previews for that node.
        readNodeProgress: (childId) => {
          try {
            const child = ctx.sessions.get(SessionId(childId))
            if (child === undefined) return undefined
            const stats = ctx.sessionProjections.stateOf(child, 'sessionStats')
            const outline = ctx.sessionProjections.stateOf(child, 'turnOutline')
            if (stats === undefined && outline === undefined) return undefined
            return {
              steps: stats?.steps ?? 0,
              llmMs: stats?.llmMs ?? 0,
              draft: outline?.draft ?? '',
            }
          } catch {
            // Best-effort: one bad projection read disables one preview tick.
            return undefined
          }
        },
        // Interactive ask rounds: an agent node whose structured output asks
        // questions relays them to the initiating session's composer card,
        // waits for the user's answers, and the engine re-runs the node with
        // the answers appended. The initiator is the live root that accepted
        // the /workflow command, which is exactly the agent ask() scopes to.
        ...(askService !== undefined ? {
          askUser: (questions: readonly AgentAskQuestion[], signal: AbortSignal) =>
            askService.ask({
              questions: questions.map((question) => ({
                id: question.id,
                question: question.question,
                ...(question.header !== undefined ? { header: question.header } : {}),
                ...(question.options !== undefined ? { options: [...question.options] } : {}),
              })),
              agent: initiator,
              signal,
            }).then((answer) => answer.answers),
        } : {}),
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
    ctx, config, registry, runner, workflowsDir, runsDir, memoryDir, curator, catalog,
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
