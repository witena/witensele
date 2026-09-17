/**
 * The composer: an auto-growing textarea, an `@` autocomplete, the mention chip
 * row and one button that is either Send or Stop.
 *
 * Keyboard contract from PLAN's "User interface": **Enter sends, Shift+Enter
 * inserts a newline.** IME composition is respected — pressing Enter to accept a
 * Chinese candidate must not send the message — which `event.nativeEvent.isComposing`
 * is the only reliable signal for. While the autocomplete is open Enter belongs
 * to the popover instead: it accepts the highlighted member rather than sending
 * a half-typed name.
 *
 * Send and Stop are the *same* slot rather than two buttons side by side: a run
 * is either happening or not, and two controls would leave the user guessing
 * which one applies. The mockup shows Stop in the same corner.
 *
 * ## The autocomplete
 *
 * Typing `@` at the start of the text or after whitespace opens a popover of the
 * chat's members — avatar, name, model — filtered by what follows. Arrow keys
 * move, Enter and Tab insert `@Name `, Escape closes, and a click does the same
 * as Enter. Everything that could be wrong about *where the token is* and
 * *which member matches* lives in `mention-query.ts` and is unit-tested there;
 * this file owns the key handling and the markup.
 *
 * The chip row under the textarea is the same action without the typing: one
 * chip per member plus `@all`, each inserting `@Name ` at the caret. The mockup
 * draws it as a static hint; making the chips real costs nothing and is the
 * fastest path to a mention on a five-member chat.
 *
 * `@Name` tokens are resolved against the chat's members with the **same**
 * parser the backend uses (`@shared/mentions`) and sent along with the text, so
 * "who did the user call on" is decided once rather than twice.
 *
 * The text is local state and is cleared only after `send` resolves true, so a
 * rejected send (no provider, chat deleted, no members yet) leaves what was typed
 * in the box — and `error` prints why, right where the user is looking, instead
 * of the message simply vanishing into nothing.
 */
import clsx from 'clsx'
import { SendHorizontal, Square } from 'lucide-react'
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject
} from 'react'
import { useTranslation } from 'react-i18next'
import { MENTION_ALL_KEYWORDS, parseMentions, type MentionMember } from '@shared/mentions'
import type { Agent } from '@shared/types'
import { avatarStyle } from '../agents/agent-display'
import { Avatar, Badge, Button, IconButton, TextArea } from '../ui'
import {
  appendMention,
  extractMentionQuery,
  filterMentionCandidates,
  insertMention,
  type MentionCandidate,
  type MentionInsertion,
  type MentionQuery
} from './mention-query'

/** How tall the textarea may grow before it starts scrolling, in lines. */
export const MAX_COMPOSER_LINES = 8

/** Line height of the textarea in pixels; `text-sm leading-relaxed` is 14 × 1.625. */
const LINE_HEIGHT_PX = 22

/** What the parent may ask the composer to do. Used by the Actions card. */
export interface ComposerHandle {
  /**
   * Sends `text` as if it had been typed, resolving mentions the same way.
   *
   * `rounds` (S5.14) caps the chain that message starts; it travels with the
   * send rather than being a second path into the backend, so "Start a vote" is
   * still an ordinary message the transcript records in full.
   */
  submitText: (text: string, rounds?: number) => Promise<boolean>
}

export interface ComposerProps {
  /** `null` disables everything: there is nothing to send into. */
  chatId: string | null
  /** The chat's members, for resolving `@Name` before the message is sent. */
  members?: readonly Agent[]
  /** True while a run is active; the button becomes Stop. */
  running: boolean
  /**
   * Resolves true when the message was accepted, which clears the box.
   *
   * `rounds` is set only by `submitText` (S5.14); a typed message never carries
   * one and runs under the chat's own `maxAutoRounds`.
   */
  onSend: (text: string, mentions: string[], rounds?: number) => Promise<boolean>
  onStop: () => void
  /** Already-translated reason the last send was refused. */
  error?: string | undefined
  /** Imperative escape hatch for the Actions card; see `ComposerHandle`. */
  handleRef?: RefObject<ComposerHandle | null> | undefined
}

