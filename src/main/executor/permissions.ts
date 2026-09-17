/**
 * The permission gate: the thing that stands between a model's decision and the
 * user's files.
 *
 * PLAN.md, "Future extension", point 2: the executor confirms *before every
 * write or command*, with "always allow in this chat" as the escape hatch. That
 * sentence is this module. `ask()` suspends the tool call, emits
 * `permission.requested`, and returns only when the user has answered through
 * `permission.reply`, the run has been stopped, or the prompt has timed out.
 *
 * ## Why a promise per request rather than a queue the turn polls
 *
 * A tool call is already an `await` inside `streamText`'s loop, so suspending it
 * costs nothing and needs no state machine: the turn is simply not finished
 * until the tool is. Several agents may be waiting at once in a parallel round —
 * every pending request is its own entry in the map, keyed by `requestId`, and
 * the renderer draws one card each.
 *
 * ## The three things S5.15 changed
 *
 * - **Grants are persisted and revocable.** S5.4 kept `allowAlways` in a `Set`
 *   for the life of the process, on the grounds that a grant surviving a restart
 *   is a permission the user cannot see and cannot remember giving. The grounds
 *   were right; the conclusion was half of the fix. The grants now live in
 *   `permission_grants` behind an injected `GrantStore`, and the chat's Group
 *   settings list them with a revoke button — so they are visible, which is what
 *   actually mattered, and quitting the app is no longer the only way back.
 * - **A `dangerous` command ignores every grant.** `request.risk` comes from
 *   `command-policy.ts`. A grant given for `run_command` was a decision about
 *   running commands, not about `git push`, and a gate that treated the two the
 *   same would make "Always allow" the most dangerous button in the product.
 * - **A prompt times out.** `timeoutMs` (`AppTimeouts.permissionTimeoutMs`)
 *   denies a prompt nobody answered and resolves it with `'timeout'`, which is
 *   a different fact from `'denied'`: one of them means the user looked at the
 *   call and said no. Before this the only end was the turn's own hard timeout,
 *   which recorded the turn as `skipped` — true, and not the reason.
 *
 * ## What it still never does
 *
 * **No electron and no storage of its own.** It is handed an `emit`, a grant
 * store, a clock's worth of timeout and an id generator, which is what lets
 * every case below be tested against an array (CLAUDE.md rule #5).
 */
import { randomUUID } from 'node:crypto'
import type { BackendEvent } from '@shared/events'
import type { CommandRisk, PermissionDecision } from '@shared/types'
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
  /**
   * The command policy's verdict, for `run_command` only (S5.15).
   *
   * `dangerous` is the one value that changes what the gate *does*: it asks even
   * when a grant would have answered, and it refuses to record a new grant. The
   * card reads the same value off the event to draw its warning.
   */
  risk?: CommandRisk
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
  | { allowed: false; reason: 'denied' | 'aborted' | 'timeout' }

/**
 * Where `allowAlways` is remembered.
 *
 * An interface rather than the repository itself, for the reason every seam in
 * `src/main/` outside `ipc/` exists: the gate must not know what a database is,
 * and a test wants three lines of `Map` rather than a migrated file.
 */
export interface GrantStore {
  has(chatId: string, toolName: string): boolean
  grant(chatId: string, toolName: string): void
}

export interface PermissionGate {
  /**
   * Asks the user, and resolves when they answer, the run is stopped, or the
   * prompt times out.
   *
   * Returns immediately when this chat + tool pair has been granted
   * `allowAlways` *and* the call is not `dangerous`, without emitting anything:
   * a card that appeared and vanished in the same frame is worse than no card.
   */
  ask(request: PermissionRequest): Promise<PermissionOutcome>
  /**
   * Answers a pending prompt. Throws `not_found` for a `requestId` that is not
   * waiting — answered already, or closed by a stop or a timeout.
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
  /**
   * The persisted grants. Omitted, the gate keeps them in memory for its own
   * lifetime — which is what a unit test that does not care about persistence
   * wants, and what S5.4 did for everybody.
   */
  grants?: GrantStore
  /**
   * How long a prompt waits before denying itself, in milliseconds.
   *
   * A function rather than a number: the setting can change while the app is
   * running, and a gate built at startup would otherwise hold the value the
   * database had then. `0` or a non-finite value disables the timeout, which is
   * what most unit tests want.
   */
  timeoutMs?: () => number
  /** Injectable so a test can assert on readable ids. Defaults to `randomUUID`. */
  newRequestId?: () => string
}

