/**
 * The chat page: the three-column layout the whole product is shaped around —
 * chat list (264px), conversation, member panel (288px).
 *
 * S1.5 built the shell; **S1.7 makes it real**. The left column lists stored
 * chats and creates, renames and deletes them; the middle column streams a live
 * conversation; the right column lists the chat's actual members with their live
 * presence dots. What is still local-only is the group-settings block: a
 * `ChatSettings` write needs the member picker and the settings form that **S2.2**
 * owns, so those controls stay wired to component state and are not persisted.
 *
 * Data comes from four stores and nothing is fetched here directly: `chats` and
 * `messages` mirror the backend, `run` says whether the Stop button is showing,
 * `presence` colours the dots. Events reach all four through
 * `lib/event-bridge.ts`, which the bootstrap starts once.
 */
import type { TFunction } from 'i18next'
import { MessagesSquare, Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_CHAT_SETTINGS,
  type Agent,
  type ChatMode,
  type SpeakingMode
} from '@shared/types'
import { ChatList } from '../components/chat/chat-list'
import { Composer } from '../components/chat/composer'
import { MemberPanel } from '../components/chat/member-panel'
import { MessageList } from '../components/chat/message-list'
import { Column } from '../components/layout/column'
import { PageHeader } from '../components/layout/page-header'
import { DRAG_REGION, NO_DRAG, TRAFFIC_LIGHT_INSET } from '../components/layout/window-chrome'
import {
  Badge,
  EmptyState,
  Field,
  IconButton,
  Input,
  SectionTitle,
  SegmentedControl,
  Select
} from '../components/ui'
import { translateError } from '../i18n/errors'
import { useAgentsStore } from '../stores/agents'
import { useChatMemberIds, useChatsStore } from '../stores/chats'
import { useChatMessages, useMessagesStore } from '../stores/messages'
import { useIsRunning, useRunStore } from '../stores/run'

/** Literal `t()` calls so the `used-keys` guard can verify both branches. */
function modeLabel(t: TFunction, mode: ChatMode): string {
  switch (mode) {
    case 'roundrobin':
      return t('chat.modeRoundrobin')
    case 'mention-only':
      return t('chat.modeMentionOnly')
  }
}

function speakingLabel(t: TFunction, speaking: SpeakingMode): string {
  switch (speaking) {
    case 'sequential':
      return t('chat.speakingSequential')
    case 'parallel':
      return t('chat.speakingParallel')
  }
}

/** The timeout values the picker offers, in milliseconds. */
const TIMEOUT_CHOICES_MS = [60_000, 120_000, 300_000]

/** How many automatic rounds a chat may run. Matches `maxAutoRounds` in the plan. */
const MAX_ROUND_CHOICES = [1, 2, 3, 5, 10]

interface GroupSettings {
  mode: ChatMode
  speaking: SpeakingMode
  maxAutoRounds: number
  hardTimeoutMs: number
}

