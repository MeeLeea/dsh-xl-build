/**
 * The xl-build main panel: run selector, live topology, minimal node detail,
 * and the run's artifact list. The panel is root-scoped and carries no Session
 * binding; it renders whatever the injected wire face currently exposes and
 * computes no run state of its own.
 */
import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { layoutWorkflow } from '../graph/layout.ts'
import { WorkflowGraph, type GraphEdgeState, type GraphNodeStatus } from '../graph/render.tsx'
import { NODE_STATUS_KEYS, RUN_STATUS_KEYS } from '../status.ts'
import type { WireSource, XlBuildRunView, XlBuildView } from '../wire.ts'
import { ExportMermaid } from './ExportMermaid.tsx'
import { NodeDetail } from './NodeDetail.tsx'
import { RunBoard } from './RunBoard.tsx'
import css from './panel.module.css'

/** Face the mount injects into the panel. */
export interface XlBuildInjected {
  /** Wire view of the most recently active session's \`xlBuild\` projection; re-emits on session and projection changes. */
  readonly wire: WireSource
  /** Opens a \`dsh-resource://file\` artifact address in the right Sidebar (\`plan.md\` §7.3). */
  readonly openArtifact: (address: string) => void
}

/** Props the host passes to the panel component. */
export type WorkflowPanelProps =
  PropsRuntime<'main'> &
  InjectFace<XlBuildInjected> &
  PropsLocale<'xl-build'>

/** Node statuses as the graph renderer reads them. */
function nodeStatusesOf(run: XlBuildRunView): Record<string, GraphNodeStatus> {
  return Object.fromEntries(run.nodes.map((node) => [node.nodeId, node.status]))
}

/** Every recorded transfer reads as transferred; truncation is surfaced through the view data. */
function edgeStatesOf(run: XlBuildRunView): Record<string, GraphEdgeState> {
  return Object.fromEntries(run.edges.map((edge) => [edge.edgeId, {
    status: 'transferred',
    format: edge.format,
    bytes: edge.bytes,
  }]))
}

/** One selector row: workflow, localized outcome, and a short run id. */
function runLabel(run: XlBuildRunView, t: PropsLocale<'xl-build'>['t']): string {
  return run.workflowId + ' \u00b7 ' + t(RUN_STATUS_KEYS[run.status]) + ' \u00b7 ' + run.runId.slice(0, 8)
}

/**
 * Render the run board.
 * @param props - host props plus the wire face and the panel locale.
 * @returns the panel content for the current wire view.
 */
export function WorkflowPanel(props: WorkflowPanelProps): ReactNode {
  const { t } = props
  // InjectFace passes the injected face's members through verbatim.
  const wire = useSyncExternalStore(props.wire.subscribe, props.wire.getSnapshot)
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined)
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined)

  const view: XlBuildView | undefined = wire.view
  if (view === undefined || (view.runs.length === 0 && view.catalog.workflows.length === 0)) {
    return <div className={css.empty}>{t('emptyNoWorkflows')}</div>
  }
  if (view.runs.length === 0) {
    return <div className={css.empty}>{t('emptyNoRuns')}</div>
  }

  // Selection is by run id, so a newly arriving run never silently replaces the
  // user's choice; a vanished run falls back to the first without extra state.
  const run = (view.runs.find((candidate) => candidate.runId === selectedRunId) ?? view.runs[0]) as XlBuildRunView
  const catalogWorkflow = view.catalog.workflows.find((workflow) => workflow.id === run.workflowId)
  const selected = run.nodes.find((node) => node.nodeId === selectedNodeId)
  const layout = layoutWorkflow(
    run.nodes.map((node) => ({ id: node.nodeId, kind: node.kind })),
    run.edges.map((edge) => ({ id: edge.edgeId, from: edge.from, to: edge.to, kind: edge.kind })),
  )

  return (
    <div className={css.panel}>
      <div className={css.toolbar}>
        <label className={css.selectorLabel} htmlFor="xl-run-selector">{t('runSelector')}</label>
        <select
          id="xl-run-selector"
          className={css.selector}
          value={run.runId}
          onChange={(event) => {
            setSelectedRunId(event.target.value)
            setSelectedNodeId(undefined)
          }}
        >
          {view.runs.map((candidate) => (
            <option key={candidate.runId} value={candidate.runId}>{runLabel(candidate, t)}</option>
          ))}
        </select>
        {catalogWorkflow !== undefined && (
          <ExportMermaid mermaid={catalogWorkflow.mermaid} filename={catalogWorkflow.id + '.mmd'} t={t} />
        )}
      </div>

      <div className={css.heading}>{t('topologyHeading')}</div>
      <WorkflowGraph
        layout={layout}
        ariaLabel={t('topologyAriaLabel')}
        truncatedMark={t('truncatedMark')}
        nodeAriaLabel={(node, status) => t('graphNodeAria', {
          id: node.id,
          kind: node.kind,
          status: status === undefined ? t('runStatus.idle') : t(NODE_STATUS_KEYS[status]),
        })}
        nodeStatuses={nodeStatusesOf(run)}
        edgeStates={edgeStatesOf(run)}
        selectedNodeId={selected?.nodeId}
        onSelectNode={setSelectedNodeId}
      />

      <div className={css.heading}>{t('detailHeading')}</div>
      {selected === undefined
        ? <div className={css.empty}>{t('noNodeSelected')}</div>
        : <NodeDetail node={selected} t={t} onOpen={props.openArtifact} />}

      <div className={css.heading}>{t('artifactsHeading')}</div>
      <RunBoard run={run} t={t} onOpen={props.openArtifact} />
    </div>
  )
}
