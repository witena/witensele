/**
 * The brand mark: one drawing, two places it is cut from.
 *
 * There is no DOM test setup in this repository — `vitest.config.ts` runs the
 * whole suite in `environment: 'node'` with no jsdom and no testing-library — so
 * this does not render React. It is the same answer `presence-dot.test.ts` gives:
 * the checkable part of the component is exported as *values*, and the values are
 * what gets asserted. Two subjects follow from that:
 *
 * 1. **The rail mark and the application icon are the same mark.** `build/icon.svg`
 *    is rasterised into `icon.icns` by a pipeline nothing in the suite runs, so a
 *    change to one of the two drawings would otherwise ship an app whose Dock icon
 *    and whose own navigation rail disagree. Comparing the geometry catches that in
 *    `npm test`, which is the only gate the icon has.
 * 2. **The rail renders the mark, not a letter** (the S7.1 acceptance criterion).
 *    `nav-rail.tsx` is read as source text, exactly as `theme.test.ts` reads
 *    `index.css` and `used-keys.test.ts` reads every component: a text assertion is
 *    a weak proof of rendering, and it is a complete proof of the thing that
 *    actually regressed here — the placeholder "W" tile coming back.
 *
 * Both files are read with Vite's raw glob rather than `node:fs`, because the
 * renderer project has no Node types (`tsconfig.web.json` lists only
 * `vite/client`), so a renderer file — test or not — must not import `fs`.
 */
import { describe, expect, it } from 'vitest'
import {
  BRAND_MARK_BLADES,
  BRAND_MARK_HEXAGON,
  BRAND_MARK_POINT,
  BRAND_MARK_STROKE_WIDTH,
  BRAND_MARK_VIEWBOX
} from './brand-mark'

function raw(pattern: string, glob: Record<string, string>): string {
  const found = Object.values(glob)[0]
  expect(found, pattern).toBeTypeOf('string')
  return found as string
}

/** `build/icon.svg` — the source the application icon is rendered from. */
const iconSvg = raw(
  'build/icon.svg',
  import.meta.glob<string>('../../../../../build/icon.svg', {
    query: '?raw',
    import: 'default',
    eager: true
  })
)

/** `build/icon-dark.svg` — the same mark on an ink tile, for dark surfaces. */
const iconDarkSvg = raw(
  'build/icon-dark.svg',
  import.meta.glob<string>('../../../../../build/icon-dark.svg', {
    query: '?raw',
    import: 'default',
    eager: true
  })
)

/** The component that inlines the mark, and the rail that mounts it. */
const brandMarkSource = raw(
  'brand-mark.tsx',
  import.meta.glob<string>('./brand-mark.tsx', {
    query: '?raw',
    import: 'default',
    eager: true
  })
)

const navRailSource = raw(
  'nav-rail.tsx',
  import.meta.glob<string>('../layout/nav-rail.tsx', {
    query: '?raw',
    import: 'default',
    eager: true
  })
)

describe('the mark and the application icon', () => {
  it('reads both sources', () => {
    // A guard on the guard: a moved file must fail here rather than turn every
    // assertion below into a comparison against an empty string.
    expect(iconSvg).toContain('<svg')
    expect(navRailSource).toContain('NavRail')
  })

  it('draws the same hexagon in the icon and in the component', () => {
    expect(iconSvg).toContain(BRAND_MARK_HEXAGON)
  })

  it('draws the same six blades', () => {
    expect(BRAND_MARK_BLADES).toHaveLength(6)
    for (const blade of BRAND_MARK_BLADES) {
      expect(
        iconSvg,
        `blade ${blade.x1},${blade.y1} → ${blade.x2},${blade.y2}`
      ).toContain(`x1="${blade.x1}" y1="${blade.y1}" x2="${blade.x2}" y2="${blade.y2}"`)
    }
  })

  it('gives every blade its own line', () => {
    const keys = BRAND_MARK_BLADES.map((b) => `${b.x1},${b.y1},${b.x2},${b.y2}`)
    expect(new Set(keys).size).toBe(BRAND_MARK_BLADES.length)
  })

  it('puts the point at the centre of the canvas, in both drawings', () => {
    expect(BRAND_MARK_VIEWBOX).toBe('0 0 1024 1024')
    expect(BRAND_MARK_POINT.cx).toBe(512)
    expect(BRAND_MARK_POINT.cy).toBe(512)
    expect(iconSvg).toContain(
      `<circle cx="${BRAND_MARK_POINT.cx}" cy="${BRAND_MARK_POINT.cy}" r="${BRAND_MARK_POINT.r}"`
    )
  })

  it('uses the same stroke weight', () => {
    expect(iconSvg).toContain(`stroke-width="${BRAND_MARK_STROKE_WIDTH}"`)
  })

  it('asks both renderers to anti-alias the diagonals', () => {
    // Every edge in this mark is a diagonal meeting another at a shallow angle.
    // Without the hint, a renderer is free to snap them to the pixel grid, which
    // is what produces the stair-stepping the mark must not have at any size.
    expect(iconSvg).toContain('shape-rendering="geometricPrecision"')
    expect(iconDarkSvg).toContain('shape-rendering="geometricPrecision"')
    expect(brandMarkSource).toContain('shapeRendering="geometricPrecision"')
  })

  it('keeps the tile bare: white fill, no stroked edge around it', () => {
    // The proposal drew a hairline around the tile on a light ground. A hairline
    // at 16px is a grey fuzz, so the shipped tile has none — and nothing but the
    // blades may carry a stroke.
    expect(iconSvg).toContain('<rect x="64" y="64" width="896" height="896" rx="200" fill="#ffffff"/>')
    expect(/<rect[^>]*stroke/.test(iconSvg)).toBe(false)
  })

  it('colours the blades by inheritance and the point by its token', () => {
    // The whole reason the mark needs no light and dark variant in the app.
    expect(brandMarkSource).toContain('stroke="currentColor"')
    expect(brandMarkSource).toContain('fill="var(--color-brand-point)"')
  })

  it('ships the terracotta literal in the icon, which cannot read a variable', () => {
    expect(iconSvg).toContain('#d97757')
    expect(iconDarkSvg).toContain('#d97757')
  })
})

describe('the navigation rail', () => {
  it('renders the mark component', () => {
    expect(navRailSource).toContain("import { BrandMark } from '../ui/brand-mark'")
    expect(navRailSource).toContain('<BrandMark')
  })

  it('no longer renders the placeholder letter tile', () => {
    // The exact markup S7.1 replaced. Its return would be invisible in a diff
    // that only looked at the import list.
    expect(navRailSource).not.toContain('bg-accent text-[13px] font-bold text-bg-base')
    expect(/>\s*W\s*</.test(navRailSource)).toBe(false)
  })

  it('sizes the mark in whole pixels, squarely', () => {
    // A square viewBox in a square, integer box: no non-uniform scaling and no
    // fractional CSS size, so no blade lands on a half pixel at 1x.
    expect(navRailSource).toMatch(/<BrandMark[^/]*className="[^"]*\bh-7 w-7\b/)
  })

  it('takes its blade colour from the palette in force', () => {
    expect(navRailSource).toMatch(/<BrandMark[^/]*className="[^"]*\btext-fg\b/)
  })
})
