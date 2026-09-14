/**
 * The permission prompt: one card above the composer per call the executor is
 * waiting on.
 *
 * PLAN.md's executor "confirms before every write or command", and this is that
 * confirmation. The turn is suspended inside the tool call while the card is on
 * screen (`src/main/executor/permissions.ts`), so the card is not a notification
 * — it is the thing the backend is blocked on.
 *
 * ## Why above the composer, and not a modal
 *
 * A modal would be the obvious choice for "nothing else matters until you
 * answer", and it is the wrong one here: several prompts can be open at once (a
 * parallel round, two chats), the transcript above is exactly the context needed
 * to judge the call, and the user must stay free to scroll it, read the tool
 * cards and switch chats. The card sits where the answer is given and stacks
 * oldest first.
 *
 * ## What it shows
 *
 * `describePermissionInput` decides; the rule that matters is that a
 * `run_command` command line is printed **verbatim** in monospace. The shell is
 * not sandboxed — only `cwd` is confined — so this prompt is the entire security
 * boundary, and a summarised command line would be a boundary that lies.
 *
 * ## Keyboard
 *
 * Enter allows, Escape denies, handled on the card itself rather than on the
 * document: a global listener would steal Enter from the composer, where Enter
 * means send. The oldest card takes focus when it appears, so the shortcuts work
 * without a click, and focus returns to whatever the user picks up next once the
 * card is gone.
 */
import clsx from 'clsx'
import { ShieldAlert } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { PermissionDecision } from '@shared/types'
import { useAgent } from '../../stores/agents'
import { useIsReplying, usePermissionsStore, type PendingPermission } from '../../stores/permissions'
import { Button } from '../ui'
import { CodeBlock } from './code-block'
import { describePermissionInput } from './permission-input'

export interface PermissionCardProps {
  request: PendingPermission
  /** True for the oldest open card: it takes the focus and the two shortcuts. */
  autoFocus?: boolean | undefined
}

export function PermissionCard({ request, autoFocus = false }: PermissionCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const agent = useAgent(request.agentId)
  const replying = useIsReplying(request.requestId)
  const card = useRef<HTMLElement>(null)

  const view = describePermissionInput(request.toolName, request.input)

  // The card itself takes the focus rather than the Allow button: a focused
  // default button is one stray Enter away from being pressed by a user who was
  // typing, and the point of this card is that allowing is a decision.
  useEffect(() => {
    if (autoFocus) card.current?.focus()
  }, [autoFocus, request.requestId])

  const answer = (decision: PermissionDecision): void => {
    void usePermissionsStore.getState().reply(request.requestId, decision)
  }

  return (
    <section
      ref={card}
      // Focusable but not in the tab order: the two shortcuts need a focused
      // element, and a card that stole a Tab stop would fight the composer.
      tabIndex={-1}
      aria-label={t('chat.permissionTitle')}
      data-testid="permission-card"
      data-request-id={request.requestId}
      data-tool={request.toolName}
      data-agent-id={request.agentId}
      className="flex flex-col gap-2 rounded-[10px] border border-accent/60 bg-bg-elevated px-3 py-2.5 focus:outline-none"
      onKeyDown={(event) => {
        if (replying) return
        if (event.key === 'Enter') {
          event.preventDefault()
          answer('allow')
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          answer('deny')
        }
      }}
    >
      <div className="flex items-center gap-2 text-xs">
        <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span data-testid="permission-card-title" className="min-w-0 truncate text-fg">
          {t('chat.permissionRequest', {
            agent: agent?.name ?? request.agentId,
            tool: request.toolName
          })}
        </span>
      </div>

      {view.path !== undefined ? (
        <p data-testid="permission-card-path" className="truncate font-mono text-[11px] text-fg-dim">
          {view.path}
        </p>
      ) : null}

      {view.kind === 'diff' ? (
        <CodeBlock language="diff" code={view.body} />
      ) : (
        <pre
          data-testid="permission-card-body"
          data-kind={view.kind}
          className={clsx(
            'max-h-48 overflow-auto rounded border border-border bg-bg-panel p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap',
            view.kind === 'command' ? 'text-fg' : 'text-fg-secondary'
          )}
        >
          {view.body}
        </pre>
      )}

      {view.truncated ? (
        <p className="text-[10px] text-fg-faint">{t('chat.permissionTruncated')}</p>
      ) : null}

      {view.kind === 'command' ? (
        <p data-testid="permission-card-command-hint" className="text-[10px] text-fg-faint">
          {t('chat.permissionCommandHint')}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          data-testid="permission-allow"
          disabled={replying}
          onClick={() => answer('allow')}
        >
          {t('chat.permissionAllow')}
        </Button>
        <Button
          size="sm"
          data-testid="permission-allow-always"
          disabled={replying}
          onClick={() => answer('allowAlways')}
        >
          {t('chat.permissionAllowAlways')}
        </Button>
        <Button
          variant="danger"
          size="sm"
          data-testid="permission-deny"
          disabled={replying}
          onClick={() => answer('deny')}
        >
          {t('chat.permissionDeny')}
        </Button>
        <span className="ml-auto shrink-0 text-[10px] text-fg-faint">
          {t('chat.permissionKeyHint')}
        </span>
      </div>
    </section>
  )
}
