/**
 * Fold the durable `plugin:xl-build/*` run records into one keyed Chat node:
 * the session-timeline run card. The fold applies the product language of
 * dsh-client-ui-workflow-run (member start/end pairing, terminal outcome,
 * abandoned-turn interruption) against this plugin's own record names.
 *
 * Plugin records are owner-validated JSON rather than SessionEventMap
 * members, so the match widens the event type to a string and the fold
 * validates the payload fields it consumes.
 */
import type {
  ConversationLocation, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'

/** Protocol record names of the xl-build run family (mirrors src/host/events.ts). */
const RUN_START = 'plugin:xl-build/run-start'
const NODE_START = 'plugin:xl-build/node-start'
const NODE_END = 'plugin:xl-build/node-end'
const NODE_ERROR = 'plugin:xl-build/node-error'
const RUN_END = 'plugin:xl-build/run-end'
const MEMORY_UPDATED = 'plugin:xl-build/memory-updated'
const UPDATE_TYPES = new Set([NODE_START, NODE_END, NODE_ERROR, RUN_END, MEMORY_UPDATED])

/** Status shown on the run card for the run itself and each member. */
export type XlBuildRunCardStatus =
  | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled' | 'interrupted'

/** Final renderer data for one member — one workflow node execution. */
export interface XlBuildRunCardMember {
  readonly seq: number
  /** Workflow node id, shown verbatim. */
  readonly label: string
  readonly kind: string
  readonly attempt: number
  readonly status: XlBuildRunCardStatus
}

/** Memory facts rendered as the card's memory line. */
export interface XlBuildRunCardMemory {
  /** Bytes of workflow memory injected at run start; absent when memory is disabled. */
  readonly injectedBytes?: number
  /** Curator verdict after run end; absent until the memory-updated record lands. */
  readonly outcome?: 'updated' | 'kept'
  /** Bytes written by the curator; absent when the memory was kept. */
  readonly updatedBytes?: number
  /** Why the previous memory was kept; absent when the memory was updated. */
  readonly reason?: string
}

/** Final keyed Chat payload for one xl-build run. */
export interface XlBuildRunCardData {
  /** Workflow id shown on the card title. */
  readonly name: string
  readonly status: XlBuildRunCardStatus
  readonly memory?: XlBuildRunCardMemory
  readonly members: readonly XlBuildRunCardMember[]
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Durable xl-build workflow run and every node that actually started. */
    'xl-build-run': XlBuildRunCardData
  }
}

/** Terminal per-node statuses a node-end record may carry. */
const NODE_STATUS = new Set(['completed', 'failed', 'skipped', 'cancelled'])
/** Terminal run outcomes a run-end record may carry. */
const RUN_OUTCOMES = new Set(['completed', 'failed', 'cancelled'])

function fieldOf(data: unknown, key: string): unknown {
  if (typeof data !== 'object' || data === null) return undefined
  return (data as Record<string, unknown>)[key]
}

function stringField(data: unknown, key: string): string | undefined {
  const value = fieldOf(data, key)
  return typeof value === 'string' ? value : undefined
}

