/**
 * The mockup's `.tool-card`: one line inside a message saying which tool the
 * agent called, with the input and the output a click away.
 *
 * Collapsed it is a wrench, `toolName(argsPreview)`, and a right-hand summary —
 * "running…", "n results · expand", or "error". Expanded it adds the
 * pretty-printed JSON of both halves, which is the only place a user can see
 * what a tool was actually asked and actually answered.
 *
 * Everything worth testing is in `tool-call.ts`; this file is the markup. No
 * tool exists until S3.1, so the card is exercised by unit tests over fixtures
 * rather than by a running server.
 */
import clsx from 'clsx'
import { Wrench } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
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
}

export function ToolCard({ call }: ToolCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <div
      data-testid="tool-card"
      data-tool={call.toolName}
      data-state={call.state}
      className="flex flex-col gap-2 rounded-lg border border-border-strong bg-bg-elevated px-2.5 py-2 text-xs"
    >
      <button
        type="button"
        data-testid="tool-card-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 text-left text-fg-dim transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        <Wrench aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span data-testid="tool-card-name" className="truncate font-mono">
          {`${call.toolName}(${call.argsPreview})`}
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
