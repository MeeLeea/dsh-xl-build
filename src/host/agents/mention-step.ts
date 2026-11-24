/**
 * `@subagent` mention injection on `agent/pre-step`.
 *
 * Only this step's draft batch is scanned, so a mention is never re-matched
 * from accumulated history. Duplicates are keyed `(messageId, segmentIndex)`,
 * because the same message is re-presented to later steps while one step can
 * contain two mentions of the same agent with different tasks.
 *
 * The step's own resolution is durable: resolved and unresolved mentions are
 * recorded before the model request is assembled, and the directed block that
 * orders `xl_agent_run` is appended as a user message, which the loop logs.
 */
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { MentionResolvedPayload, MentionSegment, MentionUnresolvedPayload } from '../events.ts'
import { parseMentions } from './mention.ts'
import type { MentionAgent } from './mention.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The mention directive this plugin assembles at step start. */
    'xl-build': { kind: 'xl-build' } & ContextFormed
  }
}

/** The `agent/pre-step` payload fields this handler consumes. */
export interface MentionStepPayload<A> {
  readonly agent: A
  readonly messages: readonly UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** Waterfall handler for `agent/pre-step`. */
export type MentionStepHandler<A> = (
  payload: MentionStepPayload<A>,
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>

/** The durable writes one step needs, bound to the session by the composition root. */
export interface MentionStepRecorder {
  /** Stable identity of the session this step belongs to. */
  readonly sessionKey: object
  /** Record the mentions this step resolved. */
  resolved(payload: MentionResolvedPayload): void
  /** Record one mention this step could not resolve. */
  unresolved(payload: MentionUnresolvedPayload): void
}

/**
 * Build the directed block one resolved mention contributes.
 * @param order - one-based position among this step's resolved mentions.
 * @param agentId - the resolved agent id.
 * @param task - the task literal the mention consumes.
 * @returns the instruction text appended as a user message.
 */
export function mentionDirective(order: number, agentId: string, task: string): string {
  return `Mention ${order}: agent="${agentId}" task="${task}". `
    + `Your first action in this step must be to call xl_agent_run with agent="${agentId}" and task="${task}". `
    + 'Do this work through that subagent instead of answering the mention yourself.'
}

/** Concatenate one message's text blocks. */
function textOf(message: UserMessage): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Create the mention injector for `agent/pre-step`.
 * @param options - the live agent catalog and the session-bound recorder.
 * @returns the waterfall handler to register on `agent/pre-step`.
 */
export function createMentionStepHandler<A>(options: {
  mentionAgents: () => readonly MentionAgent[]
  recorder: (payload: MentionStepPayload<A>) => MentionStepRecorder
  /** Called once per accepted step, before scanning; the catalog publisher uses it. */
  onStep?: (payload: MentionStepPayload<A>) => void
}): MentionStepHandler<A> {
  const seen = new WeakMap<object, Set<string>>()

  return async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || payload.signal.aborted) return decision
    options.onStep?.(payload)

    const catalog = options.mentionAgents()
    const names = new Map(catalog.map((agent) => [agent.id, agent.name]))
    const directives: string[] = []

    for (const message of payload.messages) {
      const mentions = parseMentions(textOf(message), catalog)
      const pending = mentions.filter((mention) => {
        const recorder = options.recorder(payload)
        let keys = seen.get(recorder.sessionKey)
        if (keys === undefined) {
          keys = new Set<string>()
          seen.set(recorder.sessionKey, keys)
        }
        const key = `${message.id}:${mention.segmentIndex}`
        if (keys.has(key)) return false
        keys.add(key)
        return true
      })
      if (pending.length === 0) continue

      const segments: MentionSegment[] = []
      const agentIds: string[] = []
      const resolvedNames: string[] = []
      for (const mention of pending) {
        if (mention.resolution.kind === 'resolved') {
          const agentId = mention.resolution.agentId
          segments.push({
            segmentIndex: mention.segmentIndex,
            start: mention.start,
            end: mention.end,
            task: mention.task,
          })
          agentIds.push(agentId)
          resolvedNames.push(names.get(agentId) ?? agentId)
          directives.push(mentionDirective(directives.length + 1, agentId, mention.task))
          continue
        }
        options.recorder(payload).unresolved({
          version: 1,
          token: mention.raw,
          messageId: message.id,
          stepIndex: payload.step,
          segmentIndex: mention.segmentIndex,
          reason: mention.resolution.reason,
        })
      }

      if (segments.length > 0) {
        options.recorder(payload).resolved({
          version: 1,
          agentIds,
          resolvedNames,
          messageId: message.id,
          stepIndex: payload.step,
          segments,
        })
      }
    }

    if (directives.length === 0) return decision
    const injected = createUserMessage({
      content: directives.map((text) => ({ type: 'text' as const, text })),
      source: { kind: 'xl-build' },
    })
    return { ...decision, messages: [...decision.messages, injected] }
  }
}
