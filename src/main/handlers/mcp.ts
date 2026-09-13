/**
 * `mcp.*` — the MCP server registry, plus the three questions that need a live
 * connection (`testConnection`, `tools`, `log`).
 *
 * Thin like every other namespace file: persistence belongs to
 * `db/repositories/mcpServers.ts` and connections to `mcp/manager.ts`. What lives
 * here is **validation** and the two side effects the pool cannot work out for
 * itself.
 *
 * Three rules are worth reading before changing anything:
 *
 * - **A name is a tool prefix, not a label.** `mcp/tools.ts` turns it into the
 *   `${slug}__${tool}` key the model sees, so two servers with the same name
 *   would silently hide each other's tools. Names are therefore unique,
 *   case-insensitively, exactly as agent names are.
 * - **Editing a server invalidates its connection.** A pooled client is still
 *   speaking to the old command, the old URL or the old environment; anything
 *   that changes how a server is reached, and disabling it, closes the client so
 *   the next tool call reconnects against what is now stored.
 * - **Deleting a server is not only a row delete.** `agents.mcp_server_ids` is a
 *   JSON column, not a foreign key, so nothing cascades: the id is removed from
 *   every agent by hand. No new event is emitted — the agent editor reloads its
 *   list when it opens, and the chats that contain those agents are unaffected by
 *   a tool binding.
 */
import type { McpServerRef } from '@shared/backend'
import type { McpServerInput, McpTransport } from '@shared/types'
import { validation } from '../errors'
import type { AppContext } from '../app-context'
import type { HandlerModule } from './types'

const TRANSPORTS: readonly McpTransport[] = ['stdio', 'http']

/** Fields whose change makes a pooled connection stale. */
const CONNECTION_FIELDS = ['transport', 'command', 'args', 'env', 'url'] as const

function isTransport(value: unknown): value is McpTransport {
  return typeof value === 'string' && (TRANSPORTS as readonly string[]).includes(value)
}

function assertId(input: unknown): asserts input is { id: string } {
  const id = (input as { id?: unknown })?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw validation('An MCP server id is required')
  }
}

/** `excludeId` is the record being updated, so it may keep its own name. */
function assertName(ctx: AppContext, name: unknown, excludeId?: string): void {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw validation('An MCP server name cannot be empty')
  }
  const wanted = name.trim().toLowerCase()
  const clash = ctx.repos.mcpServers
    .list(ctx.userId)
    .some((server) => server.id !== excludeId && server.name.trim().toLowerCase() === wanted)
  if (clash) throw validation('An MCP server with that name already exists', { name })
}

function assertUrl(url: unknown): void {
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw validation('An http MCP server requires a URL')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw validation('That is not a valid URL', { url })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw validation('An MCP server URL must be http or https', { url })
  }
}

function assertArgs(args: unknown): void {
  if (args === undefined) return
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
    throw validation('args must be an array of strings')
  }
}

function assertEnv(env: unknown): void {
  if (env === undefined) return
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw validation('env must be an object of string values')
  }
  if (Object.values(env as Record<string, unknown>).some((value) => typeof value !== 'string')) {
    throw validation('env must be an object of string values')
  }
}

/** The whole record, for `create` and for a draft being tested. */
function assertServerInput(ctx: AppContext, input: unknown, options: { name?: boolean } = {}): asserts input is McpServerInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw validation('An MCP server input object is required')
  }
  const candidate = input as McpServerInput

  if (options.name !== false) assertName(ctx, candidate.name)
  if (!isTransport(candidate.transport)) {
    throw validation(`Unknown MCP transport: ${String(candidate.transport)}`)
  }
  if (candidate.transport === 'stdio') {
    if (typeof candidate.command !== 'string' || candidate.command.trim().length === 0) {
      throw validation('A stdio MCP server requires a command')
    }
  } else {
    assertUrl(candidate.url)
  }
  assertArgs(candidate.args)
  assertEnv(candidate.env)
  if (typeof candidate.enabled !== 'boolean') throw validation('enabled must be a boolean')
  if (typeof candidate.sideEffects !== 'boolean') throw validation('sideEffects must be a boolean')
}

