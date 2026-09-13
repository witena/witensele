/**
 * Typed events pushed from the backend to the renderer.
 *
 * One discriminated union instead of a channel per topic: the whole stream can be
 * forwarded over a single IPC channel today and a single WebSocket tomorrow, and
 * a new event type costs one union member rather than a new channel on three
 * layers. Every payload is JSON serializable, timestamps are epoch milliseconds.
 */
import type { AgentPresence, Chat, Message, MessagePart, PermissionDecision } from './types'

/**
 * One increment of a streaming message.
 *
 * - `text` / `reasoning`: **append** to the last part of that kind; if the last
 *   part is of a different kind, start a new one. The backend never resends text
 *   it has already sent.
 * - `part`: append a whole new part (a tool call, a tool result, a system
 *   notice) that has no incremental form.
 *
 * The authoritative message always arrives afterwards in `message.updated`, so a
 * renderer that drops deltas still converges on the correct content.
 */
export type MessageDelta =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'part'; part: MessagePart }

/** Why a run stopped: normally, by the Stop button, at the round cap, or on error. */
export type RunFinishReason = 'completed' | 'stopped' | 'max-rounds' | 'error'

/** A message has been persisted, usually empty with status `streaming`. */
export interface MessageCreatedEvent {
  type: 'message.created'
  message: Message
}

/** An increment of a streaming message; see `MessageDelta` for the append rules. */
export interface MessageDeltaEvent {
  type: 'message.delta'
  chatId: string
  messageId: string
  delta: MessageDelta
}

/** The message reached its final state: status, usage and error are authoritative. */
export interface MessageUpdatedEvent {
  type: 'message.updated'
  message: Message
}

export interface ChatUpdatedEvent {
  type: 'chat.updated'
  chat: Chat
}

export interface ChatDeletedEvent {
  type: 'chat.deleted'
  chatId: string
}

export interface PresenceChangedEvent {
  type: 'presence.changed'
  presence: AgentPresence
}

/** A run began with round 1 after a user message. */
export interface RunStartedEvent {
  type: 'run.started'
  chatId: string
  round: number
}

/** A round began; `speakers` are the agent ids that will speak in it, in order. */
export interface RunRoundEvent {
  type: 'run.round'
  chatId: string
  round: number
  speakers: string[]
}

/** The run ended and control is back with the user. */
export interface RunFinishedEvent {
  type: 'run.finished'
  chatId: string
  reason: RunFinishReason
}

/**
 * The executor is about to run something with side effects and is waiting.
 *
 * Emitted by the `PermissionGate` (S5.4) before `write_file`, `edit_file`,
 * `run_command` or any tool of an MCP server flagged `sideEffects`. The turn is
 * suspended inside the tool call until `permission.reply` arrives with this
 * `requestId`, or until the run is stopped. `input` is the tool's own arguments,
 * exactly as the model produced them, so the prompt can show the path or the
 * command line rather than "a tool wants to run".
 */
export interface PermissionRequestedEvent {
  type: 'permission.requested'
  requestId: string
  chatId: string
  agentId: string
  /**
   * The name the transcript shows: a built-in executor tool (`write_file`) or an
   * MCP tool's own name without the server prefix.
   */
  toolName: string
  input: unknown
}

/**
 * The prompt is over, however it ended.
 *
 * Always emitted exactly once per `permission.requested`, which is what lets the
 * renderer dismiss a card without knowing why it went away: `allow`, `deny` and
 * `allowAlways` are the user's own answers, and `aborted` is the run being
 * stopped (or the process shutting down) while the prompt was still open.
 */
export interface PermissionResolvedEvent {
  type: 'permission.resolved'
  requestId: string
  chatId: string
  decision: PermissionDecision | 'aborted'
}

/** Round-trip probe used by the S1.3 acceptance test; carries no domain meaning. */
export interface SystemTestEvent {
  type: 'system.test'
  payload: string
}

/** Everything the backend can push, discriminated on `type`. */
export type BackendEvent =
  | MessageCreatedEvent
  | MessageDeltaEvent
  | MessageUpdatedEvent
  | ChatUpdatedEvent
  | ChatDeletedEvent
  | PresenceChangedEvent
  | RunStartedEvent
  | RunRoundEvent
  | RunFinishedEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | SystemTestEvent

/** The `type` tag of any backend event. */
export type BackendEventType = BackendEvent['type']

/** Narrows the union to the single event with the given `type`. */
export type EventOf<T extends BackendEventType> = Extract<BackendEvent, { type: T }>
