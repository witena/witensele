/**
 * The permission gate: the thing that stands between a model's decision and the
 * user's files.
 *
 * PLAN.md, "Future extension", point 2: the executor confirms *before every
 * write or command*, with "always allow in this chat" as the escape hatch. That
 * sentence is this module. `ask()` suspends the tool call, emits
 * `permission.requested`, and returns only when the user has answered through
 * `permission.reply` or the run has been stopped.
 *
 * ## Why a promise per request rather than a queue the turn polls
 *
 * A tool call is already an `await` inside `streamText`'s loop, so suspending it
 * costs nothing and needs no state machine: the turn is simply not finished
 * until the tool is. Several agents may be waiting at once in a parallel round —
 * every pending request is its own entry in the map, keyed by `requestId`, and
 * the renderer draws one card each.
 *
 * ## What it never does
 *
 * - **No persistence.** `allowAlways` lives in a `Set` for the life of the
 *   process. A remembered grant that survived a restart would be a permission
 *   the user cannot see and cannot remember giving.
 * - **No timeout of its own.** A prompt waits as long as the user does. The
 *   turn's own hard timeout (`presence/supervisor.ts`) is what eventually ends a
 *   turn nobody answered, and it arrives here as an abort like any other.
 * - **No electron and no storage.** It is handed an `emit` function and an id
 *   generator, which is what lets every case below be tested against an array
 *   (CLAUDE.md rule #5).
 */
import { randomUUID } from 'node:crypto'
import type { BackendEvent } from '@shared/events'
import type { PermissionDecision } from '@shared/types'
import { notFound } from '../errors'

/** Everything the gate needs to describe one prompt to the user. */
export interface PermissionRequest {
  chatId: string
  agentId: string
  /** The tool's own name, as the transcript shows it. */
  toolName: string
  /** The tool arguments, as the model produced them. */
  input: unknown
  /** The turn's signal. Aborting it closes the prompt as `aborted`. */
  signal: AbortSignal
}

/**
 * How one prompt ended, in the shape the tool layer reads.
 *
 * Deliberately a value rather than a rejection: "the user said no" is a normal
 * outcome of asking, and every caller has to turn it into a tool error the model
 * can read anyway. A rejection would make the two failures — the user declining
 * and the gate itself breaking — indistinguishable at the call site.
 */
export type PermissionOutcome =
  | {
      allowed: true
      /** True when the answer came from a remembered `allowAlways` grant. */
      remembered: boolean
    }
  | { allowed: false; reason: 'denied' | 'aborted' }

export interface PermissionGate {
  /**
   * Asks the user, and resolves when they answer or the run is stopped.
   *
   * Returns immediately when this chat + tool pair has already been granted
   * `allowAlways`, without emitting anything: a card that appeared and vanished
   * in the same frame is worse than no card.
   */
  ask(request: PermissionRequest): Promise<PermissionOutcome>
  /**
   * Answers a pending prompt. Throws `not_found` for a `requestId` that is not
   * waiting — answered already, or closed by a stop.
   */
  reply(input: { requestId: string; decision: PermissionDecision }): void
  /** Request ids currently waiting for an answer. For tests and diagnostics. */
  pending(): string[]
  /** Closes every pending prompt as `aborted`. Called when the context shuts down. */
  abortAll(): void
}

export interface PermissionGateOptions {
  /** Where `permission.requested` / `permission.resolved` go. */
  emit: (event: BackendEvent) => void
  /** Injectable so a test can assert on readable ids. Defaults to `randomUUID`. */
  newRequestId?: () => string
}

/** The key an `allowAlways` grant is remembered under: one chat, one tool. */
function grantKey(chatId: string, toolName: string): string {
  return `${chatId}\u0000${toolName}`
}

/** One prompt the user has not answered yet. */
interface PendingPrompt {
  chatId: string
  toolName: string
  /** Settles the waiting `ask`, emits `permission.resolved`, and cleans up. Idempotent. */
  finish(outcome: PermissionOutcome, decision: PermissionDecision | 'aborted'): void
}

export function createPermissionGate(options: PermissionGateOptions): PermissionGate {
  const newRequestId = options.newRequestId ?? (() => randomUUID())

  /** requestId → the prompt waiting on it. */
  const pending = new Map<string, PendingPrompt>()

  /** `chatId\0toolName` pairs the user answered with `allowAlways`. */
  const always = new Set<string>()

  return {
    async ask(request) {
      const key = grantKey(request.chatId, request.toolName)
      if (always.has(key)) return { allowed: true, remembered: true }

      // Stopped before we could even ask. Answering here rather than emitting and
      // immediately resolving keeps the renderer from ever seeing a card that was
      // dead before it was drawn.
      if (request.signal.aborted) return { allowed: false, reason: 'aborted' }

      const requestId = newRequestId()

      return await new Promise<PermissionOutcome>((resolve) => {
        let settled = false

        const finish = (
          outcome: PermissionOutcome,
          decision: PermissionDecision | 'aborted'
        ): void => {
          if (settled) return
          settled = true
          pending.delete(requestId)
          request.signal.removeEventListener('abort', onAbort)
          // Always emitted, exactly once per `permission.requested`, so the
          // renderer can dismiss a card without knowing why it went away.
          options.emit({
            type: 'permission.resolved',
            requestId,
            chatId: request.chatId,
            decision
          })
          resolve(outcome)
        }

        function onAbort(): void {
          finish({ allowed: false, reason: 'aborted' }, 'aborted')
        }

        pending.set(requestId, { chatId: request.chatId, toolName: request.toolName, finish })
        request.signal.addEventListener('abort', onAbort, { once: true })

        options.emit({
          type: 'permission.requested',
          requestId,
          chatId: request.chatId,
          agentId: request.agentId,
          toolName: request.toolName,
          input: request.input
        })
      })
    },

    reply({ requestId, decision }) {
      const prompt = pending.get(requestId)
      // A card answered twice, or one a stop already closed. `not_found` is the
      // renderer's cue that it is holding something stale, and the same answer
      // for both cases means a reply cannot probe for live request ids.
      if (!prompt) throw notFound('Permission request', requestId)

      if (decision === 'deny') {
        prompt.finish({ allowed: false, reason: 'denied' }, 'deny')
        return
      }
      if (decision === 'allowAlways') {
        // Recorded before the waiting call is released, so a second call of the
        // same tool that starts the moment this one resumes already sees it.
        always.add(grantKey(prompt.chatId, prompt.toolName))
        prompt.finish({ allowed: true, remembered: true }, 'allowAlways')
        return
      }
      prompt.finish({ allowed: true, remembered: false }, 'allow')
    },

    pending() {
      return [...pending.keys()]
    },

    abortAll() {
      // Snapshot: `finish` deletes from the map it is iterating.
      for (const prompt of [...pending.values()]) {
        prompt.finish({ allowed: false, reason: 'aborted' }, 'aborted')
      }
    }
  }
}
