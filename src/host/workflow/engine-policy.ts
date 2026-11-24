/**
 * Run-level policy that sits between the pure scheduler (`ready.ts`) and the
 * host-bound executors: propagating skips, deciding when a run has settled,
 * and deciding whether a loop takes another round.
 *
 * All three are pure functions of the document plus current statuses, so the
 * engine's control flow is testable without a session or an agent.
 */
import type { NodeStatus } from '../events.ts'
import type { WorkflowDocument, WorkflowNode } from './domain.ts'
import { evalCondition } from './expr.ts'
import type { ExprFrame } from './expr.ts'
import { parseCondition } from './ready.ts'

/** Edge kinds that never gate a target's readiness. */
const NON_GATING_KINDS: ReadonlySet<string> = new Set(['loop-back', 'error'])

/** Settlements that turn a dependent node into a skip. */
const BLOCKING_STATUSES: ReadonlySet<NodeStatus> = new Set(['failed', 'skipped', 'cancelled'])

/**
 * Propagate skips through the graph until stable.
 *
 * A node whose gating upstream settled anything but `completed` can never run,
 * so it is marked `skipped` — the alternative is a run that waits forever for a
 * node that will never become ready.
 * @param document - the run's document.
 * @param statuses - current per-node statuses; already-settled nodes keep theirs.
 * @returns the status map with skips propagated.
 */
export function cascadeSkips(
  document: WorkflowDocument,
  statuses: ReadonlyMap<string, NodeStatus>,
): Map<string, NodeStatus> {
  const next = new Map(statuses)
  let changed = true
  while (changed) {
    changed = false
    for (const node of document.nodes) {
      if (next.has(node.id)) continue
      const gating = document.edges.filter((edge) => edge.to === node.id && !NON_GATING_KINDS.has(edge.kind))
      if (gating.some((edge) => {
        const source = next.get(edge.from)
        return source !== undefined && BLOCKING_STATUSES.has(source)
      })) {
        next.set(node.id, 'skipped')
        changed = true
      }
    }
  }
  return next
}

/** How a run ended. */
export type RunOutcome = 'completed' | 'failed' | 'cancelled'

/** Whether the run is finished, and how. */
export interface RunSettlement {
  readonly settled: boolean
  /** Present only when `settled` is true. */
  readonly outcome?: RunOutcome
}

/**
 * Decide whether a run has settled.
 * @param document - the run's document.
 * @param statuses - current per-node statuses (run `cascadeSkips` first).
 * @returns the settlement; a run with any running or unstarted node is not settled.
 */
export function settleRun(document: WorkflowDocument, statuses: ReadonlyMap<string, NodeStatus>): RunSettlement {
  for (const node of document.nodes) {
    const status = statuses.get(node.id)
    if (status === undefined || status === 'running') return { settled: false }
  }
  const all = [...statuses.values()]
  if (all.includes('failed')) return { settled: true, outcome: 'failed' }
  if (all.includes('cancelled')) return { settled: true, outcome: 'cancelled' }
  return { settled: true, outcome: 'completed' }
}

/** What a loop should do after one round. */
export type LoopRoundDecision =
  | { readonly kind: 'continue' }
  | { readonly kind: 'stop', readonly reason: 'converged' | 'max-iters' }
  | { readonly kind: 'fail', readonly reason: string }

/**
 * Decide whether one loop takes another round.
 * @param node - the loop node.
 * @param iteration - the round that just finished, one-based.
 * @param frame - the values in scope, including the round's node results.
 * @returns the decision the engine applies.
 * @throws {Error} when the `until` expression is not JSON or is outside the subset.
 */
export function decideLoopRound(
  node: WorkflowNode & { kind: 'loop' },
  iteration: number,
  frame: ExprFrame,
): LoopRoundDecision {
  if (iteration >= node.maxIters) {
    switch (node.onMaxIters) {
      case 'fail':
        return { kind: 'fail', reason: `loop "${node.id}" reached maxIters (${node.maxIters}) without converging` }
      case 'continue':
        return { kind: 'continue' }
      case 'stop':
        return { kind: 'stop', reason: 'max-iters' }
    }
  }
  const parsed = parseCondition(node.until.expr)
  return evalCondition(parsed, frame) ? { kind: 'stop', reason: 'converged' } : { kind: 'continue' }
}
