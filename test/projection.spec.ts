import { describe, expect, it } from 'vitest'
import { XL_EVENTS } from '../src/host/events.ts'
import {
  applyXlBuildRecord,
  buildXlBuildView,
  createXlBuildProjection,
  emptyXlBuildProjection,
  truncatePreview,
} from '../src/host/projection.ts'
import type { XlBuildProjectionState } from '../src/host/projection.ts'

const OPTIONS = { recentRuns: 2, wirePreviewBytes: 2_048 }

interface TestRecord {
  type: string
  seq: number
  data: unknown
}

/** Fold a record list into a fresh projection state. */
function fold(records: TestRecord[]): XlBuildProjectionState {
  return records.reduce(applyXlBuildRecord, emptyXlBuildProjection())
}

const RUN_START = (runId: string, seq: number): TestRecord => ({
  type: XL_EVENTS.runStart,
  seq,
  data: {
    version: 1,
    runId,
    workflowId: 'release',
    workflowHash: 'abc123',
    inputs: { version: '1.2.3' },
  },
})

const NODE_START = (runId: string, nodeId: string, seq: number, attempt = 1): TestRecord => ({
  type: XL_EVENTS.nodeStart,
  seq,
  data: {
    version: 1,
    runId,
    nodeId,
    kind: 'agent',
    attempt,
    frame: { input: { version: '1.2.3' } },
    startedAt: seq,
    inputsDigest: 'digest',
  },
})

const NODE_DELTA = (runId: string, nodeId: string, text: string, seq: number): TestRecord => ({
  type: XL_EVENTS.nodeDelta,
  seq,
  data: { version: 1, runId, nodeId, text },
})

const NODE_END = (runId: string, nodeId: string, seq: number): TestRecord => ({
  type: XL_EVENTS.nodeEnd,
  seq,
  data: {
    version: 1,
    runId,
    nodeId,
    status: 'completed',
    durationMs: 25,
    artifacts: [{ id: 'a1', nodeId, kind: 'text', path: 'dsh-resource://file/session/sess-1/a1.md', title: 'a1.md' }],
    outputDigest: 'out-digest',
  },
})

const RUN_END = (runId: string, seq: number): TestRecord => ({
  type: XL_EVENTS.runEnd,
  seq,
  data: { version: 1, runId, outcome: 'completed', totalDurationMs: 900, artifacts: [] },
})

