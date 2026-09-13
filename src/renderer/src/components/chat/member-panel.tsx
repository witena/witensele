/**
 * The right column's member list: the mockup's `.member` rows.
 *
 * Real data, for the first time: name, model id and a live presence dot per
 * agent. What is still fixed is the *membership* — S1.7 puts exactly the default
 * agent in every chat, so "Add" stays disabled until **S2.2** adds the picker and
 * `chats.members.set` has a UI behind it. The per-chat token usage the artboard
 * shows on each row arrives with S4.1.
 */
import { UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Agent } from '@shared/types'
import { useAgentPresence } from '../../stores/presence'
import { Avatar, Button, EmptyState, PresenceDot, SectionTitle } from '../ui'

export interface MemberPanelProps {
  chatId: string | null
  members: Agent[]
}

export function MemberPanel({ chatId, members }: MemberPanelProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between px-1">
        <SectionTitle count={members.length}>{t('chat.members')}</SectionTitle>
        {/* Enabled by S2.2, together with the agent picker it opens. */}
        <Button variant="ghost" size="sm" className="text-accent" disabled>
          {t('common.add')}
        </Button>
      </div>

      {members.length === 0 ? (
        <EmptyState
          size="sm"
          icon={UserPlus}
          title={t('chat.emptyMembersTitle')}
          description={t('chat.emptyMembersDescription')}
        />
      ) : (
        members.map((agent) => <MemberRow key={agent.id} chatId={chatId} agent={agent} />)
      )}
    </section>
  )
}

function MemberRow({ chatId, agent }: { chatId: string | null; agent: Agent }): React.JSX.Element {
  const presence = useAgentPresence(chatId, agent.id)

  return (
    <div data-testid="member-row" className="flex items-center gap-2.5 rounded-lg p-2">
      <Avatar text={agent.avatar.text} color={agent.avatar.color} size="md" />
      <div className="flex min-w-0 grow flex-col gap-px">
        <span data-testid="member-name" className="truncate text-[13px] text-fg">
          {agent.name}
        </span>
        <span data-testid="member-model" className="truncate font-mono text-[11px] text-fg-faint">
          {agent.modelId}
        </span>
      </div>
      <PresenceDot state={presence} data-testid="member-presence" />
    </div>
  )
}