export function ChatsPage(): React.JSX.Element {
  const { t } = useTranslation()

  const chats = useChatsStore((state) => state.chats)
  const membersByChat = useChatsStore((state) => state.membersByChat)
  const selectedId = useChatsStore((state) => state.selectedId)
  const chatsError = useChatsStore((state) => state.error)
  const chatsErrorCode = useChatsStore((state) => state.errorCode)
  const agents = useAgentsStore((state) => state.agents)

  const messages = useChatMessages(selectedId)
  const memberIds = useChatMemberIds(selectedId)
  const running = useIsRunning(selectedId)

  const [settings, setSettings] = useState<GroupSettings>({
    mode: DEFAULT_CHAT_SETTINGS.mode,
    speaking: DEFAULT_CHAT_SETTINGS.speaking,
    maxAutoRounds: DEFAULT_CHAT_SETTINGS.maxAutoRounds,
    hardTimeoutMs: DEFAULT_APP_SETTINGS.timeouts.hardTimeoutMs
  })

  // The page owns both lists: the chat list needs them, and so does every message
  // row (author name, avatar, model badge).
  useEffect(() => {
    void useChatsStore.getState().load()
    void useAgentsStore.getState().load()
  }, [])

  // Transcripts are loaded per chat, the first time one is opened. Later visits
  // read the copy already in the store, which the events keep current.
  useEffect(() => {
    if (!selectedId) return
    const { byChat, status } = useMessagesStore.getState()
    if (byChat[selectedId] === undefined && status[selectedId] !== 'loading') {
      void useMessagesStore.getState().load(selectedId)
    }
  }, [selectedId])

  const selected = chats.find((chat) => chat.id === selectedId) ?? null
  const members: Agent[] = memberIds
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is Agent => agent !== undefined)

  const memberCounts = Object.fromEntries(
    Object.entries(membersByChat).map(([chatId, ids]) => [chatId, ids.length])
  )

  // The header badge in the mockup: "Round-robin · In turn · Max 3 rounds".
  const orchestrationSummary = [
    modeLabel(t, settings.mode),
    speakingLabel(t, settings.speaking),
    // `rounds`, not `count`: `count` is i18next's plural trigger and would make
    // it look for `maxRoundsShort_one` / `_other` instead of this key.
    t('chat.maxRoundsShort', { rounds: settings.maxAutoRounds })
  ].join(' · ')

  return (
    <>
      {/* Left: the chat list. */}
      <Column width={264} className="bg-bg-base">
        <div
          className={`flex shrink-0 flex-col gap-2.5 px-3 pb-2.5 ${TRAFFIC_LIGHT_INSET} ${DRAG_REGION}`}
        >
          <div className="flex items-center justify-between">
            <SectionTitle data-testid="page-chats">{t('nav.chats')}</SectionTitle>
            <IconButton
              variant="primary"
              label={t('chat.newChat')}
              data-testid="chats-new"
              className={NO_DRAG}
              onClick={() => void useChatsStore.getState().create()}
            >
              <Plus aria-hidden="true" strokeWidth={2.2} className="h-4 w-4" />
            </IconButton>
          </div>
          {/* Filtering the list is S4.3; the field is the mockup's, still inert. */}
          <Input
            type="search"
            disabled
            placeholder={t('chat.searchChats')}
            aria-label={t('chat.searchChats')}
            wrapperClassName={NO_DRAG}
            icon={<Search aria-hidden="true" className="h-3.5 w-3.5" />}
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {chats.length === 0 ? (
            <EmptyState
              size="sm"
              icon={MessagesSquare}
              title={t('chat.emptyChatsTitle')}
              description={t('chat.emptyChatsDescription')}
            />
          ) : (
            <ChatList
              chats={chats}
              selectedId={selectedId}
              memberCounts={memberCounts}
              onSelect={(id) => useChatsStore.getState().select(id)}
              onRename={(id, title) => void useChatsStore.getState().rename(id, title)}
              onDelete={(id) => void useChatsStore.getState().remove(id)}
            />
          )}

          {chatsError ? (
            <p data-testid="chats-error" className="px-3 pb-3 text-xs text-danger">
              {translateError(t, { code: chatsErrorCode ?? 'internal', message: chatsError })}
            </p>
          ) : null}
        </div>
      </Column>

      {/* Middle: the conversation. */}
      <Column border="none" className="bg-bg-panel">
        <PageHeader
          testId="page-chats-conversation"
          title={selected ? selected.title : t('chat.noChatSelected')}
          badge={<Badge>{orchestrationSummary}</Badge>}
        />

        {selected ? (
          <MessageList chatId={selected.id} messages={messages} />
        ) : (
          <div className="flex flex-1 items-center justify-center overflow-y-auto px-7 py-5">
            <EmptyState
              icon={MessagesSquare}
              title={t('chat.emptyConversationTitle')}
              description={t('chat.emptyConversationDescription')}
            />
          </div>
        )}

        <Composer
          chatId={selectedId}
          running={running}
          onSend={(text) =>
            selectedId ? useRunStore.getState().send(selectedId, text) : Promise.resolve(false)
          }
          onStop={() => {
            if (selectedId) void useRunStore.getState().stop(selectedId)
          }}
        />
      </Column>

      {/* Right: members and the chat's orchestration settings. */}
      <Column width={288} border="left" scroll className="bg-bg-base">
        {/* No traffic-light inset here: the lights are on the far left of the window. */}
        <div className="flex min-h-full flex-col gap-[18px] px-3 pt-3.5 pb-3.5">
          <MemberPanel chatId={selectedId} members={members} />

          <div className="h-px shrink-0 bg-border" />

          <section className="flex flex-col gap-3 px-1">
            <SectionTitle level={3}>{t('chat.groupSettings')}</SectionTitle>

            <Field label={t('chat.mode')} htmlFor="chat-mode">
              <Select
                id="chat-mode"
                value={settings.mode}
                onChange={(event) =>
                  setSettings((previous) => ({
                    ...previous,
                    mode: event.target.value as ChatMode
                  }))
                }
                options={[
                  { value: 'roundrobin', label: modeLabel(t, 'roundrobin') },
                  { value: 'mention-only', label: modeLabel(t, 'mention-only') }
                ]}
              />
            </Field>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-fg-muted">{t('chat.speaking')}</span>
              <SegmentedControl<SpeakingMode>
                value={settings.speaking}
                onChange={(speaking) => setSettings((previous) => ({ ...previous, speaking }))}
                options={[
                  { value: 'sequential', label: speakingLabel(t, 'sequential') },
                  { value: 'parallel', label: speakingLabel(t, 'parallel') }
                ]}
              />
            </div>

            <Field label={t('chat.maxAutoRounds')} htmlFor="chat-max-rounds">
              <Select
                id="chat-max-rounds"
                value={String(settings.maxAutoRounds)}
                onChange={(event) =>
                  setSettings((previous) => ({
                    ...previous,
                    maxAutoRounds: Number(event.target.value)
                  }))
                }
                options={MAX_ROUND_CHOICES.map((rounds) => ({
                  value: String(rounds),
                  label: String(rounds)
                }))}
              />
            </Field>

            <Field label={t('chat.timeout')} htmlFor="chat-timeout">
              <Select
                id="chat-timeout"
                value={String(settings.hardTimeoutMs)}
                onChange={(event) =>
                  setSettings((previous) => ({
                    ...previous,
                    hardTimeoutMs: Number(event.target.value)
                  }))
                }
                options={TIMEOUT_CHOICES_MS.map((ms) => ({
                  value: String(ms),
                  label: t('chat.secondsValue', { seconds: ms / 1000 })
                }))}
              />
            </Field>

            <Field label={t('chat.speakingOrder')}>
              <span className="text-[11px] text-fg-faint">{t('chat.speakingOrderHint')}</span>
            </Field>
          </section>

          <div className="flex-1" />

          <div className="flex flex-col gap-1 rounded-lg border border-border-strong p-2.5 text-xs text-fg-dim">
            <p className="text-fg-muted">{t('chat.actions')}</p>
            <p>{t('chat.actionSummarize')}</p>
            <p>{t('chat.actionVote')}</p>
          </div>
        </div>
      </Column>
    </>
  )
}
