/** The SVG board classes node shapes by run status and labels edges with wire state. */
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { layoutWorkflow } from '../src/client/graph/layout.ts'
import { WorkflowGraph, type GraphEdgeState, type GraphNodeStatus } from '../src/client/graph/render.tsx'

/** Chain fixture: input -> agent -> output, all flow edges. */
const CHAIN = layoutWorkflow(
  [
    { id: 'start', kind: 'input' },
    { id: 'research', kind: 'agent' },
    { id: 'done', kind: 'output' },
  ],
  [
    { id: 'e1', from: 'start', to: 'research', kind: 'flow' },
    { id: 'e2', from: 'research', to: 'done', kind: 'flow' },
  ],
)

it('renders node status classes over the kind shapes', () => {
  const statuses: Record<string, GraphNodeStatus> = {
    start: 'completed',
    research: 'running',
  }
  const markup = renderToStaticMarkup(
    <WorkflowGraph layout={CHAIN} nodeStatuses={statuses} />,
  )
  expect(markup).toContain('nodeStatusRunning')
  expect(markup).toContain('nodeStatusCompleted')
  expect(markup).toContain('nodeIdle')
  expect(markup).toContain('data-node-id="research"')
})

it('labels edges with format, byte size, and the truncation mark', () => {
  const edges: Record<string, GraphEdgeState> = {
    e1: { status: 'transferred', format: 'text', bytes: 13 },
    e2: { status: 'truncated', format: 'json', bytes: 2048 },
  }
  const markup = renderToStaticMarkup(
    <WorkflowGraph layout={CHAIN} edgeStates={edges} />,
  )
  expect(markup).toContain('text \u00b7 13B')
  expect(markup).toContain('json \u00b7 2048B')
  expect(markup).toContain('[truncated]')
  expect(markup).toContain('edgeTransferred')
  expect(markup).toContain('edgeTruncated')
})

it('marks the selected node and renders kind shapes for every kind', () => {
  const LAYOUT = layoutWorkflow(
    [
      { id: 'in', kind: 'input' },
      { id: 'route', kind: 'router' },
      { id: 'a', kind: 'agent' },
      { id: 'b', kind: 'script' },
      { id: 'wait', kind: 'join' },
      { id: 'body', kind: 'loop', body: 'a' },
      { id: 'n', kind: 'note' },
      { id: 'sub', kind: 'subworkflow' },
      { id: 'out', kind: 'output' },
    ],
    [
      { id: 'r1', from: 'in', to: 'route', kind: 'flow' },
      { id: 'r2', from: 'route', to: 'a', kind: 'flow' },
      { id: 'r3', from: 'route', to: 'b', kind: 'flow' },
      { id: 'r4', from: 'a', to: 'wait', kind: 'flow' },
      { id: 'r5', from: 'b', to: 'wait', kind: 'flow' },
    ],
  )
  const markup = renderToStaticMarkup(
    <WorkflowGraph layout={LAYOUT} selectedNodeId="route" />,
  )
  expect(markup).toContain('nodeSelected')
  expect(markup).toContain('data-node-id="route"')
})

it('renders the loop box and drops edges whose endpoints are missing', () => {
  const LAYOUT = layoutWorkflow(
    [
      { id: 'pre', kind: 'agent' },
      { id: 'loop', kind: 'loop', body: 'b1' },
      { id: 'b1', kind: 'agent' },
    ],
    [
      { id: 'l1', from: 'pre', to: 'loop', kind: 'flow' },
      { id: 'l2', from: 'loop', to: 'b1', kind: 'flow' },
      { id: 'l3', from: 'b1', to: 'b1', kind: 'loop-back' },
      { id: 'ghost', from: 'b1', to: 'nowhere', kind: 'flow' },
    ],
  )
  const markup = renderToStaticMarkup(
    <WorkflowGraph layout={LAYOUT} edgeStates={{ l3: { status: 'transferred', format: 'text' } }} />,
  )
  expect(markup).toContain('loopBox')
  expect(markup).toContain('data-edge-id="l3"')
  expect(markup).not.toContain('data-edge-id="ghost"')
  expect(markup).toContain('text</text>')
})
