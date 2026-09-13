/**
 * The add / edit panel for one MCP server: name, transport, the fields that
 * transport needs, the side-effects switch, and the Test / Save (/ Delete) row.
 *
 * It mirrors `ProviderEditor` — the draft lives in `stores/mcp.ts`, only Save
 * writes, Delete confirms with a second click rather than a modal — and adds the
 * three ideas a server has and a provider does not:
 *
 * - **The transport decides which half of the form exists.** `SegmentedControl`
 *   switches between the stdio fields (command, arguments, environment) and the
 *   http one (URL, headers). The hidden half is *kept* in the draft rather than
 *   cleared, so flipping the switch twice does not lose what was typed.
 * - **Arguments and environment are edited as text.** One argument per line, one
 *   `KEY=VALUE` per line; see `argsToText` / `textToEnv` in the store for why
 *   neither is a chip list or a space-separated field.
 * - **"Test connection" shows the tool list.** The point of the probe is not that
 *   a process started — it is which tools an agent would get, so the result lists
 *   them with their descriptions.
 *
 * The side-effects switch carries the explanation from `PLAN.md` inline, because
 * it is the one control on this page whose consequence is invisible: it decides
 * whether a participant agent ever sees these tools.
 */
import clsx from 'clsx'
import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { McpServerRef } from '@shared/backend'
import type { McpTransport } from '@shared/types'
import { Button, Field, Input, SectionTitle, SegmentedControl, Spinner, TextArea, Toggle } from '../ui'
import { translateError } from '../../i18n/errors'
import {
  DRAFT_TEST_KEY,
  argsToText,
  envToText,
  textToArgs,
  textToEnv,
  useMcpStore
} from '../../stores/mcp'

/** How long the delete latch stays armed before it forgets it was clicked. */
const CONFIRM_DELETE_MS = 4_000

