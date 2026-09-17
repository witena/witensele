/**
 * The chat page: the three-column layout the whole product is shaped around —
 * chat list (264px), conversation, member panel (288px).
 *
 * S1.5 built the shell, S1.7 made the conversation real and **S2.2 makes the right
 * column real**: members can be added, removed and dragged into a different
 * speaking order, and every group setting is written straight through to
 * `chats.update` instead of living in component state. There is no Save button
 * and no debounce — each control is one field of one row, and a select the user
 * changed and then closed the app on must not quietly have been forgotten.
 *
 * The settings the controls show come from the selected `Chat`, never from local
 * state, so the header badge, the controls and the database can never disagree:
 * the write returns the stored row and the `chat.updated` event re-renders both.
 *
 * The executor's permission prompts (S5.5) are drawn between the transcript and
 * the composer, one card per pending request, from `stores/permissions.ts`, and
 * "Hand to executor" (S5.6) sits just below them, in the same column and for
 * the same reason: both are answered where the user is already looking.
 *
 * Data comes from five stores and nothing is fetched here directly: `chats`,
 * `agents` and `providers` mirror the backend, `messages` holds the transcript,
 * `run` says whether the Stop button is showing and `presence` colours the dots —
 * seeded from `presence.list` whenever a chat is opened, then kept current by
 * `presence.changed`. Events reach them through `lib/event-bridge.ts`, which the
 * bootstrap starts once.
 */
import type { TFunction } from 'i18next'
import { MessagesSquare, Plus, Search, SearchX } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatCost, formatTokens } from '@shared/pricing'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_CHAT_SETTINGS,
  MAX_AUTO_ROUNDS,
  MIN_AUTO_ROUNDS,
  type Agent,
  type ChatMode,
  type ChatSettings,
  type ChatSettingsPatch,
  type SpeakingMode
} from '@shared/types'
import { ActionsCard } from '../components/chat/actions-card'
import { ChatList } from '../components/chat/chat-list'
import { conclusionPreview, latestConclusion } from '../components/chat/conclusion'
import { Composer, type ComposerHandle } from '../components/chat/composer'
import { GoalChip } from '../components/chat/goal-chip'
import { GoalSettings } from '../components/chat/goal-settings'
import { HandoffButton } from '../components/chat/handoff-button'
import { MemberPanel } from '../components/chat/member-panel'
import { OnboardingCard, useOnboarding } from '../components/onboarding/onboarding-card'
import { MessageList } from '../components/chat/message-list'
import { PermissionCard } from '../components/chat/permission-card'
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
  Select
} from '../components/ui'
import { translateFailure } from '../i18n/errors'
import { useAgentsStore } from '../stores/agents'
import { useChatGoalStatus, useChatMemberIds, useChatsStore } from '../stores/chats'
import { useChatMessages, useMessagesStore } from '../stores/messages'
import { usePresenceStore } from '../stores/presence'
import { usePendingPermissions } from '../stores/permissions'
import { useIsRunning, useRunStore } from '../stores/run'
import { useProvidersStore } from '../stores/providers'
import { useChatUsage, useUsageStore } from '../stores/usage'
import { reorder } from '../lib/reorder'
import { folderName } from '../lib/workdir'

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

/**
 * How long the search box waits after the last keystroke before asking the
 * backend (S4.3).
 *
 * Long enough that typing a word is one query rather than five, short enough
 * that the list feels like it is filtering as you type. The debounce lives here
 * rather than in the store because it is an interaction detail of this one
 * input; the store stays a plain mirror of `chats.search`.
 */
const SEARCH_DEBOUNCE_MS = 200

/** The timeout values the picker offers, in milliseconds. */
const TIMEOUT_CHOICES_MS = [30_000, 60_000, 120_000, 300_000]

/**
 * Every round count the backend accepts, so the select can never produce a value
 * `chats.update` would reject.
 */
