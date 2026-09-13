/**
 * The agent library: the list, and the configuration editor's draft.
 *
 * Shaped like `stores/providers.ts`, for the same reason — an agent is not
 * saveable field by field. Picking a provider rewrites the model, the avatar's
 * letter follows the name until the user overrides the colour, and a half-typed
 * name must not be written to a record that other chats are already using. So the
 * editor works on an `AgentInput` copy (`draft`), `dirty` says whether it differs
 * from what is stored, and only `saveDraft` touches the backend.
 *
 * ## Why validation lives here and not in the page
 *
 * `agents.create` / `agents.update` reject an empty name, a name containing `@`
 * and a name another agent already holds (see `src/main/handlers/agents.ts`) —
 * the backend is the authority. The same rules are computed here so Save can be
 * *disabled* and the reason shown under the field, rather than the user pressing
 * a button and getting a red line. `validateDraft` is pure and exported so the
 * two stay comparable in a test rather than by inspection.
 *
 * ## Why there is no `agent.created` event
 *
 * Agents are edited on one screen by one user, so the store applies its own
 * writes and re-reads nothing. The *chats* that contain an agent do get a
 * `chat.updated` from the backend, which is what keeps the member panel honest
 * when an agent is renamed or deleted from the other page.
 */
import { create } from 'zustand'
import type { Agent, AgentInput, AgentParams, BackendErrorCode } from '@shared/types'
import { AGENT_AVATAR_COLORS, DEFAULT_AGENT_AVATAR, avatarInitial } from '../components/agents/agent-display'
import { BackendClientError } from '../lib/backend'
import { getBackend } from '../lib/backend-provider'

export type AgentsStatus = 'idle' | 'loading' | 'ready' | 'error'

/** `idle` shows the "pick or create one" placeholder; the other two show the form. */
export type AgentEditorMode = 'idle' | 'create' | 'edit'

/**
 * Suffix a duplicated agent's name gets.
 *
 * Stored content rather than UI copy — it ends up in `agents.name`, which S2.3
 * resolves `@mentions` against and which the models see — so it is not an i18n
 * key, exactly like `DEFAULT_CHAT_TITLE` in the backend.
 */
export const DUPLICATE_SUFFIX = 'copy'

/** Bounds the editor enforces, mirroring `src/main/handlers/agents.ts`. */
export const TEMPERATURE_MIN = 0
export const TEMPERATURE_MAX = 2

/**
 * A params patch where a field may be set to `undefined` to *remove* it.
 *
 * `Partial<AgentParams>` cannot express that under `exactOptionalPropertyTypes`:
 * there, an absent key and a key holding `undefined` are different types, and
 * "clear the temperature field" has to be spellable.
 */
export type AgentParamsPatch = { [K in keyof AgentParams]?: AgentParams[K] | undefined }

/** Why one field is invalid. The page maps each code to an `agents.validation.*` key. */
export interface AgentDraftErrors {
  name?: 'required' | 'at' | 'taken'
  providerId?: 'required'
  modelId?: 'required'
  temperature?: 'range'
  maxTokens?: 'range'
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function classify(cause: unknown): BackendErrorCode {
  return cause instanceof BackendClientError ? cause.code : 'internal'
}

/** What a fresh "New agent" form starts from. */
export function emptyAgentDraft(): AgentInput {
  return {
    name: '',
    avatar: { kind: 'initial', text: '', ...DEFAULT_AGENT_AVATAR },
    description: '',
    systemPrompt: '',
    providerId: '',
    modelId: '',
    params: {},
    skillNames: [],
    mcpServerIds: [],
    memoryEnabled: false,
    // The UI creates participants only; `executor` is reserved for the post-MVP
    // executor agent and the backend accepts it for a future caller.
    role: 'participant'
  }
}

/** The editor copy of a stored agent. */
export function draftFromAgent(agent: Agent): AgentInput {
  return {
    name: agent.name,
    avatar: { ...agent.avatar },
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    providerId: agent.providerId,
    modelId: agent.modelId,
    params: { ...agent.params },
    skillNames: [...agent.skillNames],
    mcpServerIds: [...agent.mcpServerIds],
    memoryEnabled: agent.memoryEnabled,
    role: agent.role
  }
}

/**
 * Every reason the draft cannot be saved, keyed by field.
 *
 * `excludeId` is the record being edited, so an agent keeping its own name is not
 * a clash with itself.
 */
export function validateDraft(
  draft: AgentInput,
  agents: readonly Agent[],
  excludeId: string | null
): AgentDraftErrors {
  const errors: AgentDraftErrors = {}

  const name = draft.name.trim()
  if (name.length === 0) errors.name = 'required'
  else if (draft.name.includes('@')) errors.name = 'at'
  else if (
    agents.some(
      (agent) => agent.id !== excludeId && agent.name.trim().toLowerCase() === name.toLowerCase()
    )
  ) {
    errors.name = 'taken'
  }

  if (draft.providerId.trim().length === 0) errors.providerId = 'required'
  if (draft.modelId.trim().length === 0) errors.modelId = 'required'

  const { temperature, maxTokens } = draft.params
  if (
    temperature !== undefined &&
    (!Number.isFinite(temperature) || temperature < TEMPERATURE_MIN || temperature > TEMPERATURE_MAX)
  ) {
    errors.temperature = 'range'
  }
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
    errors.maxTokens = 'range'
  }

