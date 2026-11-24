import { describe, expect, it } from 'vitest'
import { parseWorkflowDocument } from '../src/host/workflow/domain.ts'
import { toMermaid } from '../src/host/workflow/mermaid.ts'

const EXAMPLE = parseWorkflowDocument({
  schemaVersion: 1,
  id: 'writer-chain',
  name: 'Writer chain',
  entry: 'in1',
  nodes: [
    { kind: 'input', id: 'in1' },
    { kind: 'agent', id: 'a-research', agent: 'researcher', task: 'research' },
    { kind: 'agent', id: 'a-writer', agent: 'writer', task: 'write' },
    { kind: 'script', id: 'p-lint', runtime: 'shell', command: 'lint' },
    { kind: 'output', id: 'out1', value: 'done' },
  ],
  edges: [
    { id: 'e1', from: 'in1', to: 'a-research', kind: 'flow', format: 'text' },
    { id: 'e2', from: 'a-research', to: 'a-writer', kind: 'flow', format: 'md' },
    { id: 'e3', from: 'a-writer', to: 'p-lint', kind: 'flow', format: 'json' },
    { id: 'e4', from: 'p-lint', to: 'out1', kind: 'flow', format: 'text' },
  ],
})

const EVERY_KIND = parseWorkflowDocument({
  schemaVersion: 1,
  id: 'kinds',
  name: 'Every kind',
  entry: 'in1',
  nodes: [
    { kind: 'input', id: 'in1' },
    { kind: 'agent', id: 'a1', agent: 'reviewer', task: 'review' },
    { kind: 'script', id: 'p1', runtime: 'shell', command: 'lint --fix' },
    { kind: 'script', id: 'p2', runtime: 'ptc', script: 'xlsx.read()' },
    { kind: 'tool', id: 't1', tool: 'write_file', args: {} },
    { kind: 'router', id: 'r1', branches: [{ when: 'needs-fix?', to: 'p1' }], else: 't1' },
    { kind: 'join', id: 'j1', strategy: 'quorum', quorum: 2 },
    { kind: 'loop', id: 'l1', body: 'a1', until: { expr: 'done' }, maxIters: 5 },
    { kind: 'subworkflow', id: 's1', workflow: 'review-chain', inputs: {} },
    { kind: 'note', id: 'n1', text: 'explain the fork' },
    { kind: 'output', id: 'out1', value: 'done' },
  ],
  edges: [
    { id: 'f1', from: 'in1', to: 'r1', kind: 'flow' },
    { id: 'f2', from: 'r1', to: 'p1', kind: 'branch', condition: 'needs-fix?' },
    { id: 'f3', from: 'r1', to: 't1', kind: 'branch' },
    { id: 'f4', from: 'a1', to: 'j1', kind: 'fan-out', format: 'md' },
    { id: 'f5', from: 'p1', to: 'j1', kind: 'fan-in' },
    { id: 'f6', from: 'j1', to: 'l1', kind: 'flow', format: 'json' },
    { id: 'f7', from: 'p2', to: 'l1', kind: 'loop-back' },
    { id: 'f8', from: 'l1', to: 's1', kind: 'error' },
    { id: 'f9', from: 's1', to: 'out1', kind: 'flow' },
  ],
})

describe('toMermaid', () => {
  it('projects deterministically: same document, same text', () => {
    expect(toMermaid(EXAMPLE)).toBe(toMermaid(EXAMPLE))
    expect(toMermaid(EXAMPLE).endsWith('\n')).toBe(true)
  })

  it('projects the plan example without a run view', () => {
    expect(toMermaid(EXAMPLE)).toMatchSnapshot()
  })

  it('colors the plan example with a run view without changing structure', () => {
    const plain = toMermaid(EXAMPLE)
    const colored = toMermaid(EXAMPLE, { statuses: { 'a-research': 'completed', 'p-lint': 'running' } })
    expect(colored.startsWith(plain)).toBe(true)
    expect(colored).toMatchSnapshot()
  })

  it('projects every node kind and every edge kind', () => {
    expect(toMermaid(EVERY_KIND)).toMatchSnapshot()
  })

  it('leaves every status class off for unmapped statuses', () => {
    const text = toMermaid(EXAMPLE, { statuses: { 'a-research': 'skipped', 'a-writer': 'cancelled' } })
    expect(text).not.toContain('class ')
    expect(text).toContain('classDef ok')
    expect(text).toContain('classDef bad')
    expect(text).toContain('classDef run')
  })
})
