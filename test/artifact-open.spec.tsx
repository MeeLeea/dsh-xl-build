// @vitest-environment jsdom
/** Artifact rows open their `dsh-resource://file` address through the injected opener. */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { zh, type XlBuildKey } from '../src/client/locales.ts'
import { ArtifactRows } from '../src/client/panel/NodeDetail.tsx'
import type { XlBuildArtifactView } from '../src/client/wire.ts'

const t = (key: XlBuildKey): string => zh[key]

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
