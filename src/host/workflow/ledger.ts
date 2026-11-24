/**
 * The engine's live ledger: the durable records the run has emitted, folded
 * into the same state the `xlBuild` Session projection exposes.
 *
 * Folding through `applyXlBuildRecord` is deliberate — the engine's
 * orchestration view and the projection the client reads are then the same
 * computation over the same records, so they cannot drift apart.
 */
import type { NodeStatus } from '../events.ts'
import { applyXlBuildRecord, emptyXlBuildProjection } from '../projection.ts'
import type { XlBuildProjectionState, XlBuildRecordEvent } from '../projection.ts'

/** Live read view over one run's records. */
export interface RunLedger {
  /** Folded state, identical to what the projection would compute. */
  readonly state: XlBuildProjectionState
  /**
   * Node status by node id for one run.
   * @param runId - the run to read.
   * @returns the status map the scheduler consumes; empty for an unknown run.
   */
  statuses(runId: string): Map<string, NodeStatus>
}

/**
 * Fold a record list into a ledger.
 * @param events - the run's records in emission order.
 * @returns the ledger over those records.
 */
export function foldLedger(events: readonly XlBuildRecordEvent[]): RunLedger {
  const state = events.reduce(applyXlBuildRecord, emptyXlBuildProjection())
  return {
    state,
    statuses: (runId) => {
      const run = state.runs.find((candidate) => candidate.runId === runId)
      if (run === undefined) return new Map<string, NodeStatus>()
      return new Map(Object.values(run.nodes).map((node) => [node.nodeId, node.status]))
    },
  }
}
