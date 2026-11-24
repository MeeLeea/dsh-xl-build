/**
 * Graph-level workflow validation (V5-V17): reachability, cycles, loop
 * closure, references, scale caps, and failure edges. The id and edge-shape
 * rules (V1-V4) live in `validate.ts`, which calls this module.
 *
 * V8 and V15 are read together: V8 proves the graph minus loop-back edges is
 * acyclic, V15 proves each loop body is a self-contained subgraph.
 */
import type { AgentContext, WorkflowDocument, WorkflowEdge, WorkflowNode } from './domain.ts'
import { templateRefs } from './template.ts'
import type { ValidationIssue } from './validate.ts'

/** Resolves a workflow id for subworkflow reference checks. */
export interface WorkflowCatalog {
  get(id: string): WorkflowDocument | undefined
}

/** Inputs the cross-document rules need. */
export interface ValidateOptions {
  /** Catalog of loadable workflows; required when the document has subworkflow nodes. */
  readonly catalog?: WorkflowCatalog
}

/** Scale caps from the validation table (V14). */
const MAX_NODES = 200
const MAX_EDGES = 800
const MAX_FAN_OUT = 32

/** Append one value to a map-of-arrays. */
function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

/** Ids reachable from `start` over the accepted edges. */
function reachableFrom(start: string, edges: readonly WorkflowEdge[], accept: (edge: WorkflowEdge) => boolean): Set<string> {
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) continue
    for (const edge of edges) {
      if (edge.from !== current || !accept(edge) || seen.has(edge.to)) continue
      seen.add(edge.to)
      queue.push(edge.to)
    }
  }
  return seen
}

/** Every template string a document contains, with the node or edge that owns it. */
function templateStrings(document: WorkflowDocument): { text: string, nodeId?: string, edgeId?: string }[] {
  const found: { text: string, nodeId?: string, edgeId?: string }[] = []
  for (const node of document.nodes) {
    if (node.kind === 'agent') found.push({ text: node.task, nodeId: node.id })
    if (node.kind === 'output') found.push({ text: node.value, nodeId: node.id })
    if (node.kind === 'tool') {
      for (const value of Object.values(node.args)) found.push({ text: value, nodeId: node.id })
    }
    if (node.kind === 'subworkflow') {
      for (const value of Object.values(node.inputs)) found.push({ text: value, nodeId: node.id })
    }
  }
  for (const edge of document.edges) {
    if (edge.template !== undefined) found.push({ text: edge.template, edgeId: edge.id })
  }
  return found
}

/** Walk subworkflow references to find a cycle, when the catalog resolves them. */
function findReferenceCycle(document: WorkflowDocument, catalog: WorkflowCatalog | undefined): string[] | undefined {
  if (catalog === undefined) return undefined
  const path: string[] = []
  const onPath = new Set<string>()
  const done = new Set<string>()
  const visit = (current: WorkflowDocument): string[] | undefined => {
    if (onPath.has(current.id)) return [...path.slice(path.indexOf(current.id)), current.id]
    if (done.has(current.id)) return undefined
    onPath.add(current.id)
    path.push(current.id)
    for (const node of current.nodes) {
      if (node.kind !== 'subworkflow') continue
      const next = catalog.get(node.workflow)
      if (next === undefined) continue
      const cycle = visit(next)
      if (cycle !== undefined) return cycle
    }
    path.pop()
    onPath.delete(current.id)
    done.add(current.id)
    return undefined
  }
  return visit(document)
}

/**
 * Validate the graph-level rules of one parsed workflow document.
 * @param document - the document to check; V1-V4 are assumed already checked.
 * @param options - the catalog used by subworkflow rules.
 * @returns every V5-V17 violation found.
 */
