/**
 * The single authoritative workflow representation.
 *
 * Every producer — a JSON file, a YAML file, the Python SDK, a model, or the
 * client export — yields this document; mermaid text and the client graph are
 * projections of it, never alternative runtime forms. Node kinds are a
 * discriminated union of strict objects, so a field belonging to another kind
 * (for example `self` on a `script` node) fails at parse time instead of being
 * silently dropped.
 */
import { z } from 'zod'

/** Identifier grammar shared by workflow, node, and edge ids. */
export const WORKFLOW_ID_PATTERN: RegExp = /^[a-z][a-z0-9-]{1,60}$/

const IdSchema = z.string().regex(WORKFLOW_ID_PATTERN, 'must start lowercase and contain only a-z, 0-9, - (2-61 chars)')

/** A template referencing `input.*`, `nodes.*`, `edges.*`, or `memory`. */
export const TemplateSchema = z.string().min(1)

/** Which context an `agent` node injects; the child never inherits history. */
export const AgentContextSchema = z.union([
  z.literal('none'),
  z.object({ lastMessages: z.number().int().min(1) }),
  z.object({ from: z.literal('run-input') }),
  z.object({ from: z.literal('memory') }),
])
export type AgentContext = z.infer<typeof AgentContextSchema>

/** Edge payload representation. */
export const EdgeKindSchema = z.enum(['flow', 'branch', 'fan-out', 'fan-in', 'loop-back', 'error'])
export type EdgeKind = z.infer<typeof EdgeKindSchema>

export const EdgeFormatSchema = z.enum(['str', 'text', 'md', 'json'])
export type EdgeFormat = z.infer<typeof EdgeFormatSchema>

export const WorkflowEdgeSchema = z.strictObject({
  id: IdSchema,
  from: IdSchema,
  to: IdSchema,
  kind: EdgeKindSchema,
  format: EdgeFormatSchema.default('text'),
  label: z.string().optional(),
  /** JSONPath subset selecting a sub-value from the upstream structured output. */
  select: z.string().optional(),
  /** Template overriding the default payload. */
  template: z.string().optional(),
  /** JSONLogic condition; required on every branch edge except the `else` target. */
  condition: z.string().optional(),
  maxBytes: z.number().int().positive().optional(),
})
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>

const BaseNodeShape = {
  id: IdSchema,
  timeoutMs: z.number().int().positive().optional(),
  maxAttempts: z.number().int().min(1).optional(),
}

export const InputNodeSchema = z.strictObject({
  ...BaseNodeShape,
  kind: z.literal('input'),
  params: z.array(z.strictObject({
    name: z.string().min(1),
    required: z.boolean().default(false),
    default: z.string().optional(),
  })).default([]),
})

export const AgentNodeSchema = z.strictObject({
  ...BaseNodeShape,
  kind: z.literal('agent'),
  /** Agent spec id resolved from the agent registry. */
  agent: z.string().min(1),
  task: TemplateSchema,
  context: AgentContextSchema.default('none'),
  /** Run this node as a child activation of the current agent. */
  self: z.boolean().default(false),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
})

export const ScriptNodeSchema = z.strictObject({
  ...BaseNodeShape,
  kind: z.literal('script'),
  runtime: z.enum(['shell', 'ptc']),
  /** Shell command to run. */
  command: z.string().min(1).optional(),
  /** PTC script body to run. */
  script: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  stdin: z.enum(['edges', 'none']).default('none'),
}).refine(
  (node) => (node.command === undefined) !== (node.script === undefined),
  { message: 'exactly one of command or script is required' },
)

export const ToolNodeSchema = z.strictObject({
  ...BaseNodeShape,
  kind: z.literal('tool'),
  /** Host tool name to invoke. */
  tool: z.string().min(1),
  /** Tool arguments as templates. */
  args: z.record(z.string(), z.string()).default({}),
})

export const RouterNodeSchema = z.strictObject({
  ...BaseNodeShape,
  kind: z.literal('router'),
  branches: z.array(z.strictObject({ when: z.string().min(1), to: IdSchema })).default([]),
  /** Target of the unconditional branch. */
  else: IdSchema,
})

export const JoinNodeSchema = z.strictObject({
  ...BaseNodeShape,
  kind: z.literal('join'),
  strategy: z.enum(['all', 'any', 'quorum']),
  quorum: z.number().int().min(1).optional(),
  failFast: z.boolean().default(false),
})

