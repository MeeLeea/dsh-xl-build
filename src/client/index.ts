/**
 * Web client entry of the xl-build plugin: the run board panel and the
 * workflow topology surfaces.
 */
import type { Context } from '@deepseek-ai/cordis'
import { apply as mountClient } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Mount the xl-build client UI.
 * @param ctx - browser services.
 * @returns disposer withdrawing every registered surface.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountClient(ctx)
}
