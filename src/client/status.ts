/**
 * Shared run- and node-status dictionaries. One module owns the status-to-key
 * maps so the graph, the run board, the node detail, and the run selector all
 * name the same statuses identically.
 */
import type { GraphNodeStatus } from './graph/render.tsx'
import type { XlBuildKey } from './locales.ts'
import type { XlBuildRunView } from './wire.ts'

/** Run statuses the panel locale names. */
export const RUN_STATUS_KEYS = {
  running: 'runStatus.running',
  completed: 'runStatus.completed',
  failed: 'runStatus.failed',
  cancelled: 'runStatus.cancelled',
} as const satisfies Record<XlBuildRunView['status'], XlBuildKey>

/** Node statuses the panel locale names, including the two the run never reports. */
export const NODE_STATUS_KEYS = {
  running: 'runStatus.running',
  completed: 'runStatus.completed',
  failed: 'runStatus.failed',
  skipped: 'runStatus.skipped',
  cancelled: 'runStatus.cancelled',
} as const satisfies Record<GraphNodeStatus, XlBuildKey>
