/**
 * Executors for the node kinds that need no host service, plus the frame
 * bookkeeping every node shares.
 *
 * `input`, `note`, `output`, and `router` are pure functions of the document
 * and the current frame, so they are testable without a session, a tool
 * registry, or a subagent. The kinds that need a host service (`agent`,
 * `script`, `tool`, `join`, `loop`, `subworkflow`) are owned by the host-bound
 * executor and return `undefined` here rather than faking a result.
 */
import type { ArtifactRef, NodeErrorClass } from '../events.ts'
import type { WorkflowNode } from './domain.ts'
import type { ExprFrame } from './expr.ts'
import { selectBranchTarget } from './ready.ts'
import { renderTemplate } from './template.ts'
import type { TemplateFrame } from './template.ts'

/** Outcomes a node execution can settle with inside the engine. */
export type NodeSettlement = 'completed' | 'failed' | 'skipped'

/** Result of executing one node. */
export interface NodeOutcome {
  readonly status: NodeSettlement
  /** Value downstream edges and templates read. */
  readonly output: unknown
  /** Router only: the node id the taken branch leads to. */
  readonly nextNode?: string
  /** Present when the node failed. */
  readonly error?: { readonly class: NodeErrorClass, readonly message: string }
  readonly artifacts?: readonly ArtifactRef[]
}

/** Record one node's output in the frame. */
export function withNodeOutput(frame: ExprFrame, nodeId: string, output: unknown): ExprFrame {
  return { ...frame, nodes: { ...frame.nodes, [nodeId]: output } }
}

/** Record one edge's payload in the frame. */
export function withEdgePayload(frame: ExprFrame, edgeId: string, payload: unknown): ExprFrame {
  return { ...frame, edges: { ...frame.edges, [edgeId]: payload } }
}

/** One input node's declared parameters. */
export type InputParams = Extract<WorkflowNode, { kind: 'input' }>['params']

/** Resolved run inputs plus the required parameters the caller omitted. */
export interface ResolvedRunInputs {
  readonly inputs: Record<string, unknown>
  readonly missing: string[]
}

/**
 * Resolve the run inputs an `input` node declares.
 * @param params - the declared parameters.
 * @param supplied - the values the caller supplied.
 * @returns the resolved inputs (supplied wins over the declared default) and
 *   the names of required parameters that resolved to nothing.
 */
export function resolveRunInputs(params: InputParams, supplied: Record<string, unknown>): ResolvedRunInputs {
  const inputs: Record<string, unknown> = {}
  const missing: string[] = []
  for (const param of params) {
    const value = supplied[param.name] ?? param.default
    if (value === undefined) {
      if (param.required) missing.push(param.name)
      continue
    }
    inputs[param.name] = value
  }
  return { inputs, missing }
}

/**
 * Execute one node kind that needs no host service.
 * @param node - the node to run.
 * @param frame - the values in scope (inputs, node results, edge payloads, memory).
 * @returns the outcome, or undefined when the host-bound executor owns this kind.
 */
export function executeDeterministicNode(node: WorkflowNode, frame: TemplateFrame): NodeOutcome | undefined {
  switch (node.kind) {
    case 'input':
      // The run inputs are resolved by the caller; the node itself only declares them.
      return { status: 'completed', output: undefined }
    case 'note':
      return { status: 'completed', output: undefined }
    case 'output':
      return { status: 'completed', output: renderTemplate(node.value, frame) }
    case 'router':
      return { status: 'completed', output: undefined, nextNode: selectBranchTarget(node, frame) }
    default:
      return undefined
  }
}
