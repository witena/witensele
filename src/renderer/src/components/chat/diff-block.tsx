/**
 * One file the executor changed, as a collapsible block headed by its path.
 *
 * The patch comes from the write tools (`createPatch`, `src/main/executor/`) and
 * is appended to the executor's message as a `DiffPart` when its turn ends, one
 * part per file. Rendering goes through the existing `CodeBlock` with the `diff`
 * language, so the block gets the same header, the same Copy button and the same
 * highlighting every fenced diff in a message already has — a second diff
 * renderer would be a second place for the colours to drift.
 *
 * **Collapsed by default.** A turn that touched six files would otherwise push
 * the agent's own summary — the thing worth reading first — off the screen. The
 * header line carries the path and the `+`/`-` counts, which is enough to decide
 * whether to open it.
 *
 * The path is data and is never translated (the rule the working-directory chip
 * follows). S5.7 makes it open the file in the editor; here it is text.
 */
import clsx from 'clsx'
import { ChevronRight, FileDiff } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DiffPart } from '@shared/types'
import { CodeBlock } from './code-block'
import { countDiffLines } from './transcript-rows'

export interface DiffBlockProps {
  part: DiffPart
}

export function DiffBlock({ part }: DiffBlockProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { added, removed } = countDiffLines(part.patch)

  return (
    <div
      data-testid="diff-block"
      data-path={part.path}
      className="flex flex-col gap-1 rounded-lg border border-border-strong bg-bg-elevated px-2.5 py-2"
    >
      <button
        type="button"
        data-testid="diff-block-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 text-left text-xs text-fg-dim transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        <ChevronRight
          aria-hidden="true"
          className={clsx('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <FileDiff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span data-testid="diff-block-path" className="min-w-0 truncate font-mono">
          {part.path}
        </span>
        <span data-testid="diff-block-stat" className="ml-auto shrink-0 font-mono text-[11px]">
          <span className="text-status-ok">{`+${added}`}</span>{' '}
          <span className="text-danger">{`-${removed}`}</span>
        </span>
        <span className="shrink-0 text-[11px] text-fg-faint">
          {open ? t('chat.diffCollapse') : t('chat.diffExpand')}
        </span>
      </button>

      {open ? <CodeBlock language="diff" code={part.patch} /> : null}
    </div>
  )
}
