// @vitest-environment jsdom
/** The export actions move the host-published Mermaid text verbatim: clipboard copy, execCommand fallback, and .mmd download. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zh, type XlBuildKey } from '../src/client/locales.ts'
import { ExportMermaid } from '../src/client/panel/ExportMermaid.tsx'
import { WorkflowPanel } from '../src/client/panel/WorkflowPanel.tsx'
import type { WireSource, XlBuildView } from '../src/client/wire.ts'

const t = (key: XlBuildKey): string => zh[key]

const MERMAID = 'flowchart TD\n  start(["input"])\n'

/** Snapshot object is stable so useSyncExternalStore never sees a fresh identity. */
function wireOf(view: XlBuildView | undefined): WireSource {
  const snapshot = { view }
  return { getSnapshot: () => snapshot, subscribe: () => () => undefined }
}

function runViewFixture(): XlBuildView['runs'][number] {
  return {
    runId: 'run-1',
    workflowId: 'release',
    workflowHash: 'hash-1',
    status: 'completed',
    nodes: [],
    edges: [],
    artifacts: [],
  }
}

function viewWith(catalogWorkflows: XlBuildView['catalog']['workflows']): XlBuildView {
  return { catalog: { agents: [], workflows: catalogWorkflows }, runs: [runViewFixture()] }
}

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

function restoreClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
}

/** Read one Blob's text through text() when jsdom provides it, FileReader otherwise. */
async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return await blob.text()
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(String(reader.result)) }
    reader.onerror = () => { reject(reader.error) }
    reader.readAsText(blob)
  })
}

afterEach(() => { cleanup() })

describe('ExportMermaid copy', () => {
  it('copies the mermaid text through the async clipboard', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    stubClipboard(writeText)
    try {
      render(<ExportMermaid mermaid={MERMAID} filename='release.mmd' t={t} />)
      fireEvent.click(screen.getByRole('button', { name: zh.copyMermaid }))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(MERMAID))
      await waitFor(() => expect(screen.getByRole('button', { name: zh.copiedMermaid })).toBeTruthy())
    } finally { restoreClipboard() }
  })

  it('falls back to execCommand when the async clipboard is unavailable', async () => {
    restoreClipboard()
    const original = document.execCommand
    document.execCommand = vi.fn(() => true)
    try {
      render(<ExportMermaid mermaid={MERMAID} filename='release.mmd' t={t} />)
      fireEvent.click(screen.getByRole('button', { name: zh.copyMermaid }))
      expect(document.execCommand).toHaveBeenCalledWith('copy')
      await waitFor(() => expect(screen.getByRole('button', { name: zh.copiedMermaid })).toBeTruthy())
    } finally { document.execCommand = original }
  })

  it('a rejected clipboard write falls back to execCommand', async () => {
    stubClipboard(vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('denied')))
    const original = document.execCommand
    document.execCommand = vi.fn(() => true)
    try {
      render(<ExportMermaid mermaid={MERMAID} filename='release.mmd' t={t} />)
      fireEvent.click(screen.getByRole('button', { name: zh.copyMermaid }))
      await waitFor(() => expect(screen.getByRole('button', { name: zh.copiedMermaid })).toBeTruthy())
    } finally {
      document.execCommand = original
      restoreClipboard()
    }
  })

  it('resets the copied label after the timeout', async () => {
    vi.useFakeTimers()
    stubClipboard(vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined))
    try {
      render(<ExportMermaid mermaid={MERMAID} filename='release.mmd' t={t} />)
      fireEvent.click(screen.getByRole('button', { name: zh.copyMermaid }))
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(screen.getByRole('button', { name: zh.copiedMermaid })).toBeTruthy()
      act(() => { vi.advanceTimersByTime(1500) })
      expect(screen.queryByRole('button', { name: zh.copiedMermaid })).toBeNull()
      expect(screen.getByRole('button', { name: zh.copyMermaid })).toBeTruthy()
    } finally {
      vi.useRealTimers()
      restoreClipboard()
    }
  })
})

describe('ExportMermaid download', () => {
  it('downloads the mermaid text verbatim as the .mmd file', async () => {
    const blobs: Blob[] = []
    const revoked: string[] = []
    const createDesc = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const revokeDesc = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    Object.defineProperty(URL, 'createObjectURL', {
      value: (blob: Blob) => { blobs.push(blob); return 'blob:test' },
      configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: (url: string) => { revoked.push(url) },
      configurable: true,
    })
    const clicked: HTMLAnchorElement[] = []
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this) })
    try {
      render(<ExportMermaid mermaid={MERMAID} filename='release.mmd' t={t} />)
      fireEvent.click(screen.getByRole('button', { name: zh.downloadMermaid }))
      expect(blobs).toHaveLength(1)
      expect(await blobText(blobs[0] as Blob)).toBe(MERMAID)
      expect(clicked).toHaveLength(1)
      expect((clicked[0] as HTMLAnchorElement).download).toBe('release.mmd')
      expect((clicked[0] as HTMLAnchorElement).href).toBe('blob:test')
      expect(revoked).toEqual(['blob:test'])
    } finally {
      clickSpy.mockRestore()
      if (createDesc !== undefined) Object.defineProperty(URL, 'createObjectURL', createDesc)
      if (revokeDesc !== undefined) Object.defineProperty(URL, 'revokeObjectURL', revokeDesc)
    }
  })
})

describe('WorkflowPanel export wiring', () => {
  it('shows the export actions only when the catalog carries the run workflow', () => {
    const cataloged = viewWith([{ id: 'release', name: 'Release', mermaid: MERMAID, nodes: [], edges: [] }])
    const { unmount } = render(<WorkflowPanel wire={wireOf(cataloged)} openArtifact={vi.fn()} t={t} />)
    expect(screen.getByRole('button', { name: zh.downloadMermaid })).toBeTruthy()
    unmount()

    const uncataloged = viewWith([])
    render(<WorkflowPanel wire={wireOf(uncataloged)} openArtifact={vi.fn()} t={t} />)
    expect(screen.queryByRole('button', { name: zh.downloadMermaid })).toBeNull()
  })
})
