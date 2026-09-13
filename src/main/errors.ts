/**
 * The main process's error type.
 *
 * Everything the backend throws must be expressible as a `BackendError`
 * (`src/shared/types.ts`): the IPC layer serializes it and the renderer switches
 * on `code` to pick an i18n key. An `Error` subclass does not survive the
 * transport with its prototype intact, so `toBackendError()` produces the plain
 * object that actually crosses the boundary.
 *
 * This file imports nothing but shared types — it is used by services that must
 * stay free of electron (CLAUDE.md rule #5).
 */
import type { BackendError, BackendErrorCode } from '@shared/types'

/** An `Error` that also satisfies the serializable `BackendError` contract. */
export class BackendFailure extends Error implements BackendError {
  readonly code: BackendErrorCode
  readonly details?: unknown

  constructor(code: BackendErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'BackendFailure'
    this.code = code
    if (details !== undefined) this.details = details
  }

  /** The plain object form, safe to send over IPC or HTTP. */
  toBackendError(): BackendError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {})
    }
  }
}

/** Narrows an unknown thrown value to a `BackendFailure`. */
export function isBackendFailure(value: unknown): value is BackendFailure {
  return value instanceof BackendFailure
}

/**
 * A row that does not exist, or exists but belongs to another user — the two are
 * deliberately indistinguishable so a wrong `userId` cannot probe for ids.
 */
export function notFound(entity: string, id: string): BackendFailure {
  return new BackendFailure('not_found', `${entity} not found: ${id}`)
}

/** Input the backend refuses before it reaches storage. */
export function validation(message: string, details?: unknown): BackendFailure {
  return new BackendFailure('validation', message, details)
}