export const LoopNodeSchema = z.strictObject({
  ...BaseNodeShape,
  kind: z.literal('loop'),
  /** Entry node of the loop body. */
  body: IdSchema,
  until: z.strictObject({ expr: z.string().min(1) }),
  maxIters: z.number().int().min(1),
  onMaxIters: z.enum(['fail', 'continue', 'stop']).default('fail'),
  /** Loop-back edge ids carrying values between rounds. */
  carry: z.array(IdSchema).optional(),
  /** Converged-frame output edge ids; defaults to this node's out-edges. */
  emit: z.array(IdSchema).optional(),
})

export const SubworkflowNodeSchema = z.strictObject({
  ...BaseNodeShape,
  kind: z.literal('subworkflow'),
  workflow: IdSchema,
  inputs: z.record(z.string(), z.string()).default({}),
})

/** One selectable answer of an ask node question. */
export const AskOptionSpecSchema = z.strictObject({
  label: z.string().min(1),
  description: z.string().optional(),
})
export type AskOptionSpec = z.infer<typeof AskOptionSpecSchema>

/** One question an ask node puts to the run's initiating user. */
export const AskQuestionSpecSchema = z.strictObject({
  /** Answer id downstream conditions and templates read; defaults to q1, q2, ... */
  id: z.string().min(1).optional(),
  /** The question text; a template so it can cite earlier node results. */
  question: TemplateSchema,
  header: z.string().optional(),
  /** Answer choices; absent lets the user answer free-form. */
  options: z.array(AskOptionSpecSchema).min(1).optional(),
})
export type AskQuestionSpec = z.infer<typeof AskQuestionSpecSchema>

export const AskNodeSchema = z.strictObject({
  ...BaseNodeShape,
  kind: z.literal('ask'),
  /** Questions the node asks the user; execution waits for every answer. */
  questions: z.array(AskQuestionSpecSchema).min(1),
})

export const OutputNodeSchema = z.strictObject({
  ...BaseNodeShape,
  kind: z.literal('output'),
  value: TemplateSchema,
})

export const NoteNodeSchema = z.strictObject({
  ...BaseNodeShape,
  kind: z.literal('note'),
  text: z.string(),
})

/** The closed node-kind union; base fields are shared by every member. */
export const WorkflowNodeSchema = z.discriminatedUnion('kind', [
  InputNodeSchema,
  AgentNodeSchema,
  ScriptNodeSchema,
  ToolNodeSchema,
  RouterNodeSchema,
  JoinNodeSchema,
  LoopNodeSchema,
  SubworkflowNodeSchema,
  AskNodeSchema,
  OutputNodeSchema,
  NoteNodeSchema,
])
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>
export type WorkflowNodeKind = WorkflowNode['kind']

export const WorkflowDefaultsSchema = z.strictObject({
  nodeTimeoutMs: z.number().int().positive().default(600_000),
  maxAttempts: z.number().int().min(1).default(2),
  edgeMaxBytes: z.number().int().positive().default(64_000),
})
export type WorkflowDefaults = z.infer<typeof WorkflowDefaultsSchema>

/** The defaults as the schema itself resolves them; one source for both. */
const DOCUMENT_DEFAULTS: WorkflowDefaults = WorkflowDefaultsSchema.parse({})

const WorkflowDocumentRawSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: IdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  entry: IdSchema,
  defaults: WorkflowDefaultsSchema.optional(),
  nodes: z.array(WorkflowNodeSchema).min(1),
  edges: z.array(WorkflowEdgeSchema),
  outputs: z.record(z.string(), z.string()).default({}),
})

/** A validated workflow document with its defaults resolved. */
export type WorkflowDocument = Omit<z.infer<typeof WorkflowDocumentRawSchema>, 'defaults'> & {
  defaults: WorkflowDefaults
}

/**
 * Parse one workflow document, reporting every violation with its path.
 * @param value - untrusted parsed JSON or YAML.
 * @returns the validated document, with document defaults filled in.
 * @throws {z.ZodError} when any rule in this schema fails.
 */
export function parseWorkflowDocument(value: unknown): WorkflowDocument {
  const raw = WorkflowDocumentRawSchema.parse(value)
  return { ...raw, defaults: raw.defaults ?? DOCUMENT_DEFAULTS }
}
