/**
 * `xlBuild` Session projection: folds the durable run records into the state
 * the run board reads, plus the wire view the client renders.
 *
 * The fold is pure: it never reads the clock and never touches global state
 * outside the configured view limits. Run and node state accumulates whole
 * records (the durable log is the audit trail); only the wire view applies the
 * `recentRuns` and `wirePreviewBytes` limits.
 */
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { Config } from './config.ts'
import {
  ArtifactRefSchema,
  CatalogAgentSchema,
  CatalogRecordSchema,
  CatalogWorkflowSchema,
  EdgeFormatSchema,
  EdgeTransferRecordSchema,
  NodeDeltaRecordSchema,
  NodeEndRecordSchema,
  NodeErrorClassSchema,
  NodeErrorRecordSchema,
  NodeInputRecordSchema,
  NodeStartRecordSchema,
  NodeStatusSchema,
  MemoryUpdatedRecordSchema,
  RunEndRecordSchema,
  RunStartRecordSchema,
  XL_EVENTS,
  isXlEventType,
} from './events.ts'

/** Event fields the fold consumes; a Session event satisfies this shape. */
export interface XlBuildRecordEvent {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

const RunStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled'])
export type RunStatus = z.infer<typeof RunStatusSchema>

const NodeStateSchema = z.object({
  nodeId: z.string(),
  kind: z.string(),
  attempt: z.number().int().nonnegative(),
  status: NodeStatusSchema,
  startedAt: z.number(),
  inputText: z.string(),
  delta: z.string(),
  error: z.object({
    class: NodeErrorClassSchema,
    message: z.string(),
    attempt: z.number().int().nonnegative(),
  }).optional(),
  durationMs: z.number().nonnegative().optional(),
  outputDigest: z.string().optional(),
  artifacts: z.array(ArtifactRefSchema),
})
export type XlBuildNodeState = z.infer<typeof NodeStateSchema>

const EdgeStateSchema = z.object({
  edgeId: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.string(),
  format: EdgeFormatSchema,
  bytes: z.number().int().nonnegative(),
})
export type XlBuildEdgeState = z.infer<typeof EdgeStateSchema>

const RunStateSchema = z.object({
  runId: z.string(),
  workflowId: z.string(),
  workflowHash: z.string(),
  selfNodeId: z.string().optional(),
  status: RunStatusSchema,
  nodes: z.record(z.string(), NodeStateSchema),
  edges: z.record(z.string(), EdgeStateSchema),
  artifacts: z.array(ArtifactRefSchema),
  totalDurationMs: z.number().nonnegative().optional(),
  /** Seq of the `run-end` record; orders settled runs without reading the clock. */
  settledSeq: z.number().int().optional(),
  /** Bytes of workflow memory injected at run start (absent when memory is disabled). */
  memoryBytes: z.number().int().nonnegative().optional(),
  /** Curator verdict after run end; absent while the run is active or memory is disabled. */
  memoryUpdated: z.object({
    outcome: z.enum(['updated', 'kept']),
    bytes: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
  }).optional(),
})
export type XlBuildRunState = z.infer<typeof RunStateSchema>

const CatalogStateSchema = z.object({
  agents: z.array(CatalogAgentSchema),
  workflows: z.array(CatalogWorkflowSchema),
})
export type XlBuildCatalog = z.infer<typeof CatalogStateSchema>

export const XlBuildProjectionStateSchema = z.object({
  runs: z.array(RunStateSchema),
  catalog: CatalogStateSchema,
})
export type XlBuildProjectionState = z.infer<typeof XlBuildProjectionStateSchema>

const NodeViewSchema = z.object({
  nodeId: z.string(),
  kind: z.string(),
  attempt: z.number().int().nonnegative(),
  status: NodeStatusSchema,
  startedAt: z.number(),
  inputPreview: z.string(),
  inputTruncated: z.boolean(),
  outputPreview: z.string(),
  outputTruncated: z.boolean(),
  error: z.object({
    class: NodeErrorClassSchema,
    message: z.string(),
    attempt: z.number().int().nonnegative(),
  }).optional(),
  durationMs: z.number().nonnegative().optional(),
  artifacts: z.array(ArtifactRefSchema),
})
export type XlBuildNodeView = z.infer<typeof NodeViewSchema>

const EdgeViewSchema = z.object({
  edgeId: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.string(),
  format: EdgeFormatSchema,
  bytes: z.number().int().nonnegative(),
})
export type XlBuildEdgeView = z.infer<typeof EdgeViewSchema>

const RunViewSchema = z.object({
  runId: z.string(),
  workflowId: z.string(),
  workflowHash: z.string(),
  selfNodeId: z.string().optional(),
  status: RunStatusSchema,
  nodes: z.array(NodeViewSchema),
  edges: z.array(EdgeViewSchema),
  artifacts: z.array(ArtifactRefSchema),
  totalDurationMs: z.number().nonnegative().optional(),
  /** Bytes of workflow memory injected at run start (absent when memory is disabled). */
  memoryBytes: z.number().int().nonnegative().optional(),
  /** Curator verdict after run end; absent while the run is active or memory is disabled. */
  memoryUpdated: z.object({
    outcome: z.enum(['updated', 'kept']),
    bytes: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
  }).optional(),
})
export type XlBuildRunView = z.infer<typeof RunViewSchema>

export const XlBuildProjectionViewSchema = z.object({
  catalog: CatalogStateSchema,
  runs: z.array(RunViewSchema),
})
export type XlBuildProjectionView = z.infer<typeof XlBuildProjectionViewSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    xlBuild: XlBuildProjectionState
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    xlBuild: XlBuildProjectionView
  }
}

