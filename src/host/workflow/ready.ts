/**
 * The engine's scheduling decisions, kept pure so execution order is testable
 * without a session, an agent, or a clock.
 *
 * A node is ready when every edge that must precede it has a completed source.
 * Loop-back edges belong to the loop node's round bookkeeping, so they never
 * gate readiness. An error edge selects a recovery handler only on failure: its
 * target is ready once a source failed and no source is still unresolved. A join
 * whose strategy is not `all` is gated by the engine's own join logic, so it
 * becomes ready as soon as any upstream completed.
 */
import type { NodeStatus } from '../events.ts'
import type { WorkflowDocument, WorkflowEdge, WorkflowNode } from './domain.ts'
import { evalCondition, isExpr, validateExpr } from './expr.ts'
import type { Expr, ExprFrame } from './expr.ts'

/** Everything one scheduling step needs. */
export interface ScheduleInput {
  readonly document: WorkflowDocument
  /** Status per node id; an absent id means "not started yet". */
  readonly statuses: ReadonlyMap<string, NodeStatus>
  /** Node ids the engine is running right now. */
  readonly active: readonly string[]
  /** Concurrent-node budget (`Config.maxConcurrentNodes`). */
  readonly limit: number
}

/** Edge kinds that never gate readiness of their target. */
const NON_GATING_KINDS: ReadonlySet<WorkflowEdge['kind']> = new Set(['loop-back', 'error'])

/** Whether every gating upstream of one node has completed. */
function dependenciesMet(
  document: WorkflowDocument,
  node: WorkflowNode,
  statuses: ReadonlyMap<string, NodeStatus>,
): boolean {
  const incoming = document.edges.filter((edge) => edge.to === node.id && !NON_GATING_KINDS.has(edge.kind))
  const gatingMet = incoming.length === 0
    ? true
    : node.kind === 'join' && node.strategy !== 'all'
      ? incoming.some((edge) => statuses.get(edge.from) === 'completed')
      : incoming.every((edge) => statuses.get(edge.from) === 'completed')
  if (!gatingMet) return false
  const errorSources = document.edges
    .filter((edge) => edge.to === node.id && edge.kind === 'error')
    .map((edge) => statuses.get(edge.from))
  if (errorSources.length === 0) return true
  const anyFailed = errorSources.some((status) => status === 'failed')
  const anyPending = errorSources.some((status) => status === undefined || status === 'running')
  return anyFailed && !anyPending
}

/**
 * Choose the nodes that may start now.
 * @param input - the document, current statuses, running nodes, and budget.
 * @returns node ids in document order, at most the remaining budget.
 */
export function planReadyNodes(input: ScheduleInput): string[] {
  const ready: string[] = []
  const budget = input.limit - input.active.length
  if (budget <= 0) return ready
  const running = new Set(input.active)
  for (const node of input.document.nodes) {
    if (running.has(node.id) || input.statuses.has(node.id)) continue
    if (!dependenciesMet(input.document, node, input.statuses)) continue
    ready.push(node.id)
    if (ready.length >= budget) break
  }
  return ready
}

/**
 * Parse and validate one router condition (JSONLogic text).
 * @param text - the condition as stored on the branch or edge.
 * @returns the validated expression.
 * @throws {Error} when the text is not JSON or falls outside the operator subset.
 */
export function parseCondition(text: string): Expr {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`condition is not JSON: ${(error as Error).message}`)
  }
  if (!isExpr(parsed)) {
    throw new Error(`condition is not a valid expression: ${validateExpr(parsed).join('; ')}`)
  }
  return parsed
}

/**
 * Select the router branch that applies to one frame.
 * @param router - the router node.
 * @param frame - the values in scope.
 * @returns the id of the branch target, or the router's else target when no condition matched.
 */
export function selectBranchTarget(router: WorkflowNode & { kind: 'router' }, frame: ExprFrame): string {
  for (const branch of router.branches) {
    if (evalCondition(parseCondition(branch.when), frame)) return branch.to
  }
  return router.else
}
