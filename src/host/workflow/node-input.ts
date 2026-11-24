/**
 * Composition of one node's input text.
 *
 * The text this returns is used twice: as the node's model input and as the
 * `node-input` record's `text`. Composing it in one place is what makes
 * "what the model read is what the log holds" true by construction rather than
 * by review.
 */
import type { EdgeFormat, NodeInputPayload } from '../events.ts'
import { renderEdgeEnvelope } from './envelope.ts'

/** One inbound edge's payload. */
export interface NodeInbound {
  readonly edgeId: string
  readonly from: string
  readonly to: string
  readonly format: EdgeFormat
  readonly value: unknown
  /** Byte budget for this edge's payload. */
  readonly maxBytes: number
}

/** The composed input plus its per-edge accounting. */
export type NodeInput = Pick<NodeInputPayload, 'text' | 'edges'>

/**
 * Compose one node's input.
 * @param ownText - the text the node itself declares (its rendered task, command, or args).
 * @param inbound - the inbound edge payloads, in document order.
 * @returns the node's input text and the per-edge byte accounting.
 */
export function composeNodeInput(ownText: string, inbound: readonly NodeInbound[]): NodeInput {
  const edges: NodeInput['edges'] = []
  const parts: string[] = []
  if (ownText !== '') parts.push(ownText)
  for (const edge of inbound) {
    const envelope = renderEdgeEnvelope(
      { from: edge.from, to: edge.to, format: edge.format, value: edge.value },
      edge.maxBytes,
    )
    parts.push(envelope.text)
    edges.push({ edgeId: edge.edgeId, from: edge.from, format: edge.format, bytes: envelope.bytes })
  }
  return { text: parts.join('\n\n'), edges }
}
