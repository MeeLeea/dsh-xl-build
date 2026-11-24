/**
 * The host-bound workflow run executor.
 *
 * The pure modules own every decision the run makes — scheduling
 * (`ready.ts`, `step.ts`), settlement and loop rounds (`engine-policy.ts`),
 * payload merging (`join.ts`, `node-input.ts`), templates (`template.ts`),
 * and retries (`retry.ts`). This module owns the host side: it holds the run
 * state, starts activations through the shared agent runner, appends durable
 * records through a caller-bound sink, writes artifacts, and applies the
 * run-level budgets. Node kinds that need no host service come from
 * `execute.ts`; the kinds that do come from the service ports below.
 *
 * The executor is generic over its activation parent so tests can drive it
 * with a fake parent and the composition root can bind the real `Agent`
 * without casts.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PluginRecordMap } from '@deepseek-ai/dsh-session/types'
import type {
  ArtifactRef,
  EdgeFormat,
  NodeErrorClass,
  NodeStatus,
  XlEventType,
  XlJson,
} from '../events.ts'
import { XL_EVENTS } from '../events.ts'
import type { AgentRunner } from '../agents/run.ts'
import type { AgentSpec } from '../agents/spec.ts'
import type { WorkflowDocument, WorkflowEdge, WorkflowNode } from './domain.ts'
import { decideLoopRound, settleRun } from './engine-policy.ts'
import type { RunOutcome } from './engine-policy.ts'
import { executeDeterministicNode, resolveRunInputs } from './execute.ts'
import { mergeJoinInputs } from './join.ts'
import {
  digestOf,
  edgeTransferRecord,
  nodeEndRecord,
  nodeErrorRecord,
  nodeInputRecord,
  nodeStartRecord,
  runEndRecord,
  runStartRecord,
} from './journal.ts'
import { artifactRef, runDir } from '../paths.ts'
import { composeNodeInput } from './node-input.ts'
import type { NodeInbound } from './node-input.ts'
import { shouldRetry, attemptCap } from './retry.ts'
import { planRunStep } from './step.ts'
import { serializeEdgeValue } from './envelope.ts'
import { renderTemplate } from './template.ts'
import type { TemplateFrame } from './template.ts'

/** The durable record payloads this engine writes. */
export type XlRecordPayload = PluginRecordMap[XlEventType]

/** The durable-record writer the composition root binds to the run session. */
export interface WorkflowRecordSink {
  <P extends XlEventType>(name: P, payload: PluginRecordMap[P]): Promise<void>
}

/** Executes one `script` node. */
export interface ScriptExecutor {
  (input: {
    readonly node: WorkflowNode & { kind: 'script' }
    /** Text fed to stdin when the node declares `stdin: 'edges'`; empty otherwise. */
    readonly stdin: string
    readonly timeoutMs: number
    readonly signal: AbortSignal
  }): Promise<{ readonly stdout: string, readonly truncated?: boolean }>
}

/** Executes one `tool` node. */
export interface ToolExecutor {
  (input: {
    readonly node: WorkflowNode & { kind: 'tool' }
    /** The node's declared arguments with every template rendered. */
    readonly args: Record<string, string>
    readonly signal: AbortSignal
  }): Promise<unknown>
}

/** Host services one workflow run needs. */
export interface WorkflowRunServices<P> {
  /** Starts agent activations (the shared agent runner). */
  readonly runner: AgentRunner<P>
  /** Activation parent for nodes without `self`. */
  readonly parent: P
  /** Activation parent for `self` nodes (the command's originating agent). */
  readonly initiatorParent: P
  /** Resolve an agent id to its definition; throws a readable error when unknown. */
  readonly resolveAgent: (id: string) => AgentSpec
  /** Durable-record writer bound to the run's session. */
  readonly record: WorkflowRecordSink
  /** Artifact store for this run. */
  readonly artifacts: RunArtifactStore
  /** Load a saved workflow document by id; throws a readable error when unknown. */
  readonly loadSubworkflow: (id: string) => WorkflowDocument
  /** Script execution; absent makes script nodes fail loud. */
  readonly runScript?: ScriptExecutor
  /** Tool execution; absent makes tool nodes fail loud. */
  readonly runTool?: ToolExecutor
  /** Read the workflow's distilled memory; called once per (sub)run at start, '' when disabled or missing. */
  readonly readMemory: (workflowId: string) => string
}

/** Run-level budgets the engine applies on top of the document's defaults. */
export interface WorkflowRunLimits {
  readonly maxConcurrentNodes: number
  readonly maxSteps: number
  readonly runTimeoutMs: number
  readonly scriptTimeoutMs: number
  readonly allowedScriptRuntimes: readonly string[]
  readonly retryableToolErrors: readonly string[]
}

