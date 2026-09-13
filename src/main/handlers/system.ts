/**
 * `system.*` — the transport's own probes.
 *
 * They carry no domain meaning: `system.ping` proves the request/response
 * direction works end to end and `system.emitTestEvent` proves the push
 * direction does. Both are exercised by the Playwright harness in `e2e/`.
 */
import { validation } from '../errors'
import type { HandlerModule } from './types'

export const systemHandlers: HandlerModule = {
  'system.ping': async () => 'pong',

  'system.emitTestEvent': async (ctx, input) => {
    // The renderer is untrusted input like any other client, so the payload is
    // checked here rather than assumed from the TypeScript signature.
    if (typeof input?.payload !== 'string') {
      throw validation('system.emitTestEvent requires a string payload')
    }
    ctx.events.emit({ type: 'system.test', payload: input.payload })
  }
}
