/**
 * Host-side artifact registration: run directories and the artifact
 * references recorded in `node-end.artifacts` and the run summary.
 *
 * `path` on every reference is a `dsh-resource://file/…` address generated
 * here, so the client opens artifacts without ever assembling a path
 * (`plan.md` §7.3). The address is session-scoped: a path inside the run's
 * working directory resolves against that session's workspace root, and a
 * path outside it stays absolute inside the same session's address, which
 * the host still resolves.
 */
import { join } from 'node:path'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { ArtifactRef } from './events.ts'

/**
 * The on-disk directory of one run: `<runsDir>/<runId>`.
 * @param runsDir - the configured runs directory.
 * @param runId - the run's identity.
 * @returns the run directory the journal and artifacts live under.
 */
export function runDir(runsDir: string, runId: string): string {
  return join(runsDir, runId)
}

/** Inputs `artifactRef` needs to register one persisted node artifact. */
export interface ArtifactRefInput {
  /** The node that produced the artifact. */
  readonly nodeId: string
  /** The run root session the artifact address is scoped to. */
  readonly sessionId: string
  /** The run's working directory, when known; paths inside it address relatively. */
  readonly cwd: string | undefined
  /** Absolute path of the artifact on disk, in either separator spelling. */
  readonly absPath: string
  /** Run-relative path, kept as the stable id and the display fallback. */
  readonly displayPath: string
  /** Byte size, when known. */
  readonly bytes?: number
}

/**
 * Register one persisted node artifact.
 * @param input - the producing node, the addressing session, and both spellings of the path.
 * @returns the reference the run records in `node-end.artifacts` and its summary.
 */
export function artifactRef(input: ArtifactRefInput): ArtifactRef {
  const title = input.displayPath.split(/[\\/]/).pop() ?? input.displayPath
  return {
    id: input.displayPath,
    nodeId: input.nodeId,
    kind: 'file',
    path: fileAddressFor(input.sessionId, input.cwd, input.absPath),
    ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
    title,
  }
}