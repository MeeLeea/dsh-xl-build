import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { RUN_STATUS_KEYS } from '../status.ts'
import type { XlBuildArtifactView, XlBuildRunView } from '../wire.ts'
import { ArtifactRows } from './NodeDetail.tsx'
import css from './panel.module.css'

/** Drop later artifacts that repeat an id already kept, preserving order. */
function uniqueArtifacts(artifacts: readonly XlBuildArtifactView[]): XlBuildArtifactView[] {
  const seen = new Set<string>()
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.id)) return false
    seen.add(artifact.id)
    return true
  })
}

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
  // Every artifact renders exactly once: node groups claim their ids in node
  // order, and the remaining run-level artifacts follow under one heading.
  const claimed = new Set<string>()
  const groups = run.nodes.flatMap((node) => {
    const artifacts = uniqueArtifacts(node.artifacts).filter((artifact) => {
      if (claimed.has(artifact.id)) return false
      claimed.add(artifact.id)
      return true
    })
    return artifacts.length === 0 ? [] : [{ nodeId: node.nodeId, artifacts }]
  })
  const ungrouped = uniqueArtifacts(run.artifacts).filter((artifact) => !claimed.has(artifact.id))
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
      {groups.length === 0
        ? (run.artifacts.length === 0
          ? <div className={css.empty}>{t('noArtifacts')}</div>
          : <ArtifactRows artifacts={uniqueArtifacts(run.artifacts)} t={t} onOpen={props.onOpen} />)
        : (
          <>
            {groups.map((group) => (
              <div key={group.nodeId} className={css.artifactGroup}>
                <div className={css.artifactGroupHead}>{group.nodeId}</div>
                <ArtifactRows artifacts={group.artifacts} t={t} onOpen={props.onOpen} />
              </div>
            ))}
            {ungrouped.length > 0 && (
              <div className={css.artifactGroup}>
                <div className={css.artifactGroupHead}>{t('artifactsUngrouped')}</div>
                <ArtifactRows artifacts={ungrouped} t={t} onOpen={props.onOpen} />
              </div>
            )}
          </>
        )}
    </div>
  )
}
