import { describe, expect, it } from 'vitest'
import { parseWorkflowDocument } from '../src/host/workflow/domain.ts'
import type { WorkflowNode } from '../src/host/workflow/domain.ts'
import { cascadeSkips, decideLoopRound, settleRun } from '../src/host/workflow/engine-policy.ts'
import type { NodeStatus } from '../src/host/events.ts'
import type { ExprFrame } from '../src/host/workflow/expr.ts'

function docOf(nodes: unknown[], edges: unknown[], entry = 'start') {
  return parseWorkflowDocument({ schemaVersion: 1, id: 'release', name: 'Release', entry, nodes, edges })
}

const CHAIN = docOf([
  { kind: 'input', id: 'start' },
  { kind: 'agent', id: 'work', agent: 'reviewer', task: 'work' },
  { kind: 'output', id: 'done', value: 'x' },
], [
  { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
  { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
])

const FRAME: ExprFrame = { input: {}, nodes: {}, edges: {} }

describe('cascadeSkips', () => {
  it('skips a node whose gating upstream settled without completing', () => {
    const statuses = cascadeSkips(CHAIN, new Map<string, NodeStatus>([
      ['start', 'completed'],
      ['work', 'failed'],
    ]))
    expect(statuses.get('done')).toBe('skipped')
  })

  it('propagates transitively and leaves a completed chain alone', () => {
    const transitive = cascadeSkips(CHAIN, new Map<string, NodeStatus>([
      ['start', 'failed'],
    ]))
    expect(transitive.get('work')).toBe('skipped')
    expect(transitive.get('done')).toBe('skipped')

    const untouched = cascadeSkips(CHAIN, new Map<string, NodeStatus>([
      ['start', 'completed'],
      ['work', 'completed'],
    ]))
    expect(untouched.has('done')).toBe(false)
  })

  it('does not resurrect an already settled node', () => {
    const statuses = cascadeSkips(CHAIN, new Map<string, NodeStatus>([
      ['start', 'failed'],
      ['work', 'completed'],
    ]))
    // `work` keeps its own settlement even though its upstream failed, and
    // `done` stays unstarted because its only dependency completed.
    expect(statuses.get('work')).toBe('completed')
    expect(statuses.has('done')).toBe(false)
  })
})

describe('cascadeSkips: joins and error edges', () => {
  /** A diamond whose join strategy is configurable. */
  function fanOf(strategy: string, quorum?: number) {
    return docOf([
      { kind: 'input', id: 'start' },
      { kind: 'agent', id: 'aa', agent: 'reviewer', task: 'aa' },
      { kind: 'agent', id: 'bb', agent: 'reviewer', task: 'bb' },
      { kind: 'join', id: 'merge', strategy, ...quorum === undefined ? {} : { quorum } },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'start', to: 'aa', kind: 'fan-out' },
      { id: 'e2', from: 'start', to: 'bb', kind: 'fan-out' },
      { id: 'e3', from: 'aa', to: 'merge', kind: 'fan-in' },
      { id: 'e4', from: 'bb', to: 'merge', kind: 'fan-in' },
      { id: 'e5', from: 'merge', to: 'done', kind: 'flow' },
    ])
  }

  it('keeps a non-all join while enough upstreams can still arrive', () => {
    // Corrected semantic: `any`/`quorum` joins survive one blocking upstream.
    const anyJoin = cascadeSkips(fanOf('any'), new Map<string, NodeStatus>([
      ['start', 'completed'],
      ['aa', 'failed'],
    ]))
    expect(anyJoin.has('merge')).toBe(false)

    const quorumJoin = cascadeSkips(fanOf('quorum', 1), new Map<string, NodeStatus>([
      ['start', 'completed'],
      ['aa', 'failed'],
    ]))
    expect(quorumJoin.has('merge')).toBe(false)
  })

  it('still skips an all join blocked by one upstream', () => {
    const allJoin = cascadeSkips(fanOf('all'), new Map<string, NodeStatus>([
      ['start', 'completed'],
      ['aa', 'failed'],
    ]))
    expect(allJoin.get('merge')).toBe('skipped')
  })

  it('skips an error handler only when no source failed', () => {
    // Corrected semantic: an error edge activates on failure, so a handler whose
    // sources all settled without failing is skipped instead of waiting forever.
    const errorGraph = docOf([
      { kind: 'agent', id: 'aa', agent: 'reviewer', task: 'aa' },
      { kind: 'agent', id: 'handler', agent: 'reviewer', task: 'handler' },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'aa', to: 'handler', kind: 'error' },
      { id: 'e2', from: 'aa', to: 'done', kind: 'flow' },
      { id: 'e3', from: 'handler', to: 'done', kind: 'flow' },
    ], 'aa')

    expect(cascadeSkips(errorGraph, new Map<string, NodeStatus>([['aa', 'completed']])).get('handler')).toBe('skipped')
    expect(cascadeSkips(errorGraph, new Map<string, NodeStatus>([['aa', 'failed']])).has('handler')).toBe(false)
  })
})