/**
 * Only the fields the patch carries.
 *
 * The transport-specific requirement is checked against the **merged** record,
 * not against the patch alone: switching `transport` to `http` without sending a
 * URL in the same patch has to fail, and sending only `enabled` must not.
 */
function assertServerPatch(
  ctx: AppContext,
  id: string,
  patch: unknown
): asserts patch is Partial<McpServerInput> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw validation('An MCP server patch object is required')
  }
  const candidate = patch as Partial<McpServerInput>

  if (candidate.name !== undefined) assertName(ctx, candidate.name, id)
  if (candidate.transport !== undefined && !isTransport(candidate.transport)) {
    throw validation(`Unknown MCP transport: ${String(candidate.transport)}`)
  }
  assertArgs(candidate.args)
  assertEnv(candidate.env)
  if (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean') {
    throw validation('enabled must be a boolean')
  }
  if (candidate.sideEffects !== undefined && typeof candidate.sideEffects !== 'boolean') {
    throw validation('sideEffects must be a boolean')
  }

  const merged = { ...ctx.repos.mcpServers.get(id, ctx.userId), ...candidate }
  if (merged.transport === 'stdio') {
    if (!merged.command?.trim()) throw validation('A stdio MCP server requires a command')
  } else {
    assertUrl(merged.url)
  }
}

/** True when a patch changes anything a live client depends on. */
function invalidatesConnection(patch: Partial<McpServerInput>): boolean {
  if (patch.enabled === false) return true
  return CONNECTION_FIELDS.some((field) => patch[field] !== undefined)
}

/** Resolves a `McpServerRef` to something the manager can connect to. */
function resolveTarget(ctx: AppContext, ref: McpServerRef): McpServerInput {
  if ('id' in ref) return ctx.repos.mcpServers.get(ref.id, ctx.userId)
  // A draft has never been stored, so nothing checks its name; only the fields
  // that decide whether a connection can be opened are validated.
  assertServerInput(ctx, ref.draft, { name: false })
  return ref.draft
}

export const mcpHandlers: HandlerModule = {
  'mcp.list': async (ctx) => ctx.repos.mcpServers.list(ctx.userId),

  'mcp.create': async (ctx, input) => {
    const candidate = (input as { input?: unknown })?.input
    assertServerInput(ctx, candidate)
    return ctx.repos.mcpServers.create({ ...candidate, name: candidate.name.trim() }, ctx.userId)
  },

  'mcp.update': async (ctx, input) => {
    assertId(input)
    // Proves the row exists before the patch is measured against it.
    ctx.repos.mcpServers.get(input.id, ctx.userId)
    assertServerPatch(ctx, input.id, input.patch)

    const patch = input.patch as Partial<McpServerInput>
    const updated = ctx.repos.mcpServers.update(
      input.id,
      { ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) },
      ctx.userId
    )

    // After the write, not before: a rejected update must leave the live client
    // exactly as it was.
    if (invalidatesConnection(patch)) await ctx.mcp.disconnect(input.id)
    return updated
  },

  'mcp.delete': async (ctx, input) => {
    assertId(input)
    ctx.repos.mcpServers.get(input.id, ctx.userId)

    // Close first: a stdio child process would otherwise outlive its record with
    // nothing left that knows how to stop it.
    await ctx.mcp.disconnect(input.id)
    ctx.repos.agents.removeMcpServer(input.id, ctx.userId)
    ctx.repos.mcpServers.delete(input.id, ctx.userId)
  },

  'mcp.testConnection': async (ctx, input) => {
    const ref = (input as { server?: McpServerRef })?.server
    if (!ref || typeof ref !== 'object') throw validation('An MCP server reference is required')
    const target = resolveTarget(ctx, ref)
    return ctx.mcp.testConnection(target, 'id' in ref ? ref.id : undefined)
  },

  'mcp.tools': async (ctx, input) => {
    assertId(input)
    ctx.repos.mcpServers.get(input.id, ctx.userId)
    return ctx.mcp.listToolInfo(input.id)
  },

  'mcp.log': async (ctx, input) => {
    assertId(input)
    ctx.repos.mcpServers.get(input.id, ctx.userId)
    return ctx.mcp.getLog(input.id)
  }
}
