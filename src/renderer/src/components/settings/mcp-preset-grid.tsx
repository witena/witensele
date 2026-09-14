/**
 * The connector gallery: a two-column grid of tiles that prefill the MCP editor
 * from `MCP_PRESETS`, with a "Custom" tile that clears the form back to an empty
 * stdio draft.
 *
 * It renders the table from `@shared/mcp-presets` directly. There is no backend
 * call behind it on purpose — the table is frozen data compiled into the bundle,
 * and a round trip would add a loading state to a list that cannot change at
 * runtime. That is the one thing it has in common with `preset-grid.tsx`.
 *
 * **Why this is a sibling of `preset-grid.tsx` rather than a generalisation of
 * it.** A provider tile is a monogram and a brand name, and the thing a user
 * picks between is a *vendor they already have an account with*. A connector
 * tile has to answer a different question — what does this server do, and will
 * it change anything — so it carries a one-line description, a read-only /
 * changes-things badge and the runner its command needs. Folding both into one
 * component would have meant six optional slots and a column count, and would
 * have dragged the providers feature into an MCP step to gain a shared `<button>`
 * wrapper. The duplication is the border and the focus ring.
 *
 * Brand names are **data and are not translated** (`Brave Search` is called that
 * in both languages). Two strings on a tile are not: the `custom` label, whose
 * "name" is a UI concept, and the description, which is looked up by a **runtime
 * key** — `settings.mcp.presets.<id>`. `used-keys.test.ts` cannot see a key built
 * at runtime, which is why `locales.test.ts` asserts that every preset id has one
 * in both locale files.
 */
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { MCP_PRESETS, type McpPreset } from '@shared/mcp-presets'
import { Badge } from '../ui'

export interface McpPresetGridProps {
  /** Id of the tile last picked, or `undefined` while none has been. */
  selectedId?: string | undefined
  onSelect: (presetId: string) => void
}

/** Keys live under this prefix, one per preset id. */
const DESCRIPTION_PREFIX = 'settings.mcp.presets.'

export function McpPresetGrid({ selectedId, onSelect }: McpPresetGridProps): React.JSX.Element {
  const { t } = useTranslation()

  const label = (preset: McpPreset): string =>
    preset.id === 'custom' ? t('settings.mcp.presetCustom') : preset.name

  /**
   * The badge, or nothing for `custom` — an empty form neither reads nor writes
   * anything yet, and claiming "read-only" there would be a promise about a
   * command the user has not typed.
   */
  const badge = (preset: McpPreset): string | undefined => {
    if (preset.id === 'custom') return undefined
    return preset.sideEffects ? t('settings.mcp.sideEffectsTag') : t('settings.mcp.presetReadOnly')
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {MCP_PRESETS.map((preset) => {
        const selected = preset.id === selectedId
        const tag = badge(preset)
        const description = t(`${DESCRIPTION_PREFIX}${preset.id}`)
        return (
          <button
            key={preset.id}
            type="button"
            data-testid={`mcp-preset-${preset.id}`}
            data-side-effects={preset.sideEffects ? 'true' : 'false'}
            aria-pressed={selected}
            title={description}
            onClick={() => onSelect(preset.id)}
            className={clsx(
              'flex flex-col gap-1 rounded-lg border bg-bg-base px-2.5 py-2.5 text-left transition-colors',
              'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
              selected
                ? 'border-accent text-fg'
                : 'border-border-strong text-fg-muted hover:border-fg-faint'
            )}
          >
            <span className="flex items-center gap-1.5">
              <span className="truncate text-xs">{label(preset)}</span>
              {tag ? (
                <Badge font="sans" tone={preset.sideEffects ? 'accent' : 'default'}>
                  {tag}
                </Badge>
              ) : null}
            </span>
            <span className="line-clamp-2 text-[11px] leading-snug text-fg-faint">
              {description}
            </span>
            {preset.requires ? (
              <span className="font-mono text-[10px] text-fg-faint">
                {t('settings.mcp.presetRequires', { runner: preset.requires })}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
