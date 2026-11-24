/**
 * The workflow's cross-run distilled memory: one bounded Markdown file per workflow id.
 *
 * The file is the only source of truth (plan.md §6.8): a run reads it once at start
 * and injects it only through the `{{memory}}` template reference and the
 * `context: { from: 'memory' }` preamble; after the run ends one curation activation
 * rewrites it wholesale. A missing file or a disabled switch yields the empty string
 * so workflows stay portable across deployments.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentRunner } from '../agents/run.ts'
import type { AgentSpec } from '../agents/spec.ts'
import type { MemoryUpdatedPayload } from '../events.ts'
import type { RunSummary } from './run.ts'

/** Options the composition root binds from `Config`. */
export interface ReadMemoryOptions {
  /** Directory holding one `<workflowId>.md` file per workflow. */
  readonly memoryDir: string
  /** The memory switch; `false` skips both the read and the curation pass. */
  readonly memoryEnabled: boolean
  /** Byte ceiling on the injected text. */
  readonly memoryMaxBytes: number
}

/** Cut text to a UTF-8 byte budget without splitting a code point. */
function cutToBytes(text: string, maxBytes: number): string {
  let bytes = 0
  let kept = ''
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    kept += codePoint
  }
  return kept
}

/**
 * Read one workflow's memory document.
 * @param workflowId - the workflow whose memory file is read.
 * @param options - the configured directory, switch, and byte ceiling.
 * @returns the memory text truncated to `memoryMaxBytes` bytes; '' when the
 *   switch is off or the file does not exist.
 */
