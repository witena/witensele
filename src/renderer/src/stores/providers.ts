/**
 * The providers store: the list, the editor draft and the two network probes.
 *
 * It follows the shape `stores/settings.ts` established — the backend owns the
 * data, the store mirrors it, and every call goes through `getBackend()` so the
 * whole thing is testable in plain Node — and adds the one idea the settings
 * store had no need for: an **editor draft**.
 *
 * ## Why a draft rather than editing the record
 *
 * A provider is not saveable field by field. The user picks a preset, which
 * rewrites three fields at once; types a key that must not be sent until Save;
 * and fetches a model list for an endpoint that may not exist as a row yet. So
 * the editor works on a `ProviderInput` copy (`draft`) and the record is only
 * touched by `saveDraft`. That is also why `ProviderRef` exists: both probes take
 * `{ draft }` before the first save and `{ id }` afterwards.
 *
 * ## Why the key is never in the draft after loading one
 *
 * `Provider` has no key field — only `hasApiKey` — so `startEdit` leaves
 * `draft.apiKey` **undefined**, which the update contract reads as "keep the
 * stored key". The field shows a "key stored" hint instead of a fake value, and
 * typing into it replaces the key. Clearing it to `''` clears the stored key,
 * which is the one thing an empty string may mean.
 */
import { create } from 'zustand'
import type { ProviderRef } from '@shared/backend'
import { getPreset, OAUTH_PROVIDER_TYPES, type OAuthProviderType } from '@shared/presets'
import type {
  BackendErrorCode,
  ConnectionTestResult,
  Provider,
  ProviderAuthStatus,
  ProviderInput
} from '@shared/types'
import { BackendClientError } from '../lib/backend'
import { getBackend } from '../lib/backend-provider'

export type ProvidersStatus = 'idle' | 'loading' | 'ready' | 'error'

/** `idle` shows the "pick or add one" placeholder; the other two show the form. */
export type EditorMode = 'idle' | 'create' | 'edit'

/** Key the last probe result of an unsaved draft is remembered under. */
export const DRAFT_TEST_KEY = 'draft'

/**
 * One login state per vendor, `null` before that vendor's CLI has been asked.
 *
 * A record rather than one status (S5.13) because `ant` and `gcloud` are two
 * independent facts about the machine, and the sign-in panel renders whichever
 * one its provider type names. It is still **not** per provider: two Anthropic
 * providers share the one `ant` profile, which is why the key is the type.
 */
export type AuthStatuses = Record<OAuthProviderType, ProviderAuthStatus | null>

/** Nothing asked yet, for either vendor. */
export function emptyAuthStatuses(): AuthStatuses {
  return Object.fromEntries(OAUTH_PROVIDER_TYPES.map((type) => [type, null])) as AuthStatuses
}

/** What a fresh "Add provider" form starts from: nothing but a shape. */
export function emptyDraft(): ProviderInput {
  return { type: 'openai-compatible', name: '', models: [] }
}

