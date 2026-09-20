/**
 * The topics a committee has been convened on: the chats whose `committeeId` is
 * this committee, newest first.
 *
 * Read from `stores/chats` rather than from a field on `Committee`, because
 * provenance is a fact about the *chat* — `chats.committee_id`, set once at
 * creation and cleared by the foreign key if the committee is ever deleted (see
 * `docs/features/committees/backend.md`). The store already mirrors it and
 * already receives the `chat.updated` the backend emits when a committee is
 * deleted, so this list empties itself with no reload and no second event.
 *
 * Clicking a row selects that chat and navigates to Chats, which is the whole
 * point of the block: a committee is a place to get back to its conversations
 * from.
 *
 * **New topic** (S9.3) is the other direction, and it is why the dialog's open
 * state lives in `stores/ui` rather than in the chats page: the button has to
 * navigate *and* arrive with this committee already picked, and this component
 * is unmounted the instant `setPage('chats')` runs. Opening first and then
 * navigating means the page mounts with the dialog already asked for.
 */
import type { Chat } from '@shared/types'
import { MessagesSquare, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, EmptyState, SectionTitle } from '../ui'
import { useChatsStore } from '../../stores/chats'
import { useUiStore } from '../../stores/ui'

export interface CommitteeTopicsProps {
  /** The committee whose topics these are, or `null` while creating one. */
  committeeId: string | null
}

export function CommitteeTopics({ committeeId }: CommitteeTopicsProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const chats = useChatsStore((state) => state.chats)

  // `chats` is already sorted newest `updatedAt` first by the store, so the
  // filter preserves the order the block promises.
  const topics = committeeId
    ? chats.filter((chat: Chat) => chat.committeeId === committeeId)
    : []

  const open = (chatId: string): void => {
    useChatsStore.getState().select(chatId)
    useUiStore.getState().setPage('chats')
  }

  const convene = (): void => {
    if (!committeeId) return
    // Ask for the dialog *before* navigating: this component does not survive
    // the page change, and the chats page reads the request on mount.
    useUiStore.getState().openNewChatDialog(committeeId)
    useUiStore.getState().setPage('chats')
  }

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <SectionTitle level={3} count={topics.length}>
          {t('committees.topics')}
        </SectionTitle>
        <Button
          variant="ghost"
          size="sm"
          data-testid="committee-new-topic"
          // A committee that has not been saved yet has no id to convene on.
          disabled={committeeId === null}
          className="text-accent hover:text-accent"
          onClick={convene}
        >
          <Plus aria-hidden="true" strokeWidth={2.2} className="h-3 w-3" />
          {t('committees.newTopic')}
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border-strong bg-bg-elevated">
        {topics.length === 0 ? (
          <EmptyState
            size="sm"
            icon={MessagesSquare}
            title={t('committees.topicsEmptyTitle')}
            description={t('committees.topicsEmptyDescription')}
          />
        ) : (
          <div className="flex flex-col p-1">
            {topics.map((chat) => (
              <button
                key={chat.id}
                type="button"
                data-testid="committee-topic"
                data-chat-id={chat.id}
                onClick={() => open(chat.id)}
                className="flex flex-col gap-px rounded-md px-2 py-1.5 text-left transition-colors hover:bg-bg-hover focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
              >
                <span data-testid="committee-topic-title" className="truncate text-[13px] text-fg">
                  {chat.title}
                </span>
                <span className="truncate text-[11px] text-fg-faint">
                  {new Date(chat.updatedAt).toLocaleDateString(i18n.language)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
