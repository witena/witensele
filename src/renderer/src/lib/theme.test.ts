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
import { AVATAR_PALETTE_INDEXES, THEME_SETTINGS } from '@shared/types'
import { AA_LARGE, AA_NORMAL, contrastRatio, formatRatio } from './contrast'
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

/**
 * One `@media (…) { … }` block, by the condition it opens with.
 *
 * Counts braces rather than looking for `\n}`, because unlike the two palette
 * blocks a media query *contains* rules — the first `\n}` inside one is the end
 * of its `:root` selector, not of the query.
 */
function mediaBlock(condition: string): string {
  const start = css.indexOf(`@media (${condition})`)
  expect(start, condition).toBeGreaterThan(-1)
  let depth = 0
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start, index + 1)
    }
  }
  throw new Error(`Unclosed @media (${condition})`)
}

/** The two selectors an appearance-aware block has to state separately. */
function blocksInside(media: string): { dark: string; light: string } {
  const lightStart = media.indexOf(":root[data-theme='light']")
  expect(lightStart).toBeGreaterThan(-1)
  return { dark: media.slice(0, lightStart), light: media.slice(lightStart) }
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

  it('defines all eight avatar slots, both ways, in both palettes', () => {
    // A tile painted from `var(--color-avatar-6-fg)` that no block defines is an
    // invisible monogram, and only on whichever agent happened to pick slot 6.
    for (const block of [themeBlock(), lightBlock()]) {
      for (const index of AVATAR_PALETTE_INDEXES) {
        expect(valueOf(block, `--color-avatar-${index}-bg`), `${index}-bg`).toMatch(/^#/)
        expect(valueOf(block, `--color-avatar-${index}-fg`), `${index}-fg`).toMatch(/^#/)
      }
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Contrast (S5.17)                                                            */
/* -------------------------------------------------------------------------- */

/** The six surfaces anything in the app can be drawn on. */
const SURFACES = ['base', 'panel', 'rail', 'elevated', 'hover', 'muted'].map(
  (name) => `--color-bg-${name}`
)

/**
 * The foreground steps that carry running text, and the bar each is held to.
 *
 * `fg`, `fg-secondary` and `fg-muted` are body copy — names, message bodies,
 * descriptions, every label on every form — so they are AA-normal on **every**
 * surface, not just on the one the designer had in mind. The accent joins them
 * because it is the colour of a link and of a primary button's label.
 *
 * `fg-dim` and `fg-faint` are the small print: timestamps, hints under a field,
 * the model line under an agent's name. They are held to AA-large (3:1), which
 * is the floor WCAG puts under *any* meaningful pixel — and S5.17 raised both,
 * because on `bg-hover` the old values were 4.00:1 and **2.74:1**, so a hovered
 * row failed even that.
 */
const TEXT_STEPS: readonly { token: string; bar: number }[] = [
  { token: '--color-fg', bar: AA_NORMAL },
  { token: '--color-fg-secondary', bar: AA_NORMAL },
  { token: '--color-fg-muted', bar: AA_NORMAL },
  { token: '--color-accent', bar: AA_NORMAL },
  { token: '--color-danger', bar: AA_NORMAL },
  { token: '--color-fg-dim', bar: AA_LARGE },
  { token: '--color-fg-faint', bar: AA_LARGE }
]

/** Reads a palette block into a lookup, so a test can ask for any token by name. */
function paletteOf(block: string): (token: string) => string {
  return (token) => {
    const value = valueOf(block, token)
    expect(value, token).toBeDefined()
    return value as string
  }
}

describe('palette contrast', () => {
  const palettes = [
    { name: 'dark', read: paletteOf(themeBlock()) },
    { name: 'light', read: paletteOf(lightBlock()) }
  ]

  it.each(palettes)('keeps every text step readable on every surface ($name)', ({ read }) => {
    const failures: string[] = []
    for (const step of TEXT_STEPS) {
      for (const surface of SURFACES) {
        const ratio = contrastRatio(read(step.token), read(surface))
        if (ratio < step.bar) {
          failures.push(`${step.token} on ${surface}: ${formatRatio(ratio)} < ${step.bar}`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  it.each(palettes)('keeps every monogram readable on its own tile ($name)', ({ read }) => {
    const failures: string[] = []
    for (const index of AVATAR_PALETTE_INDEXES) {
      const ratio = contrastRatio(read(`--color-avatar-${index}-fg`), read(`--color-avatar-${index}-bg`))
      // A monogram is bold, but it is also 10–13px: AA-normal, not AA-large.
      if (ratio < AA_NORMAL) failures.push(`avatar ${index}: ${formatRatio(ratio)}`)
    }
    const neutral = contrastRatio(read('--color-avatar-neutral-fg'), read('--color-avatar-neutral-bg'))
    if (neutral < AA_NORMAL) failures.push(`avatar neutral: ${formatRatio(neutral)}`)
    const user = contrastRatio(read('--color-avatar-user-fg'), read('--color-avatar-user'))
    if (user < AA_NORMAL) failures.push(`avatar user: ${formatRatio(user)}`)
    expect(failures).toEqual([])
  })

  it.each(palettes)('keeps every status pill readable on its own surface ($name)', ({ read }) => {
    const failures: string[] = []
    for (const tone of ['ok', 'warn', 'idle']) {
      const ratio = contrastRatio(read(`--color-status-${tone}`), read(`--color-status-${tone}-surface`))
      if (ratio < AA_NORMAL) failures.push(`status ${tone}: ${formatRatio(ratio)}`)
    }
    expect(failures).toEqual([])
  })

  it.each(palettes)('keeps a presence dot visible on the panel it sits on ($name)', ({ read }) => {
    // A dot is not text; AA-large is the non-text floor and the right bar here.
    const failures: string[] = []
    for (const state of ['available', 'working', 'away', 'offline']) {
      const ratio = contrastRatio(read(`--color-presence-${state}`), read('--color-bg-panel'))
      if (ratio < AA_LARGE) failures.push(`presence ${state}: ${formatRatio(ratio)}`)
    }
    expect(failures).toEqual([])
  })

  it('keeps the light foreground steps at least as strong as the dark ones', () => {
    // S5.8's promise, finally measured: the light theme is not allowed to be the
    // quieter of the two, because "it looked fine on my screen" is how a palette
    // that is 3:1 in a bright room gets shipped.
    //
    // The *neutral* steps only. The accent and the danger hue are held to AA
    // above and to nothing else: they are one hue each, and forcing a light red
    // to match a pale dark red's 7:1 would produce a near-black that no longer
    // reads as a warning.
    const dark = paletteOf(themeBlock())
    const light = paletteOf(lightBlock())
    const failures: string[] = []
    for (const step of TEXT_STEPS.filter((candidate) => candidate.token.startsWith('--color-fg'))) {
      const darkRatio = contrastRatio(dark(step.token), dark('--color-bg-base'))
      const lightRatio = contrastRatio(light(step.token), light('--color-bg-base'))
      // Half a point of slack: these are two different hue families, and the
      // rule is "no quieter", not "identical to two decimal places".
      if (lightRatio < darkRatio - 0.5) {
        failures.push(`${step.token}: light ${formatRatio(lightRatio)} < dark ${formatRatio(darkRatio)}`)
      }
    }
    expect(failures).toEqual([])
  })
})

describe('the accessibility preferences', () => {
  it('answers prefers-contrast in both appearances, not just the base one', () => {
    // The light palette's selector outranks a bare `:root` whatever the source
    // order, so a single unqualified block would strengthen dark and silently do
    // nothing in light. That is the mistake this assertion exists to catch.
    const { dark, light } = blocksInside(mediaBlock('prefers-contrast: more'))
    expect([...new Set(tokensIn(dark))].sort()).toEqual([...new Set(tokensIn(light))].sort())
    expect(tokensIn(dark).length).toBeGreaterThan(0)
  })

  it('raises the quiet steps rather than restating them', () => {
    const media = mediaBlock('prefers-contrast: more')
    const { dark, light } = blocksInside(media)
    const base = { normal: paletteOf(themeBlock()), more: paletteOf(dark) }
    const alt = { normal: paletteOf(lightBlock()), more: paletteOf(light) }

    for (const palette of [base, alt]) {
      for (const token of tokensIn(dark)) {
        const before = contrastRatio(palette.normal(token), palette.normal('--color-bg-base'))
        const after = contrastRatio(palette.more(token), palette.normal('--color-bg-base'))
        expect(after, token).toBeGreaterThan(before)
      }
    }
  })

  it('makes the one translucent surface opaque under prefers-reduced-transparency', () => {
    const { dark, light } = blocksInside(mediaBlock('prefers-reduced-transparency: reduce'))
    for (const block of [dark, light]) {
      expect(tokensIn(block)).toEqual(['--color-bg-subtle'])
      // Six digits, not eight: the whole point is that no alpha channel is left.
      expect(valueOf(block, '--color-bg-subtle')).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('has exactly one token with an alpha channel to answer for', () => {
    // If a second translucent token appears, the media query above has to grow
    // with it — and this is the assertion that says so, rather than a reviewer
    // noticing a `/60` in a diff.
    const withAlpha = (block: string): string[] =>
      tokensIn(block).filter((token) => /^#[0-9a-f]{8}$/.test(valueOf(block, token) ?? ''))
    expect(withAlpha(themeBlock())).toEqual(['--color-bg-subtle'])
    expect(withAlpha(lightBlock())).toEqual(['--color-bg-subtle'])
  })
})
