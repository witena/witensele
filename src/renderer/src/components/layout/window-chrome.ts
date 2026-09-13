/**
 * Constants for living under `titleBarStyle: 'hiddenInset'`.
 *
 * With the system title bar hidden, macOS still draws the three traffic lights
 * over the top-left of the *content*, roughly x 13–70, y 6–26. Two consequences
 * the whole shell has to respect:
 *
 * 1. Nothing may be placed under them. `TRAFFIC_LIGHT_INSET` is the top padding
 *    the navigation rail and the leftmost column header use to clear them. It is
 *    why those headers sit lower than the mockup's 14px — the mockup has no
 *    window chrome to design around.
 * 2. The window has nothing to drag by unless the app says so. `DRAG_REGION`
 *    marks a surface draggable and `NO_DRAG` opts a control back out; both are
 *    utilities defined in `index.css`. Forgetting `NO_DRAG` on a button inside a
 *    drag region makes it unclickable, which is the failure this pair exists to
 *    make obvious.
 */

/** Top padding that clears the macOS traffic lights (32px). */
export const TRAFFIC_LIGHT_INSET = 'pt-8'

/** Marks a surface as a window drag handle. */
export const DRAG_REGION = 'drag-region'

/** Opts a control inside a drag region back into receiving clicks. */
export const NO_DRAG = 'no-drag'
