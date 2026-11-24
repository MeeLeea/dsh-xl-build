/**
 * The engine's journal writers, in one place.
 *
 * Every durable record the run emits is built here, so `version: 1`, field
 * names, and the digest convention are decided once. The payload types come
 * from `events.ts`, and the composition root appends these through
 * `appendPluginRecord`, which adds the `ignorable` envelope.
 */
import type {
  ArtifactRef,
  EdgeFormat,
  EdgeTransferPayload,
  NodeEndPayload,
  NodeErrorClass,
  NodeErrorPayload,
  NodeInputPayload,
  NodeStartPayload,
  NodeStatus,
  RunEndPayload,
  RunStartPayload,
  XlJson,
} from '../events.ts'

/**
 * Stable digest of one text payload.
 *
 * FNV-1a over the UTF-16 code units: deterministic across processes and
 * versions, which is all the journal needs to prove two recorded payloads are
 * the same without storing them twice.
 * @param text - the payload text.
 * @returns an eight-character lowercase hexadecimal digest.
 */
export function digestOf(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Build the run-start record. */
export function runStartRecord(input: {
  runId: string
  workflowId: string
  workflowHash: string
  selfNodeId?: string
  /** Byte length of the memory injected into this run; absent when nothing was injected. */
  memoryBytes?: number
  inputs: Record<string, XlJson>
}): RunStartPayload {
  return {
    version: 1,
    runId: input.runId,
    workflowId: input.workflowId,
    workflowHash: input.workflowHash,
    inputs: input.inputs,
    ...input.selfNodeId !== undefined ? { selfNodeId: input.selfNodeId } : {},
    ...input.memoryBytes !== undefined ? { memoryBytes: input.memoryBytes } : {},
  }
}

/** Build the node-start record. */
export function nodeStartRecord(input: {
  runId: string
  nodeId: string
  kind: string
  attempt: number
  frame: XlJson
  startedAt: number
}): NodeStartPayload {
  return {
    version: 1,
    runId: input.runId,
    nodeId: input.nodeId,
    kind: input.kind,
    attempt: input.attempt,
    frame: input.frame,
    startedAt: input.startedAt,
    inputsDigest: digestOf(JSON.stringify(input.frame)),
  }
}

/** Build the node-input record; `text` is what the model received. */
export function nodeInputRecord(input: {
  runId: string
  nodeId: string
  edges: { edgeId: string, from: string, format: EdgeFormat, bytes: number }[]
  text: string
}): NodeInputPayload {
  return { version: 1, runId: input.runId, nodeId: input.nodeId, edges: input.edges, text: input.text }
}

/** Build the edge-transfer record. */
export function edgeTransferRecord(input: {
  runId: string
  edgeId: string
  from: string
  to: string
  kind: string
  format: EdgeFormat
  bytes: number
}): EdgeTransferPayload {
  return {
    version: 1,
    runId: input.runId,
    edgeId: input.edgeId,
    from: input.from,
    to: input.to,
    kind: input.kind,
    format: input.format,
    bytes: input.bytes,
  }
}

/** Build the node-end record. */
export function nodeEndRecord(input: {
  runId: string
  nodeId: string
  status: NodeStatus
  durationMs: number
  artifacts: ArtifactRef[]
  output: unknown
}): NodeEndPayload {
  return {
    version: 1,
    runId: input.runId,
    nodeId: input.nodeId,
    status: input.status,
    durationMs: input.durationMs,
    artifacts: input.artifacts,
    outputDigest: digestOf(JSON.stringify(input.output ?? null)),
  }
}

/** Build the node-error record. */
export function nodeErrorRecord(input: {
  runId: string
  nodeId: string
  class: NodeErrorClass
  message: string
  attempt: number
}): NodeErrorPayload {
  return {
    version: 1,
    runId: input.runId,
    nodeId: input.nodeId,
    class: input.class,
    message: input.message,
    attempt: input.attempt,
  }
}

/** Build the run-end record. */
export function runEndRecord(input: {
  runId: string
  outcome: 'completed' | 'failed' | 'cancelled'
  totalDurationMs: number
  artifacts: ArtifactRef[]
}): RunEndPayload {
  return {
    version: 1,
    runId: input.runId,
    outcome: input.outcome,
    totalDurationMs: input.totalDurationMs,
    artifacts: input.artifacts,
  }
}
