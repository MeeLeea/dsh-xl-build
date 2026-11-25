// @vitest-environment jsdom
/** The SVG board paints node status on the node group, labels edges with wire state, and exposes clickable nodes to the keyboard. */
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { layoutWorkflow } from '../src/client/graph/layout.ts'
import { WorkflowGraph, type GraphEdgeState, type GraphNodeStatus } from '../src/client/graph/render.tsx'

afterEach(cleanup)

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

/** Query a selector the fixture guarantees, failing loudly when it is absent. */
function mustQuery(container: HTMLElement, selector: string): Element {
  const node = container.querySelector(selector)
  if (node === null) throw new Error('missing ' + selector)
  return node
}

it('renders node status classes over the kind shapes', () => {
  const statuses: Record<string, GraphNodeStatus> = {
    start: 'completed',
    research: 'running',
  }
  const markup = renderToStaticMarkup(
    <WorkflowGraph layout={CHAIN} ariaLabel="board" nodeStatuses={statuses} />,
  )
  expect(markup).toContain('nodeStatusRunning')
  expect(markup).toContain('nodeStatusCompleted')
  expect(markup).toContain('nodeIdle')
  expect(markup).toContain('data-node-id="research"')
})

it('paints the status on the node group and keeps the base paint off the kind shape', () => {
  const { container } = render(
    <WorkflowGraph layout={CHAIN} ariaLabel="board" nodeStatuses={{ research: 'running' }} />,
  )
  const group = mustQuery(container, '[data-node-id="research"]')
  const groupClass = group.getAttribute('class') ?? ''
  expect(groupClass).toContain('nodeGroup')
  expect(groupClass).toContain('nodeStatusRunning')
  expect(group.firstElementChild?.getAttribute('class')).toBeNull()
})

it('labels edges with format, byte size, and the localized truncation mark', () => {
  const edges: Record<string, GraphEdgeState> = {
    e1: { status: 'transferred', format: 'text', bytes: 13 },
    e2: { status: 'truncated', format: 'json', bytes: 2048 },
  }
  const markup = renderToStaticMarkup(
    <WorkflowGraph layout={CHAIN} ariaLabel="board" edgeStates={edges} truncatedMark="[cut]" />,
  )
  expect(markup).toContain('text \u00b7 13B')
  expect(markup).toContain('json \u00b7 2048B')
  expect(markup).toContain('[cut]')
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
    <WorkflowGraph layout={LAYOUT} ariaLabel="board" selectedNodeId="route" />,
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
    <WorkflowGraph layout={LAYOUT} ariaLabel="board" edgeStates={{ l3: { status: 'transferred', format: 'text' } }} />,
  )
  expect(markup).toContain('loopBox')
  expect(markup).toContain('data-edge-id="l3"')
  expect(markup).not.toContain('data-edge-id="ghost"')
  expect(markup).toContain('text</text>')
})

it('exposes clickable nodes as buttons activated by Enter and Space', () => {
  const onSelect = vi.fn<(nodeId: string) => void>()
  const { container } = render(
    <WorkflowGraph
      layout={CHAIN}
      ariaLabel="board"
      nodeAriaLabel={(node, status) => 'node ' + node.id + ' ' + (status ?? 'idle')}
      onSelectNode={onSelect}
    />,
  )
  const group = mustQuery(container, '[data-node-id="research"]')
  expect(group.getAttribute('role')).toBe('button')
  expect(group.getAttribute('tabindex')).toBe('0')
  expect(group.getAttribute('aria-label')).toBe('node research idle')
  expect(group.getAttribute('aria-pressed')).toBe('false')
  fireEvent.keyDown(group, { key: 'Enter' })
  fireEvent.keyDown(group, { key: ' ' })
  expect(onSelect.mock.calls.map((call) => call[0])).toEqual(['research', 'research'])
})

it('keeps static nodes out of the tab order and the button role', () => {
  const { container } = render(<WorkflowGraph layout={CHAIN} ariaLabel="board" selectedNodeId="research" />)
  const group = mustQuery(container, '[data-node-id="research"]')
  expect(group.getAttribute('role')).toBeNull()
  expect(group.getAttribute('tabindex')).toBeNull()
  expect(group.getAttribute('aria-pressed')).toBeNull()
})

it('marks a selected clickable node pressed', () => {
  const { container } = render(
    <WorkflowGraph layout={CHAIN} ariaLabel="board" selectedNodeId="research" onSelectNode={() => {}} />,
  )
  expect(mustQuery(container, '[data-node-id="research"]').getAttribute('aria-pressed')).toBe('true')
})

it('names the topology through the localized label and drops the inline name', () => {
  const { container } = render(<WorkflowGraph layout={CHAIN} ariaLabel="图表" />)
  const svg = mustQuery(container, 'svg')
  expect(svg.getAttribute('role')).toBe('group')
  expect(svg.getAttribute('aria-label')).toBe('图表')
  expect(container.innerHTML).not.toContain('workflow topology')
})
