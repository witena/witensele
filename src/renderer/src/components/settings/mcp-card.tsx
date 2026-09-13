/**
 * One MCP server in the settings list: name, transport badge, endpoint, tool
 * count, status pill, the side-effects tag and the enabled switch.
 *
 * A `<div>` with a nested selection `<button>` rather than one big `<button>`,
 * unlike `ProviderCard`: the enabled switch is itself a control, and a button
 * inside a button is invalid HTML that browsers resolve by dropping the inner
 * one. The selection button therefore covers everything except the switch.
 *
 * Every label arrives already translated, like every other primitive, so no
 * shared component can hide an untranslated literal.
 */
import clsx from 'clsx'
import { Badge, StatusPill, Toggle } from '../ui'
import type { McpServer } from '@shared/types'
import { mcpEndpoint, mcpStatusTone, type McpStatus } from './mcp-display'

export interface McpCardProps {
  server: McpServer
  selected: boolean
  status: McpStatus
  /** Already translated status label. */
  statusLabel: string
  /** Already translated `n tools`, or absent when no list has been read yet. */
  toolsLabel?: string | undefined
  /** Already translated side-effects tag; absent when the flag is off. */
  sideEffectsLabel?: string | undefined
  /** Already translated accessible name for the switch. */
  enabledLabel: string
  onSelect: () => void
  onToggleEnabled: (enabled: boolean) => void
}

export function McpCard({
  server,
  selected,
  status,
  statusLabel,
  toolsLabel,
  sideEffectsLabel,
  enabledLabel,
  onSelect,
  onToggleEnabled
}: McpCardProps): React.JSX.Element {
  return (
    <div
      data-testid="mcp-card"
      data-server-id={server.id}
      data-enabled={server.enabled ? 'true' : 'false'}
      aria-current={selected ? 'true' : undefined}
      className={clsx(
        'flex w-full items-center gap-3 rounded-[10px] border bg-bg-elevated px-4 py-3.5 transition-colors',
        selected ? 'border-accent' : 'border-border-strong hover:border-fg-faint'
      )}
    >
      <button
        type="button"
        data-testid="mcp-card-select"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col gap-2 text-left focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span data-testid="mcp-card-name" className="truncate text-sm font-semibold text-fg">
            {server.name}
          </span>
          <Badge data-testid="mcp-card-transport">{server.transport}</Badge>
          {sideEffectsLabel ? (
            <Badge data-testid="mcp-card-side-effects" tone="accent" font="sans">
              {sideEffectsLabel}
            </Badge>
          ) : null}
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <span
            data-testid="mcp-card-endpoint"
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-faint"
          >
            {mcpEndpoint(server)}
          </span>
          {toolsLabel ? (
            <span data-testid="mcp-card-tools" className="shrink-0 text-[11px] text-fg-dim">
              {toolsLabel}
            </span>
          ) : null}
          <StatusPill
            data-testid="mcp-card-status"
            data-status={status}
            tone={mcpStatusTone(status)}
            label={statusLabel}
          />
        </div>
      </button>

      {/* `Toggle` takes no test id of its own, so the wrapper carries one. */}
      <span data-testid="mcp-card-enabled" className="shrink-0">
        <Toggle label={enabledLabel} checked={server.enabled} onChange={onToggleEnabled} />
      </span>
    </div>
  )
}
