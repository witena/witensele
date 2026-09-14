/**
 * The appearance rule, and the promise the light palette makes.
 *
 * Two subjects in one file because they are two halves of the same guarantee:
 * `resolveTheme` decides *which* palette is painted, and the token check proves
 * the palette it names actually exists. The second one is the more valuable of
 * the two — a wrong resolution is visible the moment anyone looks at the app,
 * while a token that was added to the dark block and forgotten in the light one
 * is invisible until someone in light mode opens the one screen that uses it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveTheme, WINDOW_BACKGROUND } from '@shared/theme'
import { THEME_SETTINGS } from '@shared/types'
import { activateTheme, applyTheme, THEME_ATTRIBUTE } from './theme'

describe('resolveTheme', () => {
  it('follows the machine for "system"', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('ignores the machine for an explicit choice', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('answers one of the two palettes for every setting', () => {
    for (const setting of THEME_SETTINGS) {
      for (const prefersDark of [true, false]) {
        expect(['light', 'dark']).toContain(resolveTheme(setting, prefersDark))
      }
    }
  })
})

/**
 * Enough of a document and a media query to drive `applyTheme` in plain Node.
 *
 * No jsdom: the module touches exactly two globals, and faking them here keeps
 * the suite's only DOM dependency visible in the file that needs it. The fake
 * media query also lets a test do the thing a real one cannot be asked to do —
 * flip at will — which is the behaviour `'system'` exists for.
 */