  return errors
}

/** True when nothing is wrong with the draft. */
export function isDraftValid(errors: AgentDraftErrors): boolean {
  return Object.keys(errors).length === 0
}

/** Element-by-element array comparison, order included. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}

/** Field-by-field comparison; `JSON.stringify` would depend on key order. */
function sameDraft(a: AgentInput, b: AgentInput): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.systemPrompt === b.systemPrompt &&
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    a.memoryEnabled === b.memoryEnabled &&
    a.role === b.role &&
    a.avatar.text === b.avatar.text &&
    a.avatar.color === b.avatar.color &&
    a.avatar.textColor === b.avatar.textColor &&
    a.params.temperature === b.params.temperature &&
    a.params.maxTokens === b.params.maxTokens &&
    a.params.reasoning === b.params.reasoning &&
    sameOrder(a.skillNames, b.skillNames) &&
    sameOrder(a.mcpServerIds, b.mcpServerIds)
  )
}

/** `"<name> copy"`, then `"<name> copy 2"`, until nothing holds it. */
export function duplicateName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((entry) => entry.trim().toLowerCase()))
  const base = `${name.trim()} ${DUPLICATE_SUFFIX}`
  if (!used.has(base.toLowerCase())) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

export interface AgentsState {
  /** Backend-owned mirror of the `agents` table, oldest first. */
  agents: Agent[]
  status: AgentsStatus
  /** Developer-facing detail of the last failure; the UI shows translated copy. */
  error?: string | undefined
  errorCode?: BackendErrorCode | undefined

  /** The agent the editor is bound to, or `null` while creating. */
  selectedId: string | null
  mode: AgentEditorMode
  /** The editor's working copy. `null` when the editor is closed. */
  draft: AgentInput | null
  /** True once the draft differs from what is stored (always true while creating). */
  dirty: boolean
  saving: boolean

  /** Reads the list. Never rejects: failures land in `status` / `error`. */
  load: () => Promise<void>
  create: (input: AgentInput) => Promise<Agent>
  update: (id: string, patch: Partial<AgentInput>) => Promise<Agent>
  remove: (id: string) => Promise<void>
  /** Copies the selected agent under a free name and opens it. Never rejects. */
  duplicate: (id: string) => Promise<Agent | null>

  startCreate: () => void
  startEdit: (id: string) => void
  closeEditor: () => void
  /** Merges into the draft and recomputes `dirty`. */
  patchDraft: (patch: Partial<AgentInput>) => void
  /** Merges into `draft.params`; `undefined` removes a field rather than storing it. */
  patchParams: (patch: AgentParamsPatch) => void
  /** Picks one of `AGENT_AVATAR_COLORS` by index, keeping the monogram. */
  pickAvatarColor: (index: number) => void
  /** Creates or updates from the draft. Never rejects; sets `error` on failure. */
  saveDraft: () => Promise<Agent | null>
  /** The current draft's errors, or an empty object when the editor is closed. */
  draftErrors: () => AgentDraftErrors
}

