import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { XlBuildRunView } from '../wire.ts'
import { ArtifactRows } from './NodeDetail.tsx'
import css from './panel.module.css'

/** Run statuses the panel locale names. */
const RUN_STATUS_KEYS = {
  running: 'runStatus.running',
  completed: 'runStatus.completed',
  failed: 'runStatus.failed',
  cancelled: 'runStatus.cancelled',
} as const satisfies Record<XlBuildRunView['status'], `runStatus.${XlBuildRunView['status']}`>

/** Memory line of a run view: injected bytes plus the curator verdict. */
function memoryLines(run: XlBuildRunView, t: PropsLocale<'xl-build'>['t']): string[] {
  const lines: string[] = []
  if (run.memoryBytes !== undefined) lines.push(t('memoryInjected', { bytes: run.memoryBytes }))
  const updated = run.memoryUpdated
  if (updated !== undefined) {
    if (updated.outcome === 'updated' && updated.bytes !== undefined) {
      lines.push(t('memoryUpdated', { bytes: updated.bytes }))
    }
    if (updated.outcome === 'kept' && updated.reason !== undefined) {
      lines.push(t('memoryKept', { reason: updated.reason }))
    }
  }
  return lines
}

/**
 * Run board under the artifacts heading: the run summary with its memory
 * state, then artifact files grouped by the node that produced them. When no
 * node recorded its artifacts, the run-level list renders flat.
 */
export function RunBoard(props: PropsLocale<'xl-build'> & {
  readonly run: XlBuildRunView
  /** Opens an artifact's `dsh-resource://file` address in the right Sidebar. */
  readonly onOpen: (address: string) => void
}): ReactNode {
  const { run, t } = props
  const grouped = run.nodes.filter((node) => node.artifacts.length > 0)
  return (
    <div className={css.detailWrap}>
      <div className={css.runSummaryLine}>
        <span className={css.runSummaryId}>{run.workflowId}</span>
        <span className={css.runSummaryStatus}>{t(RUN_STATUS_KEYS[run.status])}</span>
        <span className={css.runSummaryId}>{run.runId.slice(0, 8)}</span>
        {run.totalDurationMs !== undefined
          ? <span>{t('runDuration', { ms: run.totalDurationMs })}</span>
          : null}
      </div>
      {memoryLines(run, t).map((line) => <div key={line} className={css.memoryLine}>{line}</div>)}
      {grouped.length === 0
        ? (run.artifacts.length === 0
          ? <div className={css.empty}>{t('noArtifacts')}</div>
          : <ArtifactRows artifacts={run.artifacts} t={t} onOpen={props.onOpen} />)
        : grouped.map((node) => (
          <div key={node.nodeId} className={css.artifactGroup}>
            <div className={css.artifactGroupHead}>{node.nodeId}</div>
            <ArtifactRows artifacts={node.artifacts} t={t} onOpen={props.onOpen} />
          </div>
        ))}
    </div>
  )
}
