/**
 * Settings → Integrations (S10.4, WP-12): the other direction of MCP.
 *
 * Every other MCP screen in this app is about Witena as a *client* — Settings →
 * MCP servers registers the tools an agent may call. This one is about Witena as
 * a *server*: a switch that opens a local endpoint, and one card per coding agent
 * on this Mac that can be pointed at it, so a user connects Claude Code or Codex
 * without opening a terminal.
 *
 * Three blocks, in the order the questions are asked:
 *
 * 1. **The endpoint.** A switch and *two* status facts, not one. `enabled` is the
 *    row the switch writes; `listening` is whether this process has a socket.
 *    They agree in the desktop app and disagree wherever the host could not
 *    start (WP-7), and that is precisely the case a user reports — so the line
 *    reads `integrations.status` rather than inferring anything from the switch.
 * 2. **The clients.** One card per entry of `IntegrationStatus.clients`, which
 *    WP-11 always sends in `IDE_CLIENT_IDS` order and always in full, so a third
 *    client is a card with no change here. Not installed offers nothing;
 *    installed offers Connect; connected offers Disconnect; connected to another
 *    installation offers Repair, which is the same `integrations.connect` call.
 * 3. **The snippets.** The universal fallback for every client that has no CLI
 *    of its own, in both shapes that exist: the `mcpServers` JSON object and
 *    Codex's `[mcp_servers.witena]` table. Shown even in a build that ships no
 *    launcher, because the endpoint works there too and only the *command* has
 *    no stable spelling — the note says so and the path is left a placeholder
 *    rather than guessed at.
 *
 * The rules this file obeys, both of which have a test behind them:
 *
 * - **Every label goes through `t()`** (CLAUDE.md rule #4), including the two
 *   product names, which are simply identical in both locale files. The
 *   *snippets* do not: JSON, TOML and a filesystem path are the same in every
 *   language, and they are built by `integration-display.ts` as data — the same
 *   line Settings → About draws around the version string.
 * - **Nothing here touches `window.witena`** (rule #6). The store reaches the
 *   backend through `BackendClient`, and the clipboard is not the backend — it
 *   belongs to the window, exactly as it does for the conclusion card.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy } from 'lucide-react'
import type { IdeClientStatus } from '@shared/types'
import { Button, SectionTitle, StatusPill, Toggle } from '../../components/ui'
import {
  REPO_PLACEHOLDER,
  claudeSnippet,
  codexSnippet,
  endpointStateLabel,
  endpointTone,
  ideClientAction,
  ideClientActionLabel,
  ideClientName,
  ideClientState,
  ideClientStateLabel,
  ideClientTone,
  launcherInvocation
} from '../../components/settings/integration-display'
import { translateFailure } from '../../i18n/errors'
import { useIntegrationsStore } from '../../stores/integrations'

/** How long a Copy button stays in its confirmed state, as in `code-block.tsx`. */
const COPIED_MS = 1_500

/**
 * A block of configuration with a Copy button.
 *
 * The body is a `<pre>` holding an expression, never a text node: the snippet is
 * data, and `used-keys.test.ts` rightly refuses hard-coded text in JSX.
 */
function SnippetBlock({
  testId,
  title,
  snippet
}: {
  testId: string
  title: string
  snippet: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-fg-muted">{title}</span>
        <Button
          data-testid={`${testId}-copy`}
          data-copied={copied ? 'true' : 'false'}
          size="sm"
          variant="ghost"
          onClick={() => {
            // A clipboard the window may not write to is not worth a red line:
            // the snippet is on screen and can be selected by hand.
            void navigator.clipboard?.writeText(snippet).catch(() => undefined)
            setCopied(true)
          }}
        >
          {copied ? (
            <Check aria-hidden="true" className="h-3 w-3 shrink-0" />
          ) : (
            <Copy aria-hidden="true" className="h-3 w-3 shrink-0" />
          )}
          <span>{copied ? t('settings.integrations.copied') : t('settings.integrations.copy')}</span>
        </Button>
      </div>
      <pre
        data-testid={testId}
        className="overflow-x-auto rounded-lg border border-border-strong bg-bg-base px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-secondary"
      >
        {snippet}
      </pre>
    </div>
  )
}

