/**
 * Rendered shape of the node detail block: failed nodes expose the error
 * class and attempt count required by the M3 exit criteria.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { zh, type XlBuildKey } from '../src/client/locales.ts'
import { NodeDetail } from '../src/client/panel/NodeDetail.tsx'
import type { XlBuildNodeView } from '../src/client/wire.ts'

const t = (key: XlBuildKey): string => zh[key]

const failed: XlBuildNodeView = {
  nodeId: 'research',
  kind: 'agent',
  attempt: 2,
  status: 'failed',
  startedAt: 1,
  inputPreview: 'Research the release notes',
  inputTruncated: false,
  outputPreview: 'boom',
  outputTruncated: true,
  error: { class: 'deterministic', message: 'provider boom', attempt: 2 },
  artifacts: [{
    id: 'artifacts/research/report.md',
    nodeId: 'research',
    kind: 'file',
    path: 'dsh-resource://file/session/sess-1/artifacts/research/report.md',
    bytes: 120,
    title: 'report.md',
  }],
}

const completed: XlBuildNodeView = {
  nodeId: 'done',
  kind: 'output',
  attempt: 1,
  status: 'completed',
  startedAt: 2,
  inputPreview: 'Research the release notes',
  inputTruncated: false,
  outputPreview: 'Release notes body',
  outputTruncated: false,
  durationMs: 320,
  artifacts: [],
}

describe('NodeDetail', () => {
  it('a failed node shows the error class, the attempt count, previews, and node artifacts', () => {
    const markup = renderToStaticMarkup(<NodeDetail node={failed} t={t} />)
    expect(markup).toContain('deterministic')
    expect(markup).toContain('provider boom')
    expect(markup).toContain('2')
    expect(markup).toContain('Research the release notes')
    expect(markup).toContain('[truncated]')
    expect(markup).toContain('report.md')
    expect(markup).not.toContain('dsh-resource://')
    expect(markup).toContain(zh.detailArtifacts)
  })

  it('a completed node keeps the previews and drops the error and artifact rows', () => {
    const markup = renderToStaticMarkup(<NodeDetail node={completed} t={t} />)
    expect(markup).not.toContain('deterministic')
    expect(markup).not.toContain(zh.detailArtifacts)
    expect(markup).toContain('Release notes body')
    expect(markup).toContain('320ms')
  })
})
