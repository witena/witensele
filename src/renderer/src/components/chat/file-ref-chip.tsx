/**
 * A `path:line` reference in a message, as a chip that opens the file (S5.7).
 *
 * S5.5 drew this chip and made clicking it **copy** the reference, explicitly as
 * a placeholder: the editor integration did not exist, and a chip that did
 * nothing on click would have been a button that lies. It exists now, so the
 * click opens the file at that line in whatever Settings → Developer → Editor
 * says, and the copy behaviour is gone rather than kept beside it — a 20-pixel
 * target with two meanings is worse than either meaning on its own, and the
 * reference is still selectable text in the message it came from.
 *
 * Two chips exist, from two sources, and they are deliberately the same
 * component: a `FileRefPart` stored on a message (nothing emits one yet — see the
 * Phase 6 backlog) and a token the detector found in the body text
 * (`file-refs.ts`). Both arrive here as a part plus the absolute path to open.
 *
 * ## When it is not a button
 *
 * Without an absolute path there is nothing to open — a stored `FileRefPart`
 * whose path is relative, in a chat that is not bound to a folder — so the chip
 * renders as plain text rather than as a control that would reject on every
 * click.
 *
 * The label is the reference itself and is never translated: a path is data. The
 * tooltip and the failure state are the chip's own copy and are `t()` keys.
 */
import clsx from 'clsx'
import { FileCode, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileRefPart } from '@shared/types'
import { openInEditor } from '../../lib/editor'
import { absoluteInWorkdir } from './file-refs'
import { formatFileRef } from './transcript-rows'

/** How long the chip stays in its "that did not work" state. */
export const FAILED_FEEDBACK_MS = 2_500

export interface FileRefChipProps {
  part: FileRefPart
  /** The chat the reference is in; the backend confines the path to its folder. */
  chatId?: string | undefined
  /** That chat's working directory, used to absolutise a relative reference. */
  workdir?: string | null | undefined
  /**
   * The absolute path to open, when the caller already worked it out.
   *
   * The detector resolves every token it finds, so passing its answer through
   * saves resolving the same string twice — and is the only way a chip can open
   * a reference that came from text in the first place.
   */
  absolute?: string | null | undefined
}

export function FileRefChip({
  part,
  chatId,
  workdir,
  absolute
}: FileRefChipProps): React.JSX.Element {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const label = formatFileRef(part)
  const target = absolute ?? absoluteInWorkdir(workdir, part.path)

  // A message can scroll out of the virtualized list mid-feedback.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const open = (): void => {
    if (target === null || target === undefined) return
    setFailed(false)
    void openInEditor({
      path: target,
      ...(part.line === undefined ? {} : { line: part.line }),
      ...(chatId === undefined ? {} : { chatId })
    }).catch(() => {
      setFailed(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setFailed(false), FAILED_FEEDBACK_MS)
    })
  }

  const shared = clsx(
    'inline-flex max-w-full items-center gap-1 rounded border border-border-strong bg-bg-elevated px-1.5 py-0.5',
    'font-mono text-[11px]'
  )

  if (target === null || target === undefined) {
    return (
      <span
        data-testid="file-ref"
        data-path={part.path}
        data-openable="false"
        {...(part.line === undefined ? {} : { 'data-line': part.line })}
        className={clsx(shared, 'text-fg-faint')}
      >
        <FileCode aria-hidden="true" className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    )
  }

  return (
    <button
      type="button"
      data-testid="file-ref"
      data-path={part.path}
      data-openable="true"
      {...(part.line === undefined ? {} : { 'data-line': part.line })}
      title={failed ? t('chat.fileRefFailed') : t('chat.fileRefTitle')}
      onClick={open}
      className={clsx(
        shared,
        'transition-colors focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
        failed ? 'text-danger' : 'text-fg-dim hover:text-accent'
      )}
    >
      {failed ? (
        <TriangleAlert aria-hidden="true" className="h-3 w-3 shrink-0" />
      ) : (
        <FileCode aria-hidden="true" className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </button>
  )
}
