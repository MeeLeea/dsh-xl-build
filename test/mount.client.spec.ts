/** The xl-build client surfaces — dictionaries, the `@` source, panel slots — follow plugin disposal. */
import { Context, Service } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { apply as mountClient, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { XlBuildIcon } from '../src/client/XlBuildIcon.tsx'
import { WorkflowPanel, type XlBuildInjected } from '../src/client/panel/WorkflowPanel.tsx'
import { XlBuildRunCard } from '../src/client/run-card/XlBuildRunCard.tsx'
import { xlBuildRunDefinition } from '../src/client/run-card/definition.ts'

// The npm primitives bundle pulls undeclared third-party deps that fail in
// node; the icon never renders here, so a stub suffices.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconPlanOutlineRegular: () => null,
  DisclosureRow: (props: Record<string, unknown>) => null,
  StateDot: (props: Record<string, unknown>) => null,
}))

type Dict = Record<string, string>

/** The projection value the fixture session publishes under `xlBuild`. */
const CATALOG = {
  catalog: {
    agents: [{ id: 'reviewer', name: 'Reviewer', description: 'Reviews a diff.' }],
    workflows: [],
  },
  runs: [],
}

/** Minimal locale service: stores dictionaries, resolves keys from zh, reports presence. */
class FakeLocale extends Service {
  private readonly dicts = new Map<string, { zh: Dict, en: Dict }>()

  constructor(ctx: Context) {
    super(ctx, 'locale')
  }

  register(ns: string, dict: { zh: Dict, en: Dict }): () => void {
    this.dicts.set(ns, dict)
    return () => { this.dicts.delete(ns) }
  }

  bind(ns: string): (key: string) => string {
    return (key) => this.dicts.get(ns)?.zh[key] ?? key
  }

  has(ns: string): boolean {
    return this.dicts.has(ns)
  }
}

/** Baseline session-list snapshot the wire source reads. */
const LIST_STATE = {
  ids: ['session-1'],
  byId: { 'session-1': { updatedAt: 1 } },
  phase: 'ready',
  projectionsBySession: {},
}

/** Minimal session wire face: one retained session whose `xlBuild` projection is published. */
class FakeSessions extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  binding(sessionId: string): {
    session: { projections: { faceOf: (key: string) => { getSnapshot: () => unknown, subscribe: () => () => void } } }
  } | undefined {
    if (sessionId !== 'session-1') return undefined
    return {
      session: {
        projections: {
          faceOf: (key: string) => ({
            getSnapshot: () => (key === 'xlBuild' ? CATALOG : undefined),
            subscribe: () => () => {},
          }),
        },
      },
    }
  }

  get list(): {
    getSnapshot(): typeof LIST_STATE
    subscribe(listener: () => void): () => void
  } {
    return {
      getSnapshot: () => LIST_STATE,
      subscribe: () => () => {},
    }
  }
}

interface SlotEntry {
  readonly options: Record<string, unknown>
  readonly component: unknown
  readonly locale: string | undefined
  readonly inject: (() => unknown) | undefined
}

/** Minimal slot registry: records inject callbacks and registrations for assertions. */
class FakeSlots extends Service {
  private readonly slots = new Map<string, SlotEntry[]>()

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  inject(_name: string, callback: () => (() => void) | void): (() => void) | void {
    return this.ctx.effect(callback, 'fake slots.inject')
  }

  register(options: Record<string, unknown>, component: unknown): () => void {
    const name = String(options.name)
    const list = this.slots.get(name) ?? []
    list.push({
      options,
      component,
      locale: options.locale as string | undefined,
      inject: options.inject as (() => unknown) | undefined,
    })
    this.slots.set(name, list)
    return () => {
      const current = this.slots.get(name) ?? []
      const index = current.findIndex((entry) => entry.options === options)
      if (index >= 0) current.splice(index, 1)
    }
  }

  entries(name: string): readonly SlotEntry[] {
    return this.slots.get(name) ?? []
  }
}

/** The subset of a trigger source this spec asserts on. */
interface RegisteredSource {
  readonly trigger: string
  readonly name: string
  readonly order?: number
  candidates(
    session: { sessionId: string },
    req: { query: string, position: string, drilled: boolean, signal: AbortSignal },
  ): Promise<readonly { name: string, label?: string, description?: string, section?: string }[]>
}

/** Minimal trigger registry: stores sources by trigger+name and returns their remover. */
class FakeInputTriggers extends Service {
  private readonly sources = new Map<string, RegisteredSource>()

