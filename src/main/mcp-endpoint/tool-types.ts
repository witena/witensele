/**
 * The three types the transport and the tools agree on.
 *
 * `tasks.md`'s "Frozen contracts" puts `ToolCallContext`, `ToolOutcome` and
 * `ToolRegistry` in `./tools.ts` beside `createTools()`. They live here instead
 * for one reason: WP-4 (the transport) and WP-3 (the tools) are written in
 * parallel, and the transport needs the *types* before the implementation
 * exists. Splitting the three declarations out is the smallest change that lets
 * both packages compile — the contract's shapes are reproduced below verbatim.
 *
 * `tools.ts` re-exports all three, so every reader of the contract finds them
 * where "Frozen contracts" says they are, and `server.ts` defaults its registry
 * to `createTools()`.
 *
 * No electron here or anywhere under `src/main/mcp-endpoint/` (CLAUDE.md rule 5),
 * which `no-electron.test.ts` in this folder proves.
 */
import type { McpToolName } from '@shared/mcp-tools'
import type { BackendErrorCode } from '@shared/types'
import type { AppContext } from '../app-context'
import type { HandlerMap } from '../handlers/types'

/**
 * Everything one `tools/call` gives the tool that serves it.
 *
 * `ctx` and `handlers` are the same two objects the IPC and HTTP transports pass
 * their handlers: the endpoint owns no business logic and reaches storage only
 * through `handlers` (PLAN.md, "it is a third transport beside Electron IPC and
 * `src/server/http.ts`").
 */
export interface ToolCallContext {
  ctx: AppContext
  handlers: HandlerMap
  /** From `CLIENT_HEADER`; undefined for a direct HTTP client. */
  client?: string
  /**
   * Aborted when the MCP request is cancelled or the socket closes.
   *
   * In practice it is the socket: the endpoint is stateless, so a
   * `notifications/cancelled` for an earlier request arrives on a *different*
   * HTTP request and cannot reach this handler. See `server.ts`, "Cancellation".
   */
  signal: AbortSignal
  /**
   * Relays a line of progress to the caller, when the caller asked for one.
   *
   * Present only when the `tools/call` carried `_meta.progressToken`; a tool
   * calls it freely and never depends on it arriving.
   */
  progress?: (update: { message: string; round?: number }) => void
}

/**
 * What a tool returns. Never a throw, and never a stack.
 *
 * The split matters on the wire: `ok: true` is a tool result, `ok: false` is a
 * tool result with `isError: true` — not a JSON-RPC error — because a model that
 * gets a protocol error cannot see what went wrong and correct itself, which is
 * the MCP specification's own reasoning for `isError`.
 */
export type ToolOutcome =
  | { ok: true; structured: unknown; text: string }
  | { ok: false; code: BackendErrorCode | 'busy'; message: string }

/** Every tool name mapped to its implementation. Total: a missing tool cannot compile. */
export type ToolRegistry = {
  [N in McpToolName]: (args: unknown, call: ToolCallContext) => Promise<ToolOutcome>
}
