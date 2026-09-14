/**
 * Purely local navigation state: which page the shell shows and, inside
 * Settings, which section is selected.
 *
 * Deliberately *not* a router. The app is a desktop window with three top-level
 * destinations and no addressable URLs, no deep links and no history to
 * reconstruct — a router library would only add a second source of truth next to
 * the store the rest of the UI already reads. If deep links ever matter (the VS
 * Code extension, or the server version), the router becomes the thing that
 * writes these two fields and nothing else has to change.
 *
 * Nothing here is backend-owned, so unlike `stores/settings.ts` there is no
 * `BackendClient` call and no persistence: reopening the app starts on Chats.
 */
import { create } from 'zustand'

/** The three destinations of the navigation rail, in rail order. */
export type Page = 'chats' | 'agents' | 'settings'

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

/** Rail order. The rail renders `chats` and `agents`; `settings` is pinned last. */
export const PAGES = ['chats', 'agents', 'settings'] as const satisfies readonly Page[]

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

export interface UiState {
  /** The page the shell renders. Starts on Chats, which is the app's home. */
  page: Page
  /**
   * The selected settings section. Kept even while another page is showing, so
   * leaving Settings and coming back returns to where the user was.
   */
  settingsSection: SettingsSection
  setPage: (page: Page) => void
  setSettingsSection: (section: SettingsSection) => void
}

export const useUiStore = create<UiState>()((set) => ({
  page: 'chats',
  settingsSection: 'providers',
  setPage: (page) => set({ page }),
  setSettingsSection: (settingsSection) => set({ settingsSection })
}))
