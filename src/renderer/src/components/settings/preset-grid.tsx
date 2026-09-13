/**
 * The "start from a preset" picker: a three-column grid of monogram-plus-name
 * tiles, the selected one outlined in the accent colour.
 *
 * The grid renders `PROVIDER_PRESETS` from `@shared/presets` directly. There is
 * no backend call behind it on purpose — the table is frozen data compiled into
 * the bundle, and a round trip would add a loading state to a list that cannot
 * change at runtime.
 *
 * Preset names are brand names and are not translated. The single exception is
 * `custom`, whose "name" is a UI concept rather than a brand, so the caller
 * passes its label in.
 */
import clsx from 'clsx'
import { PROVIDER_PRESETS, type ProviderPreset } from '@shared/presets'
import { Avatar } from '../ui'
import { providerLogo } from './provider-logo'

export interface PresetGridProps {
  /** Id of the selected preset, or `undefined` while nothing is chosen. */
  selectedId?: string | undefined
  onSelect: (presetId: string) => void
  /** Translated label for the `custom` entry; every other tile uses its brand name. */
  customLabel: string
}

function label(preset: ProviderPreset, customLabel: string): string {
  return preset.id === 'custom' ? customLabel : preset.name
}

export function PresetGrid({
  selectedId,
  onSelect,
  customLabel
}: PresetGridProps): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-2">
      {PROVIDER_PRESETS.map((preset) => {
        const logo = providerLogo(preset.name, preset.id)
        const selected = preset.id === selectedId
        return (
          <button
            key={preset.id}
            type="button"
            data-testid={`preset-${preset.id}`}
            aria-pressed={selected}
            onClick={() => onSelect(preset.id)}
            className={clsx(
              'flex items-center gap-2.5 rounded-lg border bg-bg-base px-2.5 py-2.5 text-left text-xs transition-colors',
              'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
              selected
                ? 'border-accent text-fg'
                : 'border-border-strong text-fg-muted hover:border-fg-faint'
            )}
          >
            <Avatar size="sm" text={logo.text} color={logo.color} textColor={logo.textColor} />
            <span className="truncate">{label(preset, customLabel)}</span>
          </button>
        )
      })}
    </div>
  )
}
