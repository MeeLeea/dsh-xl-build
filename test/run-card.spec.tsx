import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type {
  ConversationLocation, ConversationNodeContext, ConversationStartMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import { zh } from '../src/client/locales.ts'
import {
  xlBuildRunDefinition, type RunState, type XlBuildRunCardData,
} from '../src/client/run-card/definition.ts'
import { XlBuildRunCard } from '../src/client/run-card/XlBuildRunCard.tsx'
import { RunBoard } from '../src/client/panel/RunBoard.tsx'
import type { XlBuildRunView } from '../src/client/wire.ts'

// The npm primitives bundle pulls undeclared third-party deps that fail in
// node; static render only asserts text, so transparent stubs suffice.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  DisclosureRow: (props: {
    title?: string, open?: boolean,
    collapsedContent?: unknown, children?: unknown,
  }) => (
    <div data-testid="disclosure" data-title={props.title} data-open={String(props.open ?? false)}>
      {props.collapsedContent}
      {props.children}
    </div>
  ),
  StateDot: (props: { state?: string }) => <span data-state={props.state ?? ''} />
}))

/** The wire shape a `plugin:xl-build/*` record actually travels with. */
interface FoldRecord {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: true
}

function at(seq: number, type: string, data: unknown): SessionEventLike {
  const record: FoldRecord = { type, seq, time: seq * 100, data, ignorable: true }
  return record as SessionEventLike
}

type Match = { event: SessionEventLike, role: 'start' | 'update', location: ConversationLocation }

const NO_READER = { previous: () => undefined }

function context(
  state: RunState | undefined,
  start: Match | undefined,
): ConversationNodeContext<RunState> {
  return { key: 'run-1', kind: 'xl-build-run', id: 'run-1', matches: [], start, state, current: new Map() }
}

/**
 * Fold a whole record sequence through the definition exactly as the
 * assembler would, then project the final card data.
 */
function fold(
  events: readonly SessionEventLike[],
  location: ConversationLocation = { kind: 'session' },
): { data: XlBuildRunCardData, anchorSeq: number | undefined } {
  let state: RunState | undefined
  let start: Match | undefined
  for (const event of events) {
    const matched = xlBuildRunDefinition.match(event)
    if (matched === null || matched.id !== 'run-1') continue
    const match: Match = { event, role: matched.role, location }
    if (matched.role === 'start') {
      state = xlBuildRunDefinition.start(context(undefined, undefined), match, NO_READER)
      start = match
      continue
    }
    state = xlBuildRunDefinition.update(context(state, undefined), match)
  }
  if (start === undefined) return { data: undefined as never, anchorSeq: undefined }
  const view = xlBuildRunDefinition.buildViewNode(context(state, start))
  const data = view === null ? (undefined as never) : (view.data as XlBuildRunCardData)
  return { data, anchorSeq: view === null ? undefined : view.anchorSeq }
}

/** Translate stub resolving `{name}` params from the zh dictionary. */
interface XlBuildCardT {
  (key: string, params?: Record<string, unknown>): string
}

const t: XlBuildCardT = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_all, name: string) => String(params?.[name] ?? '{' + name + '}'))
}

