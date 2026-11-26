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

/** List re-pull cadence: run records checkpoint on a write-behind, so a
 * session the client never opened needs a fresh list to surface its values. */
const LIST_REFRESH_INTERVAL_MS = 5000

/**
 * The panel's data source: the merged \`xlBuild\` views of every listed
 * session (a run's records live in that run's own session, which the
 * client usually has not opened): the newest catalog plus every run
 * keyed by runId, refreshed when the session list changes, a
 * contributing session's projection re-emits, or the list poll lands.
 * Unparsable or absent values degrade to no view.
 * @param ctx - browser services.
 * @returns an observable wire for the panel's useSyncExternalStore.
 */
function createWireSource(ctx: ClientContext): WireSource {
  const listeners = new Set<() => void>()
  let stopList: (() => void) | undefined
  let stopFaces: (() => void)[] = []
  let boundIds: readonly SessionId[] = []
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let cached: XlBuildWire = { view: undefined }
  // Per-session parse caches keep each contributing view ref-stable, which
  // the merged view's ref stability, and useSyncExternalStore, depend on.
  const viewCache = new Map<SessionId, { rawRef: unknown, view: XlBuildView | undefined }>()
  let mergeInputs: readonly XlBuildView[] | undefined
  let mergeWire: XlBuildWire | undefined

  const viewFor = (id: SessionId, raw: unknown): XlBuildView | undefined => {
    const entry = viewCache.get(id)
    if (entry !== undefined && entry.rawRef === raw) return entry.view
    const view = parseXlBuildView(raw)
    viewCache.set(id, { rawRef: raw, view })
    return view
  }

  /** Merge the contributing views: the newest catalog plus every run keyed by runId. */
  const wireFor = (views: readonly XlBuildView[]): XlBuildWire => {
    if (views.length === 0) return { view: undefined }
    if (mergeWire !== undefined && mergeInputs !== undefined
      && mergeInputs.length === views.length
      && mergeInputs.every((view, index) => view === views[index])) {
      return mergeWire
    }
    const seen = new Set<string>()
    const runs: XlBuildView['runs'] = []
    for (const view of views) {
      for (const run of view.runs) {
        if (seen.has(run.runId)) continue
        seen.add(run.runId)
        runs.push(run)
      }
    }
    const newest = views[0]
    if (newest === undefined) return { view: undefined }
    mergeInputs = views
    mergeWire = { view: { catalog: newest.catalog, runs } }
    return mergeWire
  }

  /** Latest session first; a retained binding's live face wins over the list baseline. */
  const read = (): { readonly wire: XlBuildWire, readonly sourceIds: readonly SessionId[] } => {
    const list = ctx.sessions.list.getSnapshot()
    const candidates = [...list.ids].sort((left, right) =>
      (list.byId[right]?.updatedAt ?? 0) - (list.byId[left]?.updatedAt ?? 0))
    const views: XlBuildView[] = []
    const sourceIds: SessionId[] = []
    for (const id of candidates) {
      const face = ctx.sessions.binding(id)?.session.projections.faceOf(CATALOG_PROJECTION_KEY)
      let view = face !== undefined ? viewFor(id, face.getSnapshot()) : undefined
      if (view === undefined) {
        const cell = list.projectionsBySession[id]
        // A list-carried projection block is legitimate final-state data:
        // the host writes a durable cache checkpoint when a run session
        // detaches, and the client lands it without ever flipping the
        // per-session load state away from idle. Accept any cell whose
        // values actually carry the key; absent values degrade as before.
        if (cell !== undefined
          && (cell.state === 'ready' || cell.values[CATALOG_PROJECTION_KEY] !== undefined)) {
          view = viewFor(id, cell.values[CATALOG_PROJECTION_KEY])
        }
      }
      if (view === undefined) continue
      views.push(view)
      sourceIds.push(id)
    }
    if (viewCache.size > candidates.length) {
      const listed = new Set<SessionId>(candidates)
      for (const id of viewCache.keys()) {
        if (!listed.has(id)) viewCache.delete(id)
      }
    }
    return { wire: wireFor(views), sourceIds }
  }

  /** Point live projection faces at every session the wire now reads. */
  const bindFaces = (sourceIds: readonly SessionId[]): void => {
    if (sourceIds.length === boundIds.length && sourceIds.every((id, index) => id === boundIds[index])) return
    for (const stop of stopFaces) stop()
    stopFaces = []
    boundIds = sourceIds
    for (const id of sourceIds) {
      const face = ctx.sessions.binding(id)?.session.projections.faceOf(CATALOG_PROJECTION_KEY)
      const stop = face?.subscribe(() => applyNext(read(), true))
      if (stop !== undefined) stopFaces.push(stop)
    }
  }

  const applyNext = (next: { readonly wire: XlBuildWire, readonly sourceIds: readonly SessionId[] }, notify: boolean): void => {
    bindFaces(next.sourceIds)
    if (next.wire.view !== cached.view) {
      cached = next.wire
      if (notify) for (const listener of [...listeners]) listener()
    }
  }

  // Runs record into sessions the client never opens; their projection
  // rows surface only through a fresh list. The poll is advisory and
  // fire-and-catch: an offline or transient failure just waits one cycle.
  const refreshSessions = typeof ctx.sessions.refresh === 'function'
    ? async (): Promise<void> => {
        try {
          await ctx.sessions.refresh()
          applyNext(read(), true)
        } catch {
          // offline or transient: the next poll retries
        }
      }
    : undefined

  return {
    getSnapshot: () => {
      // Pure read for useSyncExternalStore: no binding, subscription, or
      // notification; the cached object stays ref-stable while the view is.
      const next = read()
      if (next.wire.view !== cached.view) cached = next.wire
      return cached
    },
    subscribe: (listener) => {
      listeners.add(listener)
      if (listeners.size === 1) {
        stopList = ctx.sessions.list.subscribe(() => applyNext(read(), true))
        if (refreshSessions !== undefined) {
          pollTimer = setInterval(() => { void refreshSessions() }, LIST_REFRESH_INTERVAL_MS)
        }
        applyNext(read(), false)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stopList?.()
          stopList = undefined
          if (pollTimer !== undefined) {
            clearInterval(pollTimer)
            pollTimer = undefined
          }
          for (const stop of stopFaces) stop()
          stopFaces = []
          boundIds = []
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
