/**
 * The `/workflow` command: input parsing is a pure function so its grammar is
 * testable without a host, and the handler only ever answers with success text
 * or a readable usage/failure message — never a thrown error.
 *
 * `run` and `export` parse here (the grammar is one contract); `run` hands the
 * parsed request to the host runtime and `export` renders the saved document.
 */
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type { WorkflowDocument } from '../workflow/domain.ts'
import { loadMergedWorkflowCatalog } from '../workflow/builtins.ts'
import { resolveRunInputs } from '../workflow/execute.ts'
import { loadWorkflowFile } from '../workflow/loaders.ts'
import { toMermaid } from '../workflow/mermaid.ts'
import { validateWorkflow } from '../workflow/validate.ts'
import type { WorkflowRunRuntime } from '../workflow/run.ts'

/** Command name registered on `ctx.commands`. */
export const WORKFLOW_COMMAND_NAME = 'workflow'

/** Usage text returned for an unknown subcommand, a missing argument, or a bad flag. */
export const WORKFLOW_USAGE = 'usage: /workflow run <id> ["<target>"] [--input k=v]... [--self <nodeId>] '
  + '| /workflow list | /workflow validate <file> | /workflow export <id> --mermaid'

/** Grammar half of the advertised input hint; the saved ids are appended per registration. */
const WORKFLOW_INPUT_GRAMMAR = 'run <id> ["<target>"] [--input k=v] [--self <nodeId>] | list | validate <file> | export <id> --mermaid'

/** One parsed `/workflow` invocation. */
export type WorkflowCommand =
  | {
      readonly kind: 'run'
      readonly id: string
      readonly inputs: Record<string, string>
      readonly selfNodeId?: string
      /** Positional value filling the single unfilled declared input; resolved against the document when the run starts. */
      readonly positionalInput?: string
    }
  | { readonly kind: 'list' }
  | { readonly kind: 'validate', readonly file: string }
  | { readonly kind: 'export', readonly id: string, readonly format: 'mermaid' }
  | { readonly kind: 'usage', readonly text: string }

/** Build the usage answer for one rejection reason. */
function usage(reason: string): WorkflowCommand {
  return { kind: 'usage', text: `${reason}\n${WORKFLOW_USAGE}` }
}

/**
 * Split raw input on whitespace, keeping quoted values together and stripping
 * their outer quotes.
 * @param input - the raw input after the command name.
 * @returns the tokens in order.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | '\'' | undefined
  let started = false
  for (const char of input) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/** Parse the `run` subcommand. */
function parseRun(tokens: readonly string[]): WorkflowCommand {
  const [id, ...flags] = tokens
  if (id === undefined) return usage('run requires a workflow id')
  const inputs: Record<string, string> = {}
  let selfNodeId: string | undefined
  let positionalInput: string | undefined
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]
    if (flag === undefined) break
    if (flag === '--self') {
      const value = flags[index + 1]
      if (value === undefined) return usage('--self requires a node id')
      selfNodeId = value
      index += 1
      continue
    }
    if (flag === '--input') {
      const value = flags[index + 1]
      if (value === undefined) return usage('--input requires k=v')
      const separator = value.indexOf('=')
      if (separator <= 0) return usage(`--input expects k=v, got "${value}"`)
      inputs[value.slice(0, separator)] = value.slice(separator + 1)
      index += 1
      continue
    }
    if (flag.startsWith('--')) return usage(`unknown option "${flag}" for run`)
    if (positionalInput !== undefined) return usage(`unexpected extra argument "${flag}" for run`)
    positionalInput = flag
  }
  return {
    kind: 'run',
    id,
    inputs,
    ...(selfNodeId !== undefined ? { selfNodeId } : {}),
    ...(positionalInput !== undefined ? { positionalInput } : {}),
  }
}

/** Parse the `export` subcommand. */
function parseExport(tokens: readonly string[]): WorkflowCommand {
  const [id, format, ...extra] = tokens
  if (id === undefined) return usage('export requires a workflow id')
  if (format !== '--mermaid' || extra.length > 0) return usage('export supports only --mermaid')
  return { kind: 'export', id, format: 'mermaid' }
}

/**
 * Parse one `/workflow` invocation.
 * @param rawInput - the input after the command name.
 * @returns the parsed command, or a usage answer when the input is malformed.
 */
