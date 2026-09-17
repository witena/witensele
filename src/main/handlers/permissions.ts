/**
 * `permission.reply` — the user's answer to one executor permission prompt.
 *
 * The thinnest handler in the process, and deliberately so: everything that
 * happens next is inside the suspended tool call, and this only has to validate
 * two strings and hand them to the gate on the context
 * (`src/main/executor/permissions.ts`).
 *
 * Two failure modes are worth knowing about:
 *
 * - **`validation`** for a missing `requestId` or a `decision` that is not one
 *   of the three. A newer renderer sending a fourth decision must be refused
 *   rather than treated as `deny`, because silently denying a call the user
 *   allowed is the worse of the two wrong answers.
 * - **`not_found`** for a `requestId` that is not waiting — already answered, or
 *   closed because the run was stopped or the prompt timed out. The renderer
 *   reads it as "this card is stale" and drops it; it never means the executor
 *   is stuck.
 *
 * ## The grants (S5.15)
 *
 * `permissions.grants.list` and `permissions.grants.revoke` are the other half
 * of making "always allow in this chat" a thing the user can see. Both are as
 * thin as the reply: the repository is the whole implementation, and the two
 * decisions worth writing down are that **neither validates that the chat
 * exists** — a question about grants must not double as a way to probe for chat
 * ids, and a chat that was deleted has no grants either way — and that revoke
 * **returns the remaining list** rather than `void`, so the settings row cannot
 * be drawn from what the renderer hoped happened.
 */
import { isPermissionDecision } from '@shared/types'
import { validation } from '../errors'
import type { HandlerModule } from './types'

/** A required non-empty string from an unvalidated IPC payload. */
function requireField(input: unknown, field: string, message: string): string {
  const value = (input as Record<string, unknown> | null)?.[field]
  if (typeof value !== 'string' || value.length === 0) throw validation(message)
  return value
}

export const permissionHandlers: HandlerModule = {
  'permission.reply': async (ctx, input) => {
    const requestId = requireField(input, 'requestId', 'A permission request id is required')
    const decision = (input as { decision?: unknown })?.decision
    if (!isPermissionDecision(decision)) {
      throw validation('A permission decision must be allow, deny or allowAlways')
    }
    // Throws `not_found` when nothing is waiting on this id.
    ctx.permissions.reply({ requestId, decision })
  },

  'permissions.grants.list': async (ctx, input) => {
    const chatId = requireField(input, 'chatId', 'A chat id is required')
    return ctx.repos.permissionGrants.list(chatId)
  },

  'permissions.grants.revoke': async (ctx, input) => {
    const chatId = requireField(input, 'chatId', 'A chat id is required')
    const toolName = requireField(input, 'toolName', 'A tool name is required')
    // Idempotent: revoking what is not there succeeds, because the only thing
    // the user asked for is that the grant not be there afterwards.
    ctx.repos.permissionGrants.revoke(chatId, toolName)
    return ctx.repos.permissionGrants.list(chatId)
  }
}