describe('xlBuild projection fold', () => {
  it('folds a complete run into the client view', () => {
    const state = fold([
      RUN_START('r1', 1),
      NODE_START('r1', 'n1', 2),
      { type: XL_EVENTS.nodeInput, seq: 3, data: { version: 1, runId: 'r1', nodeId: 'n1', edges: [], text: 'do the thing' } },
      NODE_DELTA('r1', 'n1', 'hel', 4),
      NODE_DELTA('r1', 'n1', 'lo', 5),
      NODE_END('r1', 'n1', 6),
      {
        type: XL_EVENTS.edgeTransfer,
        seq: 7,
        data: { version: 1, runId: 'r1', edgeId: 'e1', from: 'n1', to: 'n2', kind: 'normal', format: 'md', bytes: 12 },
      },
      RUN_END('r1', 8),
    ])

    const view = buildXlBuildView(state, OPTIONS)
    expect(view.runs).toHaveLength(1)
    const [run] = view.runs
    expect(run?.status).toBe('completed')
    expect(run?.totalDurationMs).toBe(900)
    expect(run?.nodes).toHaveLength(1)
    expect(run?.nodes[0]).toMatchObject({
      nodeId: 'n1',
      kind: 'agent',
      attempt: 1,
      status: 'completed',
      inputPreview: 'do the thing',
      outputPreview: 'hello',
      outputTruncated: false,
      durationMs: 25,
      artifacts: [{ id: 'a1', nodeId: 'n1', kind: 'text', path: 'dsh-resource://file/session/sess-1/a1.md', title: 'a1.md' }],
    })
    expect(run?.edges).toEqual([
      { edgeId: 'e1', from: 'n1', to: 'n2', kind: 'normal', format: 'md', bytes: 12 },
    ])
  })

  it('returns the same state reference for foreign and malformed records', () => {
    const state = fold([RUN_START('r1', 1)])
    expect(applyXlBuildRecord(state, { type: 'plugin:other/event', seq: 2, data: {} })).toBe(state)
    expect(applyXlBuildRecord(state, { type: 'agent-multi/run-start', seq: 2, data: {} })).toBe(state)
    expect(applyXlBuildRecord(state, { type: XL_EVENTS.nodeDelta, seq: 2, data: { version: 2 } })).toBe(state)
    expect(applyXlBuildRecord(state, { type: XL_EVENTS.nodeEnd, seq: 2, data: { version: 1, runId: 'missing' } })).toBe(state)
  })

  it('marks a failed attempt and keeps its error', () => {
    const state = fold([
      RUN_START('r1', 1),
      NODE_START('r1', 'n1', 2),
      {
        type: XL_EVENTS.nodeError,
        seq: 3,
        data: { version: 1, runId: 'r1', nodeId: 'n1', class: 'timeout', message: 'took too long', attempt: 1 },
      },
    ])
    expect(buildXlBuildView(state, OPTIONS).runs[0]?.nodes[0]).toMatchObject({
      status: 'failed',
      error: { class: 'timeout', message: 'took too long', attempt: 1 },
    })
  })

  it('keeps active runs and only the most recent settled runs', () => {
    const state = fold([
      RUN_START('old', 1),
      RUN_END('old', 2),
      RUN_START('newer', 3),
      RUN_END('newer', 4),
      RUN_START('live', 5),
      NODE_START('live', 'n1', 6),
    ])

    const view = buildXlBuildView(state, { ...OPTIONS, recentRuns: 1 })
    expect(view.runs.map((run) => run.runId)).toEqual(['live', 'newer'])
  })

  it('truncates previews by UTF-8 bytes without splitting a code point', () => {
    expect(truncatePreview('ab', 4)).toEqual({ text: 'ab', truncated: false })
    expect(truncatePreview('中文文本', 4)).toEqual({ text: '中', truncated: true })
    expect(truncatePreview('abcd', 4)).toEqual({ text: 'abcd', truncated: false })

    const state = fold([
      RUN_START('r1', 1),
      NODE_START('r1', 'n1', 2),
      NODE_DELTA('r1', 'n1', '中文文本', 3),
    ])
    const node = buildXlBuildView(state, { ...OPTIONS, wirePreviewBytes: 4 }).runs[0]?.nodes[0]
    expect(node?.outputPreview).toBe('中')
    expect(node?.outputTruncated).toBe(true)
  })

  it('folds the catalog record', () => {
    const state = fold([{
      type: XL_EVENTS.catalog,
      seq: 1,
      data: {
        version: 1,
        agents: [{ id: 'reviewer', name: 'Reviewer', description: 'Reviews.' }],
        workflows: [{ id: 'release', name: 'Release', mermaid: 'flowchart TD\n  %% note: x\n' }],
      },
    }])
    expect(buildXlBuildView(state, OPTIONS).catalog).toEqual({
      agents: [{ id: 'reviewer', name: 'Reviewer', description: 'Reviews.' }],
      workflows: [{ id: 'release', name: 'Release', mermaid: 'flowchart TD\n  %% note: x\n' }],
    })
  })
})

describe('xlBuild projection unit', () => {
  it('reuses the wire view reference for an unchanged state', () => {
    const definition = createXlBuildProjection(OPTIONS)
    const state = fold([RUN_START('r1', 1)])
    const first = definition.wire?.view(state)
    const second = definition.wire?.view(state)
    expect(first).toBe(second)
  })

  it('starts empty and declares its key', () => {
    const definition = createXlBuildProjection(OPTIONS)
    expect(definition.key).toBe('xlBuild')
    expect(definition.stateVersion).toBe(1)
    const state = definition.init({} as never, 0)
    expect(buildXlBuildView(state, OPTIONS)).toEqual({ catalog: { agents: [], workflows: [] }, runs: [] })
  })
})
