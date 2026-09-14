/**
 * The Witena mark — the "Aperture" — without its tile.
 *
 * Six blades close on a single point: many members converging on one answer.
 * The tiled version of the identical geometry is `build/icon.svg`, which becomes
 * the application icon; this is the same drawing with the white slab taken off,
 * so it can sit directly on the navigation rail in either theme.
 *
 * Three things are deliberate:
 *
 * - **The blades are `currentColor`, the point is a token.** The rail renders the
 *   mark inside `text-fg`, so the blades are ink on the light palette and near-white
 *   on the dark one with no branch, no second asset and no `data-theme` lookup —
 *   exactly how S5.8 wants a colour to change. The centre point is the one part
 *   that must *not* follow the theme, so it reads `--color-brand-point`, which is
 *   the same terracotta in both palettes (see `index.css`).
 * - **The geometry is exported as data, not drawn inline.** `BRAND_MARK_*` are
 *   plain values, so `brand-mark.test.ts` can assert the mark this component
 *   renders is the mark the application icon is cut from — in plain Node, with no
 *   DOM, no renderer and no screenshot. The repository has no jsdom setup (see
 *   `vitest.config.ts`, `environment: 'node'`), and this is the same answer
 *   `presence-dot.tsx` gives: put the checkable part in a value and test that.
 * - **It is decorative.** The rail is already labelled, and the product name is
 *   printed in the window title; an `aria-label` here would make a screen reader
 *   announce "Witena" before every navigation. So `aria-hidden`, and therefore no
 *   translated string — this component adds no locale key.
 */
import clsx from 'clsx'

/** The canvas the geometry is drawn on, shared with `build/icon.svg`. */
export const BRAND_MARK_VIEWBOX = '0 0 1024 1024'

/** Stroke width of the blades, on the 1024 canvas. */
export const BRAND_MARK_STROKE_WIDTH = 30

/**
 * The outer hexagon, its six corners eased with a 52 px radius so the mark has
 * no needle points at 16 px.
 */
export const BRAND_MARK_HEXAGON =
  'M 538.0 227.0 A 52 52 0 0 0 486.0 227.0 L 278.2 347.0 A 52 52 0 0 0 252.2 392.0 L 252.2 632.0 A 52 52 0 0 0 278.2 677.0 L 486.0 797.0 A 52 52 0 0 0 538.0 797.0 L 745.8 677.0 A 52 52 0 0 0 771.8 632.0 L 771.8 392.0 A 52 52 0 0 0 745.8 347.0 L 538.0 227.0 Z'

export interface BrandMarkBlade {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** The six chords that make the iris. Each starts at a hexagon corner. */
export const BRAND_MARK_BLADES: readonly BrandMarkBlade[] = [
  { x1: 512, y1: 212, x2: 338.8, y2: 512 },
  { x1: 252.2, y1: 362, x2: 425.4, y2: 662 },
  { x1: 252.2, y1: 662, x2: 598.6, y2: 662 },
  { x1: 512, y1: 812, x2: 685.2, y2: 512 },
  { x1: 771.8, y1: 662, x2: 598.6, y2: 362 },
  { x1: 771.8, y1: 362, x2: 425.4, y2: 362 }
]

/** The terracotta point the blades close on, at the centre of the canvas. */
export const BRAND_MARK_POINT = { cx: 512, cy: 512, r: 56 } as const

export interface BrandMarkProps {
  /** Sizing utilities; the mark fills whatever box it is given. */
  className?: string | undefined
  'data-testid'?: string | undefined
}

export function BrandMark({
  className,
  'data-testid': testId = 'brand-mark'
}: BrandMarkProps): React.JSX.Element {
  return (
    <svg
      data-testid={testId}
      aria-hidden="true"
      focusable="false"
      viewBox={BRAND_MARK_VIEWBOX}
      // The mark is all diagonals meeting at shallow angles. `geometricPrecision`
      // tells the renderer to anti-alias them rather than snap them to the pixel
      // grid, which is what `crispEdges` — and, at small sizes, the default
      // `auto` — would do to a 30px stroke scaled down to 28px of screen.
      shapeRendering="geometricPrecision"
      // Uniform scale, centred: the viewBox is square and the rail gives it a
      // square, whole-pixel box (`h-7 w-7` = 28px), so nothing is stretched and
      // no blade lands on a half pixel at 1x.
      preserveAspectRatio="xMidYMid meet"
      className={clsx('shrink-0', className)}
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={BRAND_MARK_STROKE_WIDTH}
        strokeLinecap="butt"
        strokeLinejoin="miter"
      >
        <path d={BRAND_MARK_HEXAGON} />
        {BRAND_MARK_BLADES.map((blade) => (
          <line
            key={`${blade.x1},${blade.y1}-${blade.x2},${blade.y2}`}
            x1={blade.x1}
            y1={blade.y1}
            x2={blade.x2}
            y2={blade.y2}
          />
        ))}
      </g>
      <circle
        cx={BRAND_MARK_POINT.cx}
        cy={BRAND_MARK_POINT.cy}
        r={BRAND_MARK_POINT.r}
        fill="var(--color-brand-point)"
      />
    </svg>
  )
}
