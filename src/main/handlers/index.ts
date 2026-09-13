/**
 * The handler registry.
 *
 * `BACKEND_METHODS` declares the whole MVP surface from S1.1 onward, but the
 * methods land one step at a time. `buildHandlers()` therefore returns a **total**
 * map: every namespace module is merged in, and every name still missing an
 * implementation gets a stub that rejects with `internal`. The transport can then
 * look a method up without a presence check, and a renderer written against the
 * finished contract fails with an explicit message instead of a silent
 * `undefined is not a function`.
 */
import { BACKEND_METHODS, type BackendMethod } from '@shared/backend'
import { BackendFailure } from '../errors'
import { systemHandlers } from './system'
import { settingsHandlers } from './settings'
import { providerHandlers } from './providers'
import type { HandlerMap, HandlerModule } from './types'

/** Every namespace module, in merge order. Adding a namespace means adding a line here. */
const MODULES: HandlerModule[] = [systemHandlers, settingsHandlers, providerHandlers]

/** The rejection a declared-but-unimplemented method produces. */
export function notImplemented(method: BackendMethod): BackendFailure {
  return new BackendFailure('internal', `Not implemented yet: ${method} (see docs/STEPS.md)`)
}

export function buildHandlers(): HandlerMap {
  const implemented: HandlerModule = Object.assign({}, ...MODULES) as HandlerModule
  const map: Partial<Record<BackendMethod, unknown>> = {}

  for (const method of BACKEND_METHODS) {
    map[method] = implemented[method] ?? (() => Promise.reject(notImplemented(method)))
  }

  // The loop covers every entry of BACKEND_METHODS, which the shared contract
  // proves equal to `keyof BackendApi` at compile time, so the map is total.
  return map as HandlerMap
}

export type { HandlerMap, HandlerModule } from './types'
