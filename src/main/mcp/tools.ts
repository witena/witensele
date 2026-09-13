/**
 * MCP tools → AI SDK tools.
 *
 * The two sides describe the same idea in incompatible shapes, and this file is
 * the whole translation:
 *
 * | MCP | AI SDK |
 * |---|---|
 * | `tool.name`, unique **within one server** | a key in a flat `ToolSet`, unique within one model call |
 * | `tool.inputSchema`, a JSON Schema object | `inputSchema: jsonSchema(schema)` |
 * | `callTool` → `{ content: [...], isError }` | `execute` → a value, or a throw |
 *
 * Everything here is **pure**: it is handed a `call` function and never touches a
 * client, a socket or a child process. That is what lets the naming rules and the
 * result mapping be unit-tested against a two-line fake instead of a live server.
 *
 * ## Naming
 *
 * A model sees one flat namespace, but two servers may both offer `search`. So
 * the key is `${serverSlug}__${toolName}`, both halves sanitized to
 * `[a-zA-Z0-9_-]` because that is the intersection every provider's tool-name
 * rule accepts (OpenAI and Anthropic both reject a dot or a space). The
 * separator is a double underscore so a single underscore inside either half
 * cannot be mistaken for it.
 *
 * The transcript must not show that mangling, so `origins` maps the prefixed key
 * back to `{ serverId, serverName, toolName }` and `agent-turn.ts` stores the
 * original name in the `tool-call` part.
 *
 * ## Result mapping
 *
 * MCP answers with a list of content blocks; a model wants one value. Text blocks
 * are joined with a blank line, an image becomes `[image <mimeType>]` (the base64
 * payload would blow up the context for no benefit — the MVP has no vision path),
 * and a resource becomes its inline text or, failing that, its URI.
 *
 * `isError: true` is **thrown**, not returned, because that is how the AI SDK
 * distinguishes a failed call: it emits a `tool-error` part instead of a
 * `tool-result` one, and the model is told the call failed rather than being fed
 * an error message it may read as data.
 */
import { jsonSchema, tool, type ToolSet } from 'ai'
import type { McpToolInfo } from '@shared/types'

/**
 * What `jsonSchema()` accepts, derived from the function rather than imported as
 * `JSONSchema7` from `@ai-sdk/provider`: that package is a transitive dependency
 * of `ai`, not one this project declares, and importing it directly would break
 * the day the AI SDK reorganises its internals.
 */
type JsonSchemaInput = Parameters<typeof jsonSchema>[0]

/** Separator between the server slug and the tool name in a `ToolSet` key. */
export const TOOL_NAME_SEPARATOR = '__'

/** Slug used when a server's name contains nothing a tool name may keep. */
export const FALLBACK_SLUG = 'mcp'

/**
 * One tool as `client.listTools()` reports it, narrowed to the three fields this
 * layer uses. Declared here rather than imported from the MCP SDK so the pure
 * half of the feature does not depend on the client package at all.
 */
export interface McpToolDefinition {
  name: string
  description?: string | undefined
  /** A JSON Schema object; MCP guarantees `type: 'object'`. */
  inputSchema: Record<string, unknown>
}

/** One block of an MCP tool result. Unknown `type`s are tolerated, not rejected. */
export interface McpContentItem {
  type: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  resource?: { uri?: string; text?: string; mimeType?: string }
}

/** What `client.callTool()` resolves with, narrowed to what the mapping reads. */
export interface McpCallResult {
  content?: McpContentItem[]
  isError?: boolean
  structuredContent?: unknown
}

/** Runs one tool on one server. Injected so this module stays pure. */
export type CallMcpTool = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<McpCallResult>

/** Where a prefixed tool key came from, for the `tool-call` message part. */
export interface ToolOrigin {
  serverId: string
  serverName: string
  /** The tool's own name on that server, without the prefix. */
  toolName: string
}

