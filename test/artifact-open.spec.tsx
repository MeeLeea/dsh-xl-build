// @vitest-environment jsdom
/** Artifact rows open their `dsh-resource://file` address through the injected opener. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zh, type XlBuildKey } from '../src/client/locales.ts'
import { ArtifactRows } from '../src/client/panel/NodeDetail.tsx'
import { RunBoard } from '../src/client/panel/RunBoard.tsx'
import type { XlBuildArtifactView, XlBuildRunView } from '../src/client/wire.ts'

/** Translate stub resolving `{name}` params from the zh dictionary. */
const t = (key: XlBuildKey, params?: Record<string, unknown>): string =>
  zh[key].replace(/\{(\w+)\}/g, (_all, name: string) => String(params?.[name] ?? '{' + name + '}'))

afterEach(cleanup)

const artifact: XlBuildArtifactView = {
  id: 'artifacts/done/output.md',
  nodeId: 'done',
  kind: 'file',
  path: 'dsh-resource://file/session/session-1/artifacts/done/output.md',
  bytes: 42,
  title: 'output.md',
}

it('clicking an artifact row hands the dsh-resource address to the opener', () => {
  const onOpen = vi.fn<(address: string) => void>()
  render(<ArtifactRows artifacts={[artifact]} t={t} onOpen={onOpen} />)
  fireEvent.click(screen.getByRole('button', { name: 'output.md' }))
  expect(onOpen).toHaveBeenCalledWith('dsh-resource://file/session/session-1/artifacts/done/output.md')
})

it('rows without a recorded title label themselves with the stable id', () => {
  const onOpen = vi.fn<(address: string) => void>()
  const untitled: XlBuildArtifactView = { ...artifact, title: undefined }
  render(<ArtifactRows artifacts={[untitled]} t={t} onOpen={onOpen} />)
  fireEvent.click(screen.getByRole('button', { name: 'artifacts/done/output.md' }))
  expect(onOpen).toHaveBeenCalledTimes(1)
})

it('renders run-level artifacts alongside node groups, deduplicated by id', () => {
  const onOpen = vi.fn<(address: string) => void>()
  const summary: XlBuildArtifactView = {
    id: 'artifacts/run/summary.txt',
    nodeId: '',
    kind: 'file',
    path: 'dsh-resource://file/session/session-1/artifacts/run/summary.txt',
    title: 'summary.txt',
  }
  const run: XlBuildRunView = {
    runId: 'run-1',
    workflowId: 'chain',
    workflowHash: 'h',
    status: 'completed',
    nodes: [{
      nodeId: 'done',
      kind: 'output',
      attempt: 1,
      status: 'completed',
      startedAt: 1,
      inputPreview: '',
      inputTruncated: false,
      outputPreview: '',
      outputTruncated: false,
      artifacts: [artifact],
    }],
    edges: [],
    artifacts: [artifact, summary],
  }
  render(<RunBoard run={run} t={t} onOpen={onOpen} />)
  expect(screen.getAllByRole('button', { name: 'output.md' })).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'summary.txt' })).toBeTruthy()
  expect(screen.getByText(zh.artifactsUngrouped)).toBeTruthy()
})