export function validateWorkflowGraph(document: WorkflowDocument, options: ValidateOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  const edgeIds = new Set(document.edges.map((edge) => edge.id))
  const outEdges = new Map<string, WorkflowEdge[]>()
  const inEdges = new Map<string, WorkflowEdge[]>()
  for (const edge of document.edges) {
    push(outEdges, edge.from, edge)
    push(inEdges, edge.to, edge)
  }
  const outOf = (id: string): readonly WorkflowEdge[] => outEdges.get(id) ?? []
  const inOf = (id: string): readonly WorkflowEdge[] => inEdges.get(id) ?? []
  const isLoopBack = (edge: WorkflowEdge): boolean => edge.kind === 'loop-back'

  // V5: every node is reachable from the entry.
  if (nodesById.has(document.entry)) {
    const reachableIds = reachableFrom(document.entry, document.edges, () => true)
    for (const node of document.nodes) {
      if (!reachableIds.has(node.id)) {
        issues.push({ rule: 'V5', message: `node "${node.id}" is not reachable from the entry`, nodeId: node.id })
      }
    }
  }

  // V6/V7: router and join edge kinds.
  for (const node of document.nodes) {
    if (node.kind === 'router') {
      const outgoing = outOf(node.id)
      for (const edge of outgoing) {
        if (edge.kind !== 'branch') {
          issues.push({ rule: 'V6', message: `router "${node.id}" out-edge "${edge.id}" must be kind branch`, edgeId: edge.id })
        }
      }
      const elseEdges = outgoing.filter((edge) => edge.condition === undefined)
      if (elseEdges.length !== 1) {
        issues.push({ rule: 'V6', message: `router "${node.id}" needs exactly one else branch, found ${elseEdges.length}`, nodeId: node.id })
      } else if (elseEdges[0]?.to !== node.else) {
        issues.push({ rule: 'V6', message: `router "${node.id}" else target "${node.else}" has no matching edge`, nodeId: node.id })
      }
    }
    if (node.kind === 'join') {
      for (const edge of inOf(node.id)) {
        if (edge.kind !== 'fan-in') {
          issues.push({ rule: 'V7', message: `join "${node.id}" in-edge "${edge.id}" must be kind fan-in`, edgeId: edge.id })
        }
      }
      for (const edge of outOf(node.id)) {
        if (edge.kind !== 'flow') {
          issues.push({ rule: 'V7', message: `join "${node.id}" out-edge "${edge.id}" must be kind flow`, edgeId: edge.id })
        }
      }
    }
  }

  // V8: removing every loop-back edge leaves an acyclic graph (Kahn).
  const acyclicEdges = document.edges.filter((edge) => !isLoopBack(edge))
  const inDegree = new Map<string, number>(document.nodes.map((node) => [node.id, 0]))
  for (const edge of acyclicEdges) {
    if (nodesById.has(edge.to)) inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
  }
  const queue = [...inDegree].filter(([, degree]) => degree === 0).map(([id]) => id)
  let settled = 0
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) continue
    settled += 1
    for (const edge of acyclicEdges) {
      if (edge.from !== current || !nodesById.has(edge.to)) continue
      const degree = (inDegree.get(edge.to) ?? 0) - 1
      inDegree.set(edge.to, degree)
      if (degree === 0) queue.push(edge.to)
    }
  }
  if (settled !== document.nodes.length) {
    issues.push({ rule: 'V8', message: 'the graph excluding loop-back edges contains a cycle' })
  }

  // V10/V9: loop bodies exist, are not the loop itself, and own their loop-back edges.
  const bodySets = new Map<string, Set<string>>()
  for (const node of document.nodes) {
    if (node.kind !== 'loop') continue
    if (!nodesById.has(node.body)) {
      issues.push({ rule: 'V10', message: `loop "${node.id}" body "${node.body}" is not a node`, nodeId: node.id })
      continue
    }
    if (node.body === node.id) {
      issues.push({ rule: 'V10', message: `loop "${node.id}" cannot contain itself`, nodeId: node.id })
      continue
    }
    // The body extends from `body` up to (not through) each round's end: a node
    // that loops back starts the next iteration, so its other edges are the
    // boundary-crossing candidates V15 rejects.
    const cycleEnds = new Set(document.edges
      .filter((edge) => isLoopBack(edge) && edge.to === node.id)
      .map((edge) => edge.from))
    bodySets.set(node.id, reachableFrom(
      node.body,
      document.edges,
      (edge) => !isLoopBack(edge) && !cycleEnds.has(edge.from),
    ))
  }
  for (const edge of document.edges) {
    if (!isLoopBack(edge)) continue
    const target = nodesById.get(edge.to)
    if (target?.kind !== 'loop') {
      issues.push({ rule: 'V9', message: `loop-back edge "${edge.id}" must end at a loop node`, edgeId: edge.id })
      continue
    }
    const bodySet = bodySets.get(target.id)
    if (bodySet !== undefined && !bodySet.has(edge.from)) {
      issues.push({ rule: 'V9', message: `loop-back edge "${edge.id}" starts outside loop "${target.id}" body`, edgeId: edge.id })
    }
  }

  // V15: a loop body is closed — only the loop node itself may cross the boundary.
  for (const [loopId, bodySet] of bodySets) {
    for (const edge of document.edges) {
      if (isLoopBack(edge) || edge.from === loopId) continue
      if (bodySet.has(edge.from) !== bodySet.has(edge.to)) {
        issues.push({ rule: 'V15', message: `edge "${edge.id}" crosses the body boundary of loop "${loopId}"`, edgeId: edge.id })
      }
    }
  }

  // V11: subworkflow references resolve, and the reference graph is acyclic.
  for (const node of document.nodes) {
    if (node.kind !== 'subworkflow') continue
    if (options.catalog === undefined) {
      issues.push({ rule: 'V11', message: `cannot verify subworkflow "${node.workflow}" without a workflow catalog`, nodeId: node.id })
      continue
    }
    if (options.catalog.get(node.workflow) === undefined) {
      issues.push({ rule: 'V11', message: `subworkflow "${node.workflow}" does not exist`, nodeId: node.id })
    }
  }
  const cycle = findReferenceCycle(document, options.catalog)
  if (cycle !== undefined) {
    issues.push({ rule: 'V11', message: `subworkflow reference cycle: ${cycle.join(' -> ')}` })
  }

  // V12: a json edge requires the upstream node to declare an output schema.
  for (const edge of document.edges) {
    if (edge.format !== 'json') continue
    const upstream = nodesById.get(edge.from)
    if (upstream?.kind !== 'agent' || upstream.outputSchema === undefined) {
      issues.push({ rule: 'V12', message: `json edge "${edge.id}" requires an upstream output schema`, edgeId: edge.id })
    }
  }

  // V13: template references name existing inputs, nodes, and edges.
  const inputNames = new Set(document.nodes.flatMap((node) => (node.kind === 'input' ? node.params.map((param) => param.name) : [])))
  for (const entry of templateStrings(document)) {
    for (const ref of templateRefs(entry.text)) {
      const [root, name] = ref.split('.')
      if (root === 'memory') continue
      if (root === undefined || name === undefined || name === '') {
        issues.push({ rule: 'V13', message: `unusable template reference "{{${ref}}}"`, ...entry })
        continue
      }
      const exists = root === 'input'
        ? inputNames.has(name)
        : root === 'nodes'
          ? nodesById.has(name)
          : root === 'edges'
            ? edgeIds.has(name)
            : false
      if (!exists) {
        issues.push({ rule: 'V13', message: `template reference "{{${ref}}}" names no known ${root}`, ...entry })
      }
    }
  }

  // V14: scale caps.
  if (document.nodes.length > MAX_NODES) {
    issues.push({ rule: 'V14', message: `${document.nodes.length} nodes exceeds the cap of ${MAX_NODES}` })
  }
  if (document.edges.length > MAX_EDGES) {
    issues.push({ rule: 'V14', message: `${document.edges.length} edges exceeds the cap of ${MAX_EDGES}` })
  }
  for (const node of document.nodes) {
    const fanOut = outOf(node.id).length
    if (fanOut > MAX_FAN_OUT) {
      issues.push({ rule: 'V14', message: `node "${node.id}" fans out to ${fanOut} nodes, over the cap of ${MAX_FAN_OUT}`, nodeId: node.id })
    }
  }

  // V16: context choices.
  const hasInputNode = document.nodes.some((node) => node.kind === 'input')
  for (const node of document.nodes) {
    if (node.kind !== 'agent') continue
    const context: AgentContext = node.context
    if (context !== 'none' && 'from' in context && context.from === 'run-input' && !hasInputNode) {
      issues.push({ rule: 'V16', message: `node "${node.id}" reads the run input but the document has no input node`, nodeId: node.id })
    }
    if (context !== 'none' && 'lastMessages' in context && (!Number.isInteger(context.lastMessages) || context.lastMessages < 1)) {
      issues.push({ rule: 'V16', message: `node "${node.id}" needs a positive lastMessages count`, nodeId: node.id })
    }
    if (node.self && context === 'none') {
      issues.push({ rule: 'V16', message: `self node "${node.id}" must choose a non-none context`, nodeId: node.id })
    }
  }

  // V17: at most one failure edge, and it must not join or loop.
  const errorEdges = document.edges.filter((edge) => edge.kind === 'error')
  if (errorEdges.length > 1) {
    issues.push({ rule: 'V17', message: `at most one error edge is allowed, found ${errorEdges.length}` })
  }
  for (const edge of errorEdges) {
    const target: WorkflowNode | undefined = nodesById.get(edge.to)
    if (target !== undefined && (target.kind === 'loop' || target.kind === 'join')) {
      issues.push({ rule: 'V17', message: `error edge "${edge.id}" must not end at a ${target.kind} node`, edgeId: edge.id })
    }
  }

  return issues
}
