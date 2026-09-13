/**
 * The scrolling transcript.
 *
 * The only behaviour beyond `map` is the scroll rule, and it is the one everybody
 * gets wrong: **follow the bottom only while the user is already at the bottom.**
 * Scrolling up to re-read an earlier answer while a reply streams must not yank
 * the view back down every few tokens. "At the bottom" is within
 * `BOTTOM_THRESHOLD_PX`, because a streaming message grows between the scroll
 * event and the next render and an exact comparison would be false half the time.
 *
 * Virtualization (react-virtuoso, per PLAN's tech table) is deliberately not here
 * yet: it interacts badly with growing rows, and S2.5 owns message rendering.
 */
import { MessagesSquare } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Message } from '@shared/types'
import { EmptyState } from '../ui'
import { MessageItem } from './message-item'

/** How close to the bottom still counts as "following the conversation". */
export const BOTTOM_THRESHOLD_PX = 64

export interface MessageListProps {
  chatId: string
  messages: Message[]
}

export function MessageList({ chatId, messages }: MessageListProps): React.JSX.Element {
  const { t } = useTranslation()
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)

  // Recorded on scroll rather than computed at render time: by render time the
  // content has already grown and the answer would always be "not at the bottom".
  const onScroll = (): void => {
    const element = scroller.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    following.current = distance <= BOTTOM_THRESHOLD_PX
  }

  // Layout effect, not effect: scrolling after the browser has painted the new
  // row is a visible jump.
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element || !following.current) return
    element.scrollTop = element.scrollHeight
  }, [messages])

  // Switching chats always lands at the newest message, whatever the previous
  // chat's scroll position was.
  useEffect(() => {
    following.current = true
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [chatId])

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      data-testid="message-list"
      className="flex flex-1 flex-col overflow-y-auto px-7 py-5"
    >
      {messages.length === 0 ? (
        <div className="m-auto">
          <EmptyState
            icon={MessagesSquare}
            title={t('chat.emptyMessagesTitle')}
            description={t('chat.emptyMessagesDescription')}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-[22px]">
          {messages.map((message) => (
            <MessageItem key={message.id} message={message} chatId={chatId} />
          ))}
        </div>
      )}
    </div>
  )
}