/** One coding agent: what it is doing, and the one call the card offers. */
function ClientCard({ client }: { client: IdeClientStatus }): React.JSX.Element {
  const { t } = useTranslation()
  const busyClient = useIntegrationsStore((state) => state.busyClient)

  const state = ideClientState(client)
  const action = ideClientAction(state)
  const busy = busyClient !== null

  return (
    <div
      data-testid="integration-card"
      data-client={client.id}
      data-state={state}
      className="flex w-full items-center gap-3 rounded-[10px] border border-border-strong bg-bg-elevated px-4 py-3.5"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span data-testid="integration-card-name" className="truncate text-sm font-semibold text-fg">
            {ideClientName(t, client.id)}
          </span>
          <StatusPill
            data-testid="integration-card-status"
            data-status={state}
            tone={ideClientTone(state)}
            label={ideClientStateLabel(t, state)}
          />
        </div>

        {state === 'not-installed' ? (
          <p className="text-[11px] leading-relaxed text-fg-faint">
            {t('settings.integrations.notInstalledHint')}
          </p>
        ) : null}
        {state === 'stale' ? (
          <p className="text-[11px] leading-relaxed text-status-warn">
            {t('settings.integrations.staleHint')}
          </p>
        ) : null}
        {/* The registered command is a path: data, printed rather than translated. */}
        {client.command ? (
          <span
            data-testid="integration-card-command"
            className="min-w-0 truncate font-mono text-[11px] text-fg-faint"
          >
            {client.command}
          </span>
        ) : null}
      </div>

      {action ? (
        <Button
          data-testid="integration-card-action"
          data-action={action}
          size="sm"
          variant={action === 'disconnect' ? 'secondary' : 'primary'}
          disabled={busy}
          onClick={() => {
            const store = useIntegrationsStore.getState()
            // Repair is Connect. The two cannot drift apart, because WP-11 made
            // the repair a branch inside that one handler.
            void (action === 'disconnect' ? store.disconnect(client.id) : store.connect(client.id))
          }}
        >
          {ideClientActionLabel(t, action)}
        </Button>
      ) : null}
    </div>
  )
}

export function IntegrationsSection(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useIntegrationsStore((state) => state.status)
  const togglingEndpoint = useIntegrationsStore((state) => state.togglingEndpoint)
  const error = useIntegrationsStore((state) => state.error)
  const errorCode = useIntegrationsStore((state) => state.errorCode)
  const errorDetails = useIntegrationsStore((state) => state.errorDetails)

  // One read on mount. The status is a question about this machine — which CLIs
  // are installed, what they have registered — so it is asked when the screen is
  // opened rather than held from the bootstrap.
  useEffect(() => {
    void useIntegrationsStore.getState().load()
  }, [])

  const endpoint = status?.endpoint ?? { enabled: false, listening: false }
  const invocation = launcherInvocation(status?.launcherPath ?? null)

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <SectionTitle level={3}>{t('settings.integrations.endpoint')}</SectionTitle>

        <div className="flex items-center gap-3">
          {/* `Toggle` takes no test id of its own, so the wrapper carries one. */}
          <span data-testid="integrations-endpoint-toggle" data-enabled={endpoint.enabled}>
            <Toggle
              label={t('settings.integrations.endpointSwitch')}
              checked={endpoint.enabled}
              disabled={status === null || togglingEndpoint}
              onChange={(enabled) => {
                void useIntegrationsStore.getState().setEndpointEnabled(enabled)
              }}
            />
          </span>
          <StatusPill
            data-testid="integrations-endpoint-status"
            data-status={endpoint.listening ? 'listening' : endpoint.enabled ? 'stopped' : 'off'}
            tone={endpointTone(endpoint)}
            label={endpointStateLabel(t, endpoint)}
          />
        </div>

        <p className="text-[11px] leading-relaxed text-fg-faint">
          {t('settings.integrations.endpointHint')}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle level={3}>{t('settings.integrations.clients')}</SectionTitle>
        <p className="text-[11px] leading-relaxed text-fg-faint">
          {t('settings.integrations.clientsHint')}
        </p>
        <div className="flex flex-col gap-2">
          {(status?.clients ?? []).map((client) => (
            <ClientCard key={client.id} client={client} />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle level={3}>{t('settings.integrations.snippets')}</SectionTitle>
        <p className="text-[11px] leading-relaxed text-fg-faint">
          {t('settings.integrations.snippetsHint')}
        </p>
        {status !== null && status.launcherPath === null ? (
          <p
            data-testid="integrations-dev-note"
            className="text-[11px] leading-relaxed text-status-warn"
          >
            {t('settings.integrations.snippetDevNote', { placeholder: REPO_PLACEHOLDER })}
          </p>
        ) : null}
        <SnippetBlock
          testId="integrations-snippet-json"
          title={t('settings.integrations.snippetJson')}
          snippet={claudeSnippet(invocation)}
        />
        <SnippetBlock
          testId="integrations-snippet-toml"
          title={t('settings.integrations.snippetToml')}
          snippet={codexSnippet(invocation)}
        />
      </div>

      {errorCode || error ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-danger" data-testid="integrations-error">
            {translateFailure(t, errorCode, errorDetails)}
          </p>
          {/* The CLI's own words, in whatever language it speaks them: the
              dimmed detail beside the sentence, never in place of it. */}
          {error ? (
            <p className="font-mono text-[11px] break-all text-fg-faint">{error}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
