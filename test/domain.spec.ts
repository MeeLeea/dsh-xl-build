import { describe, expect, it } from 'vitest'
import { parseWorkflowDocument, WorkflowNodeSchema } from '../src/host/workflow/domain.ts'

/** Minimal valid document wrapping the supplied nodes and edges. */
function documentWith(nodes: unknown[], edges: unknown[] = []): unknown {
  return {
    schemaVersion: 1,
    id: 'release',
    name: 'Release',
    entry: nodes[0] !== undefined && typeof nodes[0] === 'object' && nodes[0] !== null && 'id' in nodes[0]
      ? (nodes[0] as { id: string }).id
      : 'start',
    nodes,
    edges,
  }
}

const NODE_CASES: [string, unknown][] = [
  ['input', { kind: 'input', id: 'start', params: [{ name: 'version', required: true }] }],
  ['agent', { kind: 'agent', id: 'start', agent: 'reviewer', task: 'Review {{input.version}}' }],
  ['script', { kind: 'script', id: 'start', runtime: 'shell', command: 'echo hi' }],
  ['tool', { kind: 'tool', id: 'start', tool: 'todo_write', args: { items: '{{input.items}}' } }],
  ['router', { kind: 'router', id: 'start', branches: [{ when: '{"var":"input.ok"}', to: 'start' }], else: 'start' }],
  ['join', { kind: 'join', id: 'start', strategy: 'all' }],
  ['loop', { kind: 'loop', id: 'start', body: 'start', until: { expr: '{"var":"nodes.start.done"}' }, maxIters: 3 }],
  ['subworkflow', { kind: 'subworkflow', id: 'start', workflow: 'inner', inputs: { value: '{{input.version}}' } }],
  ['output', { kind: 'output', id: 'start', value: '{{nodes.start.output}}' }],
  ['note', { kind: 'note', id: 'start', text: 'why this order' }],
]

describe('workflow node union', () => {
  it.each(NODE_CASES)('accepts a %s node', (_kind, node) => {
    expect(() => WorkflowNodeSchema.parse(node)).not.toThrow()
  })

  it('applies the documented node defaults', () => {
    const agent = WorkflowNodeSchema.parse({ kind: 'agent', id: 'start', agent: 'a', task: 't' })
    expect(agent).toMatchObject({ context: 'none', self: false })

    const edge = parseWorkflowDocument(documentWith([{ kind: 'note', id: 'start', text: 'x' }], [
      { id: 'e1', from: 'start', to: 'start', kind: 'flow' },
    ]))
    expect(edge.edges[0]?.format).toBe('text')
    expect(edge.defaults).toEqual({ nodeTimeoutMs: 600_000, maxAttempts: 2, edgeMaxBytes: 64_000 })
  })

  it('rejects a field belonging to another kind', () => {
    expect(() => WorkflowNodeSchema.parse({
      kind: 'script',
      id: 'start',
      runtime: 'shell',
      command: 'echo',
      self: true,
    })).toThrow()
  })

  it('rejects a script node without exactly one of command or script', () => {
    expect(() => WorkflowNodeSchema.parse({ kind: 'script', id: 'start', runtime: 'shell' })).toThrow()
    expect(() => WorkflowNodeSchema.parse({
      kind: 'script',
      id: 'start',
      runtime: 'shell',
      command: 'echo',
      script: 'print(1)',
    })).toThrow()
  })

  it('rejects an unknown kind and a bad id', () => {
    expect(() => WorkflowNodeSchema.parse({ kind: 'squad', id: 'start' })).toThrow()
    expect(() => WorkflowNodeSchema.parse({ kind: 'note', id: 'Start', text: 'x' })).toThrow()
  })

  it('rejects an unknown top-level key', () => {
    expect(() => parseWorkflowDocument({
      ...documentWith([{ kind: 'note', id: 'start', text: 'x' }]) as object,
      triggers: [],
    })).toThrow()
  })

  it('requires a non-empty node list', () => {
    expect(() => parseWorkflowDocument({ schemaVersion: 1, id: 'w', name: 'W', entry: 'start', nodes: [] })).toThrow()
  })
})