/** One workflow run request. */
export interface WorkflowRunOptions<P> {
  readonly document: WorkflowDocument
  /** Pre-assigned run identity; generated when absent so the host can share it with the artifact store. */
  readonly runId?: string
  /** Supplied run inputs (`--input k=v`); validated against every `input` node. */
  readonly inputs: Record<string, string>
  /** Node id forced to `self` for this run (`--self`); the document is not modified. */
  readonly selfNodeId?: string
  readonly limits: WorkflowRunLimits
  readonly services: WorkflowRunServices<P>
  /** External cancellation; the run's own timeout is separate. */
  readonly signal?: AbortSignal
}

/**
 * The host-side runtime behind the '/workflow run' command: it starts one run in a dormant
 * run-root session and delivers the completion notice to the initiating session.
 * The command layer only parses; this interface owns execution.
 */
export interface WorkflowRunRuntime {
  /**
   * Start one workflow run.
   * @param input - the validated document, supplied inputs, and optional self-node override.
   * @param initiator - the session agent that accepted the command; it receives the
   *   completion follow-up and parents self-node activations.
   * @returns the accepted run's identity, before the run settles.
   */
  startRun(
    input: { readonly document: WorkflowDocument, readonly inputs: Record<string, string>, readonly selfNodeId?: string },
    initiator: Agent,
  ): Promise<{ readonly runId: string }>
}

/** A started run: its identity and the promise of its summary. */
export interface WorkflowRunHandle {
  readonly runId: string
  /** Settles when the run ends; never rejects — every failure is folded in. */
  readonly outcome: Promise<RunSummary>
}

/** The terminal outcome of one run. */
export interface RunSummary {
  readonly runId: string
  readonly workflowId: string
  readonly outcome: RunOutcome
  readonly totalDurationMs: number
  /** Artifacts written by the run's `output` nodes, in completion order. */
  readonly artifacts: readonly ArtifactRef[]
  /** Node or engine failures that made the run fail; empty when completed. */
  readonly failures: readonly { readonly nodeId: string, readonly message: string }[]
  /** The run's rendered `outputs` mapping. */
  readonly outputs: Record<string, string>
}

/** Fixed nesting cap for `subworkflow` nodes; rule `V11` already forbids cycles. */
const SUBWORKFLOW_MAX_DEPTH = 8

/** One scoped execution state: the whole run at the top, one loop round inside a body. */
interface GraphScope {
  /** The (sub)document this scope schedules; a node and edge subset of the run document. */
  readonly document: WorkflowDocument
  /** Scope-local frame identity written into every node-start record. */
  readonly frame: { readonly id: string, readonly loopId?: string, readonly iteration?: number }
  readonly statuses: Map<string, NodeStatus>
  readonly outputs: Map<string, unknown>
  readonly edgePayloads: Map<string, unknown>
  /** Inbound payloads waiting to be consumed, keyed by target node id. */
  readonly inbound: Map<string, NodeInbound[]>
  readonly active: Map<string, Promise<void>>
  /** First failure inside this scope, propagated to a loop node when scoped. */
  firstFailure?: { readonly errorClass: NodeErrorClass, readonly message: string }
}

/**
 * The completion notice text the host delivers to the initiating session:
 * the outcome line, the first file artifact for a completed run, and one
 * line per node failure.
 * @param summary - the settled run summary.
 * @param runsDir - absolute runs directory the artifact id resolves against.
 * @returns the notice body.
 */
export function runNoticeText(summary: RunSummary, runsDir: string): string {
  const lines = [`xl-build run ${summary.runId} ${summary.outcome} — workflow ${summary.workflowId}.`]
  const artifact = summary.artifacts.find((candidate) => candidate.kind === 'file')
  if (summary.outcome === 'completed' && artifact !== undefined) {
    lines.push(`Output: ${join(runsDir, summary.runId, artifact.id)}`)
  }
  for (const failure of summary.failures) lines.push(`- ${failure.nodeId}: ${failure.message}`)
  return lines.join('\n')
}
/**
 * A node execution failure with its durable classification.
 *
 * Kind executors throw this; the retry loop turns it into `node-error`
 * records and the retry decision.
 */
export class NodeExecutionError extends Error {
  /** The durable failure classification. */
  readonly errorClass: NodeErrorClass
  /** Tool error code for the retry whitelist; absent for other kinds. */
  readonly errorCode?: string

  constructor(errorClass: NodeErrorClass, message: string, errorCode?: string) {
    super(message)
    this.name = 'NodeExecutionError'
    this.errorClass = errorClass
    if (errorCode !== undefined) this.errorCode = errorCode
  }
}

