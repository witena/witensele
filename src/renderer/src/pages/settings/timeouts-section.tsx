/**
 * Settings → Timeouts & heartbeat.
 *
 * The three budgets `AgentSupervisor` runs on, plus the legend that explains what
 * the four dots in the member panel mean. The section is small but it is the only
 * place the user can see *why* an agent turned orange, so the explanation is part
 * of it rather than a tooltip somewhere else.
 *
 * ## Seconds here, milliseconds in storage
 *
 * `AppTimeouts` is milliseconds end to end — every duration in the shared types
 * is — but "120000" is not a number anybody wants to type. The fields convert on
 * the way in and out, and `SECONDS` is the single multiplier both directions go
 * through, so the two halves cannot drift.
 *
 * ## Why each field commits on blur rather than on every keystroke
 *
 * A controlled input writing straight through would persist "1", "12", "120" as
 * the user types 120, and briefly give the supervisor a one-millisecond hard
 * timeout. So the field keeps a local draft, and Enter or leaving the field
 * commits it; an empty or nonsensical value snaps back to what is stored instead
 * of being saved.
 */
import type { TFunction } from 'i18next'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_APP_SETTINGS, type AppTimeouts, type PresenceState } from '@shared/types'
import { Field, Input, PresenceDot, SectionTitle } from '../../components/ui'
import { useSettingsStore } from '../../stores/settings'

/** Milliseconds in one second; the only place the conversion is written down. */
const SECONDS = 1_000

/** Bounds the field accepts, in seconds. A zero budget would abort every turn. */
const MIN_SECONDS = 1
const MAX_SECONDS = 3_600

/** Literal `t()` calls, so the used-keys guard can see all four legend labels. */
function presenceLabel(t: TFunction, state: PresenceState): string {
  switch (state) {
    case 'available':
      return t('presence.available')
    case 'working':
      return t('presence.working')
    case 'away':
      return t('presence.away')
    case 'offline':
      return t('presence.offline')
  }
}

function legendDescription(t: TFunction, state: PresenceState): string {
  switch (state) {
    case 'available':
      return t('settings.timeouts.legendAvailable')
    case 'working':
      return t('settings.timeouts.legendWorking')
    case 'away':
      return t('settings.timeouts.legendAway')
    case 'offline':
      return t('settings.timeouts.legendOffline')
  }
}

const LEGEND: PresenceState[] = ['available', 'working', 'away', 'offline']

interface SecondsFieldProps {
  id: string
  testId: string
  label: string
  hint: string
  /** The stored value, in milliseconds. */
  valueMs: number
  onCommit: (ms: number) => void
}

function SecondsField({
  id,
  testId,
  label,
  hint,
  valueMs,
  onCommit
}: SecondsFieldProps): React.JSX.Element {
  const { t } = useTranslation()
  const stored = String(Math.round(valueMs / SECONDS))
  const [draft, setDraft] = useState(stored)

  // The stored value wins whenever it changes underneath the field — another
  // window, or the answer coming back from `settings.update`.
  useEffect(() => setDraft(stored), [stored])

  const commit = (): void => {
    const seconds = Number(draft)
    if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
      setDraft(stored)
      return
    }
    const rounded = Math.round(seconds)
    if (rounded * SECONDS !== valueMs) onCommit(rounded * SECONDS)
    setDraft(String(rounded))
  }

  return (
    <Field label={label} hint={t('settings.timeouts.unit')} htmlFor={id} layout="column">
      <Input
        id={id}
        data-testid={testId}
        type="number"
        min={MIN_SECONDS}
        max={MAX_SECONDS}
        wrapperClassName="w-40"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
      <p className="text-[11px] leading-relaxed text-fg-faint">{hint}</p>
    </Field>
  )
}

export function TimeoutsSection(): React.JSX.Element {
  const { t } = useTranslation()
  const timeouts: AppTimeouts = useSettingsStore(
    (state) => state.settings?.timeouts ?? DEFAULT_APP_SETTINGS.timeouts
  )

  const commit = (patch: Partial<AppTimeouts>): void => {
    void useSettingsStore.getState().setTimeouts(patch)
  }

  return (
    <div className="flex max-w-lg flex-col gap-4">
      <p className="text-xs leading-relaxed text-fg-muted">{t('settings.timeouts.intro')}</p>

      <SecondsField
        id="settings-stall-timeout"
        testId="settings-stall-timeout"
        label={t('settings.timeouts.stall')}
        hint={t('settings.timeouts.stallHint')}
        valueMs={timeouts.stallTimeoutMs}
        onCommit={(stallTimeoutMs) => commit({ stallTimeoutMs })}
      />

      <SecondsField
        id="settings-hard-timeout"
        testId="settings-hard-timeout"
        label={t('settings.timeouts.hard')}
        hint={t('settings.timeouts.hardHint')}
        valueMs={timeouts.hardTimeoutMs}
        onCommit={(hardTimeoutMs) => commit({ hardTimeoutMs })}
      />

      <SecondsField
        id="settings-tool-timeout"
        testId="settings-tool-timeout"
        label={t('settings.timeouts.tool')}
        hint={t('settings.timeouts.toolHint')}
        valueMs={timeouts.toolTimeoutMs}
        onCommit={(toolTimeoutMs) => commit({ toolTimeoutMs })}
      />

      <p className="text-[11px] leading-relaxed text-fg-faint">{t('settings.timeouts.perChat')}</p>

      <div className="flex flex-col gap-2 rounded-lg border border-border-strong p-3">
        <SectionTitle level={3}>{t('settings.timeouts.legend')}</SectionTitle>
        {LEGEND.map((state) => (
          <div key={state} className="flex items-start gap-2.5" data-testid="presence-legend-row">
            <PresenceDot
              state={state}
              label={presenceLabel(t, state)}
              className="mt-1"
              data-testid="presence-legend-dot"
            />
            <span className="flex min-w-0 flex-col gap-px">
              <span className="text-xs text-fg">{presenceLabel(t, state)}</span>
              <span className="text-[11px] text-fg-faint">{legendDescription(t, state)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
