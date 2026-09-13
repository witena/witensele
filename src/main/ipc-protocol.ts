/**
 * The wire format shared by the main process and the preload bridge.
 *
 * It lives outside `src/main/ipc/` because preload imports it too and neither
 * side may guess at the other's constants. It imports no electron, so the same
 * envelope can be reused by an HTTP transport.
 *
 * Two channels, not one per method: `BACKEND_METHODS` is data, the method name
 * travels as the first argument, and a new method costs nothing at this layer.
 */
import type { BackendError } from '@shared/types'
import { isBackendFailure } from './errors'

/** Request/response channel; arguments are `(method, input)`. */
export const IPC_INVOKE = 'witena:invoke'

/** Push channel; the payload is one `BackendEvent`. */
export const IPC_EVENT = 'witena:event'

/**
 * Every `invoke` resolves with this envelope, including failures.
 *
 * Electron rejects an `ipcMain.handle` promise by flattening the thrown value to
 * its message string: the `code` and `details` of a `BackendError` would be lost
 * and the renderer could not switch on them. So the handler never rejects — it
 * resolves with `ok: false` and the renderer's client throws the real error again
 * on its own side.
 */
export type InvokeResponse = { ok: true; value: unknown } | { ok: false; error: BackendError }

/**
 * Normalizes anything thrown by a handler into the serializable error shape.
 *
 * A `BackendFailure` keeps its `code` and `details`; everything else — a bug, a
 * driver error, a rejected string — becomes `internal`, because a code the
 * renderer switches on must be chosen deliberately, never inferred.
 */
export function toBackendError(err: unknown): BackendError {
  if (isBackendFailure(err)) return err.toBackendError()
  if (err instanceof Error) return { code: 'internal', message: err.message }
  return { code: 'internal', message: String(err) }
}