export interface AgentTools {
  /** Ready for `streamText({ tools })`. */
  tools: ToolSet
  /** Prefixed key → origin, for turning a call back into something readable. */
  origins: Record<string, ToolOrigin>
}

/** Everything a provider's tool-name rule rejects, collapsed to `_`. */
export function sanitizeToolSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * The prefix a server's tools carry.
 *
 * Trimmed of leading and trailing underscores so `@my/server` does not become
 * `_my_server`, and replaced by `FALLBACK_SLUG` when nothing survives — an empty
 * prefix would produce keys starting with `__`, which reads as an internal name.
 */
export function serverSlug(serverName: string): string {
  const slug = sanitizeToolSegment(serverName).replace(/^_+|_+$/g, '')
  return slug.length > 0 ? slug : FALLBACK_SLUG
}

/** The `ToolSet` key for one tool of one server. */
export function toolKey(serverName: string, toolName: string): string {
  return `${serverSlug(serverName)}${TOOL_NAME_SEPARATOR}${sanitizeToolSegment(toolName)}`
}

/** One content block, flattened to the text a model can read. */
function renderItem(item: McpContentItem): string {
  switch (item.type) {
    case 'text':
      return item.text ?? ''
    case 'image':
    case 'audio':
      return `[${item.type} ${item.mimeType ?? 'unknown'}]`
    case 'resource':
      // Inline text when the server sent it; otherwise the URI is the only thing
      // worth saying — a base64 `blob` is noise in a prompt.
      return item.resource?.text ?? item.resource?.uri ?? ''
    case 'resource_link':
      return item.uri ?? ''
    default:
      return item.text ?? ''
  }
}

/**
 * An MCP result as one string.
 *
 * Exported for the tests and for `agent-turn.ts`, which shows the same rendering
 * in the tool card as the model was given — a card that disagreed with what the
 * model saw would be worse than no card.
 */
export function renderToolResult(result: McpCallResult): string {
  const rendered = (result.content ?? []).map(renderItem).filter((text) => text.length > 0)
  if (rendered.length > 0) return rendered.join('\n\n')
  // A tool that answers only with `structuredContent` (MCP 2025-06-18) would
  // otherwise look like it returned nothing at all.
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent)
  }
  return ''
}

/** Thrown for `isError: true`, so the AI SDK emits a `tool-error` part. */
export class McpToolError extends Error {
  constructor(toolName: string, detail: string) {
    super(detail.length > 0 ? detail : `${toolName} failed`)
    this.name = 'McpToolError'
  }
}

/** The list the renderer shows: names and descriptions, never schemas. */
export function toToolInfo(tools: readonly McpToolDefinition[]): McpToolInfo[] {
  return tools.map((definition) => ({
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {})
  }))
}

/**
 * Wraps one server's tools as AI SDK tools.
 *
 * `call` receives the tool's **original** name, because that is what the server
 * knows; only the `ToolSet` key is prefixed.
 */
export function toAiTools(
  serverId: string,
  serverName: string,
  tools: readonly McpToolDefinition[],
  call: CallMcpTool
): AgentTools {
  const set: ToolSet = {}
  const origins: Record<string, ToolOrigin> = {}

  for (const definition of tools) {
    const key = toolKey(serverName, definition.name)
    // A server that lists `a.b` and `a_b` would collide; first one wins, which
    // is at least deterministic — `listTools` returns a stable order.
    if (key in set) continue

    origins[key] = { serverId, serverName, toolName: definition.name }
    set[key] = tool({
      ...(definition.description ? { description: definition.description } : {}),
      // The MCP schema is passed through untouched: rewriting it is how a tool
      // starts being called with arguments its server rejects.
      inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema as JsonSchemaInput),
      execute: async (input) => {
        const result = await call(definition.name, input ?? {})
        const text = renderToolResult(result)
        if (result.isError === true) throw new McpToolError(definition.name, text)
        return text
      }
    })
  }

  return { tools: set, origins }
}
