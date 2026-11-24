import { describe, expect, it } from 'vitest'
import { parseWorkflowDocument } from '../src/host/workflow/domain.ts'
import { validateWorkflow } from '../src/host/workflow/validate.ts'
import type { WorkflowCatalog } from '../src/host/workflow/validate.ts'

/** Parse a document fixture from raw node and edge literals. */
function docOf(nodes: unknown[], edges: unknown[] = [], entry = 'start') {
  return parseWorkflowDocument({ schemaVersion: 1, id: 'release', name: 'Release', entry, nodes, edges })
}

/** Rules reported for one fixture. */
function rulesOf(nodes: unknown[], edges: unknown[] = [], entry = 'start', catalog?: WorkflowCatalog): string[] {
  return validateWorkflow(docOf(nodes, edges, entry), catalog === undefined ? {} : { catalog })
    .map((issue) => issue.rule)
}

const NOTE = { kind: 'note', id: 'note', text: 'x' }

describe('V5 reachability', () => {
  it('reports a node that no path reaches', () => {
    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'agent', id: 'work', agent: 'reviewer', task: 'work' },
      { kind: 'output', id: 'done', value: '{{nodes.work.output}}' },
      { kind: 'agent', id: 'orphan', agent: 'reviewer', task: 'work' },
      { kind: 'output', id: 'done-two', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
      { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
      { id: 'e3', from: 'orphan', to: 'done-two', kind: 'flow' },
    ])).toContain('V5')
  })
})

describe('V6 and V7 edge kinds', () => {
  const ROUTER_NODES = [
    { kind: 'input', id: 'start' },
    { kind: 'router', id: 'pick', branches: [], else: 'right' },
    { kind: 'agent', id: 'left', agent: 'reviewer', task: 'left' },
    { kind: 'agent', id: 'right', agent: 'reviewer', task: 'right' },
    { kind: 'output', id: 'done', value: 'x' },
  ]

  it('reports a router without exactly one else branch or with a non-branch edge', () => {
    expect(rulesOf(ROUTER_NODES, [
      { id: 'e1', from: 'start', to: 'pick', kind: 'flow' },
      { id: 'e2', from: 'pick', to: 'left', kind: 'branch', condition: '{"var":"input.go"}' },
      { id: 'e3', from: 'pick', to: 'right', kind: 'branch', condition: '{"var":"input.stop"}' },
      { id: 'e4', from: 'left', to: 'done', kind: 'flow' },
      { id: 'e5', from: 'right', to: 'done', kind: 'flow' },
    ])).toContain('V6')

    expect(rulesOf(ROUTER_NODES, [
      { id: 'e1', from: 'start', to: 'pick', kind: 'flow' },
      { id: 'e2', from: 'pick', to: 'left', kind: 'flow' },
      { id: 'e4', from: 'left', to: 'done', kind: 'flow' },
      { id: 'e5', from: 'right', to: 'done', kind: 'flow' },
    ])).toContain('V6')
  })

  it('accepts a router whose else edge matches its else target', () => {
    expect(rulesOf(ROUTER_NODES, [
      { id: 'e1', from: 'start', to: 'pick', kind: 'flow' },
      { id: 'e2', from: 'pick', to: 'left', kind: 'branch', condition: '{"var":"input.go"}' },
      { id: 'e3', from: 'pick', to: 'right', kind: 'branch' },
      { id: 'e4', from: 'left', to: 'done', kind: 'flow' },
      { id: 'e5', from: 'right', to: 'done', kind: 'flow' },
    ])).not.toContain('V6')
  })

  it('reports a join whose edges are not fan-in and flow', () => {
    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'join', id: 'merge', strategy: 'all' },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'merge', kind: 'flow' },
      { id: 'e2', from: 'merge', to: 'done', kind: 'flow' },
    ])).toContain('V7')
  })
})

