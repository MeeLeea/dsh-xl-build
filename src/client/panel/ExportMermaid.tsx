/**
 * Mermaid export actions: copy the host-published projection to the clipboard
 * or download it as a .mmd file. The text arrives with the catalog wire view —
 * the client never regenerates it (plan.md §6.6).
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './panel.module.css'

/** How long the copied confirmation stays on the button. */
const COPIED_RESET_MS = 1500

/** Props the panel passes down: the workflow's Mermaid text, file name, and locale. */
export type ExportMermaidProps = PropsLocale<'xl-build'> & {
  /** Host-computed `toMermaid` output for the selected run's workflow. */
  readonly mermaid: string
  /** Download file name, `<workflowId>.mmd`. */
  readonly filename: string
}

/** Write one text payload to the clipboard, falling back to a hidden textarea when the async clipboard is unavailable. */
function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard !== undefined) {
    return navigator.clipboard.writeText(text).then(() => true, () => copyViaTextarea(text))
  }
  return Promise.resolve(copyViaTextarea(text))
}

/** Synchronous clipboard fallback for contexts without `navigator.clipboard`. */
function copyViaTextarea(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
  textarea.remove()
  return copied
}

/** Download one text payload as a file. */
function downloadText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * Render the copy and download actions.
 * @param props - the Mermaid text, the download file name, and the locale.
 * @returns the two export buttons.
 */
export function ExportMermaid(props: ExportMermaidProps): ReactNode {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => { setCopied(false) }, COPIED_RESET_MS)
    return () => { clearTimeout(timer) }
  }, [copied])

  return (
    <span className={css.exportActions}>
      <button
        type="button"
        className={css.exportButton}
        onClick={() => {
          void copyText(props.mermaid).then((done) => {
            if (done) setCopied(true)
          })
        }}
      >
        {copied ? props.t('copiedMermaid') : props.t('copyMermaid')}
      </button>
      <button
        type="button"
        className={css.exportButton}
        onClick={() => { downloadText(props.mermaid, props.filename) }}
      >
        {props.t('downloadMermaid')}
      </button>
    </span>
  )
}
