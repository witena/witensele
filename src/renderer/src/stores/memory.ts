/**
 * One agent's memory, as the agent editor's panel edits it.
 *
 * Scoped to a single agent at a time (`agentId`), because that is how the panel
 * is used: it opens with the agent, loads its index and entries, and is thrown
 * away when another agent is selected. Keeping a cache per agent would buy
 * nothing — the files change underneath the app whenever a turn calls
 * `memory_save`, so what is on screen has to be re-read on open anyway.
 *
 * ## Why there is a draft here, unlike `stores/skills.ts`
 *
 * These files *are* edited in the app: the index and each note open in a
 * textarea with a Save button. So the panel owns `draft` plus `dirty`, the same
 * shape the agent and MCP editors use, and only `save` touches the backend. The
 * alternative — writing on every keystroke — would race a running turn that is
 * appending to the same index.
 */
import { create } from 'zustand'
import type { BackendErrorCode, MemoryEntry } from '@shared/types'
import { BackendClientError } from '../lib/backend'
import { getBackend } from '../lib/backend-provider'

export type MemoryStatus = 'idle' | 'loading' | 'ready' | 'error'

/** The index file, which is always openable even before the first note exists. */
export const MEMORY_INDEX_PATH = 'MEMORY.md'

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function classify(cause: unknown): BackendErrorCode {
  return cause instanceof BackendClientError ? cause.code : 'internal'
}

export interface MemoryState {
  /** The agent whose memory is loaded, or `null` before the first load. */
  agentId: string | null
  /** Backend-owned mirror of the index's entries, in index order. */
  entries: MemoryEntry[]
  status: MemoryStatus
  error?: string | undefined
  errorCode?: BackendErrorCode | undefined
  /** Path of the file open in the editor, or `null` when none is. */
  openPath: string | null
  /** The editor's working copy of that file. */
  draft: string
  /** What was last read or written, so `dirty` is a comparison rather than a flag. */
  saved: string
  saving: boolean

  /** Loads one agent's entries. Never rejects. Resets the open file. */
  load: (agentId: string) => Promise<void>
  /** Opens one file in the editor. Never rejects. */
  open: (path: string) => Promise<void>
  closeFile: () => void
  setDraft: (draft: string) => void
  /** Writes the open file and reloads the entry list. Never rejects. */
  save: () => Promise<void>
  /** Deletes one note, or empties the index. Never rejects. */
  remove: (path: string) => Promise<void>
  /** Drops everything, for when the editor moves to another agent. */
  reset: () => void
}

/** True when the open file differs from what is stored. */
export function isDirty(state: Pick<MemoryState, 'openPath' | 'draft' | 'saved'>): boolean {
  return state.openPath !== null && state.draft !== state.saved
}

export const useMemoryStore = create<MemoryState>()((set, get) => ({
  agentId: null,
  entries: [],
  status: 'idle',
  error: undefined,
  errorCode: undefined,
  openPath: null,
  draft: '',
  saved: '',
  saving: false,

  async load(agentId) {
    set({
      agentId,
      status: 'loading',
      error: undefined,
      errorCode: undefined,
      openPath: null,
      draft: '',
      saved: ''
    })
    try {
      const entries = await getBackend().invoke('memory.list', { agentId })
      // Another agent may have been selected while this was in flight.
      if (get().agentId !== agentId) return
      set({ entries, status: 'ready' })
    } catch (cause) {
      if (get().agentId !== agentId) return
      set({ status: 'error', error: describe(cause), errorCode: classify(cause) })
    }
  },

  async open(path) {
    const agentId = get().agentId
    if (!agentId) return
    set({ openPath: path, draft: '', saved: '', error: undefined, errorCode: undefined })
    try {
      const { content } = await getBackend().invoke('memory.read', { agentId, path })
      if (get().openPath !== path) return
      set({ draft: content, saved: content })
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
    }
  },

  closeFile() {
    set({ openPath: null, draft: '', saved: '' })
  },

  setDraft(draft) {
    set({ draft })
  },

  async save() {
    const { agentId, openPath, draft } = get()
    if (!agentId || !openPath) return
    set({ saving: true, error: undefined, errorCode: undefined })
    try {
      await getBackend().invoke('memory.write', { agentId, path: openPath, content: draft })
      set({ saved: draft })
      // The title and the hook of an entry live in the files that were just
      // rewritten, so the list is read again rather than patched.
      const entries = await getBackend().invoke('memory.list', { agentId })
      set({ entries })
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
    } finally {
      set({ saving: false })
    }
  },

  async remove(path) {
    const agentId = get().agentId
    if (!agentId) return
    try {
      await getBackend().invoke('memory.delete', { agentId, path })
      const entries = await getBackend().invoke('memory.list', { agentId })
      set((state) => ({
        entries,
        ...(state.openPath === path ? { openPath: null, draft: '', saved: '' } : {}),
        error: undefined,
        errorCode: undefined
      }))
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
    }
  },

  reset() {
    set({
      agentId: null,
      entries: [],
      status: 'idle',
      error: undefined,
      errorCode: undefined,
      openPath: null,
      draft: '',
      saved: '',
      saving: false
    })
  }
}))
