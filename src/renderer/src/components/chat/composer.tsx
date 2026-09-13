/**
 * The composer: a textarea, the mention hint and one button that is either Send
 * or Stop.
 *
 * Keyboard contract from PLAN's "User interface": **Enter sends, Shift+Enter
 * inserts a newline.** IME composition is respected — pressing Enter to accept a
 * Chinese candidate must not send the message — which `event.nativeEvent.isComposing`
 * is the only reliable signal for.
 *
 * Send and Stop are the *same* slot rather than two buttons side by side: a run
 * is either happening or not, and two controls would leave the user guessing
 * which one applies. The mockup shows Stop in the same corner.
 *
 * The text is local state and is cleared only after `send` resolves true, so a
 * rejected send (no provider, chat deleted) leaves what was typed in the box.
 */
import { SendHorizontal, Square } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AtSign } from 'lucide-react'
import { Badge, Button, IconButton, TextArea } from '../ui'

export interface ComposerProps {
  /** `null` disables everything: there is nothing to send into. */
  chatId: string | null
  /** True while a run is active; the button becomes Stop. */
  running: boolean
  /** Resolves true when the message was accepted, which clears the box. */
  onSend: (text: string) => Promise<boolean>
  onStop: () => void
}

export function Composer({ chatId, running, onSend, onStop }: ComposerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const disabled = chatId === null
  const canSend = !disabled && !busy && text.trim().length > 0

  const submit = async (): Promise<void> => {
    if (!canSend) return
    setBusy(true)
    try {
      if (await onSend(text)) setText('')
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    // Mid-composition Enter belongs to the IME, not to us.
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    void submit()
  }

  return (
    <div className="shrink-0 px-7 pt-3 pb-[18px]">
      <div className="flex flex-col gap-2.5 rounded-[10px] border border-border-strong bg-bg-elevated px-3 py-2.5">
        <TextArea
          rows={2}
          value={text}
          disabled={disabled}
          data-testid="composer-input"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('chat.composerPlaceholder')}
          aria-label={t('chat.composerPlaceholder')}
        />
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            {/* Autocomplete for `@` is S2.5; the hint is the mockup's chip row. */}
            <Badge font="sans" className="gap-1">
              <AtSign aria-hidden="true" className="h-3 w-3" />
              {t('chat.mentionHint')}
            </Badge>
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
    </div>
  )
}
