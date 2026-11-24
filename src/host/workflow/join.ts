/**
 * Fan-in payload merging for `join` nodes.
 *
 * The three strategies differ only in when the join is decided and which
 * arrivals its payload carries: `all` waits for every declared upstream, `any`
 * decides on the first arrival, `quorum` decides once enough arrived. The
 * merged text keeps arrivals in the order they were declared, so the same
 * graph and the same arrivals always produce the same model input.
 */
import type { WorkflowNode } from './domain.ts'

/** One upstream arrival. */
export interface JoinArrival {
  readonly nodeId: string
  /** The edge payload text the upstream produced. */
  readonly text: string
}

/** The merge result for one join. */
export interface JoinMerge {
  /** Whether the strategy is satisfied by these arrivals. */
  readonly decided: boolean
  /** Merged payload text, empty until the join is decided. */
  readonly text: string
}

/** Section header introducing one arrival in the merged payload. */
function section(arrival: JoinArrival): string {
  return `[from ${arrival.nodeId}]\n${arrival.text}`
}

/**
 * Merge the arrivals one join has received.
 * @param node - the join node (its strategy and quorum).
 * @param expected - every upstream node id that feeds this join, in document order.
 * @param arrivals - the arrivals received so far.
 * @returns whether the join is decided and, when it is, the merged payload.
 */
export function mergeJoinInputs(
  node: WorkflowNode & { kind: 'join' },
  expected: readonly string[],
  arrivals: readonly JoinArrival[],
): JoinMerge {
  const arrived = new Set(arrivals.map((arrival) => arrival.nodeId))
  const ordered = expected.flatMap((nodeId) => {
    const arrival = arrivals.find((candidate) => candidate.nodeId === nodeId)
    return arrival === undefined ? [] : [arrival]
  })
  switch (node.strategy) {
    case 'all':
      if (!expected.every((nodeId) => arrived.has(nodeId))) return { decided: false, text: '' }
      return { decided: true, text: ordered.map(section).join('\n\n') }
    case 'any': {
      const [first] = ordered
      if (first === undefined) return { decided: false, text: '' }
      return { decided: true, text: section(first) }
    }
    case 'quorum': {
      const quorum = node.quorum ?? expected.length
      if (ordered.length < quorum) return { decided: false, text: '' }
      return { decided: true, text: ordered.slice(0, quorum).map(section).join('\n\n') }
    }
  }
}
