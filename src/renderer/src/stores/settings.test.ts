/**
 * The settings store against a fake `BackendClient`.
 *
 * No jsdom and no React: the store is vanilla zustand, so `getState()` drives it
 * directly. That is the point of `lib/backend-provider.ts` — a store that reached
 * for `window.witena` could only be tested by launching Electron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendClient, BackendMethod } from '@shared/backend'
import type { AppSettings, AppSettingsPatch } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/types'
import { i18n, initI18n } from '../i18n'
import { resetBackend, setBackend } from '../lib/backend-provider'
import { useSettingsStore } from './settings'

interface Call {
  method: BackendMethod
  input: unknown
}

/**
 * A backend whose settings row lives in a local variable and whose `update`
 * merges like the real repository does, so the store is exercised against the
 * contract rather than against a stub that always answers the same thing.
 */
function fakeBackend(initial: AppSettings = DEFAULT_APP_SETTINGS): {
  client: BackendClient
  calls: Call[]
  stored: () => AppSettings
  fail: (error: Error | null) => void
} {
  const calls: Call[] = []
  let stored: AppSettings = initial
  let failure: Error | null = null

  const client: BackendClient = {
    invoke: (async (method: BackendMethod, input: unknown) => {
      calls.push({ method, input })
      if (failure) throw failure
      if (method === 'settings.get') return stored
      if (method === 'settings.update') {
        const patch = (input as { patch: AppSettingsPatch }).patch
        stored = {
          ...stored,
          ...(patch.language !== undefined ? { language: patch.language } : {}),
          ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
          editor: { ...stored.editor, ...patch.editor },
          timeouts: { ...stored.timeouts, ...patch.timeouts }
        }
        return stored
      }
      if (method === 'system.applyTheme') return undefined
      throw new Error(`unexpected method ${method}`)
    }) as BackendClient['invoke'],
    subscribe: () => () => {}
  }

  return {
    client,
    calls,
    stored: () => stored,
    fail: (error) => {
      failure = error
    }
  }
}

function resetStore(): void {
  useSettingsStore.setState({ settings: null, status: 'idle', error: undefined })
}

/**
 * `setTheme` stamps `data-theme` on the document element, so the store needs one
 * — in plain Node, where there is none. Two globals are enough (S5.8); see
 * `lib/theme.test.ts` for the same fakes driving the theme module itself.
 */
function stubDocument(): () => string | undefined {
  const attributes = new Map<string, string>()
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute: (name: string, value: string) => attributes.set(name, value)
    }
  })
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
  return () => attributes.get('data-theme')
}

beforeEach(() => {
  resetStore()
  // A machine-independent starting point: every test that cares sets its own.
  vi.stubGlobal('navigator', { language: 'en-US' })
  initI18n('en')
})

afterEach(() => {
  resetBackend()
  vi.unstubAllGlobals()
})

describe('load', () => {
  it('populates the store from settings.get', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().status).toBe('ready')
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_APP_SETTINGS)
    expect(backend.calls).toEqual([{ method: 'settings.get', input: undefined }])
  })

  it('records a failure instead of throwing, so the bootstrap can still render', async () => {
    const backend = fakeBackend()
    backend.fail(new Error('bridge is down'))
    setBackend(backend.client)

    await expect(useSettingsStore.getState().load()).resolves.toBeUndefined()

    expect(useSettingsStore.getState().status).toBe('error')
    expect(useSettingsStore.getState().error).toBe('bridge is down')
    expect(useSettingsStore.getState().settings).toBeNull()
  })
})