/** The editor copy of a stored provider. Deliberately carries no `apiKey`. */
export function draftFromProvider(provider: Provider): ProviderInput {
  return {
    type: provider.type,
    name: provider.name,
    models: [...provider.models],
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.presetId ? { presetId: provider.presetId } : {}),
    ...(provider.auth ? { auth: provider.auth } : {})
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The failure class behind a rejection.
 *
 * The renderer never prints `error.message` as the headline — that string is
 * provider or driver text in whatever language that system speaks — so the code
 * is kept alongside it and `i18n/errors.ts` turns it into a sentence.
 */
function classify(cause: unknown): BackendErrorCode {
  return cause instanceof BackendClientError ? cause.code : 'internal'
}

/**
 * The three halves of a failure, as one patch.
 *
 * `details` is the half that is easiest to forget, and the one S5.2's
 * `translateFailure` needs: without it a refusal that knows exactly what it
 * disliked — a base URL on a provider that signs in — prints "rejected as
 * invalid" instead of saying so.
 */
function failureOf(cause: unknown): {
  error: string
  errorCode: BackendErrorCode
  errorDetails: unknown
} {
  return {
    error: describe(cause),
    errorCode: classify(cause),
    errorDetails: cause instanceof BackendClientError ? cause.details : undefined
  }
}

/** The same patch, inverted: nothing failed. */
const NO_FAILURE = { error: undefined, errorCode: undefined, errorDetails: undefined } as const

export interface ProvidersState {
  /** Backend-owned mirror of the `providers` table, oldest first. */
  providers: Provider[]
  status: ProvidersStatus
  /** Developer-facing detail of the last failure; the UI shows translated copy. */
  error?: string | undefined
  /** Failure class of the last error, for `i18n/errors.ts`. */
  errorCode?: BackendErrorCode | undefined
  /**
   * The failing call's `BackendError.details`, which may carry a
   * `ValidationReason`. Kept beside the code so `translateFailure` can name the
   * refusal rather than reaching for the generic sentence — the shape
   * `stores/chats.ts` introduced in S5.2.
   */
  errorDetails?: unknown
  /** The provider the editor is bound to, or `null` while creating. */
  selectedId: string | null
  mode: EditorMode
  /** The editor's working copy. `null` when the editor is closed. */
  draft: ProviderInput | null
  /**
   * The last connection test per provider id, plus `DRAFT_TEST_KEY` for an
   * unsaved one. Runtime only: a probe result is a fact about *now*, so it is
   * never persisted and is empty again after a restart.
   */
  testResults: Record<string, ConnectionTestResult>
  testing: boolean
  fetchingModels: boolean
  saving: boolean
  /**
   * What each vendor's CLI reports, or `null` before it has been asked.
   *
   * One status per vendor for the whole app rather than one per provider: it is
   * a fact about this machine — is the CLI installed, is a profile logged in —
   * not about a row, and two providers of the same type share the one login.
   */
  authStatus: AuthStatuses
  /**
   * True while a vendor login / logout is running, which needs a spinner.
   *
   * One flag rather than one per vendor: exactly one sign-in panel is on screen
   * at a time, because it belongs to the one draft the editor is holding.
   */
  authBusy: boolean
  /** Failure class of the last sign-in attempt, cleared when one succeeds. */
  authErrorCode?: BackendErrorCode | undefined

  /** Reads the list. Never rejects: failures land in `status` / `error`. */
  load: () => Promise<void>
  create: (input: ProviderInput) => Promise<Provider>
  update: (id: string, patch: Partial<ProviderInput>) => Promise<Provider>
  remove: (id: string) => Promise<void>
  /** Reads `/models`; replaces `draft.models` when the editor is open. */
  fetchModels: (ref: ProviderRef) => Promise<string[]>
  /**
   * Runs one probe and remembers the result. Never rejects.
   * `modelId` picks which model to send the probe to; omitted, the backend uses
   * the provider's first known model.
   */
  testConnection: (ref: ProviderRef, modelId?: string) => Promise<ConnectionTestResult>

  startCreate: () => void
  /**
   * Makes sure a draft exists **without opening the settings editor** (S7.5).
   *
   * The first-run card edits the same draft as the provider form, but it lives
   * on the chat page: `startCreate` would also set `mode`, and a user who then
   * opened Settings → Providers would find the Add form already open on a
   * screen they had never touched. `mode` is the *settings editor's* state, so
   * only the settings editor sets it.
   */
  ensureDraft: () => void
  startEdit: (id: string) => void
  closeEditor: () => void
  patchDraft: (patch: Partial<ProviderInput>) => void
  /** Fills type, name, base URL and models from a preset, keeping a typed key. */
  applyPreset: (presetId: string) => void
  addModel: (modelId: string) => void
  removeModel: (modelId: string) => void
  /** Creates or updates from the draft. Never rejects; sets `error` on failure. */
  saveDraft: () => Promise<Provider | null>

  /** Reads one vendor CLI's state. Never rejects: "not installed" is an answer. */
  loadAuthStatus: (type: OAuthProviderType) => Promise<ProviderAuthStatus>
  /** Runs the browser sign-in and stores the resulting status. Never rejects. */
  signIn: (type: OAuthProviderType) => Promise<void>
  /** Signs the vendor's CLI out and stores the resulting status. Never rejects. */
  signOut: (type: OAuthProviderType) => Promise<void>
  /**
   * Writes the Google quota project and stores the resulting status. Never
   * rejects — a project id the CLI refused is a line under the field, and the
   * panel stays open on it.
   */
  setQuotaProject: (project: string) => Promise<void>
}

/** Where a probe result belongs: the saved row it is about, or the draft. */
function testKey(ref: ProviderRef, selectedId: string | null): string {
  if ('id' in ref) return ref.id
  return selectedId ?? DRAFT_TEST_KEY
}

export const useProvidersStore = create<ProvidersState>()((set, get) => ({
  providers: [],
  status: 'idle',
  error: undefined,
  errorCode: undefined,
  errorDetails: undefined,
  selectedId: null,
  mode: 'idle',
  draft: null,
  testResults: {},
  testing: false,
  fetchingModels: false,
  saving: false,
  authStatus: emptyAuthStatuses(),
  authBusy: false,
  authErrorCode: undefined,

  async load() {
    set({ status: 'loading', ...NO_FAILURE })
    try {
      const providers = await getBackend().invoke('providers.list')
      set({ providers, status: 'ready', ...NO_FAILURE })
    } catch (cause) {
      // The settings page must still render: a failed list is state, not a crash.
      set({ status: 'error', ...failureOf(cause) })
    }
  },

  async create(input) {
    const created = await getBackend().invoke('providers.create', { input })
    set((state) => ({ providers: [...state.providers, created], ...NO_FAILURE }))
    return created
  },

  async update(id, patch) {
    const updated = await getBackend().invoke('providers.update', { id, patch })
    set((state) => ({
      providers: state.providers.map((provider) => (provider.id === id ? updated : provider)),
      ...NO_FAILURE
    }))
    return updated
  },

  async remove(id) {
    await getBackend().invoke('providers.delete', { id })
    set((state) => {
      const { [id]: _removed, ...testResults } = state.testResults
      const closing = state.selectedId === id
      return {
        providers: state.providers.filter((provider) => provider.id !== id),
        testResults,
        ...(closing ? { selectedId: null, mode: 'idle' as const, draft: null } : {}),
        ...NO_FAILURE
      }
    })
  },

  async fetchModels(ref) {
    set({ fetchingModels: true, ...NO_FAILURE })
    try {
      const models = await getBackend().invoke('providers.fetchModels', { provider: ref })
      // The answer is the authoritative list for that endpoint, so it replaces
      // whatever the form held — including a preset's guesses.
      set((state) => (state.draft ? { draft: { ...state.draft, models } } : {}))
      return models
    } catch (cause) {
      set(failureOf(cause))
      throw cause
    } finally {
      set({ fetchingModels: false })
    }
  },

  async testConnection(ref, modelId) {
    set({ testing: true })
    const key = testKey(ref, get().selectedId)
    try {
      const result = await getBackend().invoke('providers.testConnection', {
        provider: ref,
        ...(modelId ? { modelId } : {})
      })
      set((state) => ({ testResults: { ...state.testResults, [key]: result } }))
      return result
    } catch (cause) {
      // The handler answers with a value rather than a rejection, but a rejection
      // is still possible — a transport failure, or (S7.6) a stored key this
      // build cannot decrypt, which `resolveProvider` refuses before the probe
      // can run. The class is carried over rather than flattened to `internal`,
      // so the line under the button says what actually happened.
      const result: ConnectionTestResult = {
        ok: false,
        error: { code: classify(cause), message: describe(cause) }
      }
      set((state) => ({ testResults: { ...state.testResults, [key]: result } }))
      return result
    } finally {
      set({ testing: false })
    }
  },

  startCreate() {
    set({
      mode: 'create',
      selectedId: null,
      draft: emptyDraft(),
      ...NO_FAILURE
    })
  },

  ensureDraft() {
    if (get().draft === null) set({ draft: emptyDraft() })
  },

  startEdit(id) {
    const provider = get().providers.find((candidate) => candidate.id === id)
    if (!provider) return
    set({
      mode: 'edit',
      selectedId: id,
      draft: draftFromProvider(provider),
      ...NO_FAILURE
    })
  },

  closeEditor() {
    set({ mode: 'idle', selectedId: null, draft: null })
  },

  patchDraft(patch) {
    const draft = get().draft
    if (!draft) return
    set({ draft: { ...draft, ...patch } })
  },

  applyPreset(presetId) {
    const preset = getPreset(presetId)
    const draft = get().draft
    if (!preset || !draft) return
    set({
      draft: {
        ...draft,
        presetId: preset.id,
        type: preset.type,
        // Only overwrite a name the user has not written themselves.
        name: draft.name.trim().length === 0 ? preset.name : draft.name,
        baseUrl: preset.baseUrl ?? '',
        models: [...preset.defaultModels]
      }
    })
  },

  addModel(modelId) {
    const draft = get().draft
    const id = modelId.trim()
    if (!draft || id.length === 0 || draft.models.includes(id)) return
    set({ draft: { ...draft, models: [...draft.models, id] } })
  },

  removeModel(modelId) {
    const draft = get().draft
    if (!draft) return
    set({ draft: { ...draft, models: draft.models.filter((model) => model !== modelId) } })
  },

  async loadAuthStatus(type) {
    try {
      const status = await getBackend().invoke('providers.authStatus', { type })
      set((state) => ({
        authStatus: { ...state.authStatus, [type]: status },
        authErrorCode: undefined
      }))
      return status
    } catch (cause) {
      // The two states the panel exists for are answers, not rejections, so
      // reaching this line means the call itself failed. The panel still has to
      // render something, and "no CLI" is the safe thing to show.
      const status: ProviderAuthStatus = { state: 'not-installed' }
      set((state) => ({
        authStatus: { ...state.authStatus, [type]: status },
        authErrorCode: classify(cause)
      }))
      return status
    }
  },

  async signIn(type) {
    set({ authBusy: true, authErrorCode: undefined })
    try {
      const status = await getBackend().invoke('providers.login', { type })
      set((state) => ({ authStatus: { ...state.authStatus, [type]: status } }))
    } catch (cause) {
      // A flow the user closed in the browser lands here. That is not an app
      // failure: record the class, then ask the CLI what actually happened.
      set({ authErrorCode: classify(cause) })
      await get().loadAuthStatus(type)
    } finally {
      set({ authBusy: false })
    }
  },

  async signOut(type) {
    set({ authBusy: true, authErrorCode: undefined })
    try {
      const status = await getBackend().invoke('providers.logout', { type })
      set((state) => ({ authStatus: { ...state.authStatus, [type]: status } }))
    } catch (cause) {
      set({ authErrorCode: classify(cause) })
    } finally {
      set({ authBusy: false })
    }
  },

  async setQuotaProject(project) {
    set({ authBusy: true, authErrorCode: undefined })
    try {
      const status = await getBackend().invoke('providers.setQuotaProject', { project })
      set((state) => ({ authStatus: { ...state.authStatus, google: status } }))
    } catch (cause) {
      set({ authErrorCode: classify(cause) })
    } finally {
      set({ authBusy: false })
    }
  },

  async saveDraft() {
    const { draft, mode, selectedId } = get()
    if (!draft) return null

    set({ saving: true, ...NO_FAILURE })
    try {
      if (mode === 'edit' && selectedId) {
        const updated = await get().update(selectedId, draft)
        // Re-seed the draft from the saved row so the key field goes back to its
        // "a key is stored" state instead of keeping what was typed.
        set({ draft: draftFromProvider(updated) })
        return updated
      }
      const created = await get().create(draft)
      // Stay on the record that was just created: the user usually tests next.
      set({ mode: 'edit', selectedId: created.id, draft: draftFromProvider(created) })
      return created
    } catch (cause) {
      set(failureOf(cause))
      return null
    } finally {
      set({ saving: false })
    }
  }
}))
