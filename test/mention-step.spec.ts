import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import type { MentionResolvedPayload, MentionUnresolvedPayload } from '../src/host/events.ts'
import { createMentionStepHandler, mentionDirective } from '../src/host/agents/mention-step.ts'
import type { MentionStepPayload } from '../src/host/agents/mention-step.ts'

const AGENTS = [
  { id: 'reviewer', name: 'Reviewer' },
  { id: 'writer', name: 'Writer' },
]

/** One user message carrying text. */
function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** The step payload with a string stand-in for the live Agent. */
function payload(messages: readonly UserMessage[], step = 1): MentionStepPayload<string> {
  return { agent: 'session-1', messages, turn: 1, step, signal: new AbortController().signal }
}

/** Enter decision carrying exactly the supplied messages. */
function enterOf(messages: readonly UserMessage[]): PreStepDecision {
  return { kind: 'enter', messages: [...messages] }
}

/** Join the appended message's text blocks. */
function textsOf(messages: readonly UserMessage[]): string[] {
  return messages.flatMap((message) => message.content.map((block) => (block.type === 'text' ? block.text : '')))
}

/** Recording stub for the session-bound writes. */
function recorderStub() {
  const resolved: MentionResolvedPayload[] = []
  const unresolved: MentionUnresolvedPayload[] = []
  const sessionKey = {}
  return {
    resolved,
    unresolved,
    make: () => ({
      sessionKey,
      resolved: (value: MentionResolvedPayload) => resolved.push(value),
      unresolved: (value: MentionUnresolvedPayload) => unresolved.push(value),
    }),
  }
}

function handler(stub: ReturnType<typeof recorderStub>) {
  return createMentionStepHandler<string>({ mentionAgents: () => AGENTS, recorder: stub.make })
}

describe('mention injection', () => {
  it('records a resolved mention and appends the directed block', async () => {
    const stub = recorderStub()
    const messages = [userMessage('please <xl-agent id="reviewer" /> check the diff')]
    const decision = await handler(stub)(payload(messages), async () => enterOf(messages))

    expect(stub.resolved).toEqual([{
      version: 1,
      agentIds: ['reviewer'],
      resolvedNames: ['Reviewer'],
      messageId: messages[0]?.id,
      stepIndex: 1,
      segments: [{ segmentIndex: 0, start: 7, end: 33, task: 'check the diff' }],
    }])
    expect(stub.unresolved).toEqual([])
    expect(decision.kind).toBe('enter')
    const appended = decision.kind === 'enter' ? decision.messages.slice(messages.length) : []
    expect(appended).toHaveLength(1)
    expect(textsOf(appended)).toEqual([mentionDirective(1, 'reviewer', 'check the diff')])
  })

  it('injects once when the same message is presented to a later step', async () => {
    const stub = recorderStub()
    const messages = [userMessage('@reviewer check it')]
    const run = handler(stub)

    const first = await run(payload(messages, 1), async () => enterOf(messages))
    const second = await run(payload(messages, 2), async () => enterOf(messages))

    expect(stub.resolved).toHaveLength(1)
    expect(first.kind === 'enter' && first.messages.length).toBe(2)
    expect(second.kind === 'enter' && second.messages.length).toBe(1)
  })

  it('numbers two mentions of the same agent in one step separately', async () => {
    const stub = recorderStub()
    const messages = [userMessage('@reviewer first @reviewer second')]
    const decision = await handler(stub)(payload(messages), async () => enterOf(messages))

    expect(stub.resolved[0]?.segments.map((segment) => segment.task)).toEqual(['first', 'second'])
    const appended = decision.kind === 'enter' ? decision.messages.slice(1) : []
    expect(appended).toHaveLength(1)
    expect(textsOf(appended)).toEqual([mentionDirective(1, 'reviewer', 'first'), mentionDirective(2, 'reviewer', 'second')])
  })

  it('records an unresolved mention without injecting anything', async () => {
    const stub = recorderStub()
    const messages = [userMessage('<xl-agent id="missing" /> do it')]
    const decision = await handler(stub)(payload(messages), async () => enterOf(messages))

    expect(stub.resolved).toEqual([])
    expect(stub.unresolved).toEqual([{
      version: 1,
      token: '<xl-agent id="missing" />',
      messageId: messages[0]?.id,
      stepIndex: 1,
      segmentIndex: 0,
      reason: 'unknown-agent',
    }])
    expect(decision.kind === 'enter' && decision.messages).toHaveLength(1)
  })

  it('leaves a rejected step and a cancelled step untouched', async () => {
    const stub = recorderStub()
    const messages = [userMessage('@reviewer check it')]
    const rejected = await handler(stub)(payload(messages), async () => ({ kind: 'reject' }))
    expect(rejected).toEqual({ kind: 'reject' })

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const cancelledPayload: MentionStepPayload<string> = { ...payload(messages), signal: controller.signal }
    const cancelled = await handler(stub)(cancelledPayload, async () => enterOf(messages))
    expect(cancelled.kind === 'enter' && cancelled.messages).toHaveLength(1)
    expect(stub.resolved).toEqual([])
  })

  it('keeps the injected messages immutable', async () => {
    const stub = recorderStub()
    const messages = [userMessage('@reviewer check it')]
    const snapshot = [...messages].length
    await handler(stub)(payload(messages), async () => enterOf(messages))
    expect(messages).toHaveLength(snapshot)
  })
})
