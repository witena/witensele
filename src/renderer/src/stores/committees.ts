/**
 * The committee library: the list, and the editor's draft.
 *
 * Shaped like `stores/agents.ts`, because the page is shaped like the Agents
 * page and for the same underlying reason — a committee is not saveable field by
 * field. A half-typed name must not reach a record, and the member list is part
 * of the entity (`committees.update` replaces it wholesale, see
 * `docs/features/committees/backend.md`), so the editor works on a
 * `CommitteeInput` copy and only `save` touches the backend.
 *
 * ## Why validation lives here as well as in the handler
 *
 * `committees.create` / `committees.update` refuse a blank name and a name past
 * `MAX_COMMITTEE_NAME_CHARS`; the backend is the authority. The same two rules
 * are computed here so Save can be *disabled* with the reason under the field,
 * rather than the user pressing a button and getting a red line. `validateDraft`
 * is pure and exported so the two stay comparable in a test.
 *
 * The rules this store deliberately does **not** duplicate are the ones it
 * cannot know as well as the backend: an id that names no agent, and the second
 * executor. The picker greys an executor out when one is already in (the same
 * explanation the member panel gives), and if a refusal arrives anyway it is
 * kept as `errorCode` plus `errorDetails` and translated through
 * `translateFailure`, which reads the `second_executor` reason out of the
 * details. No backend sentence is ever shown.
 *
 * ## Why there is no `committee.*` event
 *
 * Committees are edited on one screen by one user, so the store applies its own
 * writes and re-reads nothing. The one committee change the rest of the app can
 * observe is a *chat* losing its provenance when a committee is deleted, and the
 * backend emits `chat.updated` for that — which the chats store already mirrors.
 */
import { create } from 'zustand'
import type { BackendErrorCode, Committee, CommitteeInput } from '@shared/types'
import { MAX_COMMITTEE_NAME_CHARS } from '@shared/types'
import { BackendClientError } from '../lib/backend'
import { getBackend } from '../lib/backend-provider'
import { reorder } from '../lib/reorder'

export type CommitteesStatus = 'idle' | 'loading' | 'ready' | 'error'

/** `idle` shows the "pick or create one" placeholder; the other two show the form. */
export type CommitteeEditorMode = 'idle' | 'create' | 'edit'

/** Why the name is invalid. The editor maps each code to a `committees.validation.*` key. */
export interface CommitteeDraftErrors {
  name?: 'required' | 'tooLong'
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function classify(cause: unknown): BackendErrorCode {
  return cause instanceof BackendClientError ? cause.code : 'internal'
}

/**
 * The failing handler's own `details`, when the rejection carried any.
 *
 * Kept beside the code for the reason `stores/chats.ts` keeps it: a `validation`
 * refusal may name which rule it broke, and "this committee already has an
 * executor" is a far better line than "the request was rejected as invalid".
 */
function detailsOf(cause: unknown): unknown {
  return cause instanceof BackendClientError ? cause.details : undefined
}

/** What a fresh "New committee" form starts from. */
export function emptyCommitteeDraft(): CommitteeInput {
  return { name: '', description: '', memberAgentIds: [] }
}

/** The editor copy of a stored committee. */
export function draftFromCommittee(committee: Committee): CommitteeInput {
  return {
    name: committee.name,
    description: committee.description,
    memberAgentIds: [...committee.memberAgentIds]
  }
}

/** Every reason the draft cannot be saved, keyed by field. */
export function validateDraft(draft: CommitteeInput): CommitteeDraftErrors {
  const name = draft.name.trim()
  if (name.length === 0) return { name: 'required' }
  // Measured on the trimmed name, which is what the handler stores.
  if (name.length > MAX_COMMITTEE_NAME_CHARS) return { name: 'tooLong' }
  return {}
}

/** True when nothing is wrong with the draft. */
export function isDraftValid(errors: CommitteeDraftErrors): boolean {
  return Object.keys(errors).length === 0
}

/** Element-by-element array comparison, order included. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}

function sameDraft(a: CommitteeInput, b: CommitteeInput): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    sameOrder(a.memberAgentIds, b.memberAgentIds)
  )
}

export interface CommitteesState {
  /** Backend-owned mirror of `committees.list`, newest `updatedAt` first. */
  committees: Committee[]
  status: CommitteesStatus
  /** Developer-facing detail of the last failure; the UI shows translated copy. */
  error?: string | undefined
  errorCode?: BackendErrorCode | undefined
  /** The refusal's `details`, which may carry a `ValidationReason`. */
  errorDetails?: unknown

  /** The committee the editor is bound to, or `null` while creating. */
  selectedId: string | null
  mode: CommitteeEditorMode
  /** The editor's working copy. `null` when the editor is closed. */
  draft: CommitteeInput | null
  /** True once the draft differs from what is stored (always true while creating). */
  dirty: boolean
  saving: boolean

