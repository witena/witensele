/**
 * The shell's first modal (S9.3): a scrim, a panel, and the three behaviours a
 * dialog has to have before it is one.
 *
 * Everything before this step that needed a decision from the user asked for it
 * in place — the two-step Delete on the Agents page, the rename row in the chat
 * list, the popover the member picker opens. That is still the right shape for a
 * confirmation and for a single field. The New chat dialog is the first thing
 * that is genuinely *modal*: it composes three independent choices (a title, a
 * committee, a set of agents) into one write, and half of it applied to the
 * screen behind would be a chat nobody asked for.
 *
 * ## What it owns
 *
 * - **`role="dialog"` + `aria-modal="true"`**, labelled by its own heading, so a
 *   screen reader announces the panel rather than reading the page under it.
 * - **Escape closes**, from a capturing listener on the document: the panel's
 *   own fields swallow key events (the title `Input` is a text field), and a
 *   handler on the panel would never see the keystroke that matters.
 * - **The backdrop closes**, on `mousedown` and only when the press *started* on
 *   the scrim itself. A `click` would also fire for a drag that began on a
 *   label inside the panel and ended outside it, which is a selection, not a
 *   dismissal.
 * - **Focus is trapped and restored.** The first focusable child is focused on
 *   open, Tab and Shift+Tab cycle inside the panel, and whatever had focus
 *   before is given it back on close. Without the last part, closing the dialog
 *   would drop focus on `<body>` and a keyboard user would start the next Tab
 *   from the top of the window.
 *
 * ## What it does not own
 *
 * No `open` prop and no animation: the caller renders it or does not, which is
 * what makes "open" a single fact in one store rather than a prop and a piece of
 * component state that can disagree. And no portal — the app is one window with
 * no transformed ancestors, so `fixed inset-0` is already relative to the
 * viewport, and rendering in place keeps the dialog inside the React tree that
 * owns its data.
 *
 * Colours are tokens like everywhere else; the scrim is `--color-overlay`, which
 * is declared in both palettes and goes opaque under
 * `prefers-reduced-transparency` (see `index.css`).
 */
import clsx from 'clsx'
import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { IconButton } from './icon-button'

/**
 * What counts as focusable for the trap.
 *
 * Deliberately the plain list rather than a library: the panel's contents are
 * ordinary buttons, inputs and links, and anything with a positive `tabindex` is
 * already a bug of its own.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface DialogProps {
  /** The accessible name, rendered as the panel's heading. Already translated. */
  title: string
  /** The close button's label and tooltip. Already translated. */
  closeLabel: string
  /**
   * `data-testid` of the panel. The scrim carries `<testId>-backdrop`, so a test
   * can click *outside* the dialog without guessing at coordinates.
   */
  testId?: string | undefined
  /** The action row along the bottom, right aligned. Omit for a dialog with none. */
  footer?: ReactNode
  /** Extra classes for the panel; the width belongs to the caller. */
  className?: string | undefined
  onClose: () => void
  children: ReactNode
}

export function Dialog({
  title,
  closeLabel,
  testId,
  footer,
  className,
  onClose,
  children
}: DialogProps): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const headingId = useId()

  // Focus in on open, back where it came from on close. The panel itself is the
  // fallback target, which is why it carries `tabIndex={-1}`.
  useEffect(() => {
    const previous = document.activeElement
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? panel.current)?.focus()
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const nodes = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      if (nodes.length === 0) {
        // Nothing to move to; letting Tab through would leave the modal.
        event.preventDefault()
        return
      }

      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      const inside = active instanceof Node && panel.current?.contains(active) === true

      if (event.shiftKey ? !inside || active === first : !inside || active === last) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }

    // Capturing: a text field inside the panel would otherwise consume Escape.
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  return (
    <div
      data-testid={testId ? `${testId}-backdrop` : undefined}
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        data-testid={testId}
        className={clsx(
          'flex max-h-full min-h-0 w-full max-w-lg flex-col rounded-xl border border-border-strong bg-bg-elevated shadow-lg',
          'focus:outline-none',
          className
        )}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 id={headingId} className="truncate text-sm font-semibold text-fg">
            {title}
          </h2>
          <IconButton size="sm" label={closeLabel} data-testid="dialog-close" onClick={onClose}>
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </IconButton>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          {children}
        </div>

        {footer ? (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  )
}
