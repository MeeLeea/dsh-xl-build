/**
 * Client-local mirror of the xl-build wire view. The client face cannot import
 * the host face, so this schema restates the projection contract of
 * src/host/projection.ts; a value that fails validation degrades to an absent
 * view instead of reaching the panel.
 */
import { z } from 'zod'

/** One artifact produced by a run, as the panel receives it. */
export type XlBuildArtifactView = z.infer<typeof ArtifactViewSchema>
/** One node execution, as the panel receives it. */
export type XlBuildNodeView = z.infer<typeof NodeViewSchema>
/** One settled or live edge transfer, as the panel receives it. */
export type XlBuildEdgeView = z.infer<typeof EdgeViewSchema>
/** One run, as the panel receives it. */
export type XlBuildRunView = z.infer<typeof RunViewSchema>
/** Full projection value the host publishes under the \`xlBuild\` key. */
export type XlBuildView = z.infer<typeof XlBuildViewSchema>

const ArtifactViewSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  kind: z.string(),
  /** Host-generated `dsh-resource://file/…` address; the panel opens it as-is. */
  path: z.string(),
  bytes: z.number().int().nonnegative().optional(),
  title: z.string().optional(),
})

const NodeErrorViewSchema = z.object({
  class: z.enum(['transient', 'timeout', 'deterministic', 'auth']),
  message: z.string(),
  attempt: z.number().int().nonnegative(),
})

const NodeViewSchema = z.object({
  nodeId: z.string(),
  kind: z.string(),
  attempt: z.number().int().nonnegative(),
  status: z.enum(['running', 'completed', 'failed', 'skipped', 'cancelled']),
  startedAt: z.number(),
  inputPreview: z.string(),
  inputTruncated: z.boolean(),
  outputPreview: z.string(),
  outputTruncated: z.boolean(),
  error: NodeErrorViewSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
  artifacts: z.array(ArtifactViewSchema),
})

const EdgeViewSchema = z.object({
  edgeId: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.string(),
  format: z.enum(['json', 'md', 'text']),
  bytes: z.number().int().nonnegative(),
})

const RunViewSchema = z.object({
  runId: z.string(),
  workflowId: z.string(),
  workflowHash: z.string(),
  selfNodeId: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  nodes: z.array(NodeViewSchema),
  edges: z.array(EdgeViewSchema),
  artifacts: z.array(ArtifactViewSchema),
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

const CatalogSchema = z.object({
  agents: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  workflows: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional(), mermaid: z.string() })),
})

const EMPTY_CATALOG: XlBuildView['catalog'] = { agents: [], workflows: [] }

export const XlBuildViewSchema = z.object({
  catalog: CatalogSchema,
  runs: z.array(RunViewSchema),
})

/**
 * Parse one raw projection value into the view the panel reads. Degradation is
 * per part: a malformed catalog falls back to an empty catalog and a malformed
 * run is dropped, so one bad item never blanks the whole panel.
 * @param value - raw projection snapshot; may be absent or foreign.
 * @returns the parsed view, or undefined when the value is not an object or carries neither `catalog` nor `runs`.
 */
export function parseXlBuildView(value: unknown): XlBuildView | undefined {
  if (!isRecord(value)) return undefined
  if (!('catalog' in value) && !('runs' in value)) return undefined
  const catalogResult = CatalogSchema.safeParse(value.catalog)
  const runs: XlBuildRunView[] = []
  const rawRuns: unknown = value.runs
  if (Array.isArray(rawRuns)) {
    for (const raw of rawRuns) {
      const result = RunViewSchema.safeParse(raw)
      if (result.success) runs.push(result.data)
    }
  }
  return { catalog: catalogResult.success ? catalogResult.data : EMPTY_CATALOG, runs }
}

/**
 * Narrow a wire value to a non-null object before reading its members.
 * @param value - candidate value.
 * @returns whether the value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The slice of the projection the panel consumes. */
export interface XlBuildWire {
  /** Parsed view of the most recently active session, or undefined while none publishes a valid view. */
  readonly view: XlBuildView | undefined
}

/** Observable face of one wire; structurally the client store's snapshot contract. */
export interface WireSource {
  getSnapshot(): XlBuildWire
  subscribe(listener: () => void): () => void
}
