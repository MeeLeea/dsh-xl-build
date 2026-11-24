/**
 * M1 acceptance (doc/impl-plan.md §3.2 M1-6): one real model turn resolves a
 * `@subagent` mention, calls `xl_agent_run`, and the child's completion is
 * delivered back into the parent session; `/workflow list` runs the real
 * command path. Self-skips without DEEPSEEK_API_KEY.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/host/index.ts'
import type { Config } from '../../src/host/config.ts'
import { XL_EVENTS } from '../../src/host/events.ts'

const PROBE = 'PAPAYA-271828'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Mount the real loop, model adapter, subagent port, and command runtime. */
async function mount(workdir: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek, { models: [{ id: 'deepseek-v4-flash' }] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  return ctx
}

/** The plugin configuration over the temporary deployment directories. */
function configFor(workdir: string): Config {
  return {
    agentsDir: join(workdir, 'agents'),
    workflowsDir: join(workdir, 'workflows'),
    runsDir: join(workdir, 'runs'),
    maxConcurrentNodes: 2,
    maxConcurrentAgentTools: 4,
    runTimeoutMs: 600_000,
    maxSteps: 50,
    scriptTimeoutMs: 120_000,
    allowedScriptRuntimes: ['shell', 'ptc'],
    retryableToolErrors: [],
    wirePreviewBytes: 2_048,
    recentRuns: 5,
    persistRuns: false,
    memoryEnabled: false,
    memoryDir: join(workdir, 'memory'),
    memoryMaxBytes: 16_000,
    memoryCurator: 'memory-curator',
    runRootProvider: 'spawn',
  }
}

/** Write one agent definition and one saved workflow for the real command path. */
function writeFixtures(workdir: string): void {
  mkdirSync(join(workdir, 'agents'), { recursive: true })
  mkdirSync(join(workdir, 'workflows'), { recursive: true })
  writeFileSync(join(workdir, 'agents', 'researcher.yml'), [
    'id: researcher',
    'name: Researcher',
    'description: Executes one self-contained instruction and answers with text only.',
    'prompt: 收到任务后，严格按任务文本执行；如果任务要求只输出一段文本，就只输出它，不要提问，不要添加说明。',
    '',
  ].join(NL))
  writeFileSync(join(workdir, 'workflows', 'chain-e2e.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'chain-e2e',
    name: 'Chain e2e',
    entry: 'start',
    nodes: [
      { kind: 'input', id: 'start', params: [{ name: 'topic', required: true }] },
      { kind: 'agent', id: 'research', agent: 'researcher', task: 'Summarize {{input.topic}} in one sentence.' },
      { kind: 'output', id: 'done', value: '{{nodes.research}}' },
    ],
    edges: [
      { id: 'start-to-research', from: 'start', to: 'research', kind: 'flow' },
      { id: 'research-to-done', from: 'research', to: 'done', kind: 'flow' },
    ],
    outputs: { report: '{{nodes.done}}' },
  }, null, 2))
}

/** Resolve on the agent's first idle status. */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** All text of one session event, for presence assertions. */
function eventText(event: SessionEvent): string {
  return JSON.stringify(event)
}

/** Every user-message text block in the session, in order. */
function userTexts(events: readonly SessionEvent[]): string[] {
  return events
    .filter((event) => event.type === 'user/message')
    .map((event) => {
      const data = event.data as { content: { type: string, text?: string }[] }
      return data.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
    })
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('m1 e2e: real model delegates through xl_agent_run', () => {
  it('resolves a mention, delivers the child completion, and lists workflows', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'dsh-xl-build-m1-e2e-'))
    roots.push(workdir)
    writeFixtures(workdir)
    const ctx = await mount(workdir)
    apply(ctx, configFor(workdir))
    const agent = await ctx.agentLoop.create(
      SessionId(randomUUID()),
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      { cwd: workdir },
    )

    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '@researcher 请只输出字符串 ' + PROBE + '，不要输出任何其他内容。' }],
      source: { kind: 'user' },
    }))
    await idle

    // The parent's journal carries the mention resolution and the directive.
    const events = agent.session.snapshotEvents()
    const resolved = events.find((event) => event.type === XL_EVENTS.mentionResolved)
    expect(resolved?.data).toMatchObject({ agentIds: ['researcher'] })
    expect(events.some((event) => eventText(event).includes('xl_agent_run'))).toBe(true)

    // The child completion reaches this session through the parent notification.
    await vi.waitFor(() => {
      expect(userTexts(agent.session.snapshotEvents()).some((text) => text.includes(PROBE))).toBe(true)
    }, { timeout: 180_000, interval: 2_000 })
    const notice = userTexts(agent.session.snapshotEvents()).find((text) => text.includes(PROBE))
    expect(notice).toBeDefined()

    // /workflow list walks the real command path over the saved directory.
    const execution = await ctx.commands.execute(agent, '/workflow list', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect(execution?.result.kind === 'success' && execution.result.text.includes('chain-e2e')).toBe(true)
  }, 600_000)
})

