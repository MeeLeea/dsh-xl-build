/**
 * Workflow document loading: the `json`/`yaml` syntax pair and the Python DSL
 * (compiled by `python -m xl_build`) behind one validated result, plus
 * directory scanning for `list`.
 *
 * A broken file is reported per file and never hides the others; loaders throw
 * only when a single file is requested explicitly. The schema-version gate
 * refuses missing, malformed, and newer versions with a reason and migrates
 * older ones step by step (plan.md §6.7).
 */
import { spawnSync } from 'node:child_process'
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import { parseWorkflowDocument } from './domain.ts'
import type { WorkflowDocument } from './domain.ts'

/** Extensions the workflow directory loader accepts; `.py` compiles per file, not per directory. */
export const WORKFLOW_FILE_EXTENSIONS: ReadonlySet<string> = new Set(['.json', '.yml', '.yaml'])

/** The document schema this plugin parses; every lower version migrates up to it. */
export const WORKFLOW_SCHEMA_VERSION = 1

/** A document as JSON.parse or YAML load produced it, before schema validation. */
type RawWorkflowDocument = Record<string, unknown>

/**
 * One migration step per source version; each returns the document at
 * `version + 1`. The chain repeats until WORKFLOW_SCHEMA_VERSION.
 */
const SCHEMA_MIGRATIONS: Readonly<Record<number, (document: RawWorkflowDocument) => RawWorkflowDocument>> = {}

/** Format zod issues as `path: message` pairs. */
function formatIssues(error: { issues: { path: PropertyKey[], message: string }[] }): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ')
}

/**
 * Check `schemaVersion` before schema validation: refuse documents without a
 * version or above this build, and migrate lower ones version by version.
 * @param document - parsed JSON or YAML value.
 * @param file - file name used in error text.
 * @returns the document at WORKFLOW_SCHEMA_VERSION.
 * @throws {Error} when the version is missing, malformed, newer than this
 * plugin supports, or a migration step is missing or misbehaves.
 */
function normalizeSchemaVersion(document: unknown, file: string): RawWorkflowDocument {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    const kind = Array.isArray(document) ? 'an array' : document === null ? 'null' : typeof document
    throw new Error(`${file}: a workflow document must be a JSON object, got ${kind}`)
  }
  const raw = document as RawWorkflowDocument
  const declared = raw['schemaVersion']
  if (declared === undefined) {
    throw new Error(`${file}: missing schemaVersion — add "schemaVersion": ${WORKFLOW_SCHEMA_VERSION}`)
  }
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1) {
    throw new Error(`${file}: schemaVersion must be a positive integer, got ${JSON.stringify(declared)}`)
  }
  if (declared > WORKFLOW_SCHEMA_VERSION) {
    throw new Error(`${file}: schemaVersion ${declared} is newer than this plugin supports (highest supported: ${WORKFLOW_SCHEMA_VERSION}); upgrade dsh-xl-build to read this workflow`)
  }
  let migrated = raw
  let version = declared
  while (version < WORKFLOW_SCHEMA_VERSION) {
    const step = SCHEMA_MIGRATIONS[version]
    if (step === undefined) {
      throw new Error(`${file}: no migration path from schemaVersion ${version} to ${WORKFLOW_SCHEMA_VERSION}`)
    }
    migrated = step(migrated)
    const produced = migrated['schemaVersion']
    if (typeof produced !== 'number' || produced !== version + 1) {
      throw new Error(`${file}: migration from schemaVersion ${version} must produce schemaVersion ${version + 1}`)
    }
    version = produced
  }
  return migrated
}

/**
 * Parse one workflow document by file extension.
 * @param text - file contents.
 * @param file - file name or path, used for the syntax choice and error text.
 * @returns the validated document, with document defaults filled in.
 * @throws {Error} when the syntax, schema version, or schema is invalid.
 */
export function parseWorkflowText(text: string, file: string): WorkflowDocument {
  let parsed: unknown
  try {
    parsed = extname(file) === '.json' ? JSON.parse(text) : loadYaml(text)
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`)
  }
  const document = normalizeSchemaVersion(parsed, file)
  try {
    return parseWorkflowDocument(document)
  } catch (error) {
    throw new Error(`${file}: ${formatIssues(error as { issues: { path: PropertyKey[], message: string }[] })}`)
  }
}

/** One definition file, either usable or diagnosed. */
export type WorkflowLoadResult =
  | { readonly status: 'valid', readonly file: string, readonly document: WorkflowDocument }
  | { readonly status: 'invalid', readonly file: string, readonly error: string }

/**
 * Load one workflow file; `.py` routes through the Python compiler.
 * @param path - absolute or relative file path.
 * @returns the validated document.
 * @throws {Error} when the file cannot be read, compiled, or validated.
 */
export function loadWorkflowFile(path: string): WorkflowDocument {
  if (extname(path) === '.py') return loadPythonWorkflowFile(path)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`)
  }
  return parseWorkflowText(text, path)
}

/**
 * Read every workflow file in one directory.
 * @param dir - absolute workflows directory.
 * @returns one entry per accepted-extension file, sorted by file name.
 */
