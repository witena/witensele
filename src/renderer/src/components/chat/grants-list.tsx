/**
 * The **Always allowed** block of the group settings (S5.15).
 *
 * "Always allow in this chat" was the one decision in the product the user could
 * make and then never see again: S5.4 kept it in a `Set` for the life of the
 * process, precisely so that it could not become an invisible standing
 * permission. That worked by making the grant weak rather than by making it
 * visible, and it meant a user who clicked the button by accident had to quit
 * the app to undo it.
 *
 * This block is the other answer. The grants are rows in `permission_grants`,
 * they survive a restart, and they are listed here with a revoke button each —
 * which is what makes persisting them safe rather than merely convenient.
 *
 * ## What it does not show
 *
 * A grant is a **chat + tool** pair and that is all the row says. It carries no
 * agent, because the grant is not about one: a chat has one executor, and an
 * `allowAlways` on an MCP tool covers whichever member is bound to that server.
 * The date is not shown either — one line in a 288px column, and "when did I
 * grant this" is a question nobody has asked; the ordering (newest first) is the
 * useful half of the same fact.
 *
 * ## Why the list is redrawn from the backend
 *
 * `revokeGrant` sends the revoke and renders what comes back, never an
 * optimistic splice. A row that disappeared from the screen while the grant
 * stayed in the database is the exact failure this block exists to remove.
 */
import { ShieldCheck, X } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton, SectionTitle } from '../ui'
import { useGrants, usePermissionsStore } from '../../stores/permissions'

export interface GrantsListProps {
  chatId: string | null
}

export function GrantsList({ chatId }: GrantsListProps): React.JSX.Element {
  const { t } = useTranslation()
  const grants = useGrants(chatId)

  // Loaded when the chat is opened, and refreshed by `event-bridge.ts` whenever
  // an `allowAlways` resolves — so a grant given from the card above the
  // composer appears here without the panel being reopened.
  useEffect(() => {
    if (chatId) void usePermissionsStore.getState().loadGrants(chatId)
  }, [chatId])

  return (
    <div className="flex flex-col gap-1.5" data-testid="grants-list" data-count={grants.length}>
      <SectionTitle level={3}>{t('chat.grantsTitle')}</SectionTitle>

      {grants.length === 0 ? (
        <p data-testid="grants-empty" className="text-[11px] leading-relaxed text-fg-faint">
          {t('chat.grantsEmpty')}
        </p>
      ) : (
        <>
          {grants.map((grant) => (
            <div
              key={grant.toolName}
              data-testid="grant-row"
              data-tool={grant.toolName}
              className="group flex items-center gap-1.5 rounded-md py-1 pr-0.5 pl-1 hover:bg-bg-muted"
            >
              <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
              {/* The tool's own name is data, not copy — the same rule the
                  working-directory chip follows — so it is printed, in the
                  monospace the transcript's tool cards use. */}
              <span className="min-w-0 grow truncate font-mono text-[11px] text-fg-dim">
                {grant.toolName}
              </span>
              <IconButton
                size="sm"
                label={t('chat.grantRevoke')}
                data-testid="grant-revoke"
                className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => {
                  if (chatId) void usePermissionsStore.getState().revokeGrant(chatId, grant.toolName)
                }}
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          ))}
          <p className="text-[11px] leading-relaxed text-fg-faint">{t('chat.grantsHint')}</p>
        </>
      )}
    </div>
  )
}
