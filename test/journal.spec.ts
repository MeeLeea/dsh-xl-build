import { describe, expect, it } from 'vitest'
import { renderEdgeEnvelope } from '../src/host/workflow/envelope.ts'
import {
  digestOf,
  edgeTransferRecord,
  nodeEndRecord,
  nodeErrorRecord,
  nodeInputRecord,
  nodeStartRecord,
  runEndRecord,
  runStartRecord,
} from '../src/host/workflow/journal.ts'

describe('digestOf', () => {
  it('is a stable eight-character hexadecimal digest', () => {
    expect(digestOf('abc')).toBe(digestOf('abc'))
    expect(digestOf('abc')).toMatch(/^[0-9a-f]{8}$/)
    expect(digestOf('abc')).not.toBe(digestOf('abd'))
    expect(digestOf('')).toHaveLength(8)
  })

  it('distinguishes payloads that differ only in structure', () => {
    expect(digestOf(JSON.stringify({ a: 1 }))).not.toBe(digestOf(JSON.stringify({ a: '1' })))
  })
})

describe('journal builders', () => {
  it('marks every record as version 1 and passes fields through', () => {
    expect(runStartRecord({ runId: 'r1', workflowId: 'w1', workflowHash: 'h1', inputs: {} }))
      .toEqual({ version: 1, runId: 'r1', workflowId: 'w1', workflowHash: 'h1', inputs: {} })

    expect(runStartRecord({ runId: 'r1', workflowId: 'w1', workflowHash: 'h1', inputs: {}, selfNodeId: 'n1' }))
      .toMatchObject({ version: 1, selfNodeId: 'n1' })

    expect(nodeInputRecord({ runId: 'r1', nodeId: 'n1', edges: [], text: 'text' }))
      .toEqual({ version: 1, runId: 'r1', nodeId: 'n1', edges: [], text: 'text' })

    expect(nodeErrorRecord({ runId: 'r1', nodeId: 'n1', class: 'timeout', message: 'late', attempt: 2 }))
      .toEqual({ version: 1, runId: 'r1', nodeId: 'n1', class: 'timeout', message: 'late', attempt: 2 })

    expect(runEndRecord({ runId: 'r1', outcome: 'failed', totalDurationMs: 12, artifacts: [] }))
      .toEqual({ version: 1, runId: 'r1', outcome: 'failed', totalDurationMs: 12, artifacts: [] })
  })

  it('digests the node frame and the node output', () => {
    const frame = { input: { version: '1.2.3' } }
    expect(nodeStartRecord({
      runId: 'r1', nodeId: 'n1', kind: 'agent', attempt: 1, frame, startedAt: 5,
    })).toEqual({
      version: 1,
      runId: 'r1',
      nodeId: 'n1',
      kind: 'agent',
      attempt: 1,
      frame,
      startedAt: 5,
      inputsDigest: digestOf(JSON.stringify(frame)),
    })

    expect(nodeEndRecord({
      runId: 'r1', nodeId: 'n1', status: 'completed', durationMs: 7, artifacts: [], output: 'done',
    }).outputDigest).toBe(digestOf('"done"'))

    // An absent output digests the explicit `null` the record carries.
    expect(nodeEndRecord({
      runId: 'r1', nodeId: 'n1', status: 'completed', durationMs: 7, artifacts: [], output: undefined,
    }).outputDigest).toBe(digestOf('null'))
  })

  it('records the byte size the envelope reported for an edge', () => {
    const envelope = renderEdgeEnvelope({ from: 'aa', to: 'bb', format: 'md', value: '# title' })
    expect(edgeTransferRecord({
      runId: 'r1', edgeId: 'e1', from: 'aa', to: 'bb', kind: 'flow', format: 'md', bytes: envelope.bytes,
    })).toMatchObject({ version: 1, edgeId: 'e1', format: 'md', bytes: envelope.bytes })
    expect(envelope.bytes).toBeGreaterThan(0)
  })
})