describe('xlBuildRunDefinition', () => {
  it('folds a completed run with member pairing and the memory verdict', () => {
    const { data, anchorSeq } = fold([
      at(1, 'plugin:xl-build/run-start', { version: 1, runId: 'run-1', workflowId: 'chain', workflowHash: 'h', memoryBytes: 120, inputs: {} }),
      at(2, 'plugin:xl-build/node-start', { version: 1, runId: 'run-1', nodeId: 'research', kind: 'agent', attempt: 1, frame: { id: 'f1' }, startedAt: 1, inputsDigest: 'd' }),
      at(3, 'plugin:xl-build/node-end', { version: 1, runId: 'run-1', nodeId: 'research', status: 'completed', durationMs: 5, artifacts: [], outputDigest: 'o' }),
      at(4, 'plugin:xl-build/node-start', { version: 1, runId: 'run-1', nodeId: 'done', kind: 'output', attempt: 1, frame: { id: 'f2' }, startedAt: 2, inputsDigest: 'd' }),
      at(5, 'plugin:xl-build/node-end', { version: 1, runId: 'run-1', nodeId: 'done', status: 'completed', durationMs: 1, artifacts: [], outputDigest: 'o' }),
      at(6, 'plugin:xl-build/run-end', { version: 1, runId: 'run-1', workflowId: 'chain', outcome: 'completed', totalDurationMs: 9, artifacts: [] }),
      at(7, 'plugin:xl-build/memory-updated', { version: 1, runId: 'run-1', workflowId: 'chain', outcome: 'updated', bytes: 150 }),
    ])
    expect(anchorSeq).toBe(1)
    expect(data.name).toBe('chain')
    expect(data.status).toBe('completed')
    expect(data.memory).toEqual({ injectedBytes: 120, outcome: 'updated', updatedBytes: 150 })
    expect(data.members.map((member) => member.label + ':' + member.status)).toEqual(['research:completed', 'done:completed'])
  })

  it('marks a member failed on node-error while the run keeps running', () => {
    const { data } = fold([
      at(1, 'plugin:xl-build/run-start', { version: 1, runId: 'run-1', workflowId: 'chain', workflowHash: 'h', inputs: {} }),
      at(2, 'plugin:xl-build/node-start', { version: 1, runId: 'run-1', nodeId: 'research', kind: 'agent', attempt: 1, frame: { id: 'f1' }, startedAt: 1, inputsDigest: 'd' }),
      at(3, 'plugin:xl-build/node-error', { version: 1, runId: 'run-1', nodeId: 'research', class: 'transient', message: 'provider boom', attempt: 2 }),
    ])
    expect(data.status).toBe('running')
    expect(data.members[0]?.status).toBe('failed')
  })

  it('projects an abandoned turn as interrupted with interrupted members', () => {
    const location = {
      kind: 'turn',
      turn: { turn: 1, status: 'interrupted', steps: [], end: { seq: 9, time: 0, type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } } },
    } as ConversationLocation
    const { data } = fold([
      at(1, 'plugin:xl-build/run-start', { version: 1, runId: 'run-1', workflowId: 'chain', workflowHash: 'h', inputs: {} }),
      at(2, 'plugin:xl-build/node-start', { version: 1, runId: 'run-1', nodeId: 'research', kind: 'agent', attempt: 1, frame: { id: 'f1' }, startedAt: 1, inputsDigest: 'd' }),
    ], location)
    expect(data.status).toBe('interrupted')
    expect(data.members[0]?.status).toBe('interrupted')
  })

  it('ignores high-frequency records and records without a runId', () => {
    expect(xlBuildRunDefinition.match(at(1, 'plugin:xl-build/node-input', { version: 1, runId: 'run-1', text: '', edges: [] }))).toBeNull()
    expect(xlBuildRunDefinition.match(at(2, 'plugin:xl-build/edge-transfer', { version: 1, runId: 'run-1', edgeId: 'e', from: 'a', to: 'b', kind: 'flow', format: 'text', bytes: 3 }))).toBeNull()
    expect(xlBuildRunDefinition.match(at(3, 'plugin:xl-build/run-start', { version: 1, workflowId: 'chain', inputs: {} }))).toBeNull()
    expect(xlBuildRunDefinition.match(at(4, 'user/message', { content: [] }))).toBeNull()
  })
})

describe('XlBuildRunCard render', () => {
  it('renders the title, member rows, and the memory line', () => {
    const node = {
      key: 'run-1', kind: 'xl-build-run', id: 'run-1', target: 'chat',
      anchorSeq: 1, location: { kind: 'session' }, visibility: 'visible',
      data: {
        name: 'chain',
        status: 'failed',
        memory: { injectedBytes: 120, outcome: 'kept', reason: 'invalid memory payload' },
        members: [
          { seq: 2, label: 'research', nodeId: 'research', kind: 'agent', attempt: 2, status: 'failed' },
          { seq: 4, label: 'done', nodeId: 'done', kind: 'output', attempt: 1, status: 'skipped' },
        ],
      },
    }
    const props = { node, t }
    const markup = renderToStaticMarkup(<XlBuildRunCard {...(props as never)} />)
    expect(markup).toContain(zh.runCardTitle.replace('{name}', 'chain'))
    expect(markup).toContain('research')
    expect(markup).toContain(zh['cardStatus.failed'])
    expect(markup).toContain(zh.cardAttempt.replace('{attempt}', '2'))
    expect(markup).toContain(zh.memoryKept.replace('{reason}', 'invalid memory payload'))
    expect(markup).toContain(zh['cardStatus.skipped'])
  })
})

describe('RunBoard render', () => {
  it('renders the run summary, the memory line, and artifacts grouped by node', () => {
    const run: XlBuildRunView = {
      runId: 'run-1',
      workflowId: 'chain',
      workflowHash: 'h',
      status: 'completed',
      totalDurationMs: 1234,
      memoryBytes: 88,
      memoryUpdated: { outcome: 'updated', bytes: 200 },
      nodes: [
        { nodeId: 'research', kind: 'agent', attempt: 1, status: 'completed', startedAt: 1, inputPreview: '', inputTruncated: false, outputPreview: '', outputTruncated: false, artifacts: [] },
        { nodeId: 'done', kind: 'output', attempt: 1, status: 'completed', startedAt: 2, inputPreview: '', inputTruncated: false, outputPreview: '', outputTruncated: false, artifacts: [{ id: 'artifacts/done/output.md', nodeId: 'done', kind: 'file', path: 'dsh-resource://file/session/sess-1/artifacts/done/output.md', bytes: 42, title: 'output.md' }] },
      ],
      edges: [],
      artifacts: [{ id: 'artifacts/done/output.md', nodeId: 'done', kind: 'file', path: 'dsh-resource://file/session/sess-1/artifacts/done/output.md', bytes: 42, title: 'output.md' }],
    }
    const markup = renderToStaticMarkup(<RunBoard run={run} t={t} />)
    expect(markup).toContain('chain')
    expect(markup).toContain(zh['runStatus.completed'])
    expect(markup).toContain(zh.runDuration.replace('{ms}', '1234'))
    expect(markup).toContain(zh.memoryInjected.replace('{bytes}', '88'))
    expect(markup).toContain(zh.memoryUpdated.replace('{bytes}', '200'))
    expect(markup).toContain('done')
    expect(markup).toContain('output.md')
  })
})
