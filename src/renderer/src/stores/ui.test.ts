/**
 * The navigation store is tiny, but it is the one piece of the shell every page
 * and the rail both read, so the defaults and the independence of the two fields
 * are worth pinning down: a regression here shows up as "Settings opens on the
 * wrong section" long after the change that caused it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { PAGES, SETTINGS_SECTIONS, useUiStore } from './ui'

const INITIAL = useUiStore.getState()

beforeEach(() => {
  // zustand stores are module singletons; without this a test would inherit the
  // page the previous one navigated to.
  useUiStore.setState({ page: INITIAL.page, settingsSection: INITIAL.settingsSection })
})

describe('ui store', () => {
  it('starts on the chats page with the first settings section selected', () => {
    expect(useUiStore.getState().page).toBe('chats')
    expect(useUiStore.getState().settingsSection).toBe('providers')
  })

  it('switches to every page the rail offers', () => {
    for (const page of PAGES) {
      useUiStore.getState().setPage(page)
      expect(useUiStore.getState().page).toBe(page)
    }
  })

  it('switches to every settings section the nav offers', () => {
    for (const section of SETTINGS_SECTIONS) {
      useUiStore.getState().setSettingsSection(section)
      expect(useUiStore.getState().settingsSection).toBe(section)
    }
  })

  it('keeps the selected settings section while another page is shown', () => {
    useUiStore.getState().setSettingsSection('developer')
    useUiStore.getState().setPage('chats')

    // Leaving Settings must not reset the section: coming back returns the user
    // to where they were, which is why the two fields live in one store.
    expect(useUiStore.getState().settingsSection).toBe('developer')
  })

  it('leaves the page alone when only the section changes', () => {
    useUiStore.getState().setPage('agents')
    useUiStore.getState().setSettingsSection('mcp')

    expect(useUiStore.getState().page).toBe('agents')
  })

  it('lists the rail destinations in rail order, Settings last', () => {
    // The order is what the rail renders top to bottom (S9.2 inserted
    // `committees` between Chats and Agents), and `app-shell.tsx` keys its page
    // lookup off the same union — a page added to one and not the other is a
    // compile error there and a missing button here.
    expect([...PAGES]).toEqual(['chats', 'committees', 'agents', 'settings'])
  })

  it('lists the sections the settings nav renders, without duplicates', () => {
    expect(new Set(SETTINGS_SECTIONS).size).toBe(SETTINGS_SECTIONS.length)
    expect(new Set(PAGES).size).toBe(PAGES.length)
  })
})
