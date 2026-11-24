import { IconPlanOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Sidebar glyph for the xl-build run board. */
export function XlBuildIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconPlanOutlineRegular size={size} />
}
