/**
 * Layout fixtures: fan-out, join, and loop topologies must land on stable
 * layers with no two nodes overlapping, and loop bodies must close inside
 * their visible rectangle.
 */
import { describe, expect, it } from 'vitest'
import { layoutWorkflow, type LayoutEdgeInput, type LayoutNodeInput, type PlacedNode } from '../src/client/graph/layout.ts'

/** Overlap predicate for two placed node rectangles. */
function overlaps(a: PlacedNode, b: PlacedNode): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** One flow edge with a generated id. */
function flow(from: string, to: string, kind = 'flow'): LayoutEdgeInput {
  return { id: `${from}->${to}`, from, to, kind }
}

describe('layoutWorkflow', () => {
  const fanOut = {
    nodes: [
      { id: 'start', kind: 'input' },
      { id: 'a', kind: 'agent' },
      { id: 'b', kind: 'agent' },
      { id: 'c', kind: 'script' },
      { id: 'join', kind: 'join' },
    ] satisfies LayoutNodeInput[],
    edges: [flow('start', 'a'), flow('start', 'b'), flow('start', 'c', 'fan-out'), flow('a', 'join'), flow('b', 'join'), flow('c', 'join', 'fan-in')],
  }

  it('lays a fan-out with join out in three layers without overlaps', () => {
    const layout = layoutWorkflow(fanOut.nodes, fanOut.edges)
    const layerOf = Object.fromEntries(layout.nodes.map((node) => [node.id, node.layer]))
    expect(layerOf).toEqual({ start: 0, a: 1, b: 1, c: 1, join: 2 })
    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        expect(overlaps(layout.nodes[i]!, layout.nodes[j]!)).toBe(false)
      }
    }
    expect(layout.loops).toEqual([])
  })

  const diamond = {
    nodes: [
      { id: 'entry', kind: 'input' },
      { id: 'left', kind: 'agent' },
      { id: 'right', kind: 'agent' },
      { id: 'sink', kind: 'output' },
    ] satisfies LayoutNodeInput[],
    edges: [flow('entry', 'left'), flow('entry', 'right'), flow('left', 'sink'), flow('right', 'sink')],
  }

  it('keeps diamond branches on one layer and stacks them apart', () => {
    const layout = layoutWorkflow(diamond.nodes, diamond.edges)
    const left = layout.nodes.find((node) => node.id === 'left')
    const right = layout.nodes.find((node) => node.id === 'right')
    expect(left?.layer).toBe(1)
    expect(right?.layer).toBe(1)
    expect(right!.y).toBeGreaterThan(left!.y)
    expect(overlaps(left!, right!)).toBe(false)
  })

  const loop = {
    nodes: [
      { id: 'pre', kind: 'input' },
      { id: 'loop', kind: 'loop', body: 'b1' },
      { id: 'b1', kind: 'agent' },
      { id: 'b2', kind: 'script' },
      { id: 'post', kind: 'output' },
    ] satisfies LayoutNodeInput[],
    edges: [
      flow('pre', 'loop'),
      flow('loop', 'b1'),
      flow('b1', 'b2'),
      flow('b2', 'b1', 'loop-back'),
      flow('loop', 'post'),
    ],
  }

  it('places the loop body right of the loop node and wraps it in a rectangle', () => {
    const layout = layoutWorkflow(loop.nodes, loop.edges)
    const layerOf = Object.fromEntries(layout.nodes.map((node) => [node.id, node.layer]))
    expect(layerOf).toEqual({ pre: 0, loop: 1, b1: 2, b2: 3, post: 2 })
    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        expect(overlaps(layout.nodes[i]!, layout.nodes[j]!)).toBe(false)
      }
    }
    const box = layout.loops.find((candidate) => candidate.loopId === 'loop')
    expect(box).toBeDefined()
    for (const bodyId of ['b1', 'b2']) {
      const node = layout.nodes.find((candidate) => candidate.id === bodyId)!
      expect(node.x).toBeGreaterThan(box!.x)
      expect(node.x + node.width).toBeLessThan(box!.x + box!.width)
      expect(node.y).toBeGreaterThan(box!.y)
      expect(node.y + node.height).toBeLessThan(box!.y + box!.height)
    }
    // The converged-output node is outside the body: its rectangle never
    // intersects the loop rectangle.
    const outside = layout.nodes.find((candidate) => candidate.id === 'post')!
    const outsideInsideBox = outside.x < box!.x + box!.width && box!.x < outside.x + outside.width
      && outside.y < box!.y + box!.height && box!.y < outside.y + outside.height
    expect(outsideInsideBox).toBe(false)
  })

  it('anchors every edge between known endpoints and drops unknown ones', () => {
    const layout = layoutWorkflow(loop.nodes, loop.edges)
    expect(layout.edges).toHaveLength(loop.edges.length)
    const back = layout.edges.find((edge) => edge.kind === 'loop-back')!
    const b1 = layout.nodes.find((node) => node.id === 'b1')!
    const b2 = layout.nodes.find((node) => node.id === 'b2')!
    expect(back.fromPoint.y).toBe(b2.y + b2.height)
    expect(back.toPoint.y).toBe(b1.y + b1.height)
    const ghost = layoutWorkflow(loop.nodes, [...loop.edges, flow('ghost', 'post')])
    expect(ghost.edges).toHaveLength(loop.edges.length)
  })
});
