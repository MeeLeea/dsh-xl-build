/**
 * Layered topology layout for the run board: nodes stack left to right by
 * topological layer, and each loop body is aggregated into one rectangle.
 *
 * The layout is a pure function of the node and edge subsets it is handed —
 * no React state, no services, no clock — so the same topology always
 * renders at the same coordinates. Callers project both a saved workflow
 * document and a live run view onto the same input shape.
 */

/** Geometry constants: one place to keep the board readable. */
const NODE_WIDTH = 168
const NODE_HEIGHT = 44
const GAP_X = 88
const GAP_Y = 20
const LOOP_PAD = 20
const ORIGIN_X = 24
const ORIGIN_Y = 24

/** One node of the layout input: a document node or a run-view node. */
export interface LayoutNodeInput {
  readonly id: string
  readonly kind: string
  /** Entry node of the body, present on loop nodes only. */
  readonly body?: string
}

/** One edge of the layout input; endpoints outside the subset drop the edge. */
export interface LayoutEdgeInput {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly kind: string
}

/** A point in layout coordinates. */
export interface LayoutPoint {
  readonly x: number
  readonly y: number
}

/** One node placed at its layer column and vertical slot. */
export interface PlacedNode {
  readonly id: string
  readonly kind: string
  /** Topological layer index, 0 at the left edge. */
  readonly layer: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One edge anchored between its endpoint nodes. */
export interface PlacedEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly kind: string
  /** Anchor on the source node: right midpoint, or bottom for loop-backs. */
  readonly fromPoint: LayoutPoint
  /** Anchor on the target node: left midpoint, or bottom for loop-backs. */
  readonly toPoint: LayoutPoint
}

/** The visible rectangle around one loop body. */
export interface LoopBox {
  readonly loopId: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The full layout result the SVG renderer draws. */
export interface WorkflowLayout {
  readonly nodes: readonly PlacedNode[]
  readonly edges: readonly PlacedEdge[]
  readonly loops: readonly LoopBox[]
  readonly width: number
  readonly height: number
}

/**
 * Compute the layered layout.
 * @param nodes - node subset in display order.
 * @param edges - edge subset in display order.
 * @returns coordinates for every known node, plus loop rectangles.
 */
export function layoutWorkflow(nodes: readonly LayoutNodeInput[], edges: readonly LayoutEdgeInput[]): WorkflowLayout {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const layer = layersOf(nodes, edges)
  const placed = placeNodes(nodes, layer)
  const boxes = loopBoxes(nodes, byId, edges, placed)
  return {
    nodes: placed,
    edges: edges.flatMap((edge) => placeEdge(edge, placed)),
    loops: boxes,
    ...extentOf(placed, boxes),
  }
}

/**
 * Longest-path layering over non-loop-back edges: sources sit at layer 0 and
 * every other node one past its deepest predecessor. Loop-backs carry no
 * layer so the return path never drags the body rightward.
 * @param nodes - node subset.
 * @param edges - edge subset.
 * @returns layer index per node id.
 */
function layersOf(nodes: readonly LayoutNodeInput[], edges: readonly LayoutEdgeInput[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const layer = new Map(nodes.map((node) => [node.id, 0]))
  const forward = edges.filter((edge) => edge.kind !== 'loop-back'
    && byId.has(edge.from) && byId.has(edge.to) && edge.from !== edge.to)
  for (let round = 0; round < nodes.length; round += 1) {
    let moved = false
    for (const edge of forward) {
      const next = (layer.get(edge.from) ?? 0) + 1
      if (next > (layer.get(edge.to) ?? 0)) {
        layer.set(edge.to, next)
        moved = true
      }
    }
    if (!moved) return layer
  }
  return layer
}

/**
 * Position one node per layer column; within a layer, input order fixes the
 * vertical slot so the same topology always lands on the same rows.
 * @param nodes - node subset in display order.
 * @param layer - layer index per node id.
 * @returns placed nodes in input order.
 */
function placeNodes(nodes: readonly LayoutNodeInput[], layer: Map<string, number>): PlacedNode[] {
  const slot = new Map<number, number>()
  return nodes.map((node) => {
    const layerIndex = layer.get(node.id) ?? 0
    const row = slot.get(layerIndex) ?? 0
    slot.set(layerIndex, row + 1)
    return {
      id: node.id,
      kind: node.kind,
      layer: layerIndex,
      x: ORIGIN_X + layerIndex * (NODE_WIDTH + GAP_X),
      y: ORIGIN_Y + row * (NODE_HEIGHT + GAP_Y),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }
  })
}

/**
 * Body closure of one loop: nodes reachable from the body entry without
 * crossing a loop-back edge. Nested loop nodes stay outside the parent body
 * set, so each rectangle wraps its own body only.
 * @param loop - the loop node.
 * @param byId - node subset by id.
 * @param edges - edge subset.
 * @returns body node ids including the entry.
 */
function bodyOf(loop: LayoutNodeInput, byId: Map<string, LayoutNodeInput>, edges: readonly LayoutEdgeInput[]): Set<string> {
  const inside = new Set<string>()
  if (loop.body === undefined || !byId.has(loop.body)) return inside
  const queue = [loop.body]
  inside.add(loop.body)
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) return inside
    for (const edge of edges) {
      if (edge.kind === 'loop-back' || edge.from !== current) continue
      const next = byId.get(edge.to)
      if (next === undefined || next.kind === 'loop' || inside.has(edge.to)) continue
      inside.add(edge.to)
      queue.push(edge.to)
    }
  }
  return inside
}

