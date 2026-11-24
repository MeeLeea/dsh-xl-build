import { describe, expect, it } from 'vitest'
import { XL_EVENTS } from '../src/host/events.ts'
import { foldLedger } from '../src/host/workflow/ledger.ts'
import type { XlBuildRecordEvent } from '../src/host/projection.ts'

/** One journal record as the engine emits it. */
function record(type: string, data: unknown, seq: number): XlBuildRecordEvent {
  return { type, seq, data }
}

describe('run ledger', () => {
  it('derives node statuses from the records the run emitted', () => {
    const ledger = foldLedger([
      record(XL_EVENTS.runStart, {
        version: 1, runId: 'r1', workflowId: 'release', workflowHash: 'h1', inputs: {},
      }, 1),
      record(XL_EVENTS.nodeStart, {
        version: 1, runId: 'r1', nodeId: 'aa', kind: 'agent', attempt: 1, frame: {}, startedAt: 1, inputsDigest: 'd',
      }, 2),
    ])
    expect([...ledger.statuses('r1')]).toEqual([['aa', 'running']])

    const completed = foldLedger([
      record(XL_EVENTS.runStart, {
        version: 1, runId: 'r1', workflowId: 'release', workflowHash: 'h1', inputs: {},
      }, 1),
      record(XL_EVENTS.nodeStart, {
        version: 1, runId: 'r1', nodeId: 'aa', kind: 'agent', attempt: 1, frame: {}, startedAt: 1, inputsDigest: 'd',
      }, 2),
      record(XL_EVENTS.nodeEnd, {
        version: 1, runId: 'r1', nodeId: 'aa', status: 'completed', durationMs: 4, artifacts: [], outputDigest: 'd',
      }, 3),
    ])
    expect(completed.statuses('r1').get('aa')).toBe('completed')
  })

  it('reports a failed node and keeps runs isolated', () => {
    const ledger = foldLedger([
      record(XL_EVENTS.runStart, {
        version: 1, runId: 'r1', workflowId: 'release', workflowHash: 'h1', inputs: {},
      }, 1),
      record(XL_EVENTS.nodeStart, {
        version: 1, runId: 'r1', nodeId: 'aa', kind: 'agent', attempt: 1, frame: {}, startedAt: 1, inputsDigest: 'd',
      }, 2),
      record(XL_EVENTS.nodeError, {
        version: 1, runId: 'r1', nodeId: 'aa', class: 'timeout', message: 'late', attempt: 1,
      }, 3),
      record(XL_EVENTS.runStart, {
        version: 1, runId: 'r2', workflowId: 'release', workflowHash: 'h1', inputs: {},
      }, 4),
    ])
    expect(ledger.statuses('r1').get('aa')).toBe('failed')
    expect(ledger.statuses('r2').size).toBe(0)
    expect(ledger.statuses('absent').size).toBe(0)
    expect(ledger.state.runs.map((run) => run.runId)).toEqual(['r1', 'r2'])
  })

  it('ignores records outside the xl-build set', () => {
    const ledger = foldLedger([record('agent-multi/run-start', { version: 1 }, 1)])
    expect(ledger.state.runs).toEqual([])
    expect(ledger.statuses('r1').size).toBe(0)
  })
})
