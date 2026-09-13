/**
 * The mockup's `.tool-card`: one line inside a message saying which tool the
 * agent called, with the input and the output a click away.
 *
 * Collapsed it is a wrench, `toolName(argsPreview)`, and a right-hand summary —
 * "running…", "n results · expand", or "error". Expanded it adds the
 * pretty-printed JSON of both halves, which is the only place a user can see
 * what a tool was actually asked and actually answered.
 *
 * The name line reads `serverName · toolName` for a tool that came from an MCP
 * server and the bare name for a built-in one; `tool-call.ts` computes it, and
 * `data-tool` stays the tool's own name so an end-to-end spec can address a card
 * without depending on which server provided it.
 *
 * ## The "open" icon (S5.7)
 *
 * A `read_file`, `write_file` or `edit_file` card is about one file, so it gets a
 * second control on the right that opens that file in the editor. It is a
 * sibling of the expand toggle rather than something inside it — a button cannot
 * contain a button — and it only appears when the path actually resolves inside
 * the chat's folder, so a card in a chat whose folder was cleared is the plain
 * S5.5 card again.
 *
 * Everything worth testing is in `tool-call.ts`; this file is the markup.
 */
import clsx from 'clsx'
import { SquareArrowOutUpRight, Wrench } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { openInEditor } from '../../lib/editor'
import { absoluteInWorkdir } from './file-refs'
import type { ToolCallDescription } from './tool-call'

/** Literal `t()` calls so the used-keys guard can see all three summaries. */
function summary(t: TFunction, call: ToolCallDescription): string {
  switch (call.state) {
    case 'running':
      return t('chat.toolRunning')
    case 'error':
      return t('chat.toolError')
    case 'done':
      return call.resultCount === null
        ? t('chat.toolDone')
        : // `results`, not `count`: `count` is i18next's plural trigger.
          t('chat.toolResults', { results: call.resultCount })
  }
}

export interface ToolCardProps {
  call: ToolCallDescription
  /** The chat the call happened in; the backend confines the path to its folder. */
  chatId?: string | undefined
  /** That chat's working directory, for a path the model wrote relatively. */
  workdir?: string | null | undefined
}

export function ToolCard({ call, chatId, workdir }: ToolCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const target = call.filePath === null ? null : absoluteInWorkdir(workdir, call.filePath)

  return (
    <div
      data-testid="tool-card"
      data-tool={call.toolName}
      data-server={call.serverName}
      data-state={call.state}
      className="flex flex-col gap-2 rounded-lg border border-border-strong bg-bg-elevated px-2.5 py-2 text-xs"
    >
      <div className="flex w-full items-center gap-2">
        <button
          type="button"
          data-testid="tool-card-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 grow items-center gap-2 text-left text-fg-dim transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          <Wrench aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span data-testid="tool-card-name" className="truncate font-mono">
            {`${call.label}(${call.argsPreview})`}
          </span>
          <span
            data-testid="tool-card-summary"
            className={clsx(
              'ml-auto shrink-0',
              call.state === 'error' ? 'text-danger' : 'text-fg-faint',
              call.state === 'running' && 'animate-pulse'
            )}
          >
            {call.state === 'running'
              ? summary(t, call)
              : `${summary(t, call)} · ${open ? t('chat.toolCollapse') : t('chat.toolExpand')}`}
          </span>
        </button>

        {target === null ? null : (
          <button
            type="button"
            data-testid="tool-card-open"
            data-path={call.filePath}
            aria-label={t('chat.openInEditor')}
            title={t('chat.openInEditor')}
            onClick={() => {
              void openInEditor({ path: target, ...(chatId === undefined ? {} : { chatId }) }).catch(
                () => undefined
              )
            }}
            className="shrink-0 rounded p-0.5 text-fg-faint transition-colors hover:text-accent focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            <SquareArrowOutUpRight aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open ? (
        <div data-testid="tool-card-detail" className="flex flex-col gap-1.5">
          <span className="text-[10px] text-fg-faint">{t('chat.toolInput')}</span>
          <pre className="overflow-x-auto rounded border border-border bg-bg-panel p-2 font-mono text-[11px] leading-relaxed text-fg-secondary">
            {call.inputJson}
          </pre>
          {call.outputJson !== null ? (
            <>
              <span className="text-[10px] text-fg-faint">{t('chat.toolOutput')}</span>
              <pre className="overflow-x-auto rounded border border-border bg-bg-panel p-2 font-mono text-[11px] leading-relaxed text-fg-secondary">
                {call.outputJson}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