/** The view limits this projection honours; both are plugin configuration. */
export type XlBuildProjectionOptions = Pick<Config, 'recentRuns' | 'wirePreviewBytes'>

/** Empty projection state for a Session with no xl-build records. */
export function emptyXlBuildProjection(): XlBuildProjectionState {
  return { runs: [], catalog: { agents: [], workflows: [] } }
}

/** Create the state for one node attempt. */
function newNode(payload: z.infer<typeof NodeStartRecordSchema>): XlBuildNodeState {
  return {
    nodeId: payload.nodeId,
    kind: payload.kind,
    attempt: payload.attempt,
    status: 'running',
    startedAt: payload.startedAt,
    inputText: '',
    delta: '',
    artifacts: [],
  }
}

/** Replace one run, keeping array order and the old state when nothing changed. */
function withRun(
  state: XlBuildProjectionState,
  runId: string,
  update: (run: XlBuildRunState) => XlBuildRunState,
): XlBuildProjectionState {
  let changed = false
  const runs = state.runs.map((run) => {
    if (run.runId !== runId) return run
    const next = update(run)
    if (next !== run) changed = true
    return next
  })
  return changed ? { ...state, runs } : state
}

/** Replace one node of a run; an absent node leaves the run unchanged. */
function withNode(
  run: XlBuildRunState,
  nodeId: string,
  update: (node: XlBuildNodeState) => XlBuildNodeState,
): XlBuildRunState {
  const node = run.nodes[nodeId]
  if (node === undefined) return run
  const next = update(node)
  return next === node ? run : { ...run, nodes: { ...run.nodes, [nodeId]: next } }
}