describe('V8 acyclicity', () => {
  it('reports a cycle that survives loop-back removal', () => {
    expect(rulesOf([
      { kind: 'agent', id: 'aa', agent: 'reviewer', task: 'a' },
      { kind: 'agent', id: 'bb', agent: 'reviewer', task: 'b' },
    ], [
      { id: 'e1', from: 'aa', to: 'bb', kind: 'flow' },
      { id: 'e2', from: 'bb', to: 'aa', kind: 'flow' },
    ], 'aa')).toContain('V8')
  })

  it('accepts a loop expressed with a loop node and a loop-back edge', () => {
    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'loop', id: 'loop', body: 'body', until: { expr: '{"var":"nodes.body.done"}' }, maxIters: 3 },
      { kind: 'agent', id: 'body', agent: 'reviewer', task: 'body' },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'loop', kind: 'flow' },
      { id: 'e2', from: 'loop', to: 'body', kind: 'flow' },
      { id: 'e3', from: 'body', to: 'loop', kind: 'loop-back' },
      { id: 'e4', from: 'loop', to: 'done', kind: 'flow' },
    ])).not.toContain('V8')
  })
})

describe('V9 and V10 loop structure', () => {
  it('reports a loop body that is not a node and one that contains itself', () => {
    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'loop', id: 'loop', body: 'ghost', until: { expr: '{"var":"x"}' }, maxIters: 2 },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'loop', kind: 'flow' },
      { id: 'e2', from: 'loop', to: 'done', kind: 'flow' },
    ])).toContain('V10')

    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'loop', id: 'loop', body: 'loop', until: { expr: '{"var":"x"}' }, maxIters: 2 },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'loop', kind: 'flow' },
      { id: 'e2', from: 'loop', to: 'done', kind: 'flow' },
    ])).toContain('V10')
  })

  it('reports a loop-back edge that starts outside its body', () => {
    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'loop', id: 'loop', body: 'body', until: { expr: '{"var":"x"}' }, maxIters: 2 },
      { kind: 'agent', id: 'body', agent: 'reviewer', task: 'body' },
      { kind: 'agent', id: 'stray', agent: 'reviewer', task: 'stray' },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'loop', kind: 'flow' },
      { id: 'e2', from: 'loop', to: 'body', kind: 'flow' },
      { id: 'e3', from: 'body', to: 'done', kind: 'flow' },
      { id: 'e4', from: 'stray', to: 'loop', kind: 'loop-back' },
      { id: 'e5', from: 'stray', to: 'done', kind: 'flow' },
    ])).toContain('V9')
  })
})

describe('V15 body closure', () => {
  it('reports a round end that also leaves the loop', () => {
    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'loop', id: 'loop', body: 'body-in', until: { expr: '{"var":"x"}' }, maxIters: 2 },
      { kind: 'agent', id: 'body-in', agent: 'reviewer', task: 'body' },
      { kind: 'agent', id: 'round-end', agent: 'reviewer', task: 'end' },
      { kind: 'agent', id: 'after', agent: 'reviewer', task: 'after' },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'loop', kind: 'flow' },
      { id: 'e2', from: 'loop', to: 'body-in', kind: 'flow' },
      { id: 'e3', from: 'body-in', to: 'round-end', kind: 'flow' },
      { id: 'e4', from: 'round-end', to: 'loop', kind: 'loop-back' },
      { id: 'e5', from: 'round-end', to: 'after', kind: 'flow' },
      { id: 'e6', from: 'after', to: 'done', kind: 'flow' },
    ])).toContain('V15')
  })
})

describe('V11 subworkflow references', () => {
  const SUBWORKFLOW_DOC = [
    { kind: 'input', id: 'start' },
    { kind: 'subworkflow', id: 'sub', workflow: 'inner', inputs: {} },
    { kind: 'output', id: 'done', value: 'x' },
  ]
  const SUBWORKFLOW_EDGES = [
    { id: 'e1', from: 'start', to: 'sub', kind: 'flow' },
    { id: 'e2', from: 'sub', to: 'done', kind: 'flow' },
  ]

  it('fails loud when no catalog is available', () => {
    expect(rulesOf(SUBWORKFLOW_DOC, SUBWORKFLOW_EDGES)).toContain('V11')
  })

  it('reports a missing referenced workflow and a reference cycle', () => {
    expect(rulesOf(SUBWORKFLOW_DOC, SUBWORKFLOW_EDGES, 'start', { get: () => undefined })).toContain('V11')

    const inner = docOf([
      { kind: 'input', id: 'start' },
      { kind: 'subworkflow', id: 'sub', workflow: 'release', inputs: {} },
      { kind: 'output', id: 'done', value: 'x' },
    ], SUBWORKFLOW_EDGES)
    const rules = rulesOf(SUBWORKFLOW_DOC, SUBWORKFLOW_EDGES, 'start', { get: (id) => (id === 'inner' ? inner : undefined) })
    expect(rules).toContain('V11')
    const messages = validateWorkflow(docOf(SUBWORKFLOW_DOC, SUBWORKFLOW_EDGES), { catalog: { get: (id) => (id === 'inner' ? inner : undefined) } })
    expect(messages.some((issue) => issue.message.includes('cycle'))).toBe(true)
  })
})

