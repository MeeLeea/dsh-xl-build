/**
 * Deployment-tunable settings for the xl-build plugin. Every value is
 * overridable from `cordis.yml`; the plugin keeps no `DEFAULT_*` constants of
 * its own, and the schema defaults below are the single source of truth.
 */
import Schema from '@deepseek-ai/schemastery'

/** Script runtimes an agent node may execute (see the topology `script` node). */
export type ScriptRuntime = 'shell' | 'ptc'

/** Validated plugin configuration. */
export interface Config {
  /** Directory holding agent definition files (`*.yml`, `*.yaml`, `*.json`). */
  agentsDir: string
  /** Directory holding workflow definition files. */
  workflowsDir: string
  /** Directory receiving per-run artifacts (`persistRuns` only). */
  runsDir: string
  /** Maximum number of graph nodes executing at the same time within one run. */
  maxConcurrentNodes: number
  /**
   * Maximum number of unsettled activations started through `xl_agent_run`.
   * Distinct from {@link Config.maxConcurrentNodes}: this gates the
   * conversation-level tool path, not graph execution.
   */
  maxConcurrentAgentTools: number
  /** Wall-clock budget for one run, in milliseconds. */
  runTimeoutMs: number
  /** Maximum number of engine steps one run may take. */
  maxSteps: number
  /** Wall-clock budget for one script node, in milliseconds. */
  scriptTimeoutMs: number
  /** Runtimes a script node is allowed to request. */
  allowedScriptRuntimes: ScriptRuntime[]
  /**
   * Tool error codes that may be retried. An empty array (the default) means
   * tool errors are never retried; retryable codes are opted into explicitly.
   */
  retryableToolErrors: string[]
  /** Byte budget for one node's output preview in the client projection. */
  wirePreviewBytes: number
  /** Number of settled runs kept in the client projection. */
  recentRuns: number
  /** Whether completed runs are written under {@link Config.runsDir}. */
  persistRuns: boolean
  /** Master switch for long-term memory distillation after a run settles. */
  memoryEnabled: boolean
  /** Directory holding distilled workflow memory. */
  memoryDir: string
  /** Byte budget for one workflow's memory file. */
  memoryMaxBytes: number
  /** Agent spec id used to curate memory at the end of a run. */
  memoryCurator: string
  /** LLM provider route of the dormant run-root session a `/workflow run` executes in. */
  runRootProvider: string
  /** Optional model id overriding the run-root session's provider default. */
  runRootModel?: string
  /**
   * Namespace prepended to each agent spec id to form the registered dsh agent
   * preset id (`xl-reviewer` for the default). Preset ids are process-global,
   * so the prefix isolates this plugin's registrations from other presets.
   */
  presetIdPrefix: string
}

export const Config: Schema<Config> = Schema.object({
  agentsDir: Schema.string().default('agents'),
  workflowsDir: Schema.string().default('workflows'),
  runsDir: Schema.string().default('.dsh/xl-build/runs'),
  maxConcurrentNodes: Schema.natural().default(4),
  maxConcurrentAgentTools: Schema.natural().default(4),
  runTimeoutMs: Schema.natural().default(1_800_000),
  maxSteps: Schema.natural().default(200),
  scriptTimeoutMs: Schema.natural().default(120_000),
  allowedScriptRuntimes: Schema.array(Schema.union(['shell', 'ptc'])).default(['shell', 'ptc']),
  retryableToolErrors: Schema.array(Schema.string()).default([]),
  wirePreviewBytes: Schema.natural().default(2_048),
  recentRuns: Schema.natural().default(5),
  persistRuns: Schema.boolean().default(true),
  memoryEnabled: Schema.boolean().default(true),
  memoryDir: Schema.string().default('.dsh/xl-build/memory'),
  memoryMaxBytes: Schema.natural().default(16_000),
  memoryCurator: Schema.string().default('memory-curator'),
  runRootProvider: Schema.string().default('spawn'),
  runRootModel: Schema.string(),
  presetIdPrefix: Schema.string().default('xl-'),
})