/** Apply one run record to the projection state. */
function applyRunRecord(state: XlBuildProjectionState, type: string, event: XlBuildRecordEvent): XlBuildProjectionState {
  switch (type) {
    case XL_EVENTS.catalog: {
      const parsed = CatalogRecordSchema.safeParse(event.data)
      return parsed.success ? { ...state, catalog: { agents: parsed.data.agents, workflows: parsed.data.workflows } } : state
    }
    case XL_EVENTS.runStart: {
      const parsed = RunStartRecordSchema.safeParse(event.data)
      if (!parsed.success) return state
      const run: XlBuildRunState = {
        runId: parsed.data.runId,
        workflowId: parsed.data.workflowId,
        workflowHash: parsed.data.workflowHash,
        status: 'running',
        nodes: {},
        edges: {},
        artifacts: [],
        ...parsed.data.selfNodeId !== undefined ? { selfNodeId: parsed.data.selfNodeId } : {},
        ...parsed.data.memoryBytes !== undefined ? { memoryBytes: parsed.data.memoryBytes } : {},
      }
      const existing = state.runs.findIndex((candidate) => candidate.runId === run.runId)
      if (existing < 0) return { ...state, runs: [...state.runs, run] }
      const runs = state.runs.slice()
      runs[existing] = run
      return { ...state, runs }
    }
    case XL_EVENTS.nodeStart: {
      const parsed = NodeStartRecordSchema.safeParse(event.data)
      if (!parsed.success) return state
      const node = newNode(parsed.data)
      return withRun(state, parsed.data.runId, (run) => ({
        ...run,
        nodes: { ...run.nodes, [node.nodeId]: node },
      }))
    }
    case XL_EVENTS.nodeInput: {
      const parsed = NodeInputRecordSchema.safeParse(event.data)
      if (!parsed.success) return state
      return withRun(state, parsed.data.runId, (run) => withNode(run, parsed.data.nodeId, (node) => (
        node.inputText === parsed.data.text ? node : { ...node, inputText: parsed.data.text }
      )))
    }
    case XL_EVENTS.nodeDelta: {
      const parsed = NodeDeltaRecordSchema.safeParse(event.data)
      if (!parsed.success) return state
      // A delta record is a full snapshot, not an append chunk: the preview
      // always mirrors the node's newest state (live stats while running,
      // final output once completed).
      return withRun(state, parsed.data.runId, (run) => withNode(run, parsed.data.nodeId, (node) => (
        node.delta === parsed.data.text ? node : { ...node, delta: parsed.data.text }
      )))
    }
    case XL_EVENTS.edgeTransfer: {
      const parsed = EdgeTransferRecordSchema.safeParse(event.data)
      if (!parsed.success) return state
      const edge = {
        edgeId: parsed.data.edgeId,
        from: parsed.data.from,
        to: parsed.data.to,
        kind: parsed.data.kind,
        format: parsed.data.format,
        bytes: parsed.data.bytes,
      }
      return withRun(state, parsed.data.runId, (run) => ({ ...run, edges: { ...run.edges, [edge.edgeId]: edge } }))
    }
    case XL_EVENTS.nodeEnd: {
      const parsed = NodeEndRecordSchema.safeParse(event.data)
      if (!parsed.success) return state
      return withRun(state, parsed.data.runId, (run) => withNode(run, parsed.data.nodeId, (node) => ({
        ...node,
        status: parsed.data.status,
        durationMs: parsed.data.durationMs,
        artifacts: parsed.data.artifacts,
        outputDigest: parsed.data.outputDigest,
      })))
    }
    case XL_EVENTS.nodeError: {
      const parsed = NodeErrorRecordSchema.safeParse(event.data)
      if (!parsed.success) return state
      return withRun(state, parsed.data.runId, (run) => withNode(run, parsed.data.nodeId, (node) => ({
        ...node,
        status: 'failed',
        error: { class: parsed.data.class, message: parsed.data.message, attempt: parsed.data.attempt },
      })))
    }
    case XL_EVENTS.runEnd: {
      const parsed = RunEndRecordSchema.safeParse(event.data)
      if (!parsed.success) return state
      return withRun(state, parsed.data.runId, (run) => ({
        ...run,
        status: parsed.data.outcome,
        totalDurationMs: parsed.data.totalDurationMs,
        artifacts: parsed.data.artifacts,
        settledSeq: event.seq,
      }))
    }
    case XL_EVENTS.memoryUpdated: {
      const parsed = MemoryUpdatedRecordSchema.safeParse(event.data)
      if (!parsed.success) return state
      const memoryUpdated = {
        outcome: parsed.data.outcome,
        ...parsed.data.bytes !== undefined ? { bytes: parsed.data.bytes } : {},
        ...parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {},
      }
      return withRun(state, parsed.data.runId, (run) => ({ ...run, memoryUpdated }))
    }
    default:
      return state
  }
}