export function parseCommand(rawInput: string): WorkflowCommand {
  const [subcommand, ...rest] = tokenize(rawInput)
  switch (subcommand) {
    case 'list':
      return rest.length === 0 ? { kind: 'list' } : usage('list takes no arguments')
    case 'validate': {
      const [file, ...extra] = rest
      if (file === undefined || extra.length > 0) return usage('validate expects one file path')
      return { kind: 'validate', file }
    }
    case 'run':
      return parseRun(rest)
    case 'export':
      return parseExport(rest)
    case undefined:
      return usage('missing subcommand')
    default:
      return usage(`unknown subcommand "${subcommand}"`)
  }
}

/** Outcome of folding the positional input into the declared run inputs. */
type PositionalResolution = { readonly inputs: Record<string, string> } | { readonly error: string }

/**
 * Fold the positional input into the declared run inputs: it fills the first
 * declared input not already provided by `--input`, preferring required
 * inputs so a bare `"<target>"` reaches the workflow's main input;
 * declaration order breaks ties among the remaining optionals. Zero
 * candidates is a readable error, never a silent guess.
 */
function withPositionalInput(
  document: WorkflowDocument,
  provided: Record<string, string>,
  positional: string,
): PositionalResolution {
  const unfilled = document.nodes
    .flatMap((node) => node.kind === 'input' ? node.params : [])
    .filter((param) => !(param.name in provided))
  const target = unfilled.find((param) => param.required) ?? unfilled[0]
  if (target === undefined) {
    return { error: `positional input given, but "${document.id}" declares no unfilled run input; drop it or use --input k=v` }
  }
  return { inputs: { ...provided, [target.name]: positional } }
}

/**
 * Required run inputs the supplied values do not cover, in declaration order.
 * Checked before a run is started so a missing input is a command answer, not
 * a failed run that still leaves a run-root session and journal behind.
 * @param document - the validated workflow document.
 * @param supplied - the resolved input values (positional folding included).
 * @returns the required parameter names with no value; empty when complete.
 */
function missingRequiredInputs(
  document: WorkflowDocument,
  supplied: Record<string, string>,
): string[] {
  const missing: string[] = []
  for (const node of document.nodes) {
    if (node.kind !== 'input') continue
    missing.push(...resolveRunInputs(node.params, supplied).missing)
  }
  return missing
}

/** Options the workflow command needs from plugin configuration. */
export interface WorkflowCommandOptions {
  /** Absolute workflows directory scanned by `list`. */
  readonly workflowsDir: string
  /** Shipped workflow directory merged under `workflowsDir`; absent when the package ships none. */
  readonly builtInWorkflowsDir?: string
  /** Base for a relative `validate` path; defaults to the process directory. */
  readonly cwd?: string
  /** Run executor; absent until the run milestone is wired into the host. */
  readonly runtime?: WorkflowRunRuntime
}

/**
 * The saved, valid document with one id, or `undefined` when no valid file
 * defines it — the user directory is scanned first, then the shipped one.
 */
function findSavedWorkflow(options: WorkflowCommandOptions, id: string): WorkflowDocument | undefined {
  const { entries } = loadMergedWorkflowCatalog(options.workflowsDir, options.builtInWorkflowsDir)
  const entry = entries.find((candidate) => candidate.status === 'valid' && candidate.document.id === id)
  return entry?.status === 'valid' ? entry.document : undefined
}

/**
 * The ids `/workflow run` can start, deduplicated: user documents first, then
 * shipped ids the user catalog does not own, in merged-catalog order. Invalid
 * files and files repeating an id already collected are skipped.
 * @param options - resolved plugin configuration.
 * @returns each runnable workflow id exactly once.
 */
