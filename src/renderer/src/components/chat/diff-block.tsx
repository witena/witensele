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
 * follows).
 *
 * ## The path opens the file (S5.7)
 *
 * The header line is one `<button>` that expands the patch, and the path inside
 * it is a second one that opens the file in the editor — nested controls are not
 * allowed, so the header is a flex row of two buttons rather than a button
 * containing a link. The path is the natural target: a reviewer reading "23 lines
 * changed in `src/main/index.ts`" wants either the diff or the file, and both are
 * now one click from the same line.
 *
 * `DiffPart.path` is **relative** to the chat's folder (the tools return the
 * resolved-then-relativised path), so it is absolutised here before it is sent;
 * a diff in a chat whose folder has since been cleared has nothing to resolve
 * against and the path stays plain text.
 */
import clsx from 'clsx'
import { ChevronRight, FileDiff } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DiffPart } from '@shared/types'
import { openInEditor } from '../../lib/editor'
import { CodeBlock } from './code-block'
import { absoluteInWorkdir } from './file-refs'
import { countDiffLines } from './transcript-rows'

export interface DiffBlockProps {
  part: DiffPart
  /** The chat the diff is in; the backend confines the path to its folder. */
  chatId?: string | undefined
  /** That chat's working directory; `DiffPart.path` is relative to it. */
  workdir?: string | null | undefined
}

export function DiffBlock({ part, chatId, workdir }: DiffBlockProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { added, removed } = countDiffLines(part.patch)
  const target = absoluteInWorkdir(workdir, part.path)

  return (
    <div
      data-testid="diff-block"
      data-path={part.path}
      className="flex flex-col gap-1 rounded-lg border border-border-strong bg-bg-elevated px-2.5 py-2"
    >
      <div className="flex w-full items-center gap-2 text-xs text-fg-dim">
        <button
          type="button"
          data-testid="diff-block-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 shrink items-center gap-2 text-left transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          <ChevronRight
            aria-hidden="true"
            className={clsx('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
          />
          <FileDiff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {target === null ? (
            <span data-testid="diff-block-path" className="min-w-0 truncate font-mono">
              {part.path}
            </span>
          ) : null}
        </button>

        {target === null ? null : (
          <button
            type="button"
            data-testid="diff-block-path"
            data-path={part.path}
            title={t('chat.openInEditor')}
            onClick={() => {
              void openInEditor({ path: target, ...(chatId === undefined ? {} : { chatId }) }).catch(
                () => undefined
              )
            }}
            className="min-w-0 truncate font-mono transition-colors hover:text-accent hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            {part.path}
          </button>
        )}

        <span data-testid="diff-block-stat" className="ml-auto shrink-0 font-mono text-[11px]">
          <span className="text-status-ok">{`+${added}`}</span>{' '}
          <span className="text-danger">{`-${removed}`}</span>
        </span>
        <button
          type="button"
          data-testid="diff-block-more"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="shrink-0 text-[11px] text-fg-faint transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          {open ? t('chat.diffCollapse') : t('chat.diffExpand')}
        </button>
      </div>

      {open ? <CodeBlock language="diff" code={part.patch} /> : null}
    </div>
  )
}
