/**
 * Settings → Developer: the transport and i18n smoke surface.
 *
 * This is the S1.3/S1.4 smoke screen, moved out of `App.tsx` (which S1.5 turns
 * into the real shell) and given a home instead of being deleted. It still earns
 * its place: `smoke.spec.ts` and `i18n.spec.ts` drive the whole stack through it —
 * renderer → preload → main → SQLite for `ping` and the language setting, and
 * main → renderer for the test event — and none of that is observable anywhere
 * else until S1.7 puts a real message on screen.
 *
 * Each `data-testid` wraps a **value**, never its translated label, so the
 * Playwright assertions do not depend on the active UI language.
 *
 * ## The Editor block (S5.7)
 *
 * It lives here rather than in Appearance & language because of who it is for:
 * `code -g {path}:{line}` is a command line, the setting only matters to someone
 * who reads code out of a chat, and Developer is already where the things that
 * assume a terminal live. The kind is a `SegmentedControl` because three options
 * should be comparable at a glance, and the command field appears only for
 * `custom` — the template is meaningless for the two URL schemes and showing it
 * greyed out would just invite someone to edit it.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_APP_SETTINGS, type EditorKind } from '@shared/types'
import { getBackend } from '../../lib/backend-provider'
import { useSettingsStore } from '../../stores/settings'
import { Button, Field, Input, SectionTitle, SegmentedControl } from '../../components/ui'
import { applyEditorSetting } from './editor'

/**
 * The editor choice and, for a custom one, its command template.
 *
 * The template field commits on blur or Enter, exactly like the timeout fields:
 * a controlled input writing straight through would persist `c`, `co`, `cod` as
 * someone types `code`, and the backend refuses a blank command — so an empty
 * field snaps back to what is stored rather than throwing on every keystroke.
 */
function EditorBlock(): React.JSX.Element {
  const { t } = useTranslation()
  const editor = useSettingsStore((state) => state.settings?.editor ?? DEFAULT_APP_SETTINGS.editor)
  const [draft, setDraft] = useState(editor.command)

  // The stored value wins whenever it changes underneath the field.
  useEffect(() => setDraft(editor.command), [editor.command])

  const commit = (): void => {
    const command = draft.trim()
    if (command.length === 0 || command === editor.command) {
      setDraft(editor.command)
      return
    }
    applyEditorSetting({ command })
  }

  // Literal `t()` calls rather than a key table, so `used-keys.test.ts` can see
  // every one of them (the rule `appearance-section.tsx` follows).
  const kinds: { value: EditorKind; label: string; testId: string }[] = [
    { value: 'vscode', label: t('settings.developer.editorVscode'), testId: 'editor-vscode' },
    { value: 'cursor', label: t('settings.developer.editorCursor'), testId: 'editor-cursor' },
    { value: 'custom', label: t('settings.developer.editorCustom'), testId: 'editor-custom' }
  ]

  return (
    <div className="flex w-full flex-col gap-3" data-testid="settings-editor">
      <SectionTitle level={3}>{t('settings.developer.editor')}</SectionTitle>

      <SegmentedControl
        value={editor.kind}
        onChange={(kind) => applyEditorSetting({ kind })}
        options={kinds}
        className="w-full"
      />
      <p className="text-[11px] leading-relaxed text-fg-faint">
        {t('settings.developer.editorHint')}
      </p>

      {editor.kind === 'custom' ? (
        <Field
          label={t('settings.developer.editorCommand')}
          htmlFor="settings-editor-command"
          layout="column"
        >
          <Input
            id="settings-editor-command"
            data-testid="settings-editor-command"
            className="font-mono"
            wrapperClassName="w-full"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
          <p className="text-[11px] leading-relaxed text-fg-faint">
            {t('settings.developer.editorCommandHint')}
          </p>
        </Field>
      ) : null}
    </div>
  )
}

export function DeveloperSection(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [ping, setPing] = useState<string | null>(null)
  const [lastEvent, setLastEvent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const languageSetting = useSettingsStore((state) => state.settings?.language ?? null)
  const settingsError = useSettingsStore((state) => state.error)

  useEffect(() => {
    // Request/response: renderer -> preload -> main -> handler.
    void (async () => {
      try {
        setPing(await getBackend().invoke('system.ping'))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }, [])

  useEffect(() => {
    // Push. Unsubscribing matters under StrictMode, which runs this twice in dev.
    return getBackend().subscribe((event) => {
      if (event.type === 'system.test') setLastEvent(event.payload)
    })
  }, [])

  const pending = t('settings.developer.pending')
  const failure = error ?? settingsError ?? null

  return (
    <div className="flex max-w-lg flex-col items-start gap-3 text-sm">
      <p className="text-fg-muted">
        <span>{t('settings.developer.backend')}</span>{' '}
        <span className="font-mono text-fg" data-testid="ping">
          {ping ?? pending}
        </span>
      </p>
      <p className="text-fg-muted">
        <span>{t('settings.developer.languageSetting')}</span>{' '}
        <span className="font-mono text-fg" data-testid="language">
          {languageSetting ?? pending}
        </span>
      </p>
      <p className="text-fg-muted">
        <span>{t('settings.developer.resolvedLanguage')}</span>{' '}
        <span className="font-mono text-fg" data-testid="resolved-language">
          {i18n.language}
        </span>
      </p>
      <p className="text-fg-muted">
        <span>{t('settings.developer.lastEvent')}</span>{' '}
        <span className="font-mono text-fg" data-testid="last-event">
          {lastEvent ?? t('settings.developer.noEvent')}
        </span>
      </p>

      <Button
        data-testid="emit-test-event"
        onClick={() => {
          void getBackend().invoke('system.emitTestEvent', { payload: `hello-${Date.now()}` })
        }}
      >
        {t('settings.developer.emitTestEvent')}
      </Button>

      <EditorBlock />

      {failure ? (
        <p className="text-danger" data-testid="error">
          {failure}
        </p>
      ) : null}
    </div>
  )
}
