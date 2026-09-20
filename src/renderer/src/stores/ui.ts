/**
 * Purely local navigation state: which page the shell shows and, inside
 * Settings, which section is selected.
 *
 * Deliberately *not* a router. The app is a desktop window with a handful of
 * top-level destinations and no addressable URLs, no deep links and no history to
 * reconstruct — a router library would only add a second source of truth next to
 * the store the rest of the UI already reads. If deep links ever matter (the VS
 * Code extension, or the server version), the router becomes the thing that
 * writes these two fields and nothing else has to change.
 *
 * Nothing here is backend-owned, so unlike `stores/settings.ts` there is no
 * `BackendClient` call and no persistence: reopening the app starts on Chats.
 *
 * S9.3 adds a third field of the same kind: whether the New chat dialog is
 * open. It is here rather than in `ChatsPage` because two pages open it — the
 * chat list's "+" and the Committees page's "New topic", which navigates first
 * — and one of them is unmounted by the time the dialog appears.
 */
import { create } from 'zustand'

/** The destinations of the navigation rail, in rail order. */
export type Page = 'chats' | 'committees' | 'agents' | 'settings'

/** The sections of the settings page, in the order the settings nav lists them. */
export type SettingsSection =
  | 'providers'
  | 'mcp'
  | 'skills'
  | 'timeouts'
  | 'appearance'
  | 'data'
  | 'about'
  | 'developer'

/**
 * Rail order. The rail renders `chats`, `committees` and `agents`; `settings` is
 * pinned last.
 *
 * `committees` sits between Chats and Agents (S9.2) because that is the order
 * the three are used in: a topic is convened from a committee, and a committee
 * is assembled from agents.
 */
export const PAGES = [
  'chats',
  'committees',
  'agents',
  'settings'
] as const satisfies readonly Page[]

/**
 * Settings nav order. `developer` is last on purpose: it is the transport and
 * i18n smoke surface the end-to-end tests drive, not a user-facing feature.
 * `about` (S7.5) sits directly above it — the version, the repository and the
 * licences are the end of the list on every desktop app there is.
 */
export const SETTINGS_SECTIONS = [
  'providers',
  'mcp',
  'skills',
  'timeouts',
  'appearance',
  'data',
  'about',
  'developer'
] as const satisfies readonly SettingsSection[]

/**
 * Whether the New chat dialog is up, and which committee it opened on (S9.3).
 *
 * `committeeId` is a *seed*, not the selection: the dialog copies it into its
 * own state when it mounts and the user is free to change or clear it. Keeping
 * the live selection here would make the store re-render on every click in a
 * list that nothing outside the dialog reads.
 */
export interface NewChatDialogState {
  open: boolean
  /** The committee to preselect, absent for the chat list's plain "+". */
  committeeId?: string | undefined
}

export interface UiState {
  /** The page the shell renders. Starts on Chats, which is the app's home. */
  page: Page
  /**
   * The selected settings section. Kept even while another page is showing, so
   * leaving Settings and coming back returns to where the user was.
   */
  settingsSection: SettingsSection
  /**
   * The New chat dialog (S9.3).
   *
   * In this store rather than in `ChatsPage` because the **Committees** page
   * opens it: "New topic" navigates to Chats and wants the dialog up with its
   * committee already picked, and a page that has just been unmounted cannot
   * hand state to the one replacing it.
   */
  newChatDialog: NewChatDialogState
  setPage: (page: Page) => void
  setSettingsSection: (section: SettingsSection) => void
  /** Opens the dialog, optionally on a committee. Does **not** change the page. */
  openNewChatDialog: (committeeId?: string) => void
  closeNewChatDialog: () => void
}

/** The closed state, as a fresh object each time so nothing can hold on to it. */
function closedDialog(): NewChatDialogState {
  return { open: false }
}

export const useUiStore = create<UiState>()((set) => ({
  page: 'chats',
  settingsSection: 'providers',
  newChatDialog: closedDialog(),
  setPage: (page) => set({ page }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  openNewChatDialog: (committeeId) =>
    set({
      // `exactOptionalPropertyTypes` is on, so an absent committee is an absent
      // key rather than an explicit `undefined`.
      newChatDialog: { open: true, ...(committeeId ? { committeeId } : {}) }
    }),
  closeNewChatDialog: () => set({ newChatDialog: closedDialog() })
}))