function fakeEnvironment(prefersDark: boolean): {
  theme: () => string | undefined
  flip: (toDark: boolean) => void
  listeners: () => number
} {
  const attributes = new Map<string, string>()
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute: (name: string, value: string) => attributes.set(name, value)
    }
  })

  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  let matches = prefersDark
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return matches
    },
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener)
    }
  }))

  return {
    theme: () => attributes.get(THEME_ATTRIBUTE),
    flip: (toDark) => {
      matches = toDark
      for (const listener of listeners) listener({ matches: toDark } as MediaQueryListEvent)
    },
    listeners: () => listeners.size
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('applyTheme', () => {
  it('stamps the resolved theme on the document element', () => {
    const environment = fakeEnvironment(true)

    applyTheme('light')
    expect(environment.theme()).toBe('light')

    applyTheme('system')
    expect(environment.theme()).toBe('dark')
  })

  it('re-stamps when the machine flips, but only for "system"', () => {
    const environment = fakeEnvironment(true)

    const stop = applyTheme('system')
    environment.flip(false)
    expect(environment.theme()).toBe('light')

    // An explicit choice subscribes to nothing, so the same flip changes nothing
    // — once the previous subscription has been dropped. `applyTheme` hands that
    // job to its caller, which is precisely what `activateTheme` was added to do:
    // the raw function left to itself would keep the old listener alive.
    stop()
    applyTheme('dark')
    environment.flip(true)
    environment.flip(false)
    expect(environment.theme()).toBe('dark')
  })

  it('stops following the machine when its unsubscribe is called', () => {
    const environment = fakeEnvironment(true)

    const stop = applyTheme('system')
    expect(environment.listeners()).toBe(1)
    stop()
    expect(environment.listeners()).toBe(0)

    environment.flip(false)
    expect(environment.theme()).toBe('dark')
  })

  it('returns a no-op unsubscribe for an explicit setting', () => {
    fakeEnvironment(false)
    expect(() => applyTheme('dark')()).not.toThrow()
  })
})

describe('activateTheme', () => {
  it('keeps exactly one subscription, whatever the user clicks through', () => {
    const environment = fakeEnvironment(true)

    activateTheme('system')
    activateTheme('system')
    expect(environment.listeners()).toBe(1)

    // Leaving "system" must really stop following the machine: an OS that flips
    // at sunset would otherwise repaint an app that was explicitly set to light.
    activateTheme('light')
    expect(environment.listeners()).toBe(0)
    environment.flip(true)
    expect(environment.theme()).toBe('light')
  })
})

/**
 * `index.css` as text.
 *
 * Vite's raw glob rather than `node:fs`, for the same reason `used-keys.test.ts`
 * gives: the renderer project has no Node types, so a renderer file — test or
 * not — must not import `fs`.
 */
const css = Object.values(
  import.meta.glob<string>('../index.css', { query: '?raw', import: 'default', eager: true })
)[0] as string

/** The `@theme static { … }` block: the dark palette, which is the base. */
function themeBlock(): string {
  const start = css.indexOf('@theme static {')
  const end = css.indexOf('\n}', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end)
}

/** The `:root[data-theme='light'] { … }` block: the override. */
function lightBlock(): string {
  const start = css.indexOf(":root[data-theme='light'] {")
  const end = css.indexOf('\n}', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end)
}

function tokensIn(block: string): string[] {
  return [...block.matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string)
}

function valueOf(block: string, token: string): string | undefined {
  return new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(block)?.[1]?.trim()
}

/**
 * Tokens that are the same colour in both palettes, on purpose.
 *
 * The rule S5.8 wrote is "every token is overridden, and the override differs" —
 * the second half catches a block pasted across without being re-picked. A brand
 * colour is the one thing that legitimately fails it: `--color-brand-point` is
 * the terracotta at the centre of the mark (S7.1), and a mark whose colour
 * shifted with the appearance would be two marks rather than one identity. It is
 * still required to be *declared* in both blocks, which is what the test below
 * this one asserts, so it stays visible to the check rather than exempt from it.
 *
 * Keep this set tiny. A colour is a candidate only if it is an identity — never
 * because a light value was hard to pick.
 */
const CONSTANT_TOKENS = new Set(['--color-brand-point'])

describe('the light palette', () => {
  const dark = tokensIn(themeBlock())
  const light = tokensIn(lightBlock())

  it('finds the tokens it is checking', () => {
    // A guard on the guard: a refactor that renames the blocks must not turn this
    // file into a test that passes by matching nothing.
    expect(dark.length).toBeGreaterThan(20)
  })

  it('overrides every --color-* token the dark palette defines', () => {
    expect([...dark].sort()).toEqual([...new Set(light)].sort())
  })

  it('gives every override a different value from the dark one', () => {
    const darkBlock = themeBlock()
    const overrides = lightBlock()
    for (const token of dark) {
      if (CONSTANT_TOKENS.has(token)) continue
      expect(valueOf(overrides, token), token).not.toBe(valueOf(darkBlock, token))
    }
  })

  it('repeats the constant tokens verbatim rather than dropping them', () => {
    // The exception has to be *stated* in both blocks, not inferred from a
    // missing line: the check above is what proves the override exists at all,
    // and a brand colour that silently fell back to the dark block would be a
    // token this file no longer watches.
    const darkBlock = themeBlock()
    const overrides = lightBlock()
    for (const token of CONSTANT_TOKENS) {
      expect(dark, token).toContain(token)
      expect(valueOf(overrides, token), token).toBe(valueOf(darkBlock, token))
    }
  })

  it('declares color-scheme on both roots, so native controls follow', () => {
    expect(/:root\s*\{\s*color-scheme:\s*dark;/.test(css)).toBe(true)
    expect(lightBlock()).toContain('color-scheme: light;')
  })

  it('agrees with the window background the main process paints first', () => {
    // The one duplicated colour in the app: `createWindow` needs a string before
    // any stylesheet exists. If these drift, launching shows a flash of the wrong
    // colour before the first frame — the one bug a running app cannot correct.
    expect(valueOf(themeBlock(), '--color-bg-base')).toBe(WINDOW_BACKGROUND.dark)
    expect(valueOf(lightBlock(), '--color-bg-base')).toBe(WINDOW_BACKGROUND.light)
  })
})