export function readMemory(workflowId: string, options: ReadMemoryOptions): string {
  if (!options.memoryEnabled) return ''
  let text: string
  try {
    text = readFileSync(memoryFile(options.memoryDir, workflowId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
  return Buffer.byteLength(text, 'utf8') > options.memoryMaxBytes
    ? cutToBytes(text, options.memoryMaxBytes)
    : text
}

/** The memory file for one workflow id inside the configured directory. */
function memoryFile(memoryDir: string, workflowId: string): string {
  return join(memoryDir, workflowId + '.md')
}

/**
 * Write the memory file atomically: temp file first, rename over the target, so a
 * crash mid-write never leaves a half-written memory behind.
 */
async function writeMemoryFile(memoryDir: string, workflowId: string, memory: string): Promise<void> {
  await mkdir(memoryDir, { recursive: true })
  const temp = join(memoryDir, workflowId + '.' + randomUUID() + '.tmp')
  await writeFile(temp, memory, 'utf8')
  await rename(temp, memoryFile(memoryDir, workflowId))
}

/** Inputs for one curation pass; the curator serializes passes per workflow id. */
export interface CurateMemoryInput<P> {
  /** The settled run's identity, carried into the memory-updated record. */
  readonly runId: string
  readonly workflowId: string
  /** The finished run's digest text (`runDigestText`). */
  readonly runDigest: string
  /** Activation parent: the settled run's session agent. */
  readonly parent: P
  /** Journal sink bound to the run session; delivers the memory-updated record. */
  readonly record: (payload: MemoryUpdatedPayload) => Promise<void> | void
  /** Resolves `Config.memoryCurator` at pass time so hot reloads apply. */
  readonly resolveCurator: () => AgentSpec | undefined
}

/** The curation queue for one plugin instance, serialized per workflow id. */
export interface MemoryCurator<P> {
  /**
   * Enqueue one curation pass.
   * @param input - the settled run and the sink for its memory-updated record.
   * @returns a promise that settles when this pass and every earlier pass for the
   *   same workflow id have finished; never rejects.
   */
  curate(input: CurateMemoryInput<P>): Promise<void>
}

/** Extract the memory string from a structured curator result; undefined when the shape mismatches. */
function structuredMemory(structured: unknown): string | undefined {
  if (structured === null || typeof structured !== 'object') return undefined
  const memory = (structured as { memory?: unknown }).memory
  return typeof memory === 'string' ? memory : undefined
}

/**
 * Create the memory curation queue.
 * @param options - the shared agent runner, the curator config slice, and the
 *   memory directory and ceiling.
 * @returns the queue; passes for the same workflow id run FIFO, passes for
 *   different ids run concurrently.
 */
export function createMemoryCurator<P>(options: {
  readonly runner: AgentRunner<P>
  /** The configured curator id, named in the record when it cannot resolve. */
  readonly curatorId: string
  readonly memoryDir: string
  readonly memoryEnabled: boolean
  readonly memoryMaxBytes: number
}): MemoryCurator<P> {
  const chains = new Map<string, Promise<void>>()
  const runOne = async (input: CurateMemoryInput<P>): Promise<void> => {
    const emit = async (outcome: 'updated' | 'kept', fields: { bytes?: number, reason?: string }): Promise<void> => {
      await input.record({
        version: 1,
        runId: input.runId,
        workflowId: input.workflowId,
        outcome,
        ...fields.bytes !== undefined ? { bytes: fields.bytes } : {},
        ...fields.reason !== undefined ? { reason: fields.reason } : {},
      })
    }
    const spec = input.resolveCurator()
    if (spec === undefined) {
      await emit('kept', { reason: `curator agent "${options.curatorId}" is not defined` })
      return
    }
    const previousMemory = readMemory(input.workflowId, {
      memoryDir: options.memoryDir,
      memoryEnabled: true,
      memoryMaxBytes: options.memoryMaxBytes,
    })
    const execution = await options.runner.start({
      spec,
      task: `[run digest]\n${input.runDigest}\n\n[workflow memory]\n${previousMemory}`,
      parent: input.parent,
      signal: new AbortController().signal,
      delivery: 'caller',
    })
    const result = await execution.result
    if (result.stopReason !== 'completed') {
      await emit('kept', { reason: result.diagnostic ?? `curator activation ended (${result.stopReason})` })
      return
    }
    const memory = structuredMemory(result.structured)
    if (memory === undefined) {
      await emit('kept', { reason: 'curator output did not satisfy the { memory: string } schema' })
      return
    }
    const bytes = Buffer.byteLength(memory, 'utf8')
    if (bytes > options.memoryMaxBytes) {
      await emit('kept', { reason: `curated memory is ${bytes} bytes, over the ${options.memoryMaxBytes}-byte ceiling` })
      return
    }
    try {
      await writeMemoryFile(options.memoryDir, input.workflowId, memory)
    } catch (error) {
      await emit('kept', { reason: `memory write failed: ${(error as Error).message}` })
      return
    }
    await emit('updated', { bytes })
  }
  return {
    curate: (input) => {
      if (!options.memoryEnabled) return Promise.resolve()
      const previous = chains.get(input.workflowId) ?? Promise.resolve()
      const pass = previous
        .then(() => runOne(input), () => runOne(input))
        .catch(() => {
          // A record-sink failure leaves nothing recordable; the memory file is
          // untouched either way and the chain must stay alive for the next pass.
        })
      chains.set(input.workflowId, pass)
      return pass
    },
  }
}

/** Output values longer than this are capped in the digest; the curator sees the shape, not the full artifact. */
const DIGEST_OUTPUT_CAP = 500

/**
 * Assemble the bounded digest text the curator receives: the run outcome, one line
 * per node end and node error, the failures, the artifacts, and the rendered outputs.
 * @param summary - the settled run summary.
 * @param nodeEvents - lines captured from the run's node-end and node-error records.
 * @returns the digest text.
 */
export function runDigestText(summary: RunSummary, nodeEvents: readonly string[]): string {
  const lines = [
    `run ${summary.runId} on workflow ${summary.workflowId}: ${summary.outcome} in ${summary.totalDurationMs}ms`,
    ...nodeEvents,
  ]
  for (const failure of summary.failures) lines.push(`[failure ${failure.nodeId}] ${failure.message}`)
  for (const artifact of summary.artifacts) lines.push(`[artifact ${artifact.nodeId}] ${artifact.id}`)
  for (const [name, value] of Object.entries(summary.outputs)) {
    lines.push(`[output ${name}] ${value.length > DIGEST_OUTPUT_CAP ? value.slice(0, DIGEST_OUTPUT_CAP) + '…' : value}`)
  }
  return lines.join('\n')
}