/** A `GrantStore` that forgets everything when the process ends. */
export function createMemoryGrantStore(): GrantStore {
  const granted = new Set<string>()
  const key = (chatId: string, toolName: string): string => `${chatId}\u0000${toolName}`
  return {
    has: (chatId, toolName) => granted.has(key(chatId, toolName)),
    grant: (chatId, toolName) => void granted.add(key(chatId, toolName))
  }
}

/** One prompt the user has not answered yet. */
interface PendingPrompt {
  chatId: string
  toolName: string
  /**
   * True when the policy called this call `dangerous`.
   *
   * An `allowAlways` on such a prompt allows the call and records **nothing**.
   * The card does not offer the button, so this only catches an older renderer
   * or a direct API caller — but a grant written from a prompt that exists
   * because grants are ignored would be a grant that can never be used, sitting
   * in the user's settings list claiming otherwise.
   */
  dangerous: boolean
  /** Settles the waiting `ask`, emits `permission.resolved`, and cleans up. Idempotent. */
  finish(outcome: PermissionOutcome, decision: PermissionDecision | 'aborted' | 'timeout'): void
}

export function createPermissionGate(options: PermissionGateOptions): PermissionGate {
  const newRequestId = options.newRequestId ?? (() => randomUUID())
  const grants = options.grants ?? createMemoryGrantStore()

  /** requestId → the prompt waiting on it. */
  const pending = new Map<string, PendingPrompt>()

  return {
    async ask(request) {
      // A `dangerous` command is asked about every time, whatever has been
      // granted: the grant was a decision about the tool, and this call is not
      // the kind of call it was a decision about.
      const dangerous = request.risk?.verdict === 'dangerous'
      if (!dangerous && grants.has(request.chatId, request.toolName)) {
        return { allowed: true, remembered: true }
      }

      // Stopped before we could even ask. Answering here rather than emitting and
      // immediately resolving keeps the renderer from ever seeing a card that was
      // dead before it was drawn.
      if (request.signal.aborted) return { allowed: false, reason: 'aborted' }

      const requestId = newRequestId()

      return await new Promise<PermissionOutcome>((resolve) => {
        let settled = false
        let timer: NodeJS.Timeout | undefined

        const finish = (
          outcome: PermissionOutcome,
          decision: PermissionDecision | 'aborted' | 'timeout'
        ): void => {
          if (settled) return
          settled = true
          pending.delete(requestId)
          if (timer) clearTimeout(timer)
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

        pending.set(requestId, {
          chatId: request.chatId,
          toolName: request.toolName,
          dangerous,
          finish
        })
        request.signal.addEventListener('abort', onAbort, { once: true })

        const budget = options.timeoutMs?.() ?? 0
        if (Number.isFinite(budget) && budget > 0) {
          timer = setTimeout(() => {
            finish({ allowed: false, reason: 'timeout' }, 'timeout')
          }, budget)
          // So a pending prompt cannot keep vitest — or the app's own event loop
          // during a quit — alive on its own.
          timer.unref?.()
        }

        options.emit({
          type: 'permission.requested',
          requestId,
          chatId: request.chatId,
          agentId: request.agentId,
          toolName: request.toolName,
          input: request.input,
          // Spread rather than assigned: `exactOptionalPropertyTypes` wants the
          // field absent for every tool that has no verdict, not present and
          // undefined.
          ...(request.risk ? { risk: request.risk } : {})
        })
      })
    },

    reply({ requestId, decision }) {
      const prompt = pending.get(requestId)
      // A card answered twice, or one a stop or a timeout already closed.
      // `not_found` is the renderer's cue that it is holding something stale, and
      // the same answer for both cases means a reply cannot probe for live
      // request ids.
      if (!prompt) throw notFound('Permission request', requestId)

      if (decision === 'deny') {
        prompt.finish({ allowed: false, reason: 'denied' }, 'deny')
        return
      }
      if (decision === 'allowAlways') {
        // Recorded before the waiting call is released, so a second call of the
        // same tool that starts the moment this one resumes already sees it —
        // unless the prompt was `dangerous`, in which case there is nothing a
        // grant could ever answer.
        if (!prompt.dangerous) grants.grant(prompt.chatId, prompt.toolName)
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