describe('settleRun', () => {
  it('is not settled while a node is running or unstarted', () => {
    expect(settleRun(CHAIN, new Map())).toEqual({ settled: false })
    expect(settleRun(CHAIN, new Map<string, NodeStatus>([['start', 'completed'], ['work', 'running']])))
      .toEqual({ settled: false })
  })

  it('reports the outcome once every node settled', () => {
    expect(settleRun(CHAIN, new Map<string, NodeStatus>([
      ['start', 'completed'],
      ['work', 'completed'],
      ['done', 'completed'],
    ]))).toEqual({ settled: true, outcome: 'completed' })

    expect(settleRun(CHAIN, new Map<string, NodeStatus>([
      ['start', 'completed'],
      ['work', 'failed'],
      ['done', 'skipped'],
    ]))).toEqual({ settled: true, outcome: 'failed' })

    expect(settleRun(CHAIN, new Map<string, NodeStatus>([
      ['start', 'cancelled'],
      ['work', 'skipped'],
      ['done', 'skipped'],
    ]))).toEqual({ settled: true, outcome: 'cancelled' })
  })
})

describe('decideLoopRound', () => {
  const loopOf = (onMaxIters?: string): WorkflowNode & { kind: 'loop' } => {
    const document = docOf([
      { kind: 'loop', id: 'loop', body: 'body', until: { expr: '{"==":[{"var":"nodes.body.done"},true]}' }, maxIters: 3, ...onMaxIters === undefined ? {} : { onMaxIters } },
      { kind: 'agent', id: 'body', agent: 'reviewer', task: 'body' },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'loop', to: 'body', kind: 'flow' },
      { id: 'e2', from: 'body', to: 'loop', kind: 'loop-back' },
      { id: 'e3', from: 'loop', to: 'done', kind: 'flow' },
    ], 'loop')
    return document.nodes.find((node) => node.kind === 'loop') as WorkflowNode & { kind: 'loop' }
  }

  const converged: ExprFrame = { input: {}, nodes: { body: { done: true } }, edges: {} }

  it('stops when until converges and continues while it does not', () => {
    expect(decideLoopRound(loopOf(), 1, converged)).toEqual({ kind: 'stop', reason: 'converged' })
    expect(decideLoopRound(loopOf(), 1, FRAME)).toEqual({ kind: 'continue' })
  })

  it('applies onMaxIters once the cap is reached', () => {
    expect(decideLoopRound(loopOf(), 3, FRAME)).toEqual({ kind: 'fail', reason: 'loop "loop" reached maxIters (3) without converging' })
    expect(decideLoopRound(loopOf('continue'), 3, FRAME)).toEqual({ kind: 'continue' })
    expect(decideLoopRound(loopOf('stop'), 3, FRAME)).toEqual({ kind: 'stop', reason: 'max-iters' })
  })

  it('rejects an until expression outside the operator subset', () => {
    const document = docOf([
      { kind: 'loop', id: 'loop', body: 'body', until: { expr: '{"merge":[1,2]}' }, maxIters: 2 },
      { kind: 'agent', id: 'body', agent: 'reviewer', task: 'body' },
      { kind: 'output', id: 'done', value: 'x' },
    ], [
      { id: 'e1', from: 'loop', to: 'body', kind: 'flow' },
      { id: 'e2', from: 'body', to: 'loop', kind: 'loop-back' },
      { id: 'e3', from: 'loop', to: 'done', kind: 'flow' },
    ], 'loop')
    const loop = document.nodes.find((node) => node.kind === 'loop') as WorkflowNode & { kind: 'loop' }
    expect(() => decideLoopRound(loop, 1, FRAME)).toThrow('not a valid expression')
  })
})
