/**
 * The agent library, read-only for now.
 *
 * S1.7 needs it to *render*: a message prints its author's name, avatar and model
 * badge, and the member panel prints the same three fields. Nothing creates or
 * edits an agent yet — `agents.create` / `update` / `delete` are still stubbed in
 * the backend — so this store has `load()` and nothing else. **S2.1 adds the
 * CRUD actions here**, alongside the configuration page.
 */
import { create } from 'zustand'
import type { Agent, BackendErrorCode } from '@shared/types'
import { BackendClientError } from '../lib/backend'
import { getBackend } from '../lib/backend-provider'

export type AgentsStatus = 'idle' | 'loading' | 'ready' | 'error'

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function classify(cause: unknown): BackendErrorCode {
  return cause instanceof BackendClientError ? cause.code : 'internal'
}

export interface AgentsState {
  /** Backend-owned mirror of the `agents` table, oldest first. */
  agents: Agent[]
  status: AgentsStatus
  error?: string | undefined
  errorCode?: BackendErrorCode | undefined
  /** Reads the list. Never rejects: failures land in `status` / `error`. */
  load: () => Promise<void>
}

export const useAgentsStore = create<AgentsState>()((set) => ({
  agents: [],
  status: 'idle',
  error: undefined,
  errorCode: undefined,

  async load() {
    set({ status: 'loading', error: undefined, errorCode: undefined })
    try {
      const agents = await getBackend().invoke('agents.list')
      set({ agents, status: 'ready', error: undefined, errorCode: undefined })
    } catch (cause) {
      set({ status: 'error', error: describe(cause), errorCode: classify(cause) })
    }
  }
}))

/** One agent by id, or `undefined` when it has been deleted or not loaded yet. */
export function useAgent(agentId: string | undefined): Agent | undefined {
  return useAgentsStore((state) =>
    agentId ? state.agents.find((agent) => agent.id === agentId) : undefined
  )
}
