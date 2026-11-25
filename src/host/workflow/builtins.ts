/**
 * The shipped built-in workflow catalog: the package's own `workflow/` dir,
 * resolved like the built-in agents dir and merged under the user's
 * `workflowsDir`. A valid user document with the same id shadows the shipped
 * one; shipped documents fill every id the user directory does not define.
 *
 * The shipped directory is a packaging surface, not user data: a file that
 * fails to parse or validate fails the plugin load (readBuiltInWorkflowCatalog),
 * and shipped files with a duplicate id are an allowed redundancy resolved by
 * file-name order — first valid document per id wins.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkflowDirectory } from './loaders.ts'
import type { WorkflowLoadResult } from './loaders.ts'

/** File whose presence marks a directory as the shipped built-in workflow directory. */
export const BUILT_IN_WORKFLOW_MARKER = 'xl-build-pipeline.yml'

/** Upward search depth for the shipped workflow directory, relative to this module. */
const MAX_BUILT_IN_WALK_LEVELS = 5

/**
 * Locate the shipped built-in workflows directory by walking up from this
 * module (works from the source tree and from the bundled `lib/index.js`).
 * @returns the directory holding `workflow/` with the shipped example, or
 *   undefined when the marker is missing (package unpacked without `workflow/`).
 */
export function resolveBuiltInWorkflowsDir(): string | undefined {
  let current = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < MAX_BUILT_IN_WALK_LEVELS; depth += 1) {
    const candidate = join(current, 'workflow', BUILT_IN_WORKFLOW_MARKER)
    if (existsSync(candidate)) return join(current, 'workflow')
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * Scan the shipped workflow directory and refuse a broken package: an invalid
 * file there is a packaging error, not user data, so it must fail the plugin
 * load instead of silently vanishing from the catalog.
 * @param dir - the shipped workflow directory.
 * @returns every shipped entry; all valid when the call returns.
 * @throws {Error} when any shipped file fails to parse or validate.
 */
export function readBuiltInWorkflowCatalog(dir: string): WorkflowLoadResult[] {
  const entries = loadWorkflowDirectory(dir)
  const broken = entries.filter((entry) => entry.status === 'invalid')
  if (broken.length > 0) {
    throw new Error(`broken built-in workflow definitions in ${dir}: ${broken.map((entry) => entry.error).join('; ')}`)
  }
  return entries
}

/** The user directory and the shipped directory merged, with shipped provenance. */
export interface MergedWorkflowCatalog {
  /** User entries first, then shipped entries the user catalog does not own. */
  readonly entries: WorkflowLoadResult[]
  /** Ids served from the shipped directory in this snapshot. */
  readonly builtInIds: ReadonlySet<string>
}

/**
 * Scan both workflow directories and merge them: a valid user document with
 * the same id shadows the shipped one, and shipped files with duplicate ids
 * collapse to the first valid document in file-name order.
 * @param userDir - the user `workflowsDir`.
 * @param builtInDir - the shipped workflow directory, when the package ships one.
 * @returns the merged snapshot with shipped id provenance.
 */
export function loadMergedWorkflowCatalog(userDir: string, builtInDir?: string): MergedWorkflowCatalog {
  const user = loadWorkflowDirectory(userDir)
  const builtIn = builtInDir !== undefined ? loadWorkflowDirectory(builtInDir) : []
  const userIds = new Set(user.flatMap((entry) => entry.status === 'valid' ? [entry.document.id] : []))
  const builtInIds = new Set<string>()
  const shipped: WorkflowLoadResult[] = []
  for (const entry of builtIn) {
    if (entry.status !== 'valid') continue
    if (userIds.has(entry.document.id) || builtInIds.has(entry.document.id)) continue
    builtInIds.add(entry.document.id)
    shipped.push(entry)
  }
  return { entries: [...user, ...shipped], builtInIds }
}