function savedWorkflowIds(options: WorkflowCommandOptions): readonly string[] {
  const { entries } = loadMergedWorkflowCatalog(options.workflowsDir, options.builtInWorkflowsDir)
  const seen = new Set<string>()
  const ids: string[] = []
  for (const entry of entries) {
    if (entry.status !== 'valid') continue
    const { id } = entry.document
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * The input hint advertised to capable clients: the command grammar plus the
 * deduplicated saved workflow ids, so the composer's hint menu answers "which
 * id can I run" without a `/workflow list` round-trip. The ids are a snapshot
 * taken when the command is registered, matching the host command registry's
 * static-hint contract.
 * @param options - resolved plugin configuration.
 * @returns the hint string for the command definition.
 */
export function workflowInputHint(options: WorkflowCommandOptions): string {
  const ids = savedWorkflowIds(options)
  return ids.length === 0 ? WORKFLOW_INPUT_GRAMMAR : `${WORKFLOW_INPUT_GRAMMAR} | ids: ${ids.join(', ')}`
}

/**
 * Execute one `/workflow` invocation without touching the host.
 * @param rawInput - the input after the command name.
 * @param options - resolved plugin configuration.
 * @param initiator - the agent that accepted the command; required by `run`.
 * @returns the command result the host shows to the user.
 */
export async function runWorkflowCommand(
  rawInput: string,
  options: WorkflowCommandOptions,
  initiator?: Agent,
): Promise<CommandResult> {
  const command = parseCommand(rawInput)
  switch (command.kind) {
    case 'usage':
      return { kind: 'error', text: command.text }
    case 'list': {
      const { entries, builtInIds } = loadMergedWorkflowCatalog(options.workflowsDir, options.builtInWorkflowsDir)
      if (entries.length === 0) return { kind: 'success', text: 'No workflows are saved.' }
      const lines = entries.map((entry) => {
        if (entry.status !== 'valid') return `- ${entry.file}: invalid — ${entry.error}`
        const origin = builtInIds.has(entry.document.id) ? ' (builtin)' : ''
        return `- ${entry.document.id}: ${entry.document.name} (${entry.document.nodes.length} nodes, ${entry.document.edges.length} edges)${origin}`
      })
      return { kind: 'success', text: lines.join('\n') }
    }
    case 'validate': {
      const path = resolve(options.cwd ?? process.cwd(), command.file)
      let document
      try {
        document = loadWorkflowFile(path)
      } catch (error) {
        return { kind: 'error', text: (error as Error).message }
      }
      const issues = validateWorkflow(document)
      if (issues.length > 0) {
        return {
          kind: 'error',
          text: issues.map((issue) => `${issue.rule}: ${issue.message}`).join('\n'),
        }
      }
      return {
        kind: 'success',
        text: `Valid: ${document.id} (${document.nodes.length} nodes, ${document.edges.length} edges)`,
      }
    }
    case 'run': {
      if (options.runtime === undefined) {
        return {
          kind: 'error',
          text: `/${WORKFLOW_COMMAND_NAME} run is not available yet; the workflow engine milestone implements it.`,
        }
      }
      if (initiator === undefined) {
        return { kind: 'error', text: `/${WORKFLOW_COMMAND_NAME} run needs a session to receive the completion notice.` }
      }
      const document = findSavedWorkflow(options, command.id)
      if (document === undefined) {
        return { kind: 'error', text: `workflow "${command.id}" is not saved in ${options.workflowsDir}${options.builtInWorkflowsDir !== undefined ? ' or shipped with the plugin' : ''}` }
      }
      const issues = validateWorkflow(document)
      if (issues.length > 0) {
        return {
          kind: 'error',
          text: issues.map((issue) => `${issue.rule}: ${issue.message}`).join('\n'),
        }
      }
      const resolved = command.positionalInput !== undefined
        ? withPositionalInput(document, command.inputs, command.positionalInput)
        : { inputs: command.inputs }
      if ('error' in resolved) return { kind: 'error', text: resolved.error }
      const missing = missingRequiredInputs(document, resolved.inputs)
      if (missing.length > 0) {
        const hints = missing.map((name) => `--input ${name}=<value>`).join(' ')
        return {
          kind: 'error',
          text: `workflow "${command.id}" is missing required run inputs: ${missing.join(', ')} — add ${hints}; a bare "<target>" fills one input only`,
        }
      }
      let runId: string
      try {
        ({ runId } = await options.runtime.startRun({
          document,
          inputs: resolved.inputs,
          ...(command.selfNodeId !== undefined ? { selfNodeId: command.selfNodeId } : {}),
        }, initiator))
      } catch (error) {
        // The runtime can fail before the run exists (unknown agent, session
        // creation, engine wiring); the handler answers, never throws.
        return { kind: 'error', text: `starting workflow "${command.id}" failed: ${(error as Error).message}` }
      }
      return { kind: 'success', text: `started run ${runId} for ${command.id}` }
    }
    case 'export': {
      const document = findSavedWorkflow(options, command.id)
      if (document === undefined) {
        return { kind: 'error', text: `workflow "${command.id}" is not saved in ${options.workflowsDir}${options.builtInWorkflowsDir !== undefined ? ' or shipped with the plugin' : ''}` }
      }
      return { kind: 'success', text: toMermaid(document) }
    }
  }
}

/**
 * Build the `/workflow` command definition.
 * @param options - resolved plugin configuration.
 * @returns the definition to register on `ctx.commands`.
 */
export function createWorkflowCommand(options: WorkflowCommandOptions): CommandDefinition {
  return {
    name: WORKFLOW_COMMAND_NAME,
    description: 'List, validate, run, or export saved xl-build workflows.',
    input: { hint: workflowInputHint(options) },
    handler: async (invocation) => runWorkflowCommand(invocation.rawInput, options, invocation.agent),
  }
}
