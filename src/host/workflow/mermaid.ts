/**
 * Mermaid projection of a workflow document (plan.md §6.6).
 *
 * Mermaid text is a *projection*, never a second runtime form: it is produced
 * from the same document the engine runs, and its output is deterministic —
 * one fixed glyph and label per node kind, one arrow per edge kind, everything
 * in document order — so it can be snapshot-tested and diffed.
 */
import type { WorkflowDocument, WorkflowNode } from './domain.ts'
import type { NodeStatus } from '../events.ts'

/** Glyph pair (open, close) for each node kind; a note is a comment, not a node. */
const SHAPES: Record<Exclude<WorkflowNode['kind'], 'note'>, [string, string]> = {
  input: ['([', '])'],
  agent: ['[', ']'],
  script: ['{{', '}}'],
  tool: ['>', ']'],
  router: ['{', '}'],
  join: ['((', '))'],
  loop: ['[/', '\\]'],
  subworkflow: ['[[', ']]'],
  ask: ['((', '))'],
  output: ['[(', ')]'],
}

/** Fill/stroke pairs the run view may color nodes with; every classDef is emitted. */
const STATUS_CLASSES: Readonly<Record<string, string>> = {
  completed: 'ok',
  failed: 'bad',
  running: 'run',
}

/** Collapse one label to a single Mermaid line; quotes become apostrophes. */
function label(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replaceAll('"', '\'')
}

/** One node's label per §6.6: what names the node in each kind's grammar. */
function labelOf(node: WorkflowNode): string {
  switch (node.kind) {
    case 'input':
      return 'input'
    case 'agent':
      return label(node.agent)
    case 'script':
      return label(node.runtime === 'shell' ? `shell: ${node.command ?? ''}` : `ptc: ${node.script ?? ''}`)
    case 'tool':
      return label(node.tool)
    case 'router':
      return label(node.branches[0]?.when ?? 'router')
    case 'join':
      return node.strategy === 'quorum' ? `quorum ${node.quorum ?? ''}`.trim() : node.strategy
    case 'loop':
      return `≤${node.maxIters} 轮`
    case 'subworkflow':
      return label(node.workflow)
    case 'ask':
      return label(node.questions[0]?.question ?? 'ask')
    case 'output':
      return 'output'
    case 'note':
      return ''
  }
}

/** One edge's Mermaid arrow and label slot per §6.6. */
function edgeLine(edge: WorkflowDocument['edges'][number]): string {
  switch (edge.kind) {
    case 'flow':
      return `${edge.from} -->|${edge.format}| ${edge.to}`
    case 'branch': {
      const when = edge.condition === undefined ? 'else' : label(edge.condition)
      return `${edge.from} -- "${when}" --> ${edge.to}`
    }
    case 'fan-out':
    case 'fan-in':
      return `${edge.from} ==>|${edge.format}| ${edge.to}`
    case 'loop-back':
      return `${edge.from} -.-> ${edge.to}`
    case 'error':
      return `${edge.from} -.->|error| ${edge.to}`
  }
}

/**
 * Project one document as Mermaid flowchart text.
 * @param document - the workflow document.
 * @param view - optional run statuses; only completed/failed/running nodes get a class line, structure never changes.
 * @returns deterministic Mermaid source ending in exactly one newline.
 */
export function toMermaid(document: WorkflowDocument, view?: { readonly statuses: Readonly<Record<string, NodeStatus>> }): string {
  const lines = ['flowchart TD']
  for (const node of document.nodes) {
    if (node.kind === 'note') {
      lines.push(`  %% note: ${label(node.text)}`)
      continue
    }
    const [open, close] = SHAPES[node.kind]
    lines.push(`  ${node.id}${open}"${labelOf(node)}"${close}`)
  }
  for (const edge of document.edges) {
    lines.push(`  ${edgeLine(edge)}`)
  }
  if (view !== undefined) {
    lines.push('  classDef ok fill:#e6f4ea,stroke:#137333')
    lines.push('  classDef bad fill:#fce8e6,stroke:#c5221f')
    lines.push('  classDef run fill:#e8f0fe,stroke:#1967d2')
    for (const node of document.nodes) {
      const cls = STATUS_CLASSES[view.statuses[node.id] ?? '']
      if (cls !== undefined) lines.push(`  class ${node.id} ${cls}`)
    }
  }
  return `${lines.join('\n')}\n`
}
