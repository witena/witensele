/**
 * The push channel, one step below the transport.
 *
 * Services (`ChatRunner`, `AgentTurn`, `AgentSupervisor`, the IPC handlers) emit
 * a `BackendEvent` here and never learn who listens. Electron's
 * `webContents.send` is attached by `src/main/ipc/register.ts`, which is the only
 * place allowed to import electron (CLAUDE.md rule #5); a future Node server
 * attaches a WebSocket fan-out to the same interface instead.
 *
 * The bus is deliberately minimal: no topics, no replay, no backpressure. The
 * event union is already discriminated on `type`, so filtering belongs to the
 * subscriber, and a renderer that missed events recovers by re-reading state
 * (see `docs/features/backend-client/implement.md`).
 */
import type { BackendEvent } from '@shared/events'

/** Receives every event emitted on the bus, in emission order. */
export type EventListener = (event: BackendEvent) => void

export interface EventBus {
  /** Delivers the event to every current listener. Never throws. */
  emit(event: BackendEvent): void
  /** Registers a listener and returns the function that removes it. */
  subscribe(listener: EventListener): () => void
}

/**
 * The in-process implementation used by the desktop build.
 *
 * A listener that throws is logged and skipped: one broken window must not stop
 * the event from reaching the others, and an emit inside a streaming loop must
 * never be able to abort the run.
 */
export function createEventBus(): EventBus {
  const listeners = new Set<EventListener>()

  return {
    emit(event) {
      // Snapshot: a listener may unsubscribe (or subscribe) during delivery.
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch (error) {
          console.error(`[witena] event listener failed for ${event.type}:`, error)
        }
      }
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
