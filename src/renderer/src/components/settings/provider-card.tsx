/**
 * One provider in the settings list: monogram, name, endpoint, status pill and
 * the model chips — the card from the settings artboard.
 *
 * It is a `<button>` rather than a `<div>` with a click handler, because it *is*
 * the selection control for the editor next to it: that buys focus, Enter and
 * Space, and `aria-current` for free.
 *
 * It takes its labels already translated, like every other primitive, so no
 * shared component can hide an untranslated literal.
 *
 * S7.6 added one line to it: a provider whose stored key this build cannot
 * decrypt says so under its name. The status pill cannot carry that — the key
 * *is* stored, so "no key" would be a lie and "untested" says nothing — and the
 * user needs a sentence, not a colour.
 */
import clsx from 'clsx'
import type { Provider } from '@shared/types'
import { Avatar, Chip, StatusPill } from '../ui'
import { providerLogo } from './provider-logo'
import {
  keyUnreadable,
  providerHost,
  providerStatusTone,
  type ProviderStatus
} from './provider-display'

/** How many model chips fit on a card before the rest become a "+N" chip. */
const VISIBLE_MODELS = 4

export interface ProviderCardProps {
  provider: Provider
  selected: boolean
  status: ProviderStatus
  /** Already translated status label. */
  statusLabel: string
  /** Already translated "+N more" chip, or absent when everything fits. */
  overflowLabel?: string | undefined
  /**
   * Already translated explanation for a key this build cannot decrypt (S7.6).
   *
   * Rendered only when the provider's `keyState` says so, so the caller may
   * always pass it; the card decides whether the sentence applies.
   */
  keyUnreadableLabel?: string | undefined
  onSelect: () => void
}

export function ProviderCard({
  provider,
  selected,
  status,
  statusLabel,
  overflowLabel,
  keyUnreadableLabel,
  onSelect
}: ProviderCardProps): React.JSX.Element {
  const logo = providerLogo(provider.name, provider.presetId)
  const visible = provider.models.slice(0, VISIBLE_MODELS)
  const hidden = provider.models.length - visible.length

  return (
    <button
      type="button"
      data-testid="provider-card"
      data-provider-id={provider.id}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={clsx(
        'flex w-full flex-col gap-2.5 rounded-[10px] border bg-bg-elevated px-4 py-3.5 text-left transition-colors',
        'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
        selected ? 'border-accent' : 'border-border-strong hover:border-fg-faint'
      )}
    >
      <div className="flex items-center gap-3">
        <Avatar size="lg" text={logo.text} color={logo.color} textColor={logo.textColor} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg">{provider.name}</p>
          <p
            data-testid="provider-card-host"
            className="truncate font-mono text-[11px] text-fg-faint"
          >
            {providerHost(provider)}
          </p>
        </div>
        <StatusPill
          data-testid="provider-card-status"
          data-status={status}
          tone={providerStatusTone(status)}
          label={statusLabel}
        />
      </div>

      {keyUnreadable(provider) && keyUnreadableLabel ? (
        <p
          data-testid="provider-card-key-unreadable"
          className="text-[11px] leading-snug text-status-warn"
        >
          {keyUnreadableLabel}
        </p>
      ) : null}

      {provider.models.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {visible.map((model) => (
            <Chip key={model}>{model}</Chip>
          ))}
          {hidden > 0 && overflowLabel ? <Chip font="sans">{overflowLabel}</Chip> : null}
        </div>
      ) : null}
    </button>
  )
}