  /** Reads the list. Never rejects: failures land in `status` / `error`. */
  load: () => Promise<void>
  startCreate: () => void
  startEdit: (id: string) => void
  closeEditor: () => void
  /** Merges into the draft and recomputes `dirty`. */
  patchDraft: (patch: Partial<CommitteeInput>) => void
  /** Appends one member; an agent already in the list is ignored. */
  addMember: (agentId: string) => void
  removeMember: (agentId: string) => void
  /** Moves one member; the array order *is* the speaking order. */
  moveMember: (from: number, to: number) => void
  /** Creates or updates from the draft. Never rejects; sets `error` on failure. */
  save: () => Promise<Committee | null>
  /** Deletes one committee. Never rejects; sets `error` on failure. */
  remove: (id: string) => Promise<void>
  /** The current draft's errors, or an empty object when the editor is closed. */
  draftErrors: () => CommitteeDraftErrors
}

const CLEAR_ERROR = { error: undefined, errorCode: undefined, errorDetails: undefined }

export const useCommitteesStore = create<CommitteesState>()((set, get) => ({
  committees: [],
  status: 'idle',
  ...CLEAR_ERROR,
  selectedId: null,
  mode: 'idle',
  draft: null,
  dirty: false,
  saving: false,

  async load() {
    set({ status: 'loading', ...CLEAR_ERROR })
    try {
      const committees = await getBackend().invoke('committees.list')
      set({ committees, status: 'ready', ...CLEAR_ERROR })
    } catch (cause) {
      set({
        status: 'error',
        error: describe(cause),
        errorCode: classify(cause),
        errorDetails: detailsOf(cause)
      })
    }
  },

  startCreate() {
    // `dirty` starts true: a new committee has nothing stored to differ from,
    // and Save is gated on validity anyway, so an empty form shows
    // disabled-because-invalid rather than disabled-because-unchanged.
    set({
      mode: 'create',
      selectedId: null,
      draft: emptyCommitteeDraft(),
      dirty: true,
      ...CLEAR_ERROR
    })
  },

  startEdit(id) {
    const committee = get().committees.find((candidate) => candidate.id === id)
    if (!committee) return
    set({
      mode: 'edit',
      selectedId: id,
      draft: draftFromCommittee(committee),
      dirty: false,
      ...CLEAR_ERROR
    })
  },

  closeEditor() {
    set({ mode: 'idle', selectedId: null, draft: null, dirty: false })
  },

  patchDraft(patch) {
    const { draft, mode, selectedId, committees } = get()
    if (!draft) return
    const next = { ...draft, ...patch }
    const stored = committees.find((committee) => committee.id === selectedId)
    set({
      draft: next,
      dirty: mode === 'create' || !stored || !sameDraft(next, draftFromCommittee(stored))
    })
  },

  addMember(agentId) {
    const draft = get().draft
    if (!draft || draft.memberAgentIds.includes(agentId)) return
    get().patchDraft({ memberAgentIds: [...draft.memberAgentIds, agentId] })
  },

  removeMember(agentId) {
    const draft = get().draft
    if (!draft) return
    get().patchDraft({
      memberAgentIds: draft.memberAgentIds.filter((id) => id !== agentId)
    })
  },

  moveMember(from, to) {
    const draft = get().draft
    if (!draft) return
    // `reorder` returns a copy unchanged for an out-of-range or no-op move, so
    // a drop outside the list costs one re-render and nothing else.
    get().patchDraft({ memberAgentIds: reorder(draft.memberAgentIds, from, to) })
  },

  async save() {
    const { draft, mode, selectedId } = get()
    if (!draft) return null
    if (!isDraftValid(validateDraft(draft))) return null

    const input: CommitteeInput = { ...draft, name: draft.name.trim() }

    set({ saving: true, ...CLEAR_ERROR })
    try {
      if (mode === 'edit' && selectedId) {
        const updated = await getBackend().invoke('committees.update', {
          id: selectedId,
          patch: input
        })
        // Replaced in place rather than re-sorted to the head: the list is
        // ordered by `updatedAt`, but a row that jumped under the cursor every
        // time Save was pressed would be worse than a list that is one reload
        // behind its own ordering.
        set((state) => ({
          committees: state.committees.map((committee) =>
            committee.id === selectedId ? updated : committee
          ),
          draft: draftFromCommittee(updated),
          dirty: false
        }))
        return updated
      }

      const created = await getBackend().invoke('committees.create', { input })
      // Stay on the record that was just created: the user usually keeps
      // editing, and a committee is created to have members put in it.
      set((state) => ({
        committees: [created, ...state.committees],
        mode: 'edit',
        selectedId: created.id,
        draft: draftFromCommittee(created),
        dirty: false
      }))
      return created
    } catch (cause) {
      set({
        error: describe(cause),
        errorCode: classify(cause),
        errorDetails: detailsOf(cause)
      })
      return null
    } finally {
      set({ saving: false })
    }
  },

  async remove(id) {
    try {
      await getBackend().invoke('committees.delete', { id })
      set((state) => ({
        committees: state.committees.filter((committee) => committee.id !== id),
        ...(state.selectedId === id
          ? { selectedId: null, mode: 'idle' as const, draft: null, dirty: false }
          : {}),
        ...CLEAR_ERROR
      }))
    } catch (cause) {
      set({
        error: describe(cause),
        errorCode: classify(cause),
        errorDetails: detailsOf(cause)
      })
    }
  },

  draftErrors() {
    const draft = get().draft
    return draft ? validateDraft(draft) : {}
  }
}))