/**
 * Fold one committed record into the projection state.
 * @param state - state covering every earlier event.
 * @param event - the next committed event; foreign events return `state`.
 * @returns the next state, or the same reference when nothing changed.
 */
export function applyXlBuildRecord(state: XlBuildProjectionState, event: XlBuildRecordEvent): XlBuildProjectionState {
  return isXlEventType(event.type) ? applyRunRecord(state, event.type, event) : state
}

/** Truncate one preview to a UTF-8 byte budget without splitting a code point. */
export function truncatePreview(text: string, maxBytes: number): { text: string, truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  let bytes = 0
  let kept = ''
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    kept += codePoint
  }
  return { text: kept, truncated: true }
}

/** Build the client view over a state snapshot. */
export function buildXlBuildView(
  state: XlBuildProjectionState,
  options: XlBuildProjectionOptions,
): XlBuildProjectionView {
  const active = state.runs.filter((run) => run.status === 'running')
  const settled = state.runs
    .filter((run) => run.status !== 'running')
    .sort((left, right) => (right.settledSeq ?? -1) - (left.settledSeq ?? -1))
    .slice(0, options.recentRuns)
  return {
    catalog: state.catalog,
    runs: [...active, ...settled].map((run) => ({
      runId: run.runId,
      workflowId: run.workflowId,
      workflowHash: run.workflowHash,
      status: run.status,
      nodes: Object.values(run.nodes).map((node) => {
        const input = truncatePreview(node.inputText, options.wirePreviewBytes)
        const output = truncatePreview(node.delta, options.wirePreviewBytes)
        return {
          nodeId: node.nodeId,
          kind: node.kind,
          attempt: node.attempt,
          status: node.status,
          startedAt: node.startedAt,
          inputPreview: input.text,
          inputTruncated: input.truncated,
          outputPreview: output.text,
          outputTruncated: output.truncated,
          artifacts: node.artifacts,
          ...node.error !== undefined ? { error: node.error } : {},
          ...node.durationMs !== undefined ? { durationMs: node.durationMs } : {},
        }
      }),
      edges: Object.values(run.edges),
      artifacts: run.artifacts,
      ...run.selfNodeId !== undefined ? { selfNodeId: run.selfNodeId } : {},
      ...run.totalDurationMs !== undefined ? { totalDurationMs: run.totalDurationMs } : {},
      ...run.memoryBytes !== undefined ? { memoryBytes: run.memoryBytes } : {},
      ...run.memoryUpdated !== undefined ? { memoryUpdated: run.memoryUpdated } : {},
    })),
  }
}

/**
 * Create the `xlBuild` projection unit.
 * @param options - view limits sourced from plugin configuration.
 * @returns the projection definition registered on `ctx.sessionProjections`.
 */
export function createXlBuildProjection(
  options: XlBuildProjectionOptions,
): ProjectionDefinition<'xlBuild'> & { wire: NonNullable<ProjectionDefinition<'xlBuild'>['wire']> } {
  // The registry compares consecutive view results by reference; reusing the
  // cached view for an unchanged state suppresses those publications.
  let cachedState: XlBuildProjectionState | undefined
  let cachedView: XlBuildProjectionView | undefined
  return {
    key: 'xlBuild',
    stateVersion: 1,
    stateSchema: XlBuildProjectionStateSchema,
    init: () => emptyXlBuildProjection(),
    apply: (state, event) => applyXlBuildRecord(state, event),
    wire: {
      viewSchema: XlBuildProjectionViewSchema,
      view: (state) => {
        if (cachedState === state && cachedView !== undefined) return cachedView
        cachedState = state
        cachedView = buildXlBuildView(state, options)
        return cachedView
      },
    },
  }
}
