/**
 * The one place an edge payload becomes text.
 *
 * The model input and the durable `node-input` record use the same string, so
 * what the model read is exactly what the log holds. The header carries the
 * payload size so a graph view can show `md · 1.2KB`, and a payload cut by the
 * byte budget carries an explicit marker rather than silently losing content.
 */
import type { EdgeFormat } from './domain.ts'

/** Inputs describing one transfer between two nodes. */
export interface EdgeEnvelopeInput {
  readonly from: string
  readonly to: string
  readonly format: EdgeFormat
  readonly value: unknown
}

/** One rendered payload: the text both consumers share, its size, and whether it was cut. */
export interface EdgeEnvelope {
  /** The exact text delivered to the model and recorded in the log. */
  readonly text: string
  /** Byte length of the payload before truncation. */
  readonly bytes: number
  readonly truncated: boolean
}

/** Markdown notice prefixed to an `md` payload. */
const MARKDOWN_NOTICE = 'The following content is markdown.'

/** JSON notice prefixed to a `json` payload. */
const JSON_NOTICE = 'The following content is application/json.'

/** Marker appended inside the envelope when the byte budget cut the payload. */
export const TRUNCATION_MARKER = '[truncated:'

/**
 * Human-readable byte size, as shown in the envelope header.
 * @param bytes - the byte length.
 * @returns a compact size such as `512B` or `1.2KB`.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kilobytes = bytes / 1024
  return `${kilobytes >= 10 ? Math.round(kilobytes) : Math.round(kilobytes * 10) / 10}KB`
}

/**
 * Serialize one payload according to the edge's format.
 * @param value - the upstream value.
 * @param format - the declared representation.
 * @returns the payload text, including the format notice where the format requires one.
 */
export function serializeEdgeValue(value: unknown, format: EdgeFormat): string {
  switch (format) {
    case 'str': {
      const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
      return text.trim().replace(/\s+/g, ' ')
    }
    case 'text':
      return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
    case 'md':
      return `${MARKDOWN_NOTICE}\n\n${typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)}`
    case 'json':
      return `${JSON_NOTICE}\n\n${JSON.stringify(value, null, 2) ?? 'null'}`
  }
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
 * Render one edge payload as the envelope both the model and the log receive.
 * @param input - the endpoints, the declared format, and the upstream value.
 * @param maxBytes - optional byte budget for the payload body.
 * @returns the envelope text, the pre-truncation byte size, and whether it was cut.
 */
export function renderEdgeEnvelope(input: EdgeEnvelopeInput, maxBytes?: number): EdgeEnvelope {
  const serialized = serializeEdgeValue(input.value, input.format)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  const truncated = maxBytes !== undefined && bytes > maxBytes
  const kept = truncated ? cutToBytes(serialized, maxBytes ?? 0) : serialized
  const body = truncated
    ? `${kept}\n${TRUNCATION_MARKER} kept ${Buffer.byteLength(kept, 'utf8')} of ${bytes} bytes]`
    : kept
  const header = `[edge ${input.from} -> ${input.to} | format=${input.format} | ${formatBytes(bytes)}]`
  return { text: `${header}\n${body}\n[/edge]`, bytes, truncated }
}
