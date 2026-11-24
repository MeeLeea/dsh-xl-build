/**
 * Structural workflow validation. Every rule runs before a run starts and any
 * failure rejects the whole document with the offending node or edge id — the
 * engine never silently skips a broken branch.
 *
 * Rules V1-V4 live here (document shape and local edge rules); the graph-wide
 * rules V5-V17 live in `validate-graph.ts` and run from this entry point, so
 * callers have exactly one validator to call.
 */
import { WORKFLOW_ID_PATTERN } from './domain.ts'
import type { WorkflowDocument, WorkflowNode } from './domain.ts'
import { validateWorkflowGraph } from './validate-graph.ts'
import type { ValidateOptions } from './validate-graph.ts'

export type { ValidateOptions, WorkflowCatalog } from './validate-graph.ts'

/** One rejected workflow invariant. */
export interface ValidationIssue {
  /** Rule id from the validation table (`V1`, `V2`, ...). */
  readonly rule: string
  readonly message: string
  readonly nodeId?: string
  readonly edgeId?: string
}

/** Node kinds that terminate a path and therefore carry no out-edge. */
const TERMINAL_KINDS: ReadonlySet<WorkflowNode['kind']> = new Set(['output', 'note'])

/**
 * Validate one parsed workflow document.
 * @param document - the document to check.
 * @param options - the catalog used by the subworkflow rules.
 * @returns every violation found; an empty list means the document passes.
 */
export function validateWorkflow(document: WorkflowDocument, options: ValidateOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()

  // V1: ids are globally unique and match the naming pattern.
  for (const node of document.nodes) {
    if (nodeIds.has(node.id)) issues.push({ rule: 'V1', message: `duplicate node id "${node.id}"`, nodeId: node.id })
    nodeIds.add(node.id)
    if (!WORKFLOW_ID_PATTERN.test(node.id)) {
      issues.push({ rule: 'V1', message: `node id "${node.id}" does not match the naming pattern`, nodeId: node.id })
    }
  }
  for (const edge of document.edges) {
    if (edgeIds.has(edge.id)) issues.push({ rule: 'V1', message: `duplicate edge id "${edge.id}"`, edgeId: edge.id })
    edgeIds.add(edge.id)
    if (!WORKFLOW_ID_PATTERN.test(edge.id)) {
      issues.push({ rule: 'V1', message: `edge id "${edge.id}" does not match the naming pattern`, edgeId: edge.id })
    }
  }

  // V2: the entry exists and nothing but a loop-back edge enters it.
  if (!nodeIds.has(document.entry)) {
    issues.push({ rule: 'V2', message: `entry "${document.entry}" is not a node` })
  } else {
    for (const edge of document.edges) {
      if (edge.to === document.entry && edge.kind !== 'loop-back') {
        issues.push({
          rule: 'V2',
          message: `entry "${document.entry}" has a non-loop-back in-edge`,
          edgeId: edge.id,
        })
      }
    }
  }

  // V3: every edge endpoint exists, and no node is its own source and target.
  for (const edge of document.edges) {
    if (!nodeIds.has(edge.from)) {
      issues.push({ rule: 'V3', message: `edge "${edge.id}" starts at unknown node "${edge.from}"`, edgeId: edge.id })
    }
    if (!nodeIds.has(edge.to)) {
      issues.push({ rule: 'V3', message: `edge "${edge.id}" ends at unknown node "${edge.to}"`, edgeId: edge.id })
    }
    if (edge.from === edge.to) {
      issues.push({ rule: 'V3', message: `edge "${edge.id}" is a self-loop; use a loop node instead`, edgeId: edge.id })
    }
  }

  // V4: out-degree and in-degree by node kind.
  const outDegree = new Map<string, number>()
  for (const edge of document.edges) {
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1)
  }
  for (const node of document.nodes) {
    const outgoing = outDegree.get(node.id) ?? 0
    if (TERMINAL_KINDS.has(node.kind) && outgoing > 0) {
      issues.push({ rule: 'V4', message: `${node.kind} node "${node.id}" must not have out-edges`, nodeId: node.id })
    }
    if (!TERMINAL_KINDS.has(node.kind) && outgoing === 0) {
      issues.push({ rule: 'V4', message: `${node.kind} node "${node.id}" has no out-edge`, nodeId: node.id })
    }
    if (node.kind === 'note' && document.edges.some((edge) => edge.to === node.id)) {
      issues.push({ rule: 'V4', message: `note node "${node.id}" must not have in-edges`, nodeId: node.id })
    }
  }

  return [...issues, ...validateWorkflowGraph(document, options)]
}