function numberField(data: unknown, key: string): number | undefined {
  const value = fieldOf(data, key)
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

interface MemberState {
  readonly seq: number
  readonly nodeId: string
  readonly kind: string
  readonly attempt: number
  readonly status: 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'
}

/** Fold state carried between matched events; projected through {@link projectRun}. */
export interface RunState {
  readonly workflowId: string
  readonly members: readonly MemberState[]
  readonly outcome?: 'completed' | 'failed' | 'cancelled'
  readonly memory?: XlBuildRunCardMemory
}

function upsertMember(state: RunState, member: MemberState): RunState {
  const index = state.members.findIndex((candidate) => candidate.nodeId === member.nodeId)
  if (index < 0) return { ...state, members: [...state.members, member] }
  const members = state.members.slice()
  members[index] = member
  return { ...state, members }
}

function withMemberStatus(state: RunState, nodeId: string, status: MemberState['status']): RunState {
  const index = state.members.findIndex((member) => member.nodeId === nodeId)
  if (index < 0) return state
  const member = state.members[index] as MemberState
  if (member.status === status) return state
  const members = state.members.slice()
  members[index] = { ...member, status }
  return { ...state, members }
}

/**
 * A run that produced no run-end may still have stopped: only a Turn closed
 * after a crash or at a fork boundary proves that, mirroring the
 * dsh-client-ui-workflow-run rule.
 */
function turnAbandoned(location: ConversationLocation): boolean {
  if (location.kind !== 'step' && location.kind !== 'turn') return false
  const reason = location.turn.end?.data.reason.kind
  return reason === 'interrupted' || reason === 'forked'
}

function projectRun(
  state: RunState,
  location: ConversationLocation,
): XlBuildRunCardData {
  const interrupted = state.outcome === undefined && turnAbandoned(location)
  const status: XlBuildRunCardStatus = state.outcome ?? (interrupted ? 'interrupted' : 'running')
  const members = state.members.map((member): XlBuildRunCardMember => ({
    seq: member.seq,
    label: member.nodeId,
    kind: member.kind,
    attempt: member.attempt,
    status: member.status === 'running' && interrupted ? 'interrupted' : member.status,
  }))
  return { name: state.workflowId, status, members, ...state.memory !== undefined ? { memory: state.memory } : {} }
}

/** Durable xl-build run family folded into one keyed Chat node. */
export const xlBuildRunDefinition: ConversationNodeDefinition<RunState> = {
  kind: 'xl-build-run',
  target: 'chat',
  match: (event) => {
    const type: string = event.type
    if (type !== RUN_START && !UPDATE_TYPES.has(type)) return null
    const runId = stringField(event.data, 'runId')
    if (runId === undefined) return null
    return { id: runId, role: type === RUN_START ? 'start' : 'update' }
  },
  start: (_context, match) => {
    const event = match.event
    const type: string = event.type
    if (type !== RUN_START) {
      throw new Error('xl-build-run start requires plugin:xl-build/run-start')
    }
    const injectedBytes = numberField(event.data, 'memoryBytes')
    return {
      workflowId: stringField(event.data, 'workflowId') ?? '',
      members: [],
      ...(injectedBytes !== undefined ? { memory: { injectedBytes } satisfies XlBuildRunCardMemory } : {}),
    }
  },
  update: (context, match) => {
    const state = context.state
    const type: string = match.event.type
    const data = match.event.data
    if (type === NODE_START) {
      const nodeId = stringField(data, 'nodeId')
      if (nodeId === undefined) return state
      return upsertMember(state, {
        seq: match.event.seq,
        nodeId,
        kind: stringField(data, 'kind') ?? 'agent',
        attempt: numberField(data, 'attempt') ?? 0,
        status: 'running',
      })
    }
    if (type === NODE_END) {
      const nodeId = stringField(data, 'nodeId')
      const status = stringField(data, 'status')
      if (nodeId === undefined || status === undefined || !NODE_STATUS.has(status)) return state
      return withMemberStatus(state, nodeId, status as MemberState['status'])
    }
    if (type === NODE_ERROR) {
      const nodeId = stringField(data, 'nodeId')
      if (nodeId === undefined) return state
      return withMemberStatus(state, nodeId, 'failed')
    }
    if (type === RUN_END) {
      const outcome = stringField(data, 'outcome')
      if (outcome === undefined || !RUN_OUTCOMES.has(outcome)) return state
      return { ...state, outcome: outcome as 'completed' | 'failed' | 'cancelled' }
    }
    if (type === MEMORY_UPDATED) {
      const outcome = stringField(data, 'outcome')
      if (outcome !== 'updated' && outcome !== 'kept') return state
      const updatedBytes = numberField(data, 'bytes')
      const reason = stringField(data, 'reason')
      const memory: XlBuildRunCardMemory = {
        ...state.memory,
        outcome,
        ...(updatedBytes !== undefined ? { updatedBytes } : {}),
        ...(reason !== undefined ? { reason } : {}),
      }
      return { ...state, memory }
    }
    return state
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    const data = projectRun(context.state, context.start.location)
    return {
      key: context.key,
      kind: 'xl-build-run',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data,
    }
  },
}