export function McpEditor(): React.JSX.Element | null {
  const { t } = useTranslation()

  const draft = useMcpStore((state) => state.draft)
  const mode = useMcpStore((state) => state.mode)
  const selectedId = useMcpStore((state) => state.selectedId)
  const testResults = useMcpStore((state) => state.testResults)
  const logs = useMcpStore((state) => state.logs)
  const testing = useMcpStore((state) => state.testing)
  const saving = useMcpStore((state) => state.saving)
  const error = useMcpStore((state) => state.error)
  const errorCode = useMcpStore((state) => state.errorCode)

  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [showLog, setShowLog] = useState(false)

  // The latch must not stay armed while the user is off doing something else.
  useEffect(() => {
    if (!confirmingDelete) return
    const timer = setTimeout(() => setConfirmingDelete(false), CONFIRM_DELETE_MS)
    return () => clearTimeout(timer)
  }, [confirmingDelete])

  // Switching records must not carry the previous one's half-finished state.
  useEffect(() => {
    setConfirmingDelete(false)
    setShowLog(false)
  }, [selectedId, mode])

  if (!draft) return null

  const store = useMcpStore.getState
  const result = testResults[selectedId ?? DRAFT_TEST_KEY]
  const log = selectedId ? (logs[selectedId] ?? []) : []
  const isStdio = draft.transport === 'stdio'
  // Probing the draft, not the record: a command the user just typed has to be
  // testable before Save, exactly as a provider's key is.
  const ref: McpServerRef = { draft }
  const canProbe = isStdio ? Boolean(draft.command?.trim()) : Boolean(draft.url?.trim())

  return (
    <div data-testid="mcp-editor" className="flex max-w-2xl flex-col gap-4.5">
      <Field label={t('settings.mcp.name')} htmlFor="mcp-name" layout="column">
        <Input
          id="mcp-name"
          data-testid="mcp-name-input"
          value={draft.name}
          placeholder={t('settings.mcp.namePlaceholder')}
          onChange={(event) => store().patchDraft({ name: event.target.value })}
        />
        <p className="text-[11px] text-fg-faint">{t('settings.mcp.nameHint')}</p>
      </Field>

      <Field label={t('settings.mcp.transport')} layout="column">
        <SegmentedControl<McpTransport>
          value={draft.transport}
          onChange={(transport) => store().patchDraft({ transport })}
          options={[
            { value: 'stdio', label: t('settings.mcp.transportStdio'), testId: 'mcp-transport-stdio' },
            { value: 'http', label: t('settings.mcp.transportHttp'), testId: 'mcp-transport-http' }
          ]}
        />
      </Field>

      {isStdio ? (
        <>
          <Field label={t('settings.mcp.command')} htmlFor="mcp-command" layout="column">
            <Input
              id="mcp-command"
              data-testid="mcp-command-input"
              className="font-mono text-[12px]"
              value={draft.command ?? ''}
              placeholder={t('settings.mcp.commandPlaceholder')}
              onChange={(event) => store().patchDraft({ command: event.target.value })}
            />
          </Field>

          <Field
            label={t('settings.mcp.args')}
            hint={t('settings.mcp.argsHint')}
            htmlFor="mcp-args"
            layout="column"
          >
            <div className="flex min-h-[72px] rounded-md border border-border-strong bg-bg-elevated px-2.5 py-2">
              <TextArea
                id="mcp-args"
                data-testid="mcp-args-input"
                className="h-full font-mono text-[12px]"
                value={argsToText(draft.args)}
                placeholder={t('settings.mcp.argsPlaceholder')}
                onChange={(event) => store().patchDraft({ args: textToArgs(event.target.value) })}
              />
            </div>
          </Field>

          <Field
            label={t('settings.mcp.env')}
            hint={t('settings.mcp.envHint')}
            htmlFor="mcp-env"
            layout="column"
          >
            <div className="flex min-h-[72px] rounded-md border border-border-strong bg-bg-elevated px-2.5 py-2">
              <TextArea
                id="mcp-env"
                data-testid="mcp-env-input"
                className="h-full font-mono text-[12px]"
                value={envToText(draft.env)}
                placeholder={t('settings.mcp.envPlaceholder')}
                onChange={(event) => store().patchDraft({ env: textToEnv(event.target.value) })}
              />
            </div>
          </Field>
        </>
      ) : (
        <>
          <Field label={t('settings.mcp.url')} htmlFor="mcp-url" layout="column">
            <Input
              id="mcp-url"
              data-testid="mcp-url-input"
              className="font-mono text-[12px]"
              value={draft.url ?? ''}
              placeholder={t('settings.mcp.urlPlaceholder')}
              onChange={(event) => store().patchDraft({ url: event.target.value })}
            />
          </Field>

          <Field
            label={t('settings.mcp.headers')}
            hint={t('settings.mcp.headersHint')}
            htmlFor="mcp-headers"
            layout="column"
          >
            <div className="flex min-h-[72px] rounded-md border border-border-strong bg-bg-elevated px-2.5 py-2">
              <TextArea
                id="mcp-headers"
                data-testid="mcp-headers-input"
                className="h-full font-mono text-[12px]"
                value={envToText(draft.env)}
                placeholder={t('settings.mcp.headersPlaceholder')}
                onChange={(event) => store().patchDraft({ env: textToEnv(event.target.value) })}
              />
            </div>
          </Field>
        </>
      )}

      <div className="flex flex-col gap-2 rounded-lg border border-border-strong bg-bg-elevated px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle level={3}>{t('settings.mcp.sideEffects')}</SectionTitle>
          <span data-testid="mcp-side-effects">
            <Toggle
              label={t('settings.mcp.sideEffects')}
              checked={draft.sideEffects}
              onChange={(sideEffects) => store().patchDraft({ sideEffects })}
            />
          </span>
        </div>
        <p className="text-[11px] leading-relaxed text-fg-faint">
          {t('settings.mcp.sideEffectsHint')}
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-fg-muted">{t('settings.mcp.enabled')}</span>
        <span data-testid="mcp-enabled">
          <Toggle
            label={t('settings.mcp.enabled')}
            checked={draft.enabled}
            onChange={(enabled) => store().patchDraft({ enabled })}
          />
        </span>
      </div>

      {result ? (
        <div
          data-testid="mcp-test-result"
          data-ok={result.ok ? 'true' : 'false'}
          className={clsx('flex flex-col gap-1.5 text-xs', result.ok ? 'text-status-ok' : 'text-status-warn')}
        >
          {result.ok ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <Check aria-hidden="true" className="h-3 w-3" />
                {t('settings.mcp.testOk', { latency: result.latencyMs, tools: result.tools.length })}
              </span>
              <ul
                data-testid="mcp-tool-list"
                className="flex flex-col gap-1 rounded border border-border bg-bg-panel p-2"
              >
                {result.tools.map((tool) => (
                  <li key={tool.name} data-testid="mcp-tool" data-tool={tool.name} className="flex gap-2">
                    <span className="shrink-0 font-mono text-[11px] text-fg-secondary">
                      {tool.name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                      {tool.description ?? ''}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <X aria-hidden="true" className="h-3 w-3" />
              {translateError(t, result.error)}
              <span className="font-mono text-[11px] text-fg-faint">{result.error.message}</span>
            </span>
          )}
        </div>
      ) : null}

      {error ? (
        <p data-testid="mcp-error" className="text-xs text-danger">
          <span>{translateError(t, { code: errorCode ?? 'internal', message: error })}</span>{' '}
          <span className="font-mono text-[11px] text-fg-faint">{error}</span>
        </p>
      ) : null}

      {mode === 'edit' && selectedId ? (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            data-testid="mcp-show-log"
            onClick={() => {
              setShowLog((value) => !value)
              if (!showLog) void store().loadLog(selectedId)
            }}
            className="self-start rounded text-xs text-accent transition-colors hover:text-accent-hover focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            {showLog ? t('settings.mcp.hideLog') : t('settings.mcp.showLog')}
          </button>
          {showLog ? (
            <pre
              data-testid="mcp-log"
              className="max-h-48 overflow-auto rounded border border-border bg-bg-panel p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-secondary"
            >
              {log.length > 0 ? log.join('\n') : t('settings.mcp.logEmpty')}
            </pre>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        {mode === 'edit' && selectedId ? (
          <Button
            variant="danger"
            data-testid="mcp-delete"
            className="mr-auto"
            onClick={() => {
              if (!confirmingDelete) {
                setConfirmingDelete(true)
                return
              }
              void store().remove(selectedId)
            }}
          >
            {confirmingDelete ? t('settings.mcp.deleteConfirm') : t('common.delete')}
          </Button>
        ) : null}

        <Button
          data-testid="mcp-test"
          disabled={testing || !canProbe}
          onClick={() => {
            void store().testConnection(ref)
          }}
        >
          {testing ? <Spinner /> : null}
          {testing ? t('settings.mcp.testing') : t('settings.mcp.test')}
        </Button>

        <Button
          variant="primary"
          data-testid="mcp-save"
          disabled={saving || draft.name.trim().length === 0 || !canProbe}
          onClick={() => {
            void store().saveDraft()
          }}
        >
          {saving ? <Spinner /> : null}
          {t('common.save')}
        </Button>
      </div>
    </div>
  )
}