describe('setLanguage', () => {
  it('sends the patch, stores the answer and switches i18next', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useSettingsStore.getState().load()

    await useSettingsStore.getState().setLanguage('en')

    expect(backend.calls.at(-1)).toEqual({
      method: 'settings.update',
      input: { patch: { language: 'en' } }
    })
    expect(backend.stored().language).toBe('en')
    expect(useSettingsStore.getState().settings?.language).toBe('en')
    expect(i18n.language).toBe('en')
  })

  it('applies a concrete language without consulting the navigator', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useSettingsStore.getState().load()
    vi.stubGlobal('navigator', { language: 'en-US' })

    await useSettingsStore.getState().setLanguage('zh-CN')

    expect(i18n.language).toBe('zh-CN')
    expect(useSettingsStore.getState().settings?.language).toBe('zh-CN')
  })

  it('resolves "system" through the navigator language', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useSettingsStore.getState().load()
    vi.stubGlobal('navigator', { language: 'zh-Hans-CN' })

    await useSettingsStore.getState().setLanguage('system')

    // The *setting* stays `system` — it must keep following the machine — while
    // the *active* language is the resolved one.
    expect(useSettingsStore.getState().settings?.language).toBe('system')
    expect(i18n.language).toBe('zh-CN')
  })

  it('updates the store optimistically before the backend answers', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useSettingsStore.getState().load()

    const pending = useSettingsStore.getState().setLanguage('zh-CN')
    // The click must not wait for a round trip to highlight the new choice.
    expect(useSettingsStore.getState().settings?.language).toBe('zh-CN')
    await pending
  })
})

describe('setTheme', () => {
  it('sends the patch, stores the answer and repaints the window', async () => {
    const theme = stubDocument()
    const backend = fakeBackend()
    setBackend(backend.client)
    await useSettingsStore.getState().load()

    await useSettingsStore.getState().setTheme('light')

    expect(backend.calls.map((call) => call.method)).toContain('settings.update')
    expect(backend.stored().theme).toBe('light')
    expect(useSettingsStore.getState().settings?.theme).toBe('light')
    expect(theme()).toBe('light')
  })

  it('tells the main process, which owns the window chrome', async () => {
    stubDocument()
    const backend = fakeBackend()
    setBackend(backend.client)
    await useSettingsStore.getState().load()

    await useSettingsStore.getState().setTheme('dark')

    expect(backend.calls.at(-1)).toEqual({
      method: 'system.applyTheme',
      input: { theme: 'dark' }
    })
  })

  it('resolves "system" through the machine without storing the resolved value', async () => {
    // The fake `matchMedia` reports dark, so the *painted* theme is dark while
    // the *setting* stays `system` — the same split as `language`.
    const theme = stubDocument()
    const backend = fakeBackend()
    setBackend(backend.client)
    await useSettingsStore.getState().load()

    await useSettingsStore.getState().setTheme('system')

    expect(backend.stored().theme).toBe('system')
    expect(theme()).toBe('dark')
  })

  it('repaints before the backend answers', async () => {
    const theme = stubDocument()
    const backend = fakeBackend()
    setBackend(backend.client)
    await useSettingsStore.getState().load()

    const pending = useSettingsStore.getState().setTheme('light')
    // A click that repaints the whole window must not wait for a round trip.
    expect(theme()).toBe('light')
    expect(useSettingsStore.getState().settings?.theme).toBe('light')
    await pending
  })
})

describe('settings store (editor)', () => {
  it('starts on VS Code with the default command template', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().settings?.editor).toEqual(DEFAULT_APP_SETTINGS.editor)
  })

  it('writes the kind without clearing the command, and the other way round', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useSettingsStore.getState().load()

    await useSettingsStore.getState().setEditor({ kind: 'custom' })
    expect(backend.stored().editor).toEqual({
      kind: 'custom',
      command: DEFAULT_APP_SETTINGS.editor.command
    })

    await useSettingsStore.getState().setEditor({ command: 'subl {path}:{line}' })
    expect(backend.stored().editor).toEqual({ kind: 'custom', command: 'subl {path}:{line}' })
  })

  it('sends the patch as a partial of editor, never the whole settings object', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useSettingsStore.getState().load()

    await useSettingsStore.getState().setEditor({ kind: 'cursor' })

    expect(backend.calls.at(-1)).toEqual({
      method: 'settings.update',
      input: { patch: { editor: { kind: 'cursor' } } }
    })
  })

  it('rejects rather than swallowing a refused write', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useSettingsStore.getState().load()
    backend.fail(new Error('settings.update: editor.command must be a non-empty string'))

    // `pages/settings/editor.ts` is what turns this into the store's `error`.
    await expect(useSettingsStore.getState().setEditor({ command: ' ' })).rejects.toThrow()
  })
})
