/**
 * Mount the xl-build panel surfaces on the Web client: the \`xl-build\` locale
 * namespace, the \`@\` trigger source that offers the agents the host published
 * into this session's \`xlBuild\` projection, the main run-board panel, and the
 * sidebar navigation row.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { XlBuildIcon } from './XlBuildIcon.tsx'
import { NS, en, zh, type XlBuildKey } from './locales.ts'
import { CATALOG_PROJECTION_KEY, catalogAgentsFromProjection, createMentionSource } from './mention.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { xlBuildRunDefinition } from './run-card/definition.ts'
import { XlBuildRunCard } from './run-card/XlBuildRunCard.tsx'
import { WorkflowPanel, type XlBuildInjected } from './panel/WorkflowPanel.tsx'
import { parseXlBuildView, type WireSource, type XlBuildView, type XlBuildWire } from './wire.ts'

/** The main-panel key the sidebar row navigates to. */
export const PANEL_ID = 'xl-build' as MainPanelId

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** xl-build panel copy. */
    'xl-build': XlBuildKey
  }
}

/** Client services the xl-build UI injects. */
export const inject = ['locale', 'sessions', 'slots', 'inputTriggers', 'uiConversation', 'sidebarRight']

/** Sidebar row order: agent-multi occupies 30, builtins stay clear of both. */
const PANEL_ORDER = 40

/**
 * The panel's data source: the \`xlBuild\` view of the most recently active
 * session, refreshed when the session list changes or the bound session's
 * projection re-emits. Unparsable or absent values degrade to no view.
 * @param ctx - browser services.
 * @returns an observable wire for the panel's useSyncExternalStore.
 */
function createWireSource(ctx: ClientContext): WireSource {
  const listeners = new Set<() => void>()
  let stopList: (() => void) | undefined
  let stopFace: (() => void) | undefined
  let boundSessionId: SessionId | undefined
  let rawRef: unknown
  let parsedRef: XlBuildView | undefined
  let cached: XlBuildWire = { view: undefined }

  // Single-slot parse cache: a projection value is re-parsed only when a new
  // reference arrives, which keeps getSnapshot free of repeated validation.
  const parseView = (raw: unknown): XlBuildView | undefined => {
    if (raw === undefined) return undefined
    if (raw !== rawRef) {
      rawRef = raw
      parsedRef = parseXlBuildView(raw)
    }
    return parsedRef
  }

  /** Latest session first; a retained binding's live face wins over the list baseline. */
  const read = (): { readonly wire: XlBuildWire, readonly sourceId: SessionId | undefined } => {
    const list = ctx.sessions.list.getSnapshot()
    const candidates = [...list.ids].sort((left, right) =>
      (list.byId[right]?.updatedAt ?? 0) - (list.byId[left]?.updatedAt ?? 0))
    for (const id of candidates) {
      const face = ctx.sessions.binding(id)?.session.projections.faceOf(CATALOG_PROJECTION_KEY)
      if (face !== undefined) {
        const view = parseView(face.getSnapshot())
        if (view !== undefined) return { wire: { view }, sourceId: id }
      }
      const cell = list.projectionsBySession[id]
      if (cell?.state === 'ready') {
        const view = parseView(cell.values[CATALOG_PROJECTION_KEY])
        if (view !== undefined) return { wire: { view }, sourceId: id }
      }
    }
    return { wire: { view: undefined }, sourceId: undefined }
  }

  const applyNext = (next: { readonly wire: XlBuildWire, readonly sourceId: SessionId | undefined }, notify: boolean): void => {
    if (next.sourceId !== boundSessionId) {
      stopFace?.()
      stopFace = undefined
      boundSessionId = next.sourceId
      if (next.sourceId !== undefined) {
        const face = ctx.sessions.binding(next.sourceId)?.session.projections.faceOf(CATALOG_PROJECTION_KEY)
        stopFace = face?.subscribe(() => applyNext(read(), true)) ?? undefined
      }
    }
    if (next.wire.view !== cached.view) {
      cached = next.wire
      if (notify) for (const listener of [...listeners]) listener()
    }
  }

  return {
    getSnapshot: () => {
      // Never notify here: useSyncExternalStore requires getSnapshot to be
      // observable-free and ref-stable between renders.
      applyNext(read(), false)
      return cached
    },
    subscribe: (listener) => {
      listeners.add(listener)
      if (listeners.size === 1) {
        stopList = ctx.sessions.list.subscribe(() => applyNext(read(), true))
        applyNext(read(), false)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stopList?.()
          stopList = undefined
          stopFace?.()
          stopFace = undefined
          boundSessionId = undefined
        }
      }
    },
  }
}

/**
 * Read one session's \`xlBuild\` projection value, when its scope is retained.
 * @param ctx - browser services.
 * @param sessionId - the session owning the composer.
 * @returns the raw projection value, or undefined while the scope or key is absent.
 */
function readCatalog(ctx: ClientContext, sessionId: SessionId): unknown {
  const binding = ctx.sessions.binding(sessionId)
  return binding?.session.projections.faceOf(CATALOG_PROJECTION_KEY).getSnapshot()
}

/**
 * Register the localized xl-build surfaces.
 * @param ctx - browser services.
 */
function registerUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-xl-build: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.inputTriggers.registerSource(createMentionSource({
    agentsFor: (sessionId) => catalogAgentsFromProjection(readCatalog(ctx, sessionId)),
    section: () => t('mentionSection'),
  })), 'client-ui-xl-build: @ source')
  const wire = createWireSource(ctx)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ wire, openArtifact: (address: string) => ctx.sidebarRight.openResource(address) }) satisfies XlBuildInjected,
  }, WorkflowPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    locale: NS,
    label: () => t('panel'),
  }, XlBuildIcon))
  ctx.effect(() => ctx.uiConversation.events.register(xlBuildRunDefinition), 'client-ui-xl-build: run card definition')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'xl-build-run',
    locale: NS,
  }, XlBuildRunCard))
}

/**
 * Mount the xl-build client UI.
 * @param ctx - browser services.
 * @returns disposer withdrawing every surface this mount registered.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const ui = await ctx.inject(inject, (uiCtx) => registerUi(uiCtx))
  return () => ui.dispose()
}
