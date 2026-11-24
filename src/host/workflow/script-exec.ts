/**
 * The shell script executor for `script` nodes, over the harness `ctx.shell`
 * seam. Script escape goes through the same approval and sandbox path as every
 * other shell consumer — this module adds no side channel.
 */
import type { ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { NodeExecutionError } from './run.ts'
import type { ScriptExecutor, WorkflowRunServices } from './run.ts'
import type { WorkflowNode } from './domain.ts'

/** Stdout capture budget for one script node run. */
const SCRIPT_STDOUT_MAX_BYTES = 1024 * 1024

/** Tail of stderr included in a nonzero-exit failure message. */
const STDERR_TAIL_CHARS = 2000

/**
 * Build the script executor from the host shell service.
 * @param shell - the `ctx.shell` service.
 * @param workdir - the working directory script commands run in.
 * @returns the executor wired into {@link WorkflowRunServices.runScript}.
 */
export function createShellScriptExecutor(shell: ShellExecutor, workdir: string): ScriptExecutor {
  return async ({ node, stdin, timeoutMs, signal }) => {
    if (node.runtime === 'ptc') {
      // The PTC runtime seam arrives with a later milestone; refuse loudly instead of faking it.
      throw new NodeExecutionError('deterministic', 'ptc script runtime is not wired yet; only "shell" is available')
    }
    const spec = shell.resolve({
      command: scriptCommandOf(node),
      workdir,
      timeoutMs,
      stdoutMaxBytes: SCRIPT_STDOUT_MAX_BYTES,
      signal,
      ...stdin !== '' ? { stdin } : {},
    })
    const execution = await shell.execute(spec)
    const result = await execution.result()
    assertShellResult(node, result)
    return { stdout: result.stdout.text, truncated: result.stdout.truncated }
  }
}

/**
 * The command line one script node runs: a literal command or a script file's
 * contents. Validation enforces the xor, so a missing both is a hard error.
 */
function scriptCommandOf(node: WorkflowNode & { kind: 'script' }): string {
  if (node.command !== undefined) return node.command
  if (node.script !== undefined) return node.script
  throw new NodeExecutionError('deterministic', `script node "${node.id}" declares neither command nor script`)
}

/**
 * Turn a settled shell result into either stdout or a classified failure.
 * @param node - the node whose script ran.
 * @param result - the executor's settled result.
 */
function assertShellResult(node: WorkflowNode & { kind: 'script' }, result: ShellRunResult): void {
  if (result.timedOut) {
    throw new NodeExecutionError('timeout', `script "${node.id}" timed out after ${result.timeoutMs}ms`)
  }
  if (result.aborted) {
    throw new NodeExecutionError('deterministic', `script "${node.id}" was cancelled`)
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.text
    const tail = stderr.length > STDERR_TAIL_CHARS ? `…${stderr.slice(-STDERR_TAIL_CHARS)}` : stderr
    throw new NodeExecutionError(
      'deterministic',
      `script "${node.id}" exited ${result.exitCode ?? 'by signal'}${tail === '' ? '' : `: ${tail}`}`,
    )
  }
}
