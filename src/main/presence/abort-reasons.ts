/**
 * Why an `AbortController` was aborted, as a value rather than a guess.
 *
 * A turn can be interrupted for two entirely different reasons, and they must end
 * in two different message statuses:
 *
 * | Reason | Status | Stored `error` |
 * |---|---|---|
 * | The user pressed Stop | `error` | `'aborted'` |
 * | The supervisor hit the hard timeout | `skipped` | `'timeout'` |
 *
 * `AbortSignal.reason` is the only channel that survives from the aborter to the
 * `catch` block inside `runAgentTurn`, because the AI SDK re-throws whatever the
 * signal carries. Distinguishing them by message text would break the moment a
 * provider wraps the error; a nominal class plus a type guard cannot.
 *
 * The guard also accepts a *shape* match, not only `instanceof`: a reason can
 * cross a module boundary that was loaded twice (vitest, the bundler splitting
 * main into chunks), and a status that silently became `error` would be a bug
 * nobody could see in the UI.
 */

/** The marker `isTimeoutAbort` recognises, independent of the class identity. */
export const TIMEOUT_ABORT_NAME = 'TimeoutAbortReason'

/** Detail stored in `Message.error` when the hard timeout skipped the turn. */
export const TIMEOUT_ERROR = 'timeout'

/**
 * Passed to `controller.abort()` by `AgentSupervisor` when an agent produced no
 * activity for longer than `hardTimeoutMs`.
 */
export class TimeoutAbortReason extends Error {
  /** The agent that stopped answering, for logs. */
  readonly agentId: string
  /** The budget that was exceeded, in milliseconds. */
  readonly hardTimeoutMs: number
  /** How long the turn had been silent when it was aborted, in milliseconds. */
  readonly idleMs: number

  constructor(details: { agentId: string; hardTimeoutMs: number; idleMs: number }) {
    super(
      `Agent ${details.agentId} produced no activity for ${details.idleMs} ms ` +
        `(hard timeout ${details.hardTimeoutMs} ms)`
    )
    this.name = TIMEOUT_ABORT_NAME
    this.agentId = details.agentId
    this.hardTimeoutMs = details.hardTimeoutMs
    this.idleMs = details.idleMs
  }
}

/** True when an abort reason is the supervisor's hard timeout. */
export function isTimeoutAbort(reason: unknown): reason is TimeoutAbortReason {
  if (reason instanceof TimeoutAbortReason) return true
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as { name?: unknown }).name === TIMEOUT_ABORT_NAME
  )
}
