/**
 * The node detail block: identity and progress grid, input/output previews,
 * error class with message, and the node artifact rows. Pure presentation
 * over the wire view; the panel owns selection state.
 */
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { XlBuildArtifactView, XlBuildNodeView } from '../wire.ts'
import css from './panel.module.css'

/** Marker appended to preview labels whose wire payload was cut. */
const TRUNCATED = '[truncated]'

/** Placeholder for an empty preview cell. */
const EMPTY_PREVIEW = '—'

/** Props the panel passes down: the node view, the panel locale, and the artifact opener. */
export type NodeDetailProps = PropsLocale<'xl-build'> & {
  readonly node: XlBuildNodeView
  /** Opens an artifact's `dsh-resource://file` address in the right Sidebar. */
  readonly onOpen: (address: string) => void
}

/** Artifact rows; display titles when recorded, stable ids otherwise. Each
 * row opens its `dsh-resource://file` address through the injected opener —
 * which tab type claims the address is the Sidebar's decision (`plan.md`
 * §7.3). */
export function ArtifactRows(props: PropsLocale<'xl-build'> & {
  readonly artifacts: readonly XlBuildArtifactView[]
  readonly onOpen: (address: string) => void
}): ReactNode {
  return (
    <ul className={css.artifacts}>
      {props.artifacts.map((artifact) => (
        <li key={artifact.id} className={css.artifactRow}>
          <button
            type="button"
            className={css.artifactOpen}
            title={props.t('openArtifact')}
            onClick={() => props.onOpen(artifact.path)}
          >
            {artifact.title ?? artifact.id}
          </button>
          <span className={css.artifactMeta}>
            {artifact.kind}
            {artifact.bytes !== undefined ? ' · ' + artifact.bytes + ' B' : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Render one node wire view as the detail block.
 * @param props - the node view and the panel locale.
 * @returns identity grid, previews, error rows, and node artifacts.
 */
export function NodeDetail(props: NodeDetailProps): ReactNode {
  const { node, t } = props
  return (
    <div className={css.detailWrap}>
      <div className={css.detail}>
        <span className={css.detailKey}>id</span>
        <span className={css.detailValue}>{node.nodeId}</span>
        <span className={css.detailKey}>kind</span>
        <span className={css.detailValue}>{node.kind}</span>
        <span className={css.detailKey}>status</span>
        <span className={css.detailValue}>{node.status}</span>
        <span className={css.detailKey}>attempt</span>
        <span className={css.detailValue}>{node.attempt}</span>
        {node.durationMs !== undefined && (
          <>
            <span className={css.detailKey}>duration</span>
            <span className={css.detailValue}>{node.durationMs}ms</span>
          </>
        )}
        {node.error !== undefined && (
          <>
            <span className={css.detailKey}>error</span>
            <span className={css.detailValue}>
              <span className={css.errorClass}>{node.error.class}</span>
              {' ' + node.error.message}
            </span>
          </>
        )}
      </div>
      <div className={css.preview}>
        <div className={css.previewLabel}>{t('detailInput')}{node.inputTruncated ? ' ' + TRUNCATED : ''}</div>
        <div className={css.previewText}>{node.inputPreview === '' ? EMPTY_PREVIEW : node.inputPreview}</div>
      </div>
      <div className={css.preview}>
        <div className={css.previewLabel}>{t('detailOutput')}{node.outputTruncated ? ' ' + TRUNCATED : ''}</div>
        <div className={css.previewText}>{node.outputPreview === '' ? EMPTY_PREVIEW : node.outputPreview}</div>
      </div>
      {node.artifacts.length > 0 && (
        <div className={css.preview}>
          <div className={css.previewLabel}>{t('detailArtifacts')}</div>
          <ArtifactRows artifacts={node.artifacts} t={t} onOpen={props.onOpen} />
        </div>
      )}
    </div>
  )
}
