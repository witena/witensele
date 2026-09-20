/**
 * Witena's chats as MCP **resources**: `witena://chat/<id>` → the transcript.
 *
 * A resource is the read-only half of the endpoint. Where a tool does something
 * — starts a discussion, waits for it, stops it — a resource is a document the
 * caller can pull in without any of that happening, and WP-0b measured that
 * both clients fetch it, by two different routes:
 *
 * | Client | How the transcript reaches the model |
 * |---|---|
 * | Claude Code | `resources/list` on every session start; the user types `@witena:` and picks a chat, and the body is pasted into the conversation |
 * | Codex | Lazily, mid-turn, through its own `list_mcp_resources` / `read_mcp_resource` tools when the model asks for it |
 *
 * That is why the body is `transcript.ts`'s markdown and not a JSON blob: one
 * of those two routes puts it in front of a person as well as a model, and both
 * of them put it somewhere prose reads better than a structure. It is literally
 * the same document `get_discussion { detail: 'transcript' }` returns —
 * `renderChatTranscript` in `tools.ts` is shared rather than re-implemented, so
 * the `@`-mention and the tool can never disagree about what was said.
 *
 * **Reads only, through handlers only**, like every other module here: no
 * repository, no electron (CLAUDE.md rule 5), and nothing that could start a
 * run. Listing a chat costs one `chats.list`; reading one costs a `chats.get`
 * and the transcript.
 */
import { ErrorCode, McpError, type ListResourcesResult, type ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import { chatUrl, parseChatUrl } from '@shared/mcp-tools'
import type { AppContext } from '../app-context'
import { isBackendFailure } from '../errors'
import type { HandlerMap } from '../handlers/types'
import { loadTranscript } from './discussion'
import { renderChatTranscript } from './tools'

/**
 * How many chats `resources/list` offers.
 *
 * The list is an `@`-mention menu, not an archive: twenty of the most recently
 * active chats is more than a user scrolls and far less than a year of them.
 * There is no `nextCursor` — a caller that wants the older ones wants
 * `list_chats`, which takes a query and says which are still running.
 */
export const MAX_LISTED_CHAT_RESOURCES = 20

/** What the transcript is. Markdown, because a person may be reading it too. */
export const CHAT_RESOURCE_MIME = 'text/markdown'

/**
 * The specification's code for "the resource you named is not here", which this
 * SDK's `ErrorCode` enum does not carry a name for (it stops at the JSON-RPC
 * codes and the two MCP ones it uses itself). `McpError` takes a plain number,
 * so the code is written out with the reason beside it rather than flattened
 * into `InvalidParams` — a client that distinguishes them should be able to.
 */
const RESOURCE_NOT_FOUND = -32002

/**
 * The twenty most recently active chats, as resources.
 *
 * `chats.list` is already ordered by `updatedAt` descending, which is the order
 * a person wants: the discussion they had ten minutes ago is the one they are
 * about to mention.
 */
export async function listChatResources(
  ctx: AppContext,
  handlers: HandlerMap
): Promise<ListResourcesResult> {
  const chats = (await handlers['chats.list'](ctx)).slice(0, MAX_LISTED_CHAT_RESOURCES)

  return {
    resources: chats.map((chat) => ({
      uri: chatUrl(chat.id),
      // `name` is the programmatic handle and `title` the display one; both are
      // the chat's title, because that is the only name a chat has and a user
      // picking from a menu should see the words they typed.
      name: chat.title,
      title: chat.title,
      description: `Witena group discussion, last active ${new Date(chat.updatedAt).toISOString()}.`,
      mimeType: CHAT_RESOURCE_MIME
    }))
  }
}

/**
 * One chat's transcript.
 *
 * Two refusals, and they are different things:
 *
 * - A URI `parseChatUrl` rejects never named a chat at all — a different scheme,
 *   a path with an extra segment, an id that is not a uuid. That is the
 *   caller's parameter being wrong, so it is `InvalidParams`.
 * - A well-formed URI whose chat is not in the database is a resource that is
 *   not there, which is `-32002` and the message a model can act on.
 *
 * `chats.get` raises the second as a `BackendFailure` with code `not_found`;
 * anything else it raises is passed on as an internal error with its message
 * and no stack, exactly as the tools do.
 */
export async function readChatResource(
  ctx: AppContext,
  handlers: HandlerMap,
  uri: string
): Promise<ReadResourceResult> {
  const chatId = parseChatUrl(uri)
  if (chatId === null) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${uri} is not a Witena chat resource. Witena's resources are witena://chat/<uuid>; call resources/list to see them.`
    )
  }

  const chat = await withMcpErrors(uri, () => handlers['chats.get'](ctx, { id: chatId }))
  const messages = await withMcpErrors(uri, () => loadTranscript(ctx, handlers, chatId))

  return {
    contents: [
      {
        uri,
        mimeType: CHAT_RESOURCE_MIME,
        text: await renderChatTranscript(ctx, handlers, chat, messages)
      }
    ]
  }
}

/** A `BackendFailure` as the MCP error that says the same thing. */
async function withMcpErrors<T>(uri: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (cause) {
    if (isBackendFailure(cause) && cause.code === 'not_found') {
      throw new McpError(
        RESOURCE_NOT_FOUND,
        `There is no Witena chat at ${uri}. Call resources/list, or list_chats, to see the chats that exist.`
      )
    }
    throw new McpError(
      ErrorCode.InternalError,
      cause instanceof Error ? cause.message : String(cause)
    )
  }
}