export const useAgentsStore = create<AgentsState>()((set, get) => ({
  agents: [],
  status: 'idle',
  error: undefined,
  errorCode: undefined,
  selectedId: null,
  mode: 'idle',
  draft: null,
  dirty: false,
  saving: false,

  async load() {
    set({ status: 'loading', error: undefined, errorCode: undefined })
    try {
      const agents = await getBackend().invoke('agents.list')
      set({ agents, status: 'ready', error: undefined, errorCode: undefined })
    } catch (cause) {
      set({ status: 'error', error: describe(cause), errorCode: classify(cause) })
    }
  },

  async create(input) {
    const created = await getBackend().invoke('agents.create', { input })
    set((state) => ({ agents: [...state.agents, created], error: undefined, errorCode: undefined }))
    return created
  },

  async update(id, patch) {
    const updated = await getBackend().invoke('agents.update', { id, patch })
    set((state) => ({
      agents: state.agents.map((agent) => (agent.id === id ? updated : agent)),
      error: undefined,
      errorCode: undefined
    }))
    return updated
  },

  async remove(id) {
    try {
      await getBackend().invoke('agents.delete', { id })
      set((state) => ({
        agents: state.agents.filter((agent) => agent.id !== id),
        ...(state.selectedId === id
          ? { selectedId: null, mode: 'idle' as const, draft: null, dirty: false }
          : {}),
        error: undefined,
        errorCode: undefined
      }))
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
    }
  },

  async duplicate(id) {
    const source = get().agents.find((agent) => agent.id === id)
    if (!source) return null
    const input: AgentInput = {
      ...draftFromAgent(source),
      name: duplicateName(source.name, get().agents.map((agent) => agent.name))
    }
    try {
      const created = await get().create(input)
      set({ mode: 'edit', selectedId: created.id, draft: draftFromAgent(created), dirty: false })
      return created
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
      return null
    }
  },

  startCreate() {
    // `dirty` starts true: a new agent has nothing stored to differ from, and Save
    // is gated on validity anyway, so an empty form shows disabled-because-invalid
    // rather than disabled-because-unchanged.
    set({
      mode: 'create',
      selectedId: null,
      draft: emptyAgentDraft(),
      dirty: true,
      error: undefined,
      errorCode: undefined
    })
  },

  startEdit(id) {
    const agent = get().agents.find((candidate) => candidate.id === id)
    if (!agent) return
    set({
      mode: 'edit',
      selectedId: id,
      draft: draftFromAgent(agent),
      dirty: false,
      error: undefined,
      errorCode: undefined
    })
  },

  closeEditor() {
    set({ mode: 'idle', selectedId: null, draft: null, dirty: false })
  },

  patchDraft(patch) {
    const { draft, mode, selectedId, agents } = get()
    if (!draft) return
    const next = { ...draft, ...patch }
    const stored = agents.find((agent) => agent.id === selectedId)
    set({
      draft: next,
      dirty: mode === 'create' || !stored || !sameDraft(next, draftFromAgent(stored))
    })
  },

  patchParams(patch) {
    const draft = get().draft
    if (!draft) return
    const params: AgentParams = { ...draft.params }
    for (const [key, value] of Object.entries(patch)) {
      // `exactOptionalPropertyTypes` is on: an absent field and a field holding
      // `undefined` are different types, and only the first round-trips as JSON.
      if (value === undefined) delete params[key as keyof AgentParams]
      else Object.assign(params, { [key]: value })
    }
    get().patchDraft({ params })
  },

  pickAvatarColor(index) {
    const draft = get().draft
    const palette = AGENT_AVATAR_COLORS[index]
    if (!draft || !palette) return
    get().patchDraft({ avatar: { ...draft.avatar, ...palette } })
  },

  async saveDraft() {
    const { draft, mode, selectedId, agents } = get()
    if (!draft) return null
    if (!isDraftValid(validateDraft(draft, agents, selectedId))) return null

    // The monogram follows the name unless the user typed one of their own; an
    // empty letter would render a blank tile on every screen.
    const input: AgentInput = {
      ...draft,
      name: draft.name.trim(),
      avatar: {
        ...draft.avatar,
        text: draft.avatar.text.trim() || avatarInitial(draft.name)
      }
    }

    set({ saving: true, error: undefined, errorCode: undefined })
    try {
      if (mode === 'edit' && selectedId) {
        const updated = await get().update(selectedId, input)
        set({ draft: draftFromAgent(updated), dirty: false })
        return updated
      }
      const created = await get().create(input)
      // Stay on the record that was just created: the user usually keeps editing.
      set({ mode: 'edit', selectedId: created.id, draft: draftFromAgent(created), dirty: false })
      return created
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
      return null
    } finally {
      set({ saving: false })
    }
  },

  draftErrors() {
    const { draft, agents, selectedId } = get()
    return draft ? validateDraft(draft, agents, selectedId) : {}
  }
}))

/** One agent by id, or `undefined` when it has been deleted or not loaded yet. */
export function useAgent(agentId: string | undefined): Agent | undefined {
  return useAgentsStore((state) =>
    agentId ? state.agents.find((agent) => agent.id === agentId) : undefined
  )
}