/**
 * One rectangle per loop, padded around its body nodes. A node claimed by
 * nested loops belongs to the smallest closure, keeping inner rectangles
 * strictly inside their parent.
 * @param nodes - node subset.
 * @param byId - node subset by id.
 * @param edges - edge subset.
 * @param placed - placed nodes by id.
 * @returns loop rectangles in input order.
 */
function loopBoxes(
  nodes: readonly LayoutNodeInput[],
  byId: Map<string, LayoutNodeInput>,
  edges: readonly LayoutEdgeInput[],
  placed: readonly PlacedNode[],
): LoopBox[] {
  const claims = new Map<string, string>()
  const loops = nodes.filter((node) => node.kind === 'loop' && node.body !== undefined)
  const closures = loops.map((loop) => ({ loop, body: bodyOf(loop, byId, edges) }))
    .sort((a, b) => a.body.size - b.body.size)
  for (const { loop, body } of closures) {
    for (const nodeId of body) {
      if (!claims.has(nodeId)) claims.set(nodeId, loop.id)
    }
  }
  return loops.flatMap((loop) => {
    const members = placed.filter((node) => claims.get(node.id) === loop.id)
    if (members.length === 0) return []
    const left = Math.min(...members.map((node) => node.x))
    const right = Math.max(...members.map((node) => node.x + node.width))
    const top = Math.min(...members.map((node) => node.y))
    const bottom = Math.max(...members.map((node) => node.y + node.height))
    return [{
      loopId: loop.id,
      x: left - LOOP_PAD,
      y: top - LOOP_PAD,
      width: right - left + LOOP_PAD * 2,
      height: bottom - top + LOOP_PAD * 2,
    }]
  })
}

/**
 * Anchor one edge between its endpoint nodes; either endpoint outside the
 * subset drops the edge silently, and a loop-back anchors along the bottom
 * so the renderer can curve it back under the body.
 * @param edge - edge subset entry.
 * @param placed - placed nodes by id.
 * @returns the placed edge, or nothing when an endpoint is unknown.
 */
function placeEdge(edge: LayoutEdgeInput, placed: readonly PlacedNode[]): PlacedEdge[] {
  const from = placed.find((node) => node.id === edge.from)
  const to = placed.find((node) => node.id === edge.to)
  if (from === undefined || to === undefined) return []
  if (edge.kind === 'loop-back') {
    return [{ ...edge, fromPoint: bottomOf(from), toPoint: bottomOf(to) }]
  }
  return [{
    ...edge,
    fromPoint: { x: from.x + from.width, y: from.y + from.height / 2 },
    toPoint: { x: to.x, y: to.y + to.height / 2 },
  }]
}

/** Bottom midpoint of one placed node. */
function bottomOf(node: PlacedNode): LayoutPoint {
  return { x: node.x + node.width / 2, y: node.y + node.height }
}

/** Board extent: placed nodes and loop rectangles plus their margins. */
function extentOf(placed: readonly PlacedNode[], boxes: readonly LoopBox[]): { width: number, height: number } {
  let width = ORIGIN_X
  let height = ORIGIN_Y
  for (const node of placed) {
    width = Math.max(width, node.x + node.width + GAP_X / 2)
    height = Math.max(height, node.y + node.height + GAP_Y / 2)
  }
  for (const box of boxes) {
    width = Math.max(width, box.x + box.width + GAP_X / 2)
    height = Math.max(height, box.y + box.height + GAP_Y / 2)
  }
  return { width, height }
}
