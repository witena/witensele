/**
 * The chat page: the three-column layout the whole product is shaped around —
 * chat list (264px), conversation, member panel (288px).
 *
 * S1.5 builds the *shell* of it. There is no chat data yet (S1.7), no members
 * (S2.2) and no orchestration (S2.3), so every list is an `EmptyState` and the
 * composer is disabled. What is real: the layout, the spacing and colours from
 * the mockup, and the group-settings controls, which are wired to local state so
 * the page behaves like the finished one. They are deliberately *not* persisted —
 * a `ChatSettings` write needs a chat to write it to, and that is S2.2's job.
 *
 * The group-settings state lives here rather than in the member panel because the
 * conversation header's summary badge renders from the same values; two copies
 * would drift the moment either one changed.
 */
import type { TFunction } from 'i18next'
import { AtSign, MessagesSquare, Plus, Search, SendHorizontal, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_CHAT_SETTINGS,
  type ChatMode,
  type SpeakingMode
} from '@shared/types'
import { Column } from '../components/layout/column'
import { PageHeader } from '../components/layout/page-header'
import { DRAG_REGION, NO_DRAG, TRAFFIC_LIGHT_INSET } from '../components/layout/window-chrome'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  SectionTitle,
  SegmentedControl,
  Select,
  TextArea
} from '../components/ui'

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
  const [settings, setSettings] = useState<GroupSettings>({
    mode: DEFAULT_CHAT_SETTINGS.mode,
    speaking: DEFAULT_CHAT_SETTINGS.speaking,
    maxAutoRounds: DEFAULT_CHAT_SETTINGS.maxAutoRounds,
    hardTimeoutMs: DEFAULT_APP_SETTINGS.timeouts.hardTimeoutMs
  })

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
              className={NO_DRAG}
              disabled
              onClick={() => undefined}
            >
              <Plus aria-hidden="true" strokeWidth={2.2} className="h-4 w-4" />
            </IconButton>
          </div>
          <Input
            type="search"
            placeholder={t('chat.searchChats')}
            aria-label={t('chat.searchChats')}
            wrapperClassName={NO_DRAG}
            icon={<Search aria-hidden="true" className="h-3.5 w-3.5" />}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          <EmptyState
            size="sm"
            icon={MessagesSquare}
            title={t('chat.emptyChatsTitle')}
            description={t('chat.emptyChatsDescription')}
          />
        </div>
      </Column>

      {/* Middle: the conversation. */}
      <Column border="none" className="bg-bg-panel">
        <PageHeader
          testId="page-chats-conversation"
          title={t('chat.noChatSelected')}
          badge={<Badge>{orchestrationSummary}</Badge>}
        />

        <div className="flex flex-1 items-center justify-center overflow-y-auto px-7 py-5">
          <EmptyState
            icon={MessagesSquare}
            title={t('chat.emptyConversationTitle')}
            description={t('chat.emptyConversationDescription')}
          />
        </div>

        {/* Composer. Disabled until S1.7 gives it a chat to send into. */}
        <div className="shrink-0 px-7 pt-3 pb-[18px]">
          <div className="flex flex-col gap-2.5 rounded-[10px] border border-border-strong bg-bg-elevated px-3 py-2.5">
            <TextArea
              rows={2}
              disabled
              placeholder={t('chat.composerPlaceholder')}
              aria-label={t('chat.composerPlaceholder')}
            />
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                <Badge font="sans" className="gap-1">
                  <AtSign aria-hidden="true" className="h-3 w-3" />
                  {t('chat.mentionHint')}
                </Badge>
              </div>
              <IconButton
                variant="secondary"
                label={t('chat.send')}
                disabled
                onClick={() => undefined}
              >
                <SendHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </div>
        </div>
      </Column>

      {/* Right: members and the chat's orchestration settings. */}
      <Column width={288} border="left" scroll className="bg-bg-base">
        {/* No traffic-light inset here: the lights are on the far left of the window. */}
        <div className="flex min-h-full flex-col gap-[18px] px-3 pt-3.5 pb-3.5">
          <section className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between px-1">
              <SectionTitle count={0}>{t('chat.members')}</SectionTitle>
              <Button variant="ghost" size="sm" className="text-accent" disabled>
                {t('common.add')}
              </Button>
            </div>
            <EmptyState
              size="sm"
              icon={UserPlus}
              title={t('chat.emptyMembersTitle')}
              description={t('chat.emptyMembersDescription')}
            />
          </section>

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
