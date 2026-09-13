/**
 * A `path:line` reference in a message, as a clickable chip.
 *
 * `FileRefPart` has been in `MessagePart` since S1.1, reserved for exactly this;
 * S5.5 is where it gets a rendering. **Clicking copies the reference** — the
 * editor integration is S5.7, and until it exists a chip that did nothing on
 * click would be a button that lies. Copying is the useful half of "open this
 * file" that needs no settings, no URL scheme and no installed editor.
 *
 * The label is the reference itself and is never translated: a path is data. The
 * tooltip and the copy confirmation are the card's own copy and are `t()` keys.
 */
import clsx from 'clsx'
import { Check, FileCode } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileRefPart } from '@shared/types'
import { formatFileRef } from './transcript-rows'

/** How long the chip stays in its "copied" state, matching `CodeBlock`. */
export const COPIED_FEEDBACK_MS = 1_500

export interface FileRefChipProps {
  part: FileRefPart
}

export function FileRefChip({ part }: FileRefChipProps): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const label = formatFileRef(part)

  // A message can scroll out of the virtualized list mid-confirmation.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const copy = (): void => {
    void navigator.clipboard?.writeText(label).catch(() => undefined)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
  }

  return (
    <button
      type="button"
      data-testid="file-ref"
      data-path={part.path}
      {...(part.line === undefined ? {} : { 'data-line': part.line })}
      title={t('chat.fileRefTitle')}
      onClick={copy}
      className={clsx(
        'inline-flex max-w-full items-center gap-1 rounded border border-border-strong bg-bg-elevated px-1.5 py-0.5',
        'font-mono text-[11px] transition-colors',
        'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
        copied ? 'text-accent' : 'text-fg-dim hover:text-fg'
      )}
    >
      {copied ? (
        <Check aria-hidden="true" className="h-3 w-3 shrink-0" />
      ) : (
        <FileCode aria-hidden="true" className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </button>
  )
}
