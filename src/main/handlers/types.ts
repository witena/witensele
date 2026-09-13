/**
 * The shape every backend handler has.
 *
 * A handler is the implementation of one `BackendApi` method with the
 * application context threaded in front of the method's own arguments:
 *
 * ```ts
 * 'settings.update': (ctx, { patch }) => Promise<AppSettings>
 * ```
 *
 * Deriving the map from `BackendApi` means the compiler — not a review — checks
 * that a handler takes the declared input and returns the declared result. The
 * transport (`src/main/ipc/register.ts`) only knows this type, so the same
 * handlers serve Electron IPC today and an HTTP route table later.
 */
import type { BackendApi, BackendMethod } from '@shared/backend'
import type { AppContext } from '../app-context'

/** Every method name mapped to its `(ctx, ...args)` implementation. */
export type HandlerMap = {
  [M in BackendMethod]: (
    ctx: AppContext,
    ...args: Parameters<BackendApi[M]>
  ) => ReturnType<BackendApi[M]>
}

/**
 * One namespace's contribution to the map.
 *
 * Namespace files export this rather than the full map so a method can land with
 * its own step; `buildHandlers()` fills every gap with a rejecting stub.
 */
export type HandlerModule = Partial<HandlerMap>
