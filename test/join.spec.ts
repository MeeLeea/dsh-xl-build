import { describe, expect, it } from 'vitest'
import { parseWorkflowDocument } from '../src/host/workflow/domain.ts'
import type { WorkflowNode } from '../src/host/workflow/domain.ts'
import { mergeJoinInputs } from '../src/host/workflow/join.ts'

/** A join node fixture with the given strategy. */
function joinNode(strategy: string, quorum?: number): WorkflowNode & { kind: 'join' } {
  const document = parseWorkflowDocument({
    schemaVersion: 1,
    id: 'release',
    name: 'Release',
    entry: 'merge',
    nodes: [
      { kind: 'join', id: 'merge', strategy, ...quorum === undefined ? {} : { quorum } },
      { kind: 'output', id: 'done', value: 'x' },
    ],
    edges: [{ id: 'e1', from: 'merge', to: 'done', kind: 'flow' }],
  })
  return document.nodes.find((node) => node.kind === 'join') as WorkflowNode & { kind: 'join' }
}

const EXPECTED = ['aa', 'bb']
const ARRIVALS = [{ nodeId: 'aa', text: 'first' }, { nodeId: 'bb', text: 'second' }]

describe('mergeJoinInputs', () => {
  it('waits for every upstream under all, then merges in declared order', () => {
    expect(mergeJoinInputs(joinNode('all'), EXPECTED, [ARRIVALS[0] as { nodeId: string, text: string }]))
      .toEqual({ decided: false, text: '' })
    expect(mergeJoinInputs(joinNode('all'), EXPECTED, ARRIVALS)).toEqual({
      decided: true,
      text: '[from aa]\nfirst\n\n[from bb]\nsecond',
    })
  })

  it('decides on the first arrival under any', () => {
    expect(mergeJoinInputs(joinNode('any'), EXPECTED, [])).toEqual({ decided: false, text: '' })
    expect(mergeJoinInputs(joinNode('any'), EXPECTED, [{ nodeId: 'bb', text: 'late' }]))
      .toEqual({ decided: true, text: '[from bb]\nlate' })
  })

  it('decides once quorum arrivals arrive, keeping declared order', () => {
    expect(mergeJoinInputs(joinNode('quorum', 2), EXPECTED, [ARRIVALS[1] as { nodeId: string, text: string }]))
      .toEqual({ decided: false, text: '' })
    expect(mergeJoinInputs(joinNode('quorum', 2), EXPECTED, ARRIVALS)).toEqual({
      decided: true,
      text: '[from aa]\nfirst\n\n[from bb]\nsecond',
    })
  })

  it('ignores an arrival from a node that is not a declared upstream', () => {
    expect(mergeJoinInputs(joinNode('all'), EXPECTED, [...ARRIVALS, { nodeId: 'ghost', text: 'x' }]))
      .toEqual({ decided: true, text: '[from aa]\nfirst\n\n[from bb]\nsecond' })
  })
})