describe('V12 json edges', () => {
  it('requires an upstream output schema for a json edge', () => {
    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'output', id: 'done', value: 'x' },
    ], [{ id: 'e1', from: 'start', to: 'done', kind: 'flow', format: 'json' }])).toContain('V12')

    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'agent', id: 'work', agent: 'reviewer', task: 'work', outputSchema: { type: 'object' } },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
      { id: 'e2', from: 'work', to: 'done', kind: 'flow', format: 'json' },
    ])).not.toContain('V12')
  })
})

describe('V13 template references', () => {
  it('reports a reference to an unknown input, node, or edge', () => {
    expect(rulesOf([
      { kind: 'agent', id: 'work', agent: 'reviewer', task: 'use {{input.missing}}' },
      { kind: 'output', id: 'done', value: '{{nodes.work.output}}' },
    ], [{ id: 'e1', from: 'work', to: 'done', kind: 'flow' }], 'work')).toContain('V13')

    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'agent', id: 'work', agent: 'reviewer', task: 'use {{edges.ghost}}' },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
      { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
    ])).toContain('V13')
  })

  it('accepts the memory reference and known keys', () => {
    expect(rulesOf([
      { kind: 'input', id: 'start', params: [{ name: 'version', required: true }] },
      { kind: 'agent', id: 'work', agent: 'reviewer', task: 'use {{input.version}} and {{memory}}' },
      { kind: 'output', id: 'done', value: '{{nodes.work.output}}' },
    ], [
      { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
      { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
    ])).not.toContain('V13')
  })
})

describe('V14 scale caps', () => {
  it('reports fan-out above the cap', () => {
    const outputs = Array.from({ length: 33 }, (_value, index) => ({ kind: 'output', id: `out-${index}`, value: 'x' }))
    const edges = outputs.map((node, index) => ({ id: `e${index}`, from: 'hub', to: node.id, kind: 'flow' }))
    expect(rulesOf([
      { kind: 'agent', id: 'hub', agent: 'reviewer', task: 'fan out' },
      ...outputs,
    ], edges, 'hub')).toContain('V14')
  })
})

describe('V16 context choices', () => {
  it('reports run-input without an input node and a self node with none context', () => {
    expect(rulesOf([
      { kind: 'agent', id: 'work', agent: 'reviewer', task: 'work', context: { from: 'run-input' } },
      { kind: 'output', id: 'done', value: 'x' },
    ], [{ id: 'e1', from: 'work', to: 'done', kind: 'flow' }], 'work')).toContain('V16')

    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'agent', id: 'work', agent: 'reviewer', task: 'work', self: true },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
      { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
    ])).toContain('V16')
  })

  it('accepts a self node that reads the run input', () => {
    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'agent', id: 'work', agent: 'reviewer', task: 'work', self: true, context: { from: 'run-input' } },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
      { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
    ])).not.toContain('V16')
  })
})

describe('V17 failure edges', () => {
  it('reports more than one error edge and an error edge into a join', () => {
    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'agent', id: 'work', agent: 'reviewer', task: 'work' },
      { kind: 'output', id: 'done', value: 'x' },
      { kind: 'output', id: 'failed', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
      { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
      { id: 'e3', from: 'work', to: 'failed', kind: 'error' },
      { id: 'e4', from: 'start', to: 'failed', kind: 'error' },
    ])).toContain('V17')

    expect(rulesOf([
      { kind: 'input', id: 'start' },
      { kind: 'agent', id: 'work', agent: 'reviewer', task: 'work' },
      { kind: 'join', id: 'merge', strategy: 'all' },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
      { id: 'e2', from: 'work', to: 'merge', kind: 'fan-in' },
      { id: 'e3', from: 'start', to: 'merge', kind: 'error' },
      { id: 'e4', from: 'merge', to: 'done', kind: 'flow' },
    ])).toContain('V17')
  })
})

describe('note nodes', () => {
  it('accepts a document that only carries a note', () => {
    expect(validateWorkflow(docOf([NOTE], [], 'note'))).toEqual([])
  })
})
