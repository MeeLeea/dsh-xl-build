/**
 * Rendered shape of the node detail block: failed nodes expose the error
 * class and attempt count required by the M3 exit criteria.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { zh, type XlBuildKey } from '../src/client/locales.ts'
import { NodeDetail } from '../src/client/panel/NodeDetail.tsx'
import type { XlBuildNodeView } from '../src/client/wire.ts'

/** Translate stub resolving `{name}` params from the zh dictionary. */
const t = (key: XlBuildKey, params?: Record<string, unknown>): string =>
  zh[key].replace(/\{(\w+)\}/g, (_all, name: string) => String(params?.[name] ?? '{' + name + '}'))

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
  it('a failed node shows the error class, the localized status, and node artifacts', () => {
    const markup = renderToStaticMarkup(<NodeDetail node={failed} t={t} />)
    expect(markup).toContain('deterministic')
    expect(markup).toContain('provider boom')
    expect(markup).toContain('2')
    expect(markup).toContain('Research the release notes')
    expect(markup).toContain(zh['runStatus.failed'])
    expect(markup).toContain(zh.truncatedMark)
    expect(markup).toContain(zh.byteSize.replace('{bytes}', '120'))
    expect(markup).toContain('report.md')
    expect(markup).not.toContain('dsh-resource://')
    expect(markup).toContain(zh.detailArtifacts)
  })

  it('a completed node keeps the previews and drops the error and artifact rows', () => {
    const markup = renderToStaticMarkup(<NodeDetail node={completed} t={t} />)
    expect(markup).not.toContain('deterministic')
    expect(markup).not.toContain(zh.detailArtifacts)
    expect(markup).toContain('Release notes body')
    expect(markup).toContain(zh['runStatus.completed'])
    expect(markup).toContain(zh.durationValue.replace('{ms}', '320'))
  })
})
