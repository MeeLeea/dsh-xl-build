import { describe, expect, it } from 'vitest'
import { parseWorkflowDocument } from '../src/host/workflow/domain.ts'
import type { WorkflowNode } from '../src/host/workflow/domain.ts'
import { planReadyNodes, parseCondition, selectBranchTarget } from '../src/host/workflow/ready.ts'
import type { NodeStatus } from '../src/host/events.ts'

/** Parse a document fixture from raw node and edge literals. */
function docOf(nodes: unknown[], edges: unknown[], entry = 'start') {
  return parseWorkflowDocument({ schemaVersion: 1, id: 'release', name: 'Release', entry, nodes, edges })
}

/** Ready nodes for one status map. */
function ready(nodes: unknown[], edges: unknown[], statuses: Record<string, NodeStatus>, limit = 8, active: string[] = [], entry = 'start'): string[] {
  return planReadyNodes({
    document: docOf(nodes, edges, entry),
    statuses: new Map(Object.entries(statuses)),
    active,
    limit,
  })
}

const CHAIN_NODES = [
  { kind: 'input', id: 'start' },
  { kind: 'agent', id: 'work', agent: 'reviewer', task: 'work' },
  { kind: 'output', id: 'done', value: 'x' },
]
const CHAIN_EDGES = [
  { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
  { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
]

const FAN_NODES = [
  { kind: 'input', id: 'start' },
  { kind: 'agent', id: 'aa', agent: 'reviewer', task: 'aa' },
  { kind: 'agent', id: 'bb', agent: 'reviewer', task: 'bb' },
  { kind: 'join', id: 'merge', strategy: 'all' },
  { kind: 'output', id: 'done', value: 'x' },
]
const FAN_EDGES = [
  { id: 'e1', from: 'start', to: 'aa', kind: 'fan-out' },
  { id: 'e2', from: 'start', to: 'bb', kind: 'fan-out' },
  { id: 'e3', from: 'aa', to: 'merge', kind: 'fan-in' },
  { id: 'e4', from: 'bb', to: 'merge', kind: 'fan-in' },
  { id: 'e5', from: 'merge', to: 'done', kind: 'flow' },
]

describe('planReadyNodes', () => {
  it('starts the entry alone, then follows the chain', () => {
    expect(ready(CHAIN_NODES, CHAIN_EDGES, {})).toEqual(['start'])
    expect(ready(CHAIN_NODES, CHAIN_EDGES, { start: 'completed' })).toEqual(['work'])
    expect(ready(CHAIN_NODES, CHAIN_EDGES, { start: 'completed', work: 'completed' })).toEqual(['done'])
  })

  it('waits for an upstream that has not completed', () => {
    expect(ready(CHAIN_NODES, CHAIN_EDGES, { start: 'completed', work: 'running' })).toEqual([])
    expect(ready(CHAIN_NODES, CHAIN_EDGES, { start: 'completed', work: 'failed' })).toEqual([])
  })

  it('starts every fan-out target and gates the join on all of them', () => {
    expect(ready(FAN_NODES, FAN_EDGES, { start: 'completed' })).toEqual(['aa', 'bb'])
    expect(ready(FAN_NODES, FAN_EDGES, { start: 'completed', aa: 'completed' })).toEqual(['bb'])
    expect(ready(FAN_NODES, FAN_EDGES, { start: 'completed', aa: 'completed', bb: 'completed' })).toEqual(['merge'])
  })

  it('gates a non-all join on any completed upstream', () => {
    const nodes = FAN_NODES.map((node) => (node.kind === 'join' ? { ...node, strategy: 'any' } : node))
    expect(ready(nodes, FAN_EDGES, { start: 'completed', aa: 'completed' })).toContain('merge')
  })

  it('ignores loop-back and error edges when gating', () => {
    // `aa` is gated only by the loop-back edge, so it must be ready while its
    // successor waits for `aa` to complete.
    expect(ready([
      { kind: 'agent', id: 'aa', agent: 'reviewer', task: 'aa' },
      { kind: 'agent', id: 'bb', agent: 'reviewer', task: 'bb' },
    ], [
      { id: 'e1', from: 'aa', to: 'bb', kind: 'flow' },
      { id: 'e2', from: 'bb', to: 'aa', kind: 'loop-back' },
    ], {}, 8, [], 'aa')).toEqual(['aa'])
    expect(ready([
      { kind: 'agent', id: 'aa', agent: 'reviewer', task: 'aa' },
      { kind: 'agent', id: 'bb', agent: 'reviewer', task: 'bb' },
    ], [
      { id: 'e1', from: 'aa', to: 'bb', kind: 'flow' },
      { id: 'e2', from: 'bb', to: 'aa', kind: 'loop-back' },
    ], { aa: 'completed' }, 8, [], 'aa')).toEqual(['bb'])

    expect(ready([
      { kind: 'agent', id: 'aa', agent: 'reviewer', task: 'aa' },
      { kind: 'agent', id: 'bb', agent: 'reviewer', task: 'bb' },
    ], [{ id: 'e1', from: 'aa', to: 'bb', kind: 'error' }], {}, 8, [], 'aa')).toEqual(['aa', 'bb'])
  })

  it('respects the concurrency budget and never re-plans running nodes', () => {
    const statuses = { start: 'completed' }
    expect(ready(FAN_NODES, FAN_EDGES, statuses, 1)).toEqual(['aa'])
    expect(ready(FAN_NODES, FAN_EDGES, statuses, 8, ['aa'])).toEqual(['bb'])
    expect(ready(FAN_NODES, FAN_EDGES, statuses, 1, ['aa'])).toEqual([])
  })
})

describe('router branch selection', () => {
  const router = docOf([
    { kind: 'input', id: 'start' },
    { kind: 'router', id: 'pick', branches: [{ when: '{"==":[{"var":"input.env"},"prod"]}', to: 'aa' }], else: 'bb' },
    { kind: 'agent', id: 'aa', agent: 'reviewer', task: 'aa' },
    { kind: 'agent', id: 'bb', agent: 'reviewer', task: 'bb' },
    { kind: 'output', id: 'done', value: 'x' },
  ], [
    { id: 'e1', from: 'start', to: 'pick', kind: 'flow' },
    { id: 'e2', from: 'pick', to: 'aa', kind: 'branch', condition: '{"==":[{"var":"input.env"},"prod"]}' },
    { id: 'e3', from: 'pick', to: 'bb', kind: 'branch' },
    { id: 'e4', from: 'aa', to: 'done', kind: 'flow' },
    { id: 'e5', from: 'bb', to: 'done', kind: 'flow' },
  ]).nodes.find((node) => node.kind === 'router') as WorkflowNode & { kind: 'router' }

  const frame = {
    input: { env: 'prod' },
    nodes: {},
    edges: {},
  }

  it('takes the first matching branch and falls back to else', () => {
    expect(selectBranchTarget(router, frame)).toBe('aa')
    expect(selectBranchTarget(router, { ...frame, input: { env: 'dev' } })).toBe('bb')
  })

  it('rejects a condition that is not JSON', () => {
    expect(() => parseCondition('not json')).toThrow('condition is not JSON')
  })
})
