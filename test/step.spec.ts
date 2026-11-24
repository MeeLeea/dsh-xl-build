import { describe, expect, it } from 'vitest'
import { parseWorkflowDocument } from '../src/host/workflow/domain.ts'
import { planRunStep } from '../src/host/workflow/step.ts'
import type { NodeStatus } from '../src/host/events.ts'

/** A three-node chain: start -> work -> done. */
const CHAIN = parseWorkflowDocument({
  schemaVersion: 1,
  id: 'release',
  name: 'Release',
  entry: 'start',
  nodes: [
    { kind: 'input', id: 'start' },
    { kind: 'agent', id: 'work', agent: 'reviewer', task: 'work' },
    { kind: 'output', id: 'done', value: 'x' },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
    { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
  ],
})

/** A fan-out pair feeding one join, for the budget cases. */
const FAN = parseWorkflowDocument({
  schemaVersion: 1,
  id: 'release',
  name: 'Release',
  entry: 'start',
  nodes: [
    { kind: 'input', id: 'start' },
    { kind: 'agent', id: 'aa', agent: 'reviewer', task: 'aa' },
    { kind: 'agent', id: 'bb', agent: 'reviewer', task: 'bb' },
    { kind: 'join', id: 'merge', strategy: 'all' },
    { kind: 'output', id: 'done', value: 'x' },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'aa', kind: 'fan-out' },
    { id: 'e2', from: 'start', to: 'bb', kind: 'fan-out' },
    { id: 'e3', from: 'aa', to: 'merge', kind: 'fan-in' },
    { id: 'e4', from: 'bb', to: 'merge', kind: 'fan-in' },
    { id: 'e5', from: 'merge', to: 'done', kind: 'flow' },
  ],
})

/** One tick over the chain. */
function step(document: typeof CHAIN, entries: Record<string, NodeStatus>, active: string[] = [], limit = 4) {
  return planRunStep({ document, statuses: new Map(Object.entries(entries)), active, limit })
}

describe('planRunStep', () => {
  it('starts the entry, then follows the chain, and never settles early', () => {
    expect(step(CHAIN, {})).toMatchObject({ start: ['start'], settlement: { settled: false } })
    expect(step(CHAIN, { start: 'completed' })).toMatchObject({ start: ['work'], settlement: { settled: false } })
  })

  it('settles completed once every node settled without failure', () => {
    const result = step(CHAIN, { start: 'completed', work: 'completed', done: 'completed' })
    expect(result.start).toEqual([])
    expect(result.settlement).toEqual({ settled: true, outcome: 'completed' })
  })

  it('propagates skips from a failure and settles as failed', () => {
    const result = step(CHAIN, { start: 'failed' })
    expect(result.start).toEqual([])
    expect(result.statuses.get('work')).toBe('skipped')
    expect(result.statuses.get('done')).toBe('skipped')
    expect(result.settlement).toEqual({ settled: true, outcome: 'failed' })
  })

  it('does not settle while a node is running', () => {
    const result = step(CHAIN, { start: 'completed' }, ['work'])
    expect(result.start).toEqual([])
    expect(result.settlement).toEqual({ settled: false })
  })

  it('honours the concurrency budget across a fan-out', () => {
    expect(step(FAN, { start: 'completed' }, [], 1).start).toEqual(['aa'])
    expect(step(FAN, { start: 'completed' }, ['aa'], 2).start).toEqual(['bb'])
    expect(step(FAN, { start: 'completed' }, ['aa'], 1).start).toEqual([])
  })
})
