/**
 * The scrolling transcript, virtualized with react-virtuoso.
 *
 * ## Why a virtualizer, and why this one
 *
 * A long discussion is hundreds of messages, each of them a markdown document
 * with highlighted code in it. Mounting all of that to show twenty rows is what
 * eventually makes a chat window feel slow, and the rows are exactly the kind of
 * content — variable height, growing while it streams — that a hand-written
 * windowing loop gets wrong. `react-virtuoso` measures rows itself and is the
 * component PLAN's tech table already names.
 *
 * The one behaviour everybody gets wrong is the scroll rule: **follow the bottom
 * only while the user is already at the bottom.** Scrolling up to re-read an
 * earlier answer while a reply streams must not yank the view back down every
 * few tokens. `followOutput` receives exactly that flag, so the rule is one line
 * rather than a scroll listener and a threshold — and when the user *is* scrolled
 * up, new messages raise a "jump to latest" pill instead of moving the viewport.
 *
 * `increaseViewportBy` is deliberately generous. It keeps a screen of rows
 * mounted on either side, which hides the one artefact virtualization otherwise
 * has here: a row whose height changes as it streams, being unmounted and
 * remeasured the moment it leaves the viewport.
 *
 * ## Day separators
 *
 * The list renders a **flat array of rows** — a separator is a row of its own,
 * not a wrapper — because that is the only shape a virtualizer can measure. The
 * transform lives in `transcript-rows.ts` and is unit-tested there.
 */
import { ArrowDown, MessagesSquare } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { TFunction } from 'i18next'
import type { Agent, Message } from '@shared/types'
import { EmptyState } from '../ui'
import { MessageItem } from './message-item'
import { buildTranscriptRows, type DayBucket, type TranscriptRow } from './transcript-rows'

/** How much is kept mounted above and below the viewport, in pixels. */
const VIEWPORT_OVERSCAN_PX = 2_000

/**
 * The separator's text: two translated labels plus, for anything older, the
 * date itself.
 *
 * The date is `Intl`, not a translation: a locale already knows how to write
 * "3 May" and its Chinese equivalent, and a `{{month}} {{day}}` key would get one
 * of them wrong. The year is added only when the message is not from this year,
 * which is the rule every chat client follows.
 */
function dayLabel(t: TFunction, bucket: DayBucket, timestamp: number, language: string): string {
  switch (bucket) {
    case 'today':
      return t('chat.today')
    case 'yesterday':
      return t('chat.yesterday')
    case 'date': {
      const date = new Date(timestamp)
      const sameYear = date.getFullYear() === new Date().getFullYear()
      return date.toLocaleDateString(language, {
        month: 'short',
        day: 'numeric',
        ...(sameYear ? {} : { year: 'numeric' })
      })
    }
  }
}

export interface MessageListProps {
  chatId: string
  messages: Message[]
  /** The chat's members, passed down so each row can highlight their names. */
  members?: readonly Agent[]
  /**
   * A message to scroll to, and the click that asked for it (S5.16).
   *
   * The header's "Conclusion" chip is the only caller. `nonce` is what makes a
   * second click on the **same** message scroll again: without it the effect
   * below sees identical props and does nothing, which reads as a broken chip
   * once the user has scrolled away from the row it already found once.
   */
  scrollTo?: { messageId: string; nonce: number } | undefined
}

export function MessageList({
  chatId,
  messages,
  members,
  scrollTo
}: MessageListProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const virtuoso = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [unread, setUnread] = useState(0)
  const lastCount = useRef(messages.length)

  const rows = useMemo(() => buildTranscriptRows(messages), [messages])

  // Messages that arrived while the user was reading further up. Counting
  // *messages* rather than deltas: a streaming reply must raise the pill once,
  // not once per token.
  useEffect(() => {
    const grew = messages.length > lastCount.current
    lastCount.current = messages.length
    if (!grew) return
    if (atBottom) setUnread(0)
    else setUnread((count) => count + 1)
  }, [messages.length, atBottom])

  // Switching chats always lands at the newest message, whatever the previous
  // chat's scroll position was.
  useEffect(() => {
    setAtBottom(true)
    setUnread(0)
    lastCount.current = 0
  }, [chatId])

  // The header chip's scroll (S5.16). `align: 'center'` rather than `'start'`
  // because a conclusion is a block of text, not a line: putting its first line
  // at the top of the viewport hides the fact that there is more of it.
  //
  // The rows are read through a ref and are **not** a dependency: the effect
  // runs when the user clicked, and a list that rebuilds on every streamed token
  // would otherwise drag the viewport back to the conclusion while the next
  // answer is still arriving.
  const latestRows = useRef(rows)
  latestRows.current = rows
  useEffect(() => {
    if (!scrollTo) return
    const index = latestRows.current.findIndex(
      (row) => row.kind === 'message' && row.message.id === scrollTo.messageId
    )
    if (index === -1) return
    virtuoso.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })
  }, [scrollTo?.messageId, scrollTo?.nonce])

  const jump = (): void => {
    virtuoso.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
    setUnread(0)
  }

  if (messages.length === 0) {
    return (
      <div data-testid="message-list" className="flex flex-1 items-center overflow-y-auto px-7 py-5">
        <div className="m-auto">
          <EmptyState
            icon={MessagesSquare}
            title={t('chat.emptyMessagesTitle')}
            description={t('chat.emptyMessagesDescription')}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Virtuoso<TranscriptRow>
        ref={virtuoso}
        data-testid="message-list"
        data={rows}
        // The transcript is oldest-first, so the interesting end is the bottom.
        initialTopMostItemIndex={rows.length - 1}
        followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
        atBottomStateChange={(bottom) => {
          setAtBottom(bottom)
          if (bottom) setUnread(0)
        }}
        atBottomThreshold={64}
        increaseViewportBy={VIEWPORT_OVERSCAN_PX}
        computeItemKey={(_index, row) => row.key}
        className="flex-1"
        itemContent={(_index, row) =>
          row.kind === 'day' ? (
            <div className="flex items-center gap-3 px-7 py-2.5">
              <span className="h-px grow bg-border" />
              <span
                data-testid="day-separator"
                data-bucket={row.bucket}
                className="text-[11px] tracking-wide text-fg-faint uppercase"
              >
                {dayLabel(t, row.bucket, row.timestamp, i18n.language)}
              </span>
              <span className="h-px grow bg-border" />
            </div>
          ) : (
            // The 22px gap of the mockup, as padding on the row: a virtualized
            // list has no parent flex container that could carry a `gap`.
            <div className="px-7 pb-[22px]">
              <MessageItem
                message={row.message}
                chatId={chatId}
                conclusion={row.conclusion}
                viaClient={row.viaClient}
                {...(members ? { members } : {})}
              />
            </div>
          )
        }
        components={{
          Header: () => <div className="h-5" />,
          Footer: () => <div className="h-1" />
        }}
      />

      {!atBottom && unread > 0 ? (
        <button
          type="button"
          data-testid="jump-to-latest"
          onClick={jump}
          className="absolute inset-x-0 bottom-3 mx-auto flex w-fit items-center gap-1.5 rounded-full border border-border-strong bg-bg-elevated px-3 py-1.5 text-[11px] text-fg-muted shadow-lg transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          <ArrowDown aria-hidden="true" className="h-3 w-3" />
          {t('chat.jumpToLatest')}
        </button>
      ) : null}
    </div>
  )
}