export function loadWorkflowDirectory(dir: string): WorkflowLoadResult[] {
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && WORKFLOW_FILE_EXTENSIONS.has(extname(entry.name)))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    // A missing directory is an empty catalog; anything else is a real failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  return names.map((file) => {
    try {
      return { status: 'valid', file, document: loadWorkflowFile(join(dir, file)) }
    } catch (error) {
      return { status: 'invalid', file, error: (error as Error).message }
    }
  })
}

/** Spawn contract the Python compiler runs through; narrowed for test injection. */
export type SpawnSyncLike = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>

/** Interpreter names the loader tries in order when the caller names none. */
const DEFAULT_PYTHON_CANDIDATES: readonly string[] = ['python', 'python3']

/** Compile budget for one `python -m xl_build build` when the caller passes none. */
const PYTHON_COMPILE_DEFAULT_TIMEOUT_MS = 120_000

/** Upward search depth for the bundled Python package, relative to this module. */
const MAX_PY_PACKAGE_WALK_LEVELS = 5

/**
 * Locate the bundled `py` directory that ships with the plugin package.
 * @returns the directory containing the `xl_build` Python package.
 * @throws {Error} when the package is missing from the installation.
 */
function resolvePyPackageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let level = 0; level < MAX_PY_PACKAGE_WALK_LEVELS; level += 1) {
    if (existsSync(join(dir, 'py', 'xl_build', '__main__.py'))) return join(dir, 'py')
    dir = dirname(dir)
  }
  throw new Error('the python workflow package py/xl_build is missing from this dsh-xl-build installation')
}

/** Options narrowing the Python compile step for callers and tests. */
export interface PythonLoadOptions {
  /** Interpreter names tried in order; defaults to `python`, then `python3`. */
  readonly pythonCandidates?: readonly string[]
  /** Spawn function used to run the compiler; tests inject here. */
  readonly spawn?: SpawnSyncLike
  /** Wall-clock budget for the compiler in milliseconds; defaults to 120000. */
  readonly timeoutMs?: number
}

/**
 * Load one `.py` workflow definition by compiling it with the bundled
 * `xl_build` package (`python -m xl_build build <file> -o <tmp.json>`); the
 * plugin never reads Python source itself, only the compiled JSON document
 * (plan.md §6.7).
 * @param path - absolute or relative path to the `.py` definition.
 * @param options - interpreter candidates, spawn override, and compile budget.
 * @returns the validated document, with defaults filled in.
 * @throws {Error} when no interpreter exists, the compile fails or times out,
 * or the produced JSON does not validate.
 */
export function loadPythonWorkflowFile(path: string, options: PythonLoadOptions = {}): WorkflowDocument {
  const spawn: SpawnSyncLike = options.spawn ?? ((command, args, spawnOptions) => spawnSync(command, args, spawnOptions))
  const candidates = options.pythonCandidates ?? DEFAULT_PYTHON_CANDIDATES
  const timeoutMs = options.timeoutMs ?? PYTHON_COMPILE_DEFAULT_TIMEOUT_MS
  const pythonPackageDir = resolvePyPackageDir()
  const absolute = resolve(path)
  const workspace = mkdtempSync(join(tmpdir(), 'xl-build-'))
  const compiled = join(workspace, 'compiled.json')
  try {
    for (const python of candidates) {
      const result = spawn(python, ['-m', 'xl_build', 'build', absolute, '-o', compiled], {
        cwd: dirname(absolute),
        encoding: 'utf8',
        env: { ...process.env, PYTHONPATH: pythonPackageDir },
        timeout: timeoutMs,
      })
      if (result.error !== undefined) {
        const code = (result.error as NodeJS.ErrnoException).code
        // ENOENT means this interpreter name is absent; later candidates may exist.
        if (code === 'ENOENT') continue
        if (code === 'ETIMEDOUT') {
          throw new Error(`${path}: python compile timed out after ${timeoutMs} ms`)
        }
        throw new Error(`${path}: python compile failed to start: ${result.error.message}`)
      }
      if (result.status !== 0) {
        const output = [result.stderr, result.stdout]
          .map((chunk) => chunk?.trim())
          .filter((chunk) => chunk !== undefined && chunk.length > 0)
          .join('\n')
        const exit = result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`
        throw new Error(`${path}: python compile failed (${exit})${output.length > 0 ? `: ${output}` : ""}`)
      }
      let text: string
      try {
        text = readFileSync(compiled, 'utf8')
      } catch (error) {
        throw new Error(`${path}: python compile produced no readable document: ${(error as Error).message}`)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        throw new Error(`${path}: python compile produced invalid JSON: ${(error as Error).message}`)
      }
      try {
        return parseWorkflowDocument(parsed)
      } catch (error) {
        throw new Error(`${path}: ${formatIssues(error as { issues: { path: PropertyKey[], message: string }[] })}`)
      }
    }
    throw new Error(`${path}: no python interpreter found (tried: ${candidates.join(", ")}); install Python 3 to compile .py workflow definitions`)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}