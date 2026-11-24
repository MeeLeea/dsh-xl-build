/**
 * SVG renderer for the run board topology: one shape per node keyed by node
 * kind, one color class per run status, and edge labels carrying the wire
 * format, size, and truncation mark. The renderer draws the coordinates its
 * layout hands it; it never reads run state beyond the status maps given.
 */
import type { ReactElement } from 'react'
import type { PlacedEdge, PlacedNode, WorkflowLayout } from './layout.ts'
import styles from './graph.module.css'

/** Class-name lookup result: a CSS module key may be absent. */
type Css = string | undefined

/** Node run status; absent entries render idle. */
export type GraphNodeStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'

/** Wire state of one edge; absent entries render idle. */
export interface GraphEdgeState {
  readonly status: 'idle' | 'transferred' | 'truncated'
  readonly format: string
  readonly bytes?: number
}

/** Props of the topology board. */
export interface WorkflowGraphProps {
  readonly layout: WorkflowLayout
  /** Run status per node id. */
  readonly nodeStatuses?: Readonly<Record<string, GraphNodeStatus>>
  /** Wire state per edge id. */
  readonly edgeStates?: Readonly<Record<string, GraphEdgeState>>
  /** Node shown as selected; absent selection deselects. */
  readonly selectedNodeId?: string | undefined
  /** Node click handler; omitting it removes the pointer affordance. */
  readonly onSelectNode?: ((nodeId: string) => void) | undefined
}

const STATUS_CLASS: Record<GraphNodeStatus, Css> = {
  running: styles.nodeStatusRunning,
  completed: styles.nodeStatusCompleted,
  failed: styles.nodeStatusFailed,
  skipped: styles.nodeStatusSkipped,
  cancelled: styles.nodeStatusCancelled,
}

const EDGE_STATUS_CLASS: Record<GraphEdgeState['status'], Css> = {
  idle: styles.edgeIdle,
  transferred: styles.edgeTransferred,
  truncated: styles.edgeTruncated,
}

/**
 * Join CSS class candidates, dropping absent and empty names.
 * @param names - class candidates.
 * @returns the joined class attribute value.
 */
function cls(...names: readonly Css[]): string {
  return names.filter((name) => name !== undefined && name !== '').join(' ')
}

/** Notch width of the join shape, cut into its left edge. */
const JOIN_NOTCH = 12

/**
 * Render the workflow topology board.
 * @param props - layout plus optional run-state overlays and selection.
 * @returns the SVG element.
 */
export function WorkflowGraph(props: WorkflowGraphProps): ReactElement {
  const { layout, nodeStatuses, edgeStates, selectedNodeId, onSelectNode } = props
  return (
    <svg
      className={styles.graph}
      width={layout.width}
      height={layout.height}
      viewBox={'0 0 ' + layout.width + ' ' + layout.height}
      role="img"
      aria-label="workflow topology"
    >
      <defs>
        <marker id="xl-edge-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0 0 L7 3.5 L0 7 Z" className={cls(styles.edgeArrow)} />
        </marker>
      </defs>
      {layout.loops.map((box) => (
        <rect
          key={'loop-' + box.loopId}
          className={styles.loopBox}
          x={box.x}
          y={box.y}
          width={box.width}
          height={box.height}
          rx={12}
        />
      ))}
      {layout.edges.map((edge) => (
        <EdgePath key={edge.id} edge={edge} state={edgeStates?.[edge.id]} />
      ))}
      {layout.nodes.map((node) => (
        <NodeGroup
          key={node.id}
          node={node}
          status={nodeStatuses?.[node.id]}
          selected={selectedNodeId === node.id}
          clickable={onSelectNode !== undefined}
          onSelect={onSelectNode}
        />
      ))}
    </svg>
  )
}

/**
 * One edge: its path follows the layout anchors, and its label carries the
 * wire format, byte size, and truncation mark when the run recorded them.
 * @param edge - placed edge.
 * @param state - wire state, undefined while the edge is idle.
 * @returns the edge path and label elements.
 */
function EdgePath(props: {
  readonly edge: PlacedEdge
  readonly state?: GraphEdgeState | undefined
}): ReactElement {
  const { edge, state } = props
  const className = cls(styles.edge, state === undefined ? undefined : EDGE_STATUS_CLASS[state.status])
  const d = edge.kind === 'loop-back'
    ? loopBackPath(edge.fromPoint, edge.toPoint)
    : 'M' + edge.fromPoint.x + ' ' + edge.fromPoint.y + ' L' + edge.toPoint.x + ' ' + edge.toPoint.y
  const midX = (edge.fromPoint.x + edge.toPoint.x) / 2
  const label = edgeLabel(state)
  const labelY = edge.kind === 'loop-back'
    ? Math.max(edge.fromPoint.y, edge.toPoint.y) + 18
    : (edge.fromPoint.y + edge.toPoint.y) / 2 - 6
  return (
    <g data-edge-id={edge.id}>
      <path className={className} d={d} markerEnd="url(#xl-edge-arrow)" />
      {label !== undefined && (
        <text className={styles.edgeLabel} x={midX} y={labelY} textAnchor="middle">{label}</text>
      )}
    </g>
  )
}

/**
 * Wire label of one edge: the format alone while idle, the format and byte
 * size once transferred, and the truncation mark when the payload was cut.
 * @param state - wire state, undefined while the edge is idle.
 * @returns the label text, or nothing when the edge has no state.
 */
function edgeLabel(state?: GraphEdgeState | undefined): string | undefined {
  if (state === undefined) return undefined
  const size = state.bytes === undefined ? state.format : state.format + ' \u00b7 ' + state.bytes + 'B'
  return state.status === 'truncated' ? size + ' [truncated]' : size
}

/**
 * Path of one loop-back edge: a curve dipping under both endpoint nodes.
 * @param from - source anchor.
 * @param to - target anchor.
 * @returns the SVG path command.
 */
function loopBackPath(
  from: { readonly x: number, readonly y: number },
  to: { readonly x: number, readonly y: number },
): string {
  const dip = Math.max(from.y, to.y) + 24
  return 'M' + from.x + ' ' + from.y
    + ' C' + from.x + ' ' + dip + ', ' + to.x + ' ' + dip + ', ' + to.x + ' ' + to.y
}

/**
 * One node: its kind shape, its run-status classes, and the node id label.
 * @param node - placed node.
 * @param status - run status, undefined while idle.
 * @param selected - whether the node is the selected one.
 * @param clickable - whether node clicks are wired.
 * @param onSelect - click handler.
 * @returns the node group element.
 */
function NodeGroup(props: {
  readonly node: PlacedNode
  readonly status?: GraphNodeStatus | undefined
  readonly selected: boolean
  readonly clickable: boolean
  readonly onSelect?: ((nodeId: string) => void) | undefined
}): ReactElement {
  const { node, status, selected, clickable, onSelect } = props
  const className = cls(
    styles.node,
    status === undefined ? styles.nodeIdle : STATUS_CLASS[status],
    selected ? styles.nodeSelected : undefined,
    clickable ? styles.nodeClickable : undefined,
  )
  return (
    <g
      className={className}
      data-node-id={node.id}
      onClick={onSelect === undefined ? undefined : () => onSelect(node.id)}
    >
      {shapeFor(node)}
      <text
        className={styles.nodeLabel}
        x={node.x + node.width / 2}
        y={node.y + node.height / 2}
        textAnchor="middle"
        dominantBaseline="central"
      >
        {node.id}
      </text>
    </g>
  )
}

/**
 * Shape of one node, keyed by kind: pills for input and output, a diamond for
 * the router, a dashed rect for the loop, a light dashed rect for the note, a
 * left-notched polygon for the join, and a double-edged rect for the
 * subworkflow; every other kind is a rounded rect.
 * @param node - placed node.
 * @returns the shape element.
 */
function shapeFor(node: PlacedNode): ReactElement {
  const { x, y, width: w, height: h } = node
  switch (node.kind) {
    case 'input':
      return <rect className={cls(styles.node)} x={x} y={y} width={w} height={h} rx={h / 2} />
    case 'output':
      return (
        <>
          <rect className={cls(styles.node)} x={x} y={y} width={w} height={h} rx={8} />
          <rect className={cls(styles.outputInner)} x={x + 4} y={y + 4} width={w - 8} height={h - 8} rx={5} />
        </>
      )
    case 'router': {
      const points = (x + w / 2) + ',' + y + ' ' + (x + w) + ',' + (y + h / 2) + ' '
        + (x + w / 2) + ',' + (y + h) + ' ' + x + ',' + (y + h / 2)
      return <polygon className={cls(styles.node)} points={points} />
    }
    case 'loop':
      return <rect className={cls(styles.node, styles.loop)} x={x} y={y} width={w} height={h} rx={8} />
    case 'note':
      return <rect className={cls(styles.node, styles.note)} x={x} y={y} width={w} height={h} rx={4} />
    case 'join': {
      const points = x + ',' + y + ' ' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + h) + ' '
        + x + ',' + (y + h) + ' ' + (x + JOIN_NOTCH) + ',' + (y + h / 2)
      return <polygon className={cls(styles.node)} points={points} />
    }
    case 'subworkflow':
      return (
        <>
          <rect className={cls(styles.node)} x={x} y={y} width={w} height={h} rx={8} />
          <line className={cls(styles.subMarker)} x1={x + 5} y1={y + 6} x2={x + 5} y2={y + h - 6} />
        </>
      )
    default:
      return <rect className={cls(styles.node)} x={x} y={y} width={w} height={h} rx={8} />
  }
}
