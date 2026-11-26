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
import { layoutWorkflow, type LayoutEdgeInput, type LayoutNodeInput } from '../graph/layout.ts'
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

/**
 * Nodes for the topology layout. The catalog document carries the full graph
 * (start, joins, tail, and edges the journal never records — e.g. an input
 * node's null-payload transfer); the run view only carries what actually
 * executed. Prefer the document so an in-flight or cancelled run still shows
 * every node it never reached; fall back to the run view when the catalog
 * predates the structural projection.
 * @param catalogWorkflow - catalog entry matching the run's workflow, if any.
 * @param run - the selected run view.
 * @returns layout node inputs for the topology board.
 */
function graphNodesOf(
  catalogWorkflow: XlBuildView['catalog']['workflows'][number] | undefined,
  run: XlBuildRunView,
): LayoutNodeInput[] {
  if (catalogWorkflow === undefined || catalogWorkflow.nodes.length === 0) {
    return run.nodes.map((node) => ({ id: node.nodeId, kind: node.kind }))
  }
  return catalogWorkflow.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    ...node.body !== undefined ? { body: node.body } : {},
  }))
}

/**
 * Edges for the topology layout, mirroring graphNodesOf: the document
 * edges whenever the catalog carries them, else the run view's recorded
 * transfers.
 * @param catalogWorkflow - catalog entry matching the run's workflow, if any.
 * @param run - the selected run view.
 * @returns layout edge inputs for the topology board.
 */
function graphEdgesOf(
  catalogWorkflow: XlBuildView['catalog']['workflows'][number] | undefined,
  run: XlBuildRunView,
): LayoutEdgeInput[] {
  if (catalogWorkflow === undefined || catalogWorkflow.nodes.length === 0) {
    return run.edges.map((edge) => ({ id: edge.edgeId, from: edge.from, to: edge.to, kind: edge.kind }))
  }
  return catalogWorkflow.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, kind: edge.kind }))
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
  // The detail pane still reads the run view: an unstarted document node has no
  // recorded execution, so it selects nothing while still rendering on the graph.
  const selected = run.nodes.find((node) => node.nodeId === selectedNodeId)
  const layout = layoutWorkflow(graphNodesOf(catalogWorkflow, run), graphEdgesOf(catalogWorkflow, run))

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
      <div className={css.graphWrap}>
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
      </div>

      <div className={css.heading}>{t('detailHeading')}</div>
      {selected === undefined
        ? <div className={css.empty}>{t('noNodeSelected')}</div>
        : <NodeDetail node={selected} t={t} onOpen={props.openArtifact} />}

      <div className={css.heading}>{t('artifactsHeading')}</div>
      <RunBoard run={run} t={t} onOpen={props.openArtifact} />
    </div>
  )
}