/** Join an agent result's text blocks with newlines. */
function textOfBlocks(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** Map a document edge format onto the record-level format (`str` records as `text`). */
function recordFormat(format: WorkflowEdge['format']): EdgeFormat {
  return format === 'str' ? 'text' : format
}

/**
 * Persisted artifacts and journal for one run.
 *
 * When `persistRuns` is false nothing touches the disk: the journal stays
 * unwritten and artifacts are not produced, so the run view degrades to
 * digests exactly as `plan.md` §6.5 requires.
 */
export interface RunArtifactStore {
  /** Create the run directory and write the executed workflow document. */
  init(document: WorkflowDocument): Promise<void>
  /** Append one durable record line to the run journal. */
  appendJournal(name: XlEventType, payload: XlRecordPayload): Promise<void>
  /** Write one node artifact; returns its reference, or undefined when runs are not persisted. */
  writeArtifact(nodeId: string, filename: string, content: string): ArtifactRef | undefined
}

/** Inputs the artifact store needs: its directory, its addressing session, and persistence. */
export interface RunArtifactStoreOptions {
  /** The configured runs directory. */
  readonly runsDir: string
  /** This run's identity. */
  readonly runId: string
  /** Whether the run writes to disk at all. */
  readonly persistRuns: boolean
  /** The run root session the artifact addresses are scoped to. */
  readonly sessionId: string
  /** The run's working directory; paths inside it address relatively. */
  readonly cwd: string | undefined
}

/**
 * Create the on-disk artifact store for one run.
 * @param options - the runs directory, run identity, addressing session, and persistence flag.
 * @returns the store used by the executor.
 */
export function createRunArtifactStore(options: RunArtifactStoreOptions): RunArtifactStore {
  const { runId, persistRuns } = options
  const directory = runDir(options.runsDir, runId)
  return {
    async init(document) {
      if (!persistRuns) return
      await mkdir(join(directory, 'artifacts'), { recursive: true })
      await writeFile(join(directory, 'workflow.json'), JSON.stringify(document, null, 2), 'utf8')
    },
    async appendJournal(name, payload) {
      if (!persistRuns) return
      await appendFile(join(directory, 'journal.jsonl'), JSON.stringify({ name, payload }) + '\n', 'utf8')
    },
    writeArtifact(nodeId, filename, content) {
      if (!persistRuns) return undefined
      const relative = join('artifacts', nodeId, filename)
      mkdirSync(join(directory, 'artifacts', nodeId), { recursive: true })
      const absPath = join(directory, relative)
      writeFileSync(absPath, content, 'utf8')
      return artifactRef({
        nodeId,
        sessionId: options.sessionId,
        cwd: options.cwd,
        absPath,
        displayPath: relative,
        bytes: Buffer.byteLength(content, 'utf8'),
      })
    },
  }
}

/**
 * Start one workflow run.
 * @param options - the document, inputs, budgets, and host services.
 * @returns the run handle; the outcome promise never rejects.
 */
export function startWorkflowRun<P>(options: WorkflowRunOptions<P>): WorkflowRunHandle {
  const run = new WorkflowRun(options, 0)
  return { runId: run.runId, outcome: run.start() }
}

class WorkflowRun<P> {
  readonly runId: string
  private readonly controller = new AbortController()
  private readonly statuses = new Map<string, NodeStatus>()
  private readonly outputs = new Map<string, unknown>()
  private readonly edgePayloads = new Map<string, unknown>()
  private readonly inbound = new Map<string, NodeInbound[]>()
  private readonly active = new Map<string, Promise<void>>()
  private readonly artifacts: ArtifactRef[] = []
  private readonly failures: { nodeId: string, message: string }[] = []
  private stepsExecuted = 0
  private inputs: Record<string, unknown> = {}
  /** The workflow's memory, read once in `start()` before the graph runs. */
  private memory = ''

  constructor(
    private readonly options: WorkflowRunOptions<P>,
    private readonly depth: number,
  ) {
    this.runId = options.runId ?? randomUUID()
    if (options.signal !== undefined) {
      const forward = (): void => { this.controller.abort(options.signal?.reason) }
      options.signal.addEventListener('abort', forward, { once: true })
    }
  }

  /** The engine's view of one scope as a template frame. */
  private frameOf(scope: GraphScope): TemplateFrame {
    return {
      input: this.inputs,
      nodes: Object.fromEntries(scope.outputs),
      edges: Object.fromEntries(scope.edgePayloads),
      memory: this.memory,
    }
  }

  /** The frame identity written into node-start records. */
  private frameRecord(scope: GraphScope): XlJson {
    return scope.frame.iteration === undefined
      ? { id: scope.frame.id }
      : { id: scope.frame.id, loopId: scope.frame.loopId ?? '', iteration: scope.frame.iteration }
  }

  /** Append one durable record and mirror it into the run journal. */
  private async record(name: XlEventType, payload: XlRecordPayload): Promise<void> {
    await this.options.services.record(name, payload)
    await this.options.services.artifacts.appendJournal(name, payload)
  }

  /** Top-level run entry; folds every failure into the returned summary. */
  async start(): Promise<RunSummary> {
    const startedAt = Date.now()
    const timer = setTimeout(() => {
      this.controller.abort(new Error(`run timeout after ${this.options.limits.runTimeoutMs}ms`))
    }, this.options.limits.runTimeoutMs)
    timer.unref()
    let outcome: RunOutcome = 'completed'
    try {
      // The store is initialized first so even a run that fails input resolution
      // still has a run directory for its journal.
      // The memory file is read once per run, before anything executes (§6.8).
      this.memory = this.options.services.readMemory(this.options.document.id)
      await this.options.services.artifacts.init(this.options.document)
      this.resolveInputs()
      await this.record(XL_EVENTS.runStart, runStartRecord({
        runId: this.runId,
        workflowId: this.options.document.id,
        workflowHash: digestOf(JSON.stringify(this.options.document)),
        ...this.options.selfNodeId !== undefined ? { selfNodeId: this.options.selfNodeId } : {},
        ...this.memory !== '' ? { memoryBytes: Buffer.byteLength(this.memory, 'utf8') } : {},
        inputs: this.xlInputs(),
      }))
      await this.runGraph(this.topScope())
      const settlement = settleRun(this.options.document, this.statuses)
      outcome = settlement.outcome ?? 'failed'
      if (outcome !== 'completed') this.collectFailures()
    } catch (error) {
      // Engine-level failure: nothing else can run, so the run ends here.
      outcome = this.controller.signal.aborted ? 'cancelled' : 'failed'
      this.failures.push({ nodeId: '<engine>', message: (error as Error).message })
    } finally {
      clearTimeout(timer)
    }
    try {
      await this.record(XL_EVENTS.runEnd, runEndRecord({
        runId: this.runId,
        outcome,
        totalDurationMs: Date.now() - startedAt,
        artifacts: [...this.artifacts],
      }))
    } catch {
      // Best-effort: a journal or session sink failure here must not reject the outcome promise.
    }
    return {
      runId: this.runId,
      workflowId: this.options.document.id,
      outcome,
      totalDurationMs: Date.now() - startedAt,
      artifacts: [...this.artifacts],
      failures: [...this.failures],
      outputs: this.renderedOutputs(),
    }
  }

  /** The run inputs as durable-record JSON; non-JSON values serialize to their JSON text. */
  private xlInputs(): Record<string, XlJson> {
    const out: Record<string, XlJson> = {}
    for (const [key, value] of Object.entries(this.inputs)) {
      out[key] = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null
        ? value
        : JSON.stringify(value) ?? 'null'
    }
    return out
  }

  private topScope(): GraphScope {
    return {
      document: this.options.document,
      frame: { id: 'root' },
      statuses: this.statuses,
      outputs: this.outputs,
      edgePayloads: this.edgePayloads,
      inbound: this.inbound,
      active: this.active,
    }
  }

  /** Validate the supplied inputs against every `input` node; throws when a required input is missing. */
  private resolveInputs(): void {
    const missing: string[] = []
    for (const node of this.options.document.nodes) {
      if (node.kind !== 'input') continue
      const resolved = resolveRunInputs(node.params, this.options.inputs)
      missing.push(...resolved.missing)
      this.inputs = { ...this.inputs, ...resolved.inputs }
    }
    if (missing.length > 0) {
      throw new Error(`missing required run inputs: ${missing.join(', ')}`)
    }
  }

  /** The run's rendered `outputs` mapping. */
  private renderedOutputs(): Record<string, string> {
    const frame = this.frameOf(this.topScope())
    const rendered: Record<string, string> = {}
    for (const [name, template] of Object.entries(this.options.document.outputs)) {
      rendered[name] = renderTemplate(template, frame)
    }
    return rendered
  }

  /** One scheduling loop over one scope; returns when the scope settled. */
  private async runGraph(scope: GraphScope): Promise<void> {
    for (;;) {
      const step = planRunStep({
        document: scope.document,
        statuses: scope.statuses,
        active: [...scope.active.keys()],
        limit: this.options.limits.maxConcurrentNodes,
      })
      for (const [id, status] of step.statuses) scope.statuses.set(id, status)
      if (step.settlement.settled) return
      if (this.stepsExecuted >= this.options.limits.maxSteps) {
        throw new Error(`run exceeded maxSteps (${this.options.limits.maxSteps})`)
      }
      const startIds: string[] = []
      for (const id of step.start) {
        const node = this.nodeOf(scope.document, id)
        if (node.kind === 'join' && !this.joinDecided(scope, node)) continue
        startIds.push(id)
      }
      if (startIds.length === 0 && scope.active.size === 0) {
        // Undecided joins with nothing running can never decide — fail loud instead of spinning.
        throw new Error('scheduler stalled: no node can start and no node is running')
      }
      for (const id of startIds) {
        scope.statuses.set(id, 'running')
        const node = this.nodeOf(scope.document, id)
        const execution = this.executeNode(scope, node).finally(() => {
          scope.active.delete(id)
        })
        scope.active.set(id, execution)
        this.stepsExecuted += 1
      }
      if (scope.active.size > 0) await Promise.race([...scope.active.values()])
    }
  }

  /** Whether one join's strategy is satisfied by its current arrivals. */
  private joinDecided(scope: GraphScope, node: WorkflowNode & { kind: 'join' }): boolean {
    return this.mergeJoin(scope, node).decided
  }

  /** The join merge for one node over its current arrivals. */
  private mergeJoin(scope: GraphScope, node: WorkflowNode & { kind: 'join' }) {
    const expected = this.upstreamIds(scope.document, node.id)
    return mergeJoinInputs(node, expected, this.arrivalsOf(scope, node.id).map((arrival) => ({
      nodeId: arrival.from,
      text: serializeEdgeValue(arrival.value, arrival.format),
    })))
  }

  /** Execute one node to settlement; every failure is folded into the scope's statuses. */
  private async executeNode(scope: GraphScope, node: WorkflowNode): Promise<void> {
    const startedAt = Date.now()
    const frame = this.frameOf(scope)
    const inbound = this.takeInbound(scope, node.id)
    const composed = composeNodeInput(this.ownTextOf(node, frame), inbound)
    await this.record(XL_EVENTS.nodeStart, nodeStartRecord({
      runId: this.runId,
      nodeId: node.id,
      kind: node.kind,
      attempt: 1,
      frame: this.frameRecord(scope),
      startedAt,
    }))
    await this.record(XL_EVENTS.nodeInput, nodeInputRecord({
      runId: this.runId,
      nodeId: node.id,
      edges: composed.edges,
      text: composed.text,
    }))
    const cap = attemptCap(undefined, this.options.document.defaults.maxAttempts)
    for (let attempt = 1; ; attempt += 1) {
      try {
        const outcome = await this.runKind(scope, node, frame, composed.text, inbound)
        scope.outputs.set(node.id, outcome.output)
        scope.statuses.set(node.id, 'completed')
        this.artifacts.push(...outcome.artifacts)
        await this.record(XL_EVENTS.nodeEnd, nodeEndRecord({
          runId: this.runId,
          nodeId: node.id,
          status: 'completed',
          durationMs: Date.now() - startedAt,
          artifacts: [...outcome.artifacts],
          output: outcome.output ?? null,
        }))
        await this.transferOut(scope, node, outcome)
        return
      } catch (error) {
        const failure = error instanceof NodeExecutionError
          ? error
          : new NodeExecutionError('deterministic', (error as Error).message)
        await this.record(XL_EVENTS.nodeError, nodeErrorRecord({
          runId: this.runId,
          nodeId: node.id,
          class: failure.errorClass,
          message: failure.message,
          attempt,
        }))
        if (this.controller.signal.aborted) {
          scope.statuses.set(node.id, 'cancelled')
          await this.record(XL_EVENTS.nodeEnd, nodeEndRecord({
            runId: this.runId,
            nodeId: node.id,
            status: 'cancelled',
            durationMs: Date.now() - startedAt,
            artifacts: [],
            output: null,
          }))
          return
        }
        const decision = shouldRetry({
          errorClass: failure.errorClass,
          ...failure.errorCode !== undefined ? { errorCode: failure.errorCode } : {},
          attempt,
          maxAttempts: cap,
          retryableToolErrors: this.options.limits.retryableToolErrors,
        })
        if (!decision.retry) {
          scope.statuses.set(node.id, 'failed')
          scope.firstFailure ??= { errorClass: failure.errorClass, message: failure.message }
          await this.record(XL_EVENTS.nodeEnd, nodeEndRecord({
            runId: this.runId,
            nodeId: node.id,
            status: 'failed',
            durationMs: Date.now() - startedAt,
            artifacts: [],
            output: null,
          }))
          await this.transferError(scope, node, failure.message)
          return
        }
      }
    }
  }

  /** Dispatch one node kind to its executor. */
  private async runKind(
    scope: GraphScope,
    node: WorkflowNode,
    frame: TemplateFrame,
    composedText: string,
    inbound: readonly NodeInbound[],
  ): Promise<{ readonly output: unknown, readonly artifacts: readonly ArtifactRef[], readonly nextNode?: string }> {
    switch (node.kind) {
      case 'input':
      case 'note': {
        const outcome = executeDeterministicNode(node, frame)
        if (outcome === undefined || outcome.status !== 'completed') {
          throw new NodeExecutionError('deterministic', `node "${node.id}" did not complete`)
        }
        return { output: outcome.output, artifacts: [] }
      }
      case 'output': {
        const outcome = executeDeterministicNode(node, frame)
        if (outcome === undefined || outcome.status !== 'completed') {
          throw new NodeExecutionError('deterministic', `node "${node.id}" did not complete`)
        }
        const artifact = typeof outcome.output === 'string' && outcome.output !== ''
          ? this.options.services.artifacts.writeArtifact(node.id, 'output.md', outcome.output)
          : undefined
        const artifacts = artifact === undefined ? [] : [artifact]
        return { output: outcome.output, artifacts }
      }
      case 'router': {
        const outcome = executeDeterministicNode(node, frame)
        if (outcome === undefined || outcome.status !== 'completed' || outcome.nextNode === undefined) {
          throw new NodeExecutionError('deterministic', `router "${node.id}" selected no branch`)
        }
        // A router's value is the payload it forwards, so the branch edge carries it through.
        return { output: composedText, artifacts: [], nextNode: outcome.nextNode }
      }
      case 'agent':
        return { output: await this.runAgentNode(node, frame, inbound), artifacts: [] }
      case 'script':
        return { output: await this.runScriptNode(node, inbound), artifacts: [] }
      case 'tool':
        return { output: await this.runToolNode(node, frame), artifacts: [] }
      case 'join':
        return { output: this.mergeJoin(scope, node).text, artifacts: [] }
      case 'loop':
        return { output: await this.runLoopNode(node, composedText), artifacts: [] }
      case 'subworkflow':
        return { output: await this.runSubworkflowNode(node, frame), artifacts: [] }
    }
  }

  /** Run one agent activation through the shared runner. */
  private async runAgentNode(
    node: WorkflowNode & { kind: 'agent' },
    frame: TemplateFrame,
    inbound: readonly NodeInbound[],
  ): Promise<unknown> {
    const spec = this.options.services.resolveAgent(node.agent)
    const selfNode = node.self === true || this.options.selfNodeId === node.id
    // `context: 'none'` sends the task alone; the other modes add inbound envelopes.
    const taskInbound = node.context === 'none'
      ? []
      : node.context !== undefined && typeof node.context === 'object' && 'lastMessages' in node.context
        ? inbound.slice(-node.context.lastMessages)
        : inbound
    const taskComposed = composeNodeInput(this.agentOwnText(node, frame), taskInbound)
    const execution = await this.options.services.runner.start({
      spec,
      task: taskComposed.text,
      parent: selfNode ? this.options.services.initiatorParent : this.options.services.parent,
      signal: this.controller.signal,
      delivery: 'caller',
    })
    const result = await execution.result
    if (result.stopReason !== 'completed') {
      throw new NodeExecutionError(
        this.controller.signal.aborted ? 'timeout' : 'transient',
        result.diagnostic ?? `agent "${node.agent}" ended (${result.stopReason})`,
      )
    }
    return spec.outputSchema !== undefined && result.structured !== undefined
      ? result.structured
      : textOfBlocks(result.output)
  }

  /** Run one script node through the script executor. */
  private async runScriptNode(
    node: WorkflowNode & { kind: 'script' },
    inbound: readonly NodeInbound[],
  ): Promise<unknown> {
    if (!this.options.limits.allowedScriptRuntimes.includes(node.runtime)) {
      throw new NodeExecutionError(
        'deterministic',
        `script runtime "${node.runtime}" is not allowed (allowedScriptRuntimes: ${this.options.limits.allowedScriptRuntimes.join(', ')})`,
      )
    }
    const executor = this.options.services.runScript
    if (executor === undefined) {
      throw new NodeExecutionError('deterministic', 'script nodes need a script executor, which this host did not wire')
    }
    const stdin = node.stdin === 'edges'
      ? inbound.map((arrival) => serializeEdgeValue(arrival.value, arrival.format)).join('\n')
      : ''
    const result = await executor({
      node,
      stdin,
      timeoutMs: this.options.limits.scriptTimeoutMs,
      signal: this.controller.signal,
    })
    return result.stdout
  }

  /** Run one tool node through the tool executor. */
  private async runToolNode(
    node: WorkflowNode & { kind: 'tool' },
    frame: TemplateFrame,
  ): Promise<unknown> {
    const executor = this.options.services.runTool
    if (executor === undefined) {
      throw new NodeExecutionError('deterministic', 'tool nodes need a tool executor, which this host did not wire')
    }
    const args: Record<string, string> = {}
    for (const [key, value] of Object.entries(node.args)) {
      args[key] = renderTemplate(value, frame)
    }
    return await executor({ node, args, signal: this.controller.signal })
  }

  /** Drive one loop node's body rounds inside their own frames. */
  private async runLoopNode(node: WorkflowNode & { kind: 'loop' }, loopIn: string): Promise<unknown> {
    const bodyIds = this.bodyClosure(node.body)
    const bodyNodes = this.options.document.nodes.filter((candidate) => bodyIds.has(candidate.id))
    const bodyEdges = this.options.document.edges.filter((edge) => bodyIds.has(edge.from) && bodyIds.has(edge.to))
    const carryIds = node.carry ?? bodyEdges.filter((edge) => edge.kind === 'loop-back').map((edge) => edge.id)
    let carryTexts: string[] = []
    for (let iteration = 1; ; iteration += 1) {
      const roundIn = iteration === 1 ? loopIn : carryTexts.join('\n\n')
      const scope: GraphScope = {
        document: { ...this.options.document, nodes: bodyNodes, edges: bodyEdges },
        frame: { id: randomUUID(), loopId: node.id, iteration },
        statuses: new Map(),
        outputs: new Map(),
        edgePayloads: new Map(),
        inbound: new Map(),
        active: new Map(),
      }
      scope.inbound.set(node.body, [{
        edgeId: 'loop.in',
        from: node.id,
        to: node.body,
        format: 'text',
        value: roundIn,
        maxBytes: this.options.document.defaults.edgeMaxBytes,
      }])
      await this.runGraph(scope)
      if (scope.firstFailure !== undefined) {
        throw new NodeExecutionError(
          scope.firstFailure.errorClass,
          `loop "${node.id}" body failed: ${scope.firstFailure.message}`,
        )
      }
      carryTexts = carryIds.map((edgeId) => serializeEdgeValue(
        scope.edgePayloads.get(edgeId) ?? null,
        this.edgeById(edgeId).format,
      ))
      const decision = decideLoopRound(node, iteration, {
        input: this.inputs,
        nodes: Object.fromEntries(scope.outputs),
        edges: Object.fromEntries(scope.edgePayloads),
      })
      if (decision.kind === 'fail') {
        throw new NodeExecutionError('deterministic', decision.reason)
      }
      // `onMaxIters: 'continue'` keeps the run going once the cap is reached;
      // the loop itself stops iterating and converges on its carry payload.
      if (decision.kind === 'stop' || (decision.kind === 'continue' && iteration >= node.maxIters)) {
        return node.emit !== undefined && node.emit.length > 0
          ? node.emit.map((edgeId) => scope.edgePayloads.get(edgeId) ?? null)
          : carryTexts.join('\n\n')
      }
    }
  }

  /** Run one child workflow and surface its outputs. */
  private async runSubworkflowNode(node: WorkflowNode & { kind: 'subworkflow' }, frame: TemplateFrame): Promise<unknown> {
    if (this.depth >= SUBWORKFLOW_MAX_DEPTH) {
      throw new NodeExecutionError('deterministic', `subworkflow nesting deeper than ${SUBWORKFLOW_MAX_DEPTH}`)
    }
    const child = this.options.services.loadSubworkflow(node.workflow)
    const inputs: Record<string, string> = {}
    for (const [key, value] of Object.entries(node.inputs)) {
      inputs[key] = renderTemplate(value, frame)
    }
    const childRun = new WorkflowRun<P>({
      document: child,
      inputs,
      limits: this.options.limits,
      services: this.options.services,
    }, this.depth + 1)
    const summary = await childRun.start()
    if (summary.outcome !== 'completed') {
      throw new NodeExecutionError(
        this.controller.signal.aborted ? 'timeout' : 'deterministic',
        `subworkflow "${node.workflow}" ended ${summary.outcome}`,
      )
    }
    return summary.outputs
  }

  /** Transfer one node's completed payload along its out-edges. */
  private async transferOut(
    scope: GraphScope,
    node: WorkflowNode,
    outcome: { readonly output: unknown, readonly nextNode?: string },
  ): Promise<void> {
    await this.transferEdges(scope, node, (edge) => {
      if (edge.kind === 'loop-back') {
        // Loop-back payloads are the next round's carry; they never gate readiness.
        return { record: true, arrive: false }
      }
      if (edge.kind === 'error') return { record: false, arrive: false }
      if (outcome.nextNode !== undefined && edge.to !== outcome.nextNode) {
        return { record: false, arrive: false }
      }
      return { record: true, arrive: true }
    }, outcome.output)
  }

  /** Transfer one node's failure message along its error edges. */
  private async transferError(scope: GraphScope, node: WorkflowNode, message: string): Promise<void> {
    await this.transferEdges(scope, node, (edge) => (edge.kind === 'error'
      ? { record: true, arrive: true }
      : { record: false, arrive: false }), message)
  }

  /** Apply the transfer policy edge by edge, recording and arriving per its decision. */
  private async transferEdges(
    scope: GraphScope,
    node: WorkflowNode,
    policy: (edge: WorkflowEdge) => { readonly record: boolean, readonly arrive: boolean },
    output: unknown,
  ): Promise<void> {
    const frame = this.frameOf(scope)
    for (const edge of scope.document.edges) {
      if (edge.from !== node.id) continue
      const decision = policy(edge)
      if (!decision.record && !decision.arrive) continue
      const payload = edge.template !== undefined ? renderTemplate(edge.template, frame) : output
      if (payload === undefined || payload === null) continue
      const text = serializeEdgeValue(payload, edge.format)
      scope.edgePayloads.set(edge.id, payload)
      if (decision.record) {
        await this.record(XL_EVENTS.edgeTransfer, edgeTransferRecord({
          runId: this.runId,
          edgeId: edge.id,
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          format: recordFormat(edge.format),
          bytes: Buffer.byteLength(text, 'utf8'),
        }))
      }
      if (decision.arrive) {
        const arrivals = scope.inbound.get(edge.to) ?? []
        arrivals.push({
          edgeId: edge.id,
          from: edge.from,
          to: edge.to,
          format: recordFormat(edge.format),
          value: payload,
          maxBytes: edge.maxBytes ?? this.options.document.defaults.edgeMaxBytes,
        })
        scope.inbound.set(edge.to, arrivals)
      }
    }
  }

  /** Consume one node's inbound arrivals in edge document order. */
  private takeInbound(scope: GraphScope, nodeId: string): NodeInbound[] {
    const arrivals = scope.inbound.get(nodeId) ?? []
    scope.inbound.delete(nodeId)
    const order = new Map(this.options.document.edges.map((edge, index) => [edge.id, index]))
    return [...arrivals].sort((left, right) => (order.get(left.edgeId) ?? 0) - (order.get(right.edgeId) ?? 0))
  }

  private arrivalsOf(scope: GraphScope, nodeId: string): NodeInbound[] {
    return scope.inbound.get(nodeId) ?? []
  }

  /** Gating upstream node ids of one node, in document order. */
  private upstreamIds(document: WorkflowDocument, nodeId: string): string[] {
    return document.edges
      .filter((edge) => edge.to === nodeId && edge.kind !== 'loop-back' && edge.kind !== 'error')
      .map((edge) => edge.from)
  }

  private edgeById(edgeId: string): WorkflowEdge {
    const edge = this.options.document.edges.find((candidate) => candidate.id === edgeId)
    if (edge === undefined) throw new Error(`unknown edge "${edgeId}"`)
    return edge
  }

  private nodeOf(document: WorkflowDocument, nodeId: string): WorkflowNode {
    const node = document.nodes.find((candidate) => candidate.id === nodeId)
    if (node === undefined) throw new Error(`unknown node "${nodeId}"`)
    return node
  }

  /** Node ids reachable from the body entry through non-loop-back edges (`V15` closure). */
  private bodyClosure(entryId: string): Set<string> {
    const body = new Set<string>([entryId])
    let changed = true
    while (changed) {
      changed = false
      for (const edge of this.options.document.edges) {
        if (edge.kind === 'loop-back') continue
        if (body.has(edge.from) && !body.has(edge.to)) {
          body.add(edge.to)
          changed = true
        }
      }
    }
    return body
  }

  /**
   * The agent node's own prompt text: the rendered task, plus the context preamble
   * (`from: 'memory'`) and run inputs (`from: 'run-input'`) the node declares. Shared
   * by the activation and the `node-input` record so the model reads what the log holds.
   */
  private agentOwnText(node: WorkflowNode & { kind: 'agent' }, frame: TemplateFrame): string {
    let task = renderTemplate(node.task, frame)
    if (node.context !== undefined && typeof node.context === 'object' && 'from' in node.context) {
      if (node.context.from === 'memory' && this.memory !== '') {
        task = `[workflow memory]\n${this.memory}\n\n${task}`
      }
      if (node.context.from === 'run-input') {
        task += `\n\nRun inputs: ${JSON.stringify(this.inputs)}`
      }
    }
    return task
  }

  /** The text a node itself declares, rendered against the frame. */
  private ownTextOf(node: WorkflowNode, frame: TemplateFrame): string {
    switch (node.kind) {
      case 'agent': return this.agentOwnText(node, frame)
      case 'script': return renderTemplate(node.command ?? node.script ?? '', frame)
      case 'tool': return node.tool
      default: return ''
    }
  }

  /** Collect the failed/cancelled node messages for the run summary. */
  private collectFailures(): void {
    for (const node of this.options.document.nodes) {
      const status = this.statuses.get(node.id)
      if (status === 'failed' || status === 'cancelled') {
        this.failures.push({ nodeId: node.id, message: `${node.kind} node "${node.id}" ${status}` })
      }
    }
  }
}
