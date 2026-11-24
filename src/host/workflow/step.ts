/**
 * One tick of the run loop, as a pure decision.
 *
 * The host-bound runtime owns sessions, records, and executors; this module
 * owns what the loop *decides*: propagate skips, pick the nodes that may start
 * within the budget, and report whether the run has settled. Keeping it pure
 * means the orchestration rules are tested without a session or an agent.
 */
import type { NodeStatus } from '../events.ts'
import type { WorkflowDocument } from './domain.ts'
import { cascadeSkips, settleRun } from './engine-policy.ts'
import type { RunSettlement } from './engine-policy.ts'
import { planReadyNodes } from './ready.ts'

/** State one tick reads. */
export interface RunStepInput {
  readonly document: WorkflowDocument
  /** Statuses as the ledger reports them. */
  readonly statuses: ReadonlyMap<string, NodeStatus>
  /** Node ids currently running. */
  readonly active: readonly string[]
  /** Concurrent-node budget (`Config.maxConcurrentNodes`). */
  readonly limit: number
}

/** What the runtime must do next. */
export interface RunStep {
  /** Nodes to start now, in document order. */
  readonly start: readonly string[]
  /** Execution statuses after skip propagation; the ledger and journal follow these. */
  readonly statuses: ReadonlyMap<string, NodeStatus>
  /** Settlement, present only when no node is running and none can start. */
  readonly settlement: RunSettlement
}

/**
 * Decide one tick of the run loop.
 * @param input - the document and the run's current state.
 * @returns the nodes to start, the skip-propagated statuses, and the settlement.
 */
export function planRunStep(input: RunStepInput): RunStep {
  const statuses = cascadeSkips(input.document, input.statuses)
  const start = planReadyNodes({
    document: input.document,
    statuses,
    active: input.active,
    limit: input.limit,
  })
  const settlement: RunSettlement = start.length === 0 && input.active.length === 0
    ? settleRun(input.document, statuses)
    : { settled: false }
  return { start, statuses, settlement }
}