export function Composer({
  chatId,
  members = [],
  running,
  onSend,
  onStop,
  error,
  handleRef
}: ComposerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [span, setSpan] = useState<MentionQuery | null>(null)
  const [active, setActive] = useState(0)
  const textarea = useRef<HTMLTextAreaElement>(null)

  const disabled = chatId === null
  const canSend = !disabled && !busy && text.trim().length > 0

  const mentionMembers: MentionMember[] = members.map((member) => ({
    agentId: member.id,
    name: member.name
  }))

  const candidates: MentionCandidate[] = span
    ? filterMentionCandidates(mentionMembers, span.query)
    : []
  const popoverOpen = span !== null && candidates.length > 0

  // The box grows with its content up to eight lines and then scrolls. Height is
  // reset to `auto` first: without that, `scrollHeight` only ever reports the
  // height the box already has and the textarea can never shrink again.
  useLayoutEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_COMPOSER_LINES * LINE_HEIGHT_PX)}px`
  }, [text])

  // A chat switch clears everything the previous chat's composer was holding.
  useEffect(() => {
    setSpan(null)
    setActive(0)
  }, [chatId])

  const send = async (value: string, rounds?: number): Promise<boolean> => {
    const trimmed = value.trim()
    if (disabled || trimmed.length === 0) return false
    setBusy(true)
    try {
      return await onSend(trimmed, parseMentions(trimmed, mentionMembers), rounds)
    } finally {
      setBusy(false)
    }
  }

  useImperativeHandle(handleRef, () => ({ submitText: send }), [chatId, members])

  const submit = async (): Promise<void> => {
    if (!canSend) return
    if (await send(text)) {
      setText('')
      setSpan(null)
    }
  }

  /** Re-reads the `@…` token under the caret after any edit or caret move. */
  const syncQuery = (value: string, caret: number): void => {
    const found = extractMentionQuery(value, caret)
    setSpan(found)
    setActive(0)
  }

  /**
   * Applies an insertion and puts the caret after it.
   *
   * The DOM value is written **synchronously**, before React re-renders with the
   * same string. Deferring the caret to an animation frame instead looks fine by
   * hand and is a real race under automation: anything that reads or replaces the
   * box in between sees the old value and a caret that jumps under it.
   */
  const apply = (next: MentionInsertion): void => {
    setText(next.text)
    setSpan(null)
    const element = textarea.current
    if (!element) return
    element.value = next.text
    element.focus()
    element.setSelectionRange(next.caret, next.caret)
  }

  const accept = (candidate: MentionCandidate): void => {
    if (span) apply(insertMention(text, span, candidate.name))
  }

  const insertChip = (name: string): void => {
    const caret = textarea.current?.selectionStart ?? text.length
    apply(appendMention(text, caret, name))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (popoverOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((index) => (index + 1) % candidates.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index) => (index - 1 + candidates.length) % candidates.length)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSpan(null)
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) {
        event.preventDefault()
        const candidate = candidates[active] ?? candidates[0]
        if (candidate) accept(candidate)
        return
      }
    }

    if (event.key !== 'Enter' || event.shiftKey) return
    // Mid-composition Enter belongs to the IME, not to us.
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    void submit()
  }

  const [everyone] = MENTION_ALL_KEYWORDS

  return (
    <div className="shrink-0 px-7 pt-3 pb-[18px]">
      <div className="relative flex flex-col gap-2.5 rounded-[10px] border border-border-strong bg-bg-elevated px-3 py-2.5">
        {popoverOpen ? (
          <div
            data-testid="mention-popover"
            role="listbox"
            aria-label={t('chat.mentionHint')}
            className="absolute bottom-full left-2 z-20 mb-2 flex max-h-64 w-[264px] flex-col gap-0.5 overflow-y-auto rounded-lg border border-border-strong bg-bg-elevated p-1.5 shadow-lg"
          >
            {candidates.map((candidate, index) => {
              const member = members.find((agent) => agent.id === candidate.agentId)
              return (
                <button
                  key={candidate.agentId ?? `keyword-${candidate.name}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  data-testid="mention-option"
                  data-name={candidate.name}
                  // `mousedown`, not `click`: a click would first blur the
                  // textarea, which closes the popover before the handler runs.
                  onMouseDown={(event) => {
                    event.preventDefault()
                    accept(candidate)
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={clsx(
                    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                    index === active ? 'bg-bg-hover' : 'hover:bg-bg-hover'
                  )}
                >
                  {member ? (
                    <Avatar
                      text={member.avatar.text}
                      {...avatarStyle(member.avatar)}
                      size="md"
                    />
                  ) : (
                    <Avatar text="@" size="md" />
                  )}
                  <span className="flex min-w-0 flex-col gap-px">
                    <span className="truncate text-[13px] text-fg">{`@${candidate.name}`}</span>
                    <span className="truncate font-mono text-[11px] text-fg-faint">
                      {member ? member.modelId : t('chat.mentionAllHint')}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}

        <TextArea
          ref={textarea}
          // One line to start with, as the artboard has it; the layout effect
          // above grows the box from there.
          rows={1}
          value={text}
          disabled={disabled}
          data-testid="composer-input"
          style={{ maxHeight: `${MAX_COMPOSER_LINES * LINE_HEIGHT_PX}px` }}
          onChange={(event) => {
            setText(event.target.value)
            syncQuery(event.target.value, event.target.selectionStart)
          }}
          onKeyUp={(event) => {
            // Arrow keys and clicks move the caret without changing the text, and
            // the token under it changes with them.
            if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
              syncQuery(event.currentTarget.value, event.currentTarget.selectionStart)
            }
          }}
          onBlur={() => setSpan(null)}
          onKeyDown={onKeyDown}
          placeholder={t('chat.composerPlaceholder')}
          aria-label={t('chat.composerPlaceholder')}
        />

        <div className="flex items-center justify-between gap-3">
          <div
            data-testid="mention-chips"
            className="flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden"
          >
            {members.map((member) => (
              <button
                key={member.id}
                type="button"
                data-testid="mention-chip"
                data-agent-id={member.id}
                disabled={disabled}
                onClick={() => insertChip(member.name)}
                className="rounded transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
              >
                <Badge>{`@${member.name}`}</Badge>
              </button>
            ))}
            {members.length > 0 ? (
              <button
                type="button"
                data-testid="mention-chip-all"
                disabled={disabled}
                onClick={() => insertChip(everyone as string)}
                className="rounded transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
              >
                <Badge tone="accent">{`@${everyone}`}</Badge>
              </button>
            ) : (
              <Badge font="sans">{t('chat.mentionHint')}</Badge>
            )}
          </div>

          {running ? (
            <Button variant="danger" data-testid="composer-stop" onClick={onStop}>
              <Square aria-hidden="true" className="h-3 w-3 fill-current" />
              {t('chat.stop')}
            </Button>
          ) : (
            <IconButton
              variant="secondary"
              label={t('chat.send')}
              data-testid="composer-send"
              disabled={!canSend}
              onClick={() => void submit()}
            >
              <SendHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
      </div>

      {error ? (
        <p data-testid="composer-error" className="px-1 pt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
