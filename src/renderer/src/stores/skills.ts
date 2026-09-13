/**
 * The skills library: the list, the folders that were skipped, and the detail of
 * whichever skill is open.
 *
 * Much smaller than `stores/mcp.ts` or `stores/providers.ts`, because a skill is
 * **not edited in the app**. It is a folder the user wrote or downloaded; the app
 * imports it, shows it and deletes it. There is therefore no draft, no dirty
 * flag and no save — the three things those stores are mostly made of.
 *
 * Two callers share this store: Settings → Skills, which shows everything, and
 * the agent editor's checklist, which needs only `skills`. The second reason is
 * why the list is loaded here rather than inside the settings section: the agent
 * form has to be able to tell a name it cannot resolve (a skill whose folder was
 * moved) from one it can, and that is a comparison against this same list.
 */
import { create } from 'zustand'
import type { BackendErrorCode, SkillDetail, SkillMeta, SkillWarning } from '@shared/types'
import { BackendClientError } from '../lib/backend'
import { getBackend } from '../lib/backend-provider'

export type SkillsStatus = 'idle' | 'loading' | 'ready' | 'error'

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function classify(cause: unknown): BackendErrorCode {
  return cause instanceof BackendClientError ? cause.code : 'internal'
}

/**
 * The skill names an agent lists that no longer resolve to a folder.
 *
 * Exported and pure so the agent editor and its test agree on the rule: a match
 * is on the skill's `name` or its folder, case-insensitively, which is exactly
 * what `enabledSkills` in `src/main/agents/agent-turn.ts` does when it assembles
 * the prompt. A name here that the backend would skip is the definition of
 * "missing", and the editor tags it rather than dropping it.
 */
export function missingSkillNames(
  selected: readonly string[],
  available: readonly SkillMeta[]
): string[] {
  const known = new Set(
    available.flatMap((skill) => [skill.name.toLowerCase(), skill.folder.toLowerCase()])
  )
  return selected.filter((name) => !known.has(name.trim().toLowerCase()))
}

export interface SkillsState {
  /** Backend-owned mirror of `userData/skills/`, sorted by folder name. */
  skills: SkillMeta[]
  /** Folders that look like a skill but could not be loaded. */
  warnings: SkillWarning[]
  status: SkillsStatus
  /** Developer-facing detail of the last failure; the UI shows translated copy. */
  error?: string | undefined
  errorCode?: BackendErrorCode | undefined
  /** Name of the skill the detail pane is showing, or `null`. */
  selectedName: string | null
  /** The open skill's body and file list. `null` while it loads. */
  detail: SkillDetail | null
  importing: boolean

  /** Reads the list. Never rejects: failures land in `status` / `error`. */
  load: () => Promise<void>
  /** Opens one skill in the detail pane and reads its body. Never rejects. */
  select: (name: string) => Promise<void>
  closeDetail: () => void
  /**
   * Asks for a folder and imports it. Resolves with the imported skill, or
   * `null` when the user cancelled or the import was refused.
   */
  importFolder: () => Promise<SkillMeta | null>
  /** Deletes one skill. Never rejects; sets `error` on failure. */
  remove: (name: string) => Promise<void>
}

export const useSkillsStore = create<SkillsState>()((set, get) => ({
  skills: [],
  warnings: [],
  status: 'idle',
  error: undefined,
  errorCode: undefined,
  selectedName: null,
  detail: null,
  importing: false,

  async load() {
    set({ status: 'loading', error: undefined, errorCode: undefined })
    try {
      const { skills, warnings } = await getBackend().invoke('skills.list')
      set((state) => ({
        skills,
        warnings,
        status: 'ready',
        error: undefined,
        errorCode: undefined,
        // A skill that is no longer there must not keep a stale pane open.
        ...(state.selectedName && !skills.some((skill) => skill.name === state.selectedName)
          ? { selectedName: null, detail: null }
          : {})
      }))
    } catch (cause) {
      set({ status: 'error', error: describe(cause), errorCode: classify(cause) })
    }
  },

  async select(name) {
    set({ selectedName: name, detail: null, error: undefined, errorCode: undefined })
    try {
      const detail = await getBackend().invoke('skills.read', { name })
      // The pane may have been closed, or another skill opened, while the read
      // was in flight; the answer to the older question is dropped.
      if (get().selectedName === name) set({ detail })
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
    }
  },

  closeDetail() {
    set({ selectedName: null, detail: null })
  },

  async importFolder() {
    set({ importing: true, error: undefined, errorCode: undefined })
    try {
      const sourcePath = await getBackend().invoke('system.pickFolder')
      // Cancelling a dialog is not an error and must leave no message behind.
      if (!sourcePath) return null

      const meta = await getBackend().invoke('skills.import', { sourcePath })
      await get().load()
      await get().select(meta.name)
      return meta
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
      return null
    } finally {
      set({ importing: false })
    }
  },

  async remove(name) {
    try {
      await getBackend().invoke('skills.delete', { name })
      set((state) => ({
        skills: state.skills.filter((skill) => skill.name !== name),
        ...(state.selectedName === name ? { selectedName: null, detail: null } : {}),
        error: undefined,
        errorCode: undefined
      }))
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
    }
  }
}))
