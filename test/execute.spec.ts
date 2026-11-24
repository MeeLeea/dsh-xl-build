import { describe, expect, it } from 'vitest'
import { parseWorkflowDocument } from '../src/host/workflow/domain.ts'
import type { WorkflowNode } from '../src/host/workflow/domain.ts'
import {
  executeDeterministicNode,
  resolveRunInputs,
  withEdgePayload,
  withNodeOutput,
} from '../src/host/workflow/execute.ts'
import type { TemplateFrame } from '../src/host/workflow/template.ts'

/** Parse a document fixture and return its nodes by id. */
function nodesOf(nodes: unknown[], edges: unknown[] = [], entry = 'start'): Map<string, WorkflowNode> {
  const document = parseWorkflowDocument({ schemaVersion: 1, id: 'release', name: 'Release', entry, nodes, edges })
  return new Map(document.nodes.map((node) => [node.id, node]))
}

const FRAME: TemplateFrame = {
  input: { version: '1.2.3' },
  nodes: { work: { output: 'finished' } },
  edges: { e1: 'edge text' },
  memory: 'remembered',
}

describe('resolveRunInputs', () => {
  it('reports missing required parameters and applies declared defaults', () => {
    const parameters = [
      { name: 'version', required: true },
      { name: 'channel', required: false, default: 'stable' },
      { name: 'note', required: false },
    ]
    expect(resolveRunInputs(parameters, {})).toEqual({ inputs: { channel: 'stable' }, missing: ['version'] })
    expect(resolveRunInputs(parameters, { version: '2.0.0' }))
      .toEqual({ inputs: { version: '2.0.0', channel: 'stable' }, missing: [] })
  })

  it('lets a supplied value win over the default', () => {
    const parameters = [{ name: 'channel', required: false, default: 'stable' }]
    expect(resolveRunInputs(parameters, { channel: 'beta' })).toEqual({ inputs: { channel: 'beta' }, missing: [] })
  })

  it('falls back to the default when a supplied value is explicitly undefined', () => {
    const parameters = [{ name: 'channel', required: false, default: 'stable' }]
    expect(resolveRunInputs(parameters, { channel: undefined })).toEqual({ inputs: { channel: 'stable' }, missing: [] })
  })
})

describe('executeDeterministicNode', () => {
  const NODES = nodesOf([
    { kind: 'input', id: 'start', params: [{ name: 'version', required: true }] },
    { kind: 'note', id: 'note', text: 'why this order' },
    { kind: 'output', id: 'done', value: '{{nodes.work.output}} at {{input.version}} ({{memory}})' },
    { kind: 'router', id: 'pick', branches: [{ when: '{"==":[{"var":"input.version"},"1.2.3"]}', to: 'note' }], else: 'done' },
    { kind: 'agent', id: 'work', agent: 'reviewer', task: 'work' },
  ], [
    { id: 'e1', from: 'start', to: 'pick', kind: 'flow' },
    { id: 'e2', from: 'pick', to: 'note', kind: 'branch', condition: '{"==":[{"var":"input.version"},"1.2.3"]}' },
    { id: 'e3', from: 'pick', to: 'done', kind: 'branch' },
    { id: 'e4', from: 'note', to: 'work', kind: 'flow' },
    { id: 'e5', from: 'work', to: 'done', kind: 'flow' },
  ])

  it('completes input and note nodes without an output value', () => {
    expect(executeDeterministicNode(NODES.get('start') as WorkflowNode, FRAME)).toEqual({ status: 'completed', output: undefined })
    expect(executeDeterministicNode(NODES.get('note') as WorkflowNode, FRAME)).toEqual({ status: 'completed', output: undefined })
  })

  it('renders an output node against the frame', () => {
    expect(executeDeterministicNode(NODES.get('done') as WorkflowNode, FRAME))
      .toEqual({ status: 'completed', output: 'finished at 1.2.3 (remembered)' })
  })

  it('routes on the frame and falls back to else', () => {
    expect(executeDeterministicNode(NODES.get('pick') as WorkflowNode, FRAME)?.nextNode).toBe('note')
    expect(executeDeterministicNode(NODES.get('pick') as WorkflowNode, { ...FRAME, input: { version: '9.9.9' } })?.nextNode)
      .toBe('done')
  })

  it('leaves host-bound kinds to the host executor', () => {
    const agent = NODES.get('work') as WorkflowNode
    expect(executeDeterministicNode(agent, FRAME)).toBeUndefined()
    expect(executeDeterministicNode({ kind: 'tool', id: 'note', tool: 'todo_write' } as WorkflowNode, FRAME)).toBeUndefined()
  })

  it('rejects a router condition outside the operator subset', () => {
    const [router] = nodesOf([
      { kind: 'router', id: 'pick', branches: [{ when: '{"merge":[1,2]}', to: 'note' }], else: 'note' },
      { kind: 'note', id: 'note', text: 'x' },
    ], [], 'pick').values()
    expect(() => executeDeterministicNode(router as WorkflowNode, FRAME)).toThrow('not a valid expression')
  })
})

describe('frame bookkeeping', () => {
  it('adds node outputs and edge payloads without mutating the input frame', () => {
    const frame: TemplateFrame = { ...FRAME }
    const withNode = withNodeOutput(frame, 'extra', { ok: true })
    const withEdge = withEdgePayload(frame, 'e2', 'payload')

    expect(withNode.nodes.extra).toEqual({ ok: true })
    expect(withNode.nodes.work).toEqual({ output: 'finished' })
    expect(frame.nodes.extra).toBeUndefined()

    expect(withEdge.edges.e2).toBe('payload')
    expect(withEdge.edges.e1).toBe('edge text')
    expect(frame.edges.e2).toBeUndefined()
  })
})