const MAX_ROUND_CHOICES = Array.from(
  { length: MAX_AUTO_ROUNDS - MIN_AUTO_ROUNDS + 1 },
  (_unused, index) => MIN_AUTO_ROUNDS + index
)

export function ChatsPage(): React.JSX.Element {
  const { t } = useTranslation()
  // The Actions card sends through the composer rather than around it, so both
  // paths resolve `@Name` with the same parser and land in the same store.
  const composer = useRef<ComposerHandle>(null)

  const chats = useChatsStore((state) => state.chats)
  const membersByChat = useChatsStore((state) => state.membersByChat)
  const selectedId = useChatsStore((state) => state.selectedId)
  const chatsError = useChatsStore((state) => state.error)
  const chatsErrorCode = useChatsStore((state) => state.errorCode)
  const chatsErrorDetails = useChatsStore((state) => state.errorDetails)
  const agents = useAgentsStore((state) => state.agents)
  const providers = useProvidersStore((state) => state.providers)

  const messages = useChatMessages(selectedId)
  const memberIds = useChatMemberIds(selectedId)
  const running = useIsRunning(selectedId)
  const activeRun = useRunStore((state) => (selectedId ? state.activeByChat[selectedId] : undefined))
  const runError = useRunStore((state) => state.error)
  const runErrorCode = useRunStore((state) => state.errorCode)
  const runErrorDetails = useRunStore((state) => state.errorDetails)
  const usage = useChatUsage(selectedId)
  // Whether this chat's deliverable is on disk. A query rather than a column on
  // `Chat`, so it is loaded beside the transcript and the usage summary.
  const goalStatus = useChatGoalStatus(selectedId)
  // The executor's open permission prompts for this chat, oldest first. They sit
  // above the composer because that is where the answer is given, and because a
  // suspended tool call must not hide the transcript that explains it.
  const permissions = usePendingPermissions(selectedId)
  const matchIds = useChatsStore((state) => state.matchIds)
  // A primitive, so the effect below re-runs when the chat row really changed
  // rather than on every store write that replaced the array.
  const selectedUpdatedAt = useChatsStore(
    (state) => state.chats.find((chat) => chat.id === state.selectedId)?.updatedAt ?? 0
  )
  // What the box holds right now; the store only ever sees the debounced value.
  const [query, setQuery] = useState('')
  // Which message the transcript should scroll to, and the click that asked for
  // it (S5.16). The header's "Conclusion" chip is the only writer; the nonce is
  // what makes a second click on the same message scroll again.
  const [scrollTo, setScrollTo] = useState<{ messageId: string; nonce: number } | undefined>(
    undefined
  )
  // Every loaded transcript, for the chat list's conclusion previews. The map
  // itself is a stable reference in the store, so this subscribes to "a
  // transcript changed" rather than to every delta of the open chat.
  const transcripts = useMessagesStore((state) => state.byChat)
  // Whether a fresh installation is still being walked through its first chat
  // (S7.5). Asked here because this column draws either the card or the bare
  // "no chat selected" state, never both.
  const onboarding = useOnboarding()

  // The page owns all three lists: the chat list needs them, every message row
  // needs the author's name, avatar and model, and the member panel prints the
  // provider's name beside the model id.
  useEffect(() => {
    void useChatsStore.getState().load()
    void useAgentsStore.getState().load()
    void useProvidersStore.getState().load()
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

  // Presence is seeded on **every** visit, not only the first: the supervisor
  // has been running since the app started, so a member can have gone offline
  // while this chat was closed and no event about it was ever applied here.
  useEffect(() => {
    if (!selectedId) return
    void usePresenceStore.getState().load(selectedId)
  }, [selectedId])

  // The goal's delivery state is a fact about the filesystem, so it is asked for
  // rather than stored: on every visit, and again whenever this chat changes —
  // which is what a `chat.updated` from a goal edit, a rename or a membership
  // change already is.
  //
  // S5.12 adds the two moments an **executor turn** can have written the
  // deliverable: every round boundary, and the end of the run. A round boundary
  // is what catches a hand-off — the executor writes in its own round and the
  // review round starts the moment it is finished, so the chip flips while the
  // reviewers are still reading — and the end of the run catches the rest,
  // including a hand-off whose chat has nobody to review it. Polling at these
  // points rather than watching the file is the choice S5.10 recorded; a
  // filesystem watcher is in the Phase 6 backlog.
  const activeRound = activeRun?.round ?? 0
  useEffect(() => {
    if (!selectedId) return
    void useChatsStore.getState().loadGoalStatus(selectedId)
  }, [selectedId, selectedUpdatedAt, running, activeRound])

  // Usage is seeded from the backend on every visit too, and for the same kind of
  // reason: the summary covers the **whole** transcript while the messages store
  // holds a page of it. From here on `message.updated` keeps it current without
  // another round trip (see `stores/usage.ts`).
  useEffect(() => {
    if (!selectedId) return
    void useUsageStore.getState().load(selectedId)
  }, [selectedId])

  // The debounce: the store — and therefore the backend — only sees the value the
  // user stopped typing on.
  useEffect(() => {
    const timer = setTimeout(() => {
      void useChatsStore.getState().search(query)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const selected = chats.find((chat) => chat.id === selectedId) ?? null
  const members: Agent[] = memberIds
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is Agent => agent !== undefined)

  const memberCounts = Object.fromEntries(
    Object.entries(membersByChat).map(([chatId, ids]) => [chatId, ids.length])
  )

  // The chat list's preview lines (S5.16). Only chats whose transcript has been
  // read can have one — the store holds a page per opened chat, and a preview
  // for every chat in the database would be a query of its own; the row falls
  // back to the member count, which is what it always showed.
  const conclusionPreviews = useMemo(() => {
    const previews: Record<string, string> = {}
    for (const [chatId, messages] of Object.entries(transcripts)) {
      const preview = conclusionPreview(messages)
      if (preview !== null) previews[chatId] = preview
    }
    return previews
  }, [transcripts])

  // The header chip: the message the chip scrolls to, or `null` for no chip.
  const conclusion = latestConclusion(messages)

  // Filtering **hides rows**, it does not regroup them: `ChatList` still buckets
  // what is left into Today / Yesterday / Earlier, and a heading with nothing
  // under it is dropped by `groupChats` on its own.
  const visibleChats = matchIds === null ? chats : chats.filter((chat) => matchIds.includes(chat.id))
  const searching = query.trim().length > 0

  // `12.4k tokens · $0.04`, or the tokens alone when nothing in the chat could be
  // priced — an unknown model, or a local one, which costs nothing and would read
  // as a broken estimate if it printed `$0.00`.
  const usageSummary =
    usage.total.totalTokens > 0
      ? usage.cost !== null && usage.cost > 0
        ? t('chat.usageWithCost', {
            tokens: formatTokens(usage.total.totalTokens),
            cost: formatCost(usage.cost)
          })
        : t('chat.usage', { tokens: formatTokens(usage.total.totalTokens) })
      : null

  // A chat that is not selected yet still has to draw the settings block, so the
  // defaults stand in — they are the same ones `chats.create` stores.
  const settings: ChatSettings = selected?.settings ?? DEFAULT_CHAT_SETTINGS
  const hardTimeoutMs = settings.hardTimeoutMs ?? DEFAULT_APP_SETTINGS.timeouts.hardTimeoutMs

  const patchSettings = (patch: ChatSettingsPatch): void => {
    if (!selectedId) return
    void useChatsStore.getState().updateSettings(selectedId, patch)
  }

  const setMembers = (agentIds: string[]): void => {
    if (!selectedId) return
    // "This chat has no members" is the one send error the user fixes from right
    // here, so changing the membership drops it rather than leaving a red line
    // under a composer that would now work.
    useRunStore.getState().clearError()
    void useChatsStore.getState().setMembers(selectedId, agentIds)
  }

  // "Round 2 · Architect, Reviewer speaking": what the backend's `run.round`
  // event says, with the ids resolved to names. It replaces nothing — it appears
  // beside the settings badge only while a run is in flight.
  const speakingNow = (activeRun?.speakers ?? [])
    .map((id) => agents.find((agent) => agent.id === id)?.name ?? id)
    .join(', ')

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
          <Input
            type="search"
            value={query}
            data-testid="chats-search"
            placeholder={t('chat.searchChats')}
            aria-label={t('chat.searchChats')}
            wrapperClassName={NO_DRAG}
            icon={<Search aria-hidden="true" className="h-3.5 w-3.5" />}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {visibleChats.length === 0 ? (
            searching ? (
              <EmptyState
                size="sm"
                icon={SearchX}
                title={t('chat.searchEmptyTitle')}
                description={t('chat.searchEmptyDescription')}
              />
            ) : (
              <EmptyState
                size="sm"
                icon={MessagesSquare}
                title={t('chat.emptyChatsTitle')}
                description={t('chat.emptyChatsDescription')}
              />
            )
          ) : (
            <ChatList
              chats={visibleChats}
              selectedId={selectedId}
              memberCounts={memberCounts}
              conclusionPreviews={conclusionPreviews}
              onSelect={(id) => {
                useRunStore.getState().clearError()
                useChatsStore.getState().select(id)
              }}
              onRename={(id, title) => void useChatsStore.getState().rename(id, title)}
              onDelete={(id) => void useChatsStore.getState().remove(id)}
            />
          )}

          {chatsError ? (
            <p data-testid="chats-error" className="px-3 pb-3 text-xs text-danger">
              {translateFailure(t, chatsErrorCode, chatsErrorDetails)}
            </p>
          ) : null}
        </div>
      </Column>

      {/* Middle: the conversation. */}
      <Column border="none" className="bg-bg-panel">
        <PageHeader
          testId="page-chats-conversation"
          title={selected ? selected.title : t('chat.noChatSelected')}
          badge={
            <>
              <Badge data-testid="chat-settings-badge">{orchestrationSummary}</Badge>
              {/* The folder's own name, with the whole path in the tooltip: the
                  interesting half of a path is its last segment, and the rest
                  does not fit beside a title. */}
              {selected?.workdir ? (
                <Badge
                  tone="accent"
                  data-testid="chat-workdir-chip"
                  title={selected.workdir}
                >
                  {folderName(selected.workdir)}
                </Badge>
              ) : null}
              {/* What the chat is for (S5.10). For a `document` it carries the
                  deliverable's name and, once the file is there, opens it. */}
              {selected ? (
                <GoalChip chatId={selected.id} goal={selected.goal} status={goalStatus} />
              ) : null}
              {/* The answer this chat reached (S5.16). A chip rather than a
                  pinned copy of the conclusion: the transcript is the record,
                  and this only says "there is one, here it is". */}
              {conclusion ? (
                <button
                  type="button"
                  data-testid="chat-conclusion-chip"
                  data-message-id={conclusion.id}
                  title={t('chat.conclusionChipTitle')}
                  onClick={() =>
                    setScrollTo({ messageId: conclusion.id, nonce: Date.now() })
                  }
                  className="inline-flex rounded focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <Badge tone="accent" font="sans">
                    {t('chat.conclusion')}
                  </Badge>
                </button>
              ) : null}
            </>
          }
          actions={
            <>
              {activeRun && speakingNow.length > 0 ? (
                <span data-testid="run-status" className="truncate text-xs text-accent">
                  {t('chat.runStatus', { round: activeRun.round, speakers: speakingNow })}
                </span>
              ) : null}
              {usageSummary ? (
                <span
                  data-testid="chat-usage"
                  data-tokens={usage.total.totalTokens}
                  title={t('chat.usageTitle')}
                  className="shrink-0 font-mono text-[11px] text-fg-faint"
                >
                  {usageSummary}
                </span>
              ) : null}
            </>
          }
        />

        {selected ? (
          <MessageList
            chatId={selected.id}
            messages={messages}
            members={members}
            scrollTo={scrollTo}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center overflow-y-auto px-7 py-5">
            {/* On a fresh installation the bare empty state is replaced by the
                first-run card (S7.5): "no chat selected" is true and useless
                when the reason is that nothing is set up yet. The card renders
                `null` as soon as a chat has a member, or once Skip was pressed,
                and the empty state is what is left. */}
            {onboarding.visible ? (
              <OnboardingCard />
            ) : (
              <EmptyState
                icon={MessagesSquare}
                title={t('chat.emptyConversationTitle')}
                description={t('chat.emptyConversationDescription')}
              />
            )}
          </div>
        )}

        {permissions.length > 0 ? (
          <div
            data-testid="permission-stack"
            className="flex shrink-0 flex-col gap-2 px-7 pt-3"
          >
            {permissions.map((request, index) => (
              <PermissionCard
                key={request.requestId}
                request={request}
                autoFocus={index === 0}
              />
            ))}
          </div>
        ) : null}

        {/* "Hand to executor" (S5.6), directly above the composer: the moment
            the user decides the discussion is over is the moment they are
            looking at this corner. It is disabled, never hidden, when the chat
            has no folder or no executor — the tooltip says which. */}
        <HandoffButton
          chatId={selectedId}
          workdir={selected?.workdir}
          members={members}
          running={running}
          onHandoff={(chatId) => void useRunStore.getState().handoff(chatId)}
        />

        <Composer
          chatId={selectedId}
          handleRef={composer}
          members={members}
          running={running}
          {...(runError ? { error: translateFailure(t, runErrorCode, runErrorDetails) } : {})}
          onSend={(text, mentions, rounds) =>
            selectedId
              ? useRunStore.getState().send(selectedId, text, mentions, rounds)
              : Promise.resolve(false)
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
          <MemberPanel
            chatId={selectedId}
            members={members}
            agents={agents}
            providers={providers}
            onAdd={(agentId) => setMembers([...memberIds, agentId])}
            onRemove={(agentId) => setMembers(memberIds.filter((id) => id !== agentId))}
            onReorder={(from, to) => setMembers(reorder(memberIds, from, to))}
          />

          <div className="h-px shrink-0 bg-border" />

          <section className="flex flex-col gap-3 px-1">
            <SectionTitle level={3}>{t('chat.groupSettings')}</SectionTitle>

            <Field label={t('chat.mode')} htmlFor="chat-mode">
              <Select
                id="chat-mode"
                data-testid="chat-mode"
                disabled={!selected}
                value={settings.mode}
                onChange={(event) => patchSettings({ mode: event.target.value as ChatMode })}
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
                disabled={!selected}
                onChange={(speaking) => patchSettings({ speaking })}
                options={[
                  {
                    value: 'sequential',
                    label: speakingLabel(t, 'sequential'),
                    testId: 'chat-speaking-sequential'
                  },
                  {
                    value: 'parallel',
                    label: speakingLabel(t, 'parallel'),
                    testId: 'chat-speaking-parallel'
                  }
                ]}
              />
            </div>

            <Field label={t('chat.maxAutoRounds')} htmlFor="chat-max-rounds">
              <Select
                id="chat-max-rounds"
                data-testid="chat-max-rounds"
                disabled={!selected}
                value={String(settings.maxAutoRounds)}
                onChange={(event) => patchSettings({ maxAutoRounds: Number(event.target.value) })}
                options={MAX_ROUND_CHOICES.map((rounds) => ({
                  value: String(rounds),
                  label: String(rounds)
                }))}
              />
            </Field>

            {/*
              Who writes the conclusion when the group agrees (S5.16). The
              members of this chat and one default row, and the default is an
              empty value rather than a sentinel id: "first in speaking order" is
              the absence of a choice, and `null` on the wire is what clears it
              (see `ChatSettingsPatch`). A member removed from the chat leaves a
              stored id that matches no option, so the select falls back to
              showing the default — which is exactly what the runner will do.
            */}
            <Field label={t('chat.closingSpeaker')} htmlFor="chat-closing-speaker">
              <Select
                id="chat-closing-speaker"
                data-testid="chat-closing-speaker"
                disabled={!selected || members.length === 0}
                value={
                  members.some((member) => member.id === settings.closingAgentId)
                    ? (settings.closingAgentId as string)
                    : ''
                }
                onChange={(event) =>
                  patchSettings({ closingAgentId: event.target.value || null })
                }
                options={[
                  { value: '', label: t('chat.closingSpeakerFirst') },
                  ...members.map((member) => ({ value: member.id, label: member.name }))
                ]}
              />
            </Field>

            <Field label={t('chat.timeout')} htmlFor="chat-timeout">
              <Select
                id="chat-timeout"
                data-testid="chat-timeout"
                disabled={!selected}
                value={String(hardTimeoutMs)}
                onChange={(event) => patchSettings({ hardTimeoutMs: Number(event.target.value) })}
                options={TIMEOUT_CHOICES_MS.map((ms) => ({
                  value: String(ms),
                  label: t('chat.secondsValue', { seconds: ms / 1000 })
                }))}
              />
            </Field>

            <Field label={t('chat.speakingOrder')}>
              <span className="text-[11px] text-fg-faint">{t('chat.speakingOrderHint')}</span>
            </Field>

            {/*
              The chat's working directory (S5.2). The path itself is data, not
              copy, so it is printed rather than translated — the folder's name
              on the line, the whole path in the tooltip. "Choose…" goes through
              the native picker, which is the one backend method that needs
              electron (`src/main/ipc/dialogs.ts`).
            */}
            <Field label={t('chat.workdir')} hint={t('chat.workdirHint')} layout="column">
              <div className="flex items-center gap-1.5">
                <span
                  data-testid="chat-workdir"
                  data-path={selected?.workdir ?? ''}
                  title={selected?.workdir ?? undefined}
                  className={
                    selected?.workdir
                      ? 'min-w-0 grow truncate font-mono text-[11px] text-fg-dim'
                      : 'min-w-0 grow truncate text-[11px] text-fg-faint'
                  }
                >
                  {selected?.workdir ? folderName(selected.workdir) : t('chat.workdirNone')}
                </span>
                <Button
                  size="sm"
                  data-testid="chat-workdir-choose"
                  disabled={!selectedId}
                  onClick={() => {
                    if (selectedId) void useChatsStore.getState().chooseWorkdir(selectedId)
                  }}
                >
                  {t('chat.workdirChoose')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="chat-workdir-clear"
                  disabled={!selectedId || !selected?.workdir}
                  onClick={() => {
                    if (selectedId) void useChatsStore.getState().setWorkdir(selectedId, null)
                  }}
                >
                  {t('chat.workdirClear')}
                </Button>
              </div>
            </Field>

            {/* The Goal block (S5.10), under the folder it is written against:
                the two kinds that name files are impossible without one, and
                reading the rows in this order is what makes that obvious. */}
            <GoalSettings
              chatId={selectedId}
              workdir={selected?.workdir ?? null}
              goal={selected?.goal ?? null}
            />
          </section>

          <div className="flex-1" />

          <ActionsCard
            chatId={selectedId}
            members={members}
            onSend={(text, rounds) => void composer.current?.submitText(text, rounds)}
            workdir={selected?.workdir}
            goal={selected?.goal}
            running={running}
            onWriteDeliverable={(chatId) =>
              void useRunStore.getState().handoff(chatId, 'deliver')
            }
          />
        </div>
      </Column>
    </>
  )
}
