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
 *   closed because the run was stopped. The renderer reads it as "this card is
 *   stale" and drops it; it never means the executor is stuck.
 */
import { isPermissionDecision } from '@shared/types'
import { validation } from '../errors'
import type { HandlerModule } from './types'

export const permissionHandlers: HandlerModule = {
  'permission.reply': async (ctx, input) => {
    const requestId = (input as { requestId?: unknown })?.requestId
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw validation('A permission request id is required')
    }
    const decision = (input as { decision?: unknown })?.decision
    if (!isPermissionDecision(decision)) {
      throw validation('A permission decision must be allow, deny or allowAlways')
    }
    // Throws `not_found` when nothing is waiting on this id.
    ctx.permissions.reply({ requestId, decision })
  }
}