  constructor(ctx: Context) {
    super(ctx, 'inputTriggers')
  }

  registerSource(source: RegisteredSource): () => void {
    const key = source.trigger + source.name
    this.sources.set(key, source)
    return () => { this.sources.delete(key) }
  }

  find(key: string): RegisteredSource | undefined {
    return this.sources.get(key)
  }
}

/** Minimal right-Sidebar face: records resource addresses the panel asks to open. */
class FakeSidebarRight extends Service {
  readonly openResource = vi.fn<(address: string) => void>()

  constructor(ctx: Context) {
    super(ctx, 'sidebarRight')
  }
}

/** Minimal conversation registry: records registered event definitions. */
class FakeUiConversation extends Service {
  readonly registered: unknown[] = []

  constructor(ctx: Context) {
    super(ctx, 'uiConversation')
  }

  get events(): { register(definition: unknown): () => void } {
    const that = this
    return {
      register(definition: unknown): () => void {
        that.registered.push(definition)
        return () => {
          const index = that.registered.indexOf(definition)
          if (index >= 0) that.registered.splice(index, 1)
        }
      },
    }
  }
}

it('registers the dictionaries and the @ source, and withdraws both on disposal', async () => {
  const ctx = new Context()
  const locale = new FakeLocale(ctx)
  new FakeSessions(ctx)
  new FakeSlots(ctx)
  const triggers = new FakeInputTriggers(ctx)
  new FakeUiConversation(ctx)
  new FakeSidebarRight(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply: (pluginCtx) => mountClient(pluginCtx) })
  await fiber
  try {
    expect(locale.bind('xl-build')('panel')).toBe(zh.panel)
    expect(locale.bind('xl-build')('mentionSection')).toBe(zh.mentionSection)

    const source = triggers.find('@xl-agent')
    expect(source).toBeDefined()
    expect(source?.order).toBe(20)
    const candidates = await source?.candidates(
      { sessionId: 'session-1' },
      { query: '', position: 'inline', drilled: false, signal: new AbortController().signal },
    )
    expect(candidates).toEqual([{
      name: 'reviewer',
      label: 'Reviewer',
      description: 'Reviews a diff.',
      section: zh.mentionSection,
    }])
  } finally {
    await fiber.dispose()
  }

  expect(locale.has('xl-build')).toBe(false)
  expect(triggers.find('@xl-agent')).toBeUndefined()
  await ctx.fiber.dispose()
})

it('registers the main panel and the sidebar row, and withdraws both on disposal', async () => {
  const ctx = new Context()
  new FakeLocale(ctx)
  new FakeSessions(ctx)
  const slots = new FakeSlots(ctx)
  new FakeInputTriggers(ctx)
  const conversation = new FakeUiConversation(ctx)
  const sidebar = new FakeSidebarRight(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply: (pluginCtx) => mountClient(pluginCtx) })
  await fiber
  try {
    const panel = slots.entries('main').find((entry) => entry.component === WorkflowPanel)
    expect(panel?.options).toMatchObject({ key: 'xl-build' })
    expect(panel?.locale).toBe('xl-build')
    const face = panel?.inject?.() as XlBuildInjected
    const wire = face.wire.getSnapshot()
    expect(wire.view).toEqual(CATALOG)
    const address = 'dsh-resource://file/session/session-1/artifacts/done/output.md'
    face.openArtifact(address)
    expect(sidebar.openResource).toHaveBeenCalledWith(address)

    const row = slots.entries('sidebar.panellist').find((entry) => entry.component === XlBuildIcon)
    expect(row?.options).toMatchObject({ id: 'xl-build', order: 40 })
    expect(resolveSlotLabel(row?.options.label as () => string)).toBe(zh.panel)

    const card = slots.entries('conversation.chat.node').find((entry) => entry.component === XlBuildRunCard)
    expect(card?.options).toMatchObject({ key: 'xl-build-run' })
    expect(card?.locale).toBe('xl-build')
    expect(conversation.registered).toContain(xlBuildRunDefinition)
  } finally {
    await fiber.dispose()
  }

  expect(slots.entries('main')).toEqual([])
  expect(slots.entries('sidebar.panellist')).toEqual([])
  expect(slots.entries('conversation.chat.node')).toEqual([])
  expect(conversation.registered).toEqual([])
  await ctx.fiber.dispose()
});
