/**
 * The agent form's "MCP servers" block: one checkbox per registered server.
 *
 * The interesting part is not the list, it is the **rule it has to show**. A
 * server flagged `sideEffects` is attached only to an `executor` agent
 * (`PLAN.md`, "Future extension"; enforced in `main/agents/agent-turn.ts`), so on
 * a participant its row is disabled and says why. Hiding it instead would be
 * worse: the user registered that server on purpose and needs to know why it is
 * not on offer here rather than wondering where it went.
 *
 * A native `<input type="checkbox">` inside a `<label>`, not a styled `<button>`:
 * this is a genuine multi-select and the native control brings the role, the
 * keyboard behaviour and the label association for free.
 */
import clsx from 'clsx'
import type { McpServer } from '@shared/types'
import { Badge } from '../ui'

export interface McpChecklistProps {
  servers: readonly McpServer[]
  /** Currently bound server ids. */
  value: readonly string[]
  /** True when this agent may be given side-effecting tools. */
  allowSideEffects: boolean
  /** Tool count per server id, absent until one has been discovered. */
  toolCounts: Readonly<Record<string, number>>
  /** Already translated `n tools`, given the count. */
  toolsLabel: (count: number) => string
  /** Already translated tag for a side-effecting server. */
  sideEffectsLabel: string
  /** Already translated explanation shown on a row a participant may not have. */
  sideEffectsBlockedLabel: string
  /** Already translated line for a server that is switched off in settings. */
  disabledLabel: string
  onToggle: (serverId: string, checked: boolean) => void
}

export function McpChecklist({
  servers,
  value,
  allowSideEffects,
  toolCounts,
  toolsLabel,
  sideEffectsLabel,
  sideEffectsBlockedLabel,
  disabledLabel,
  onToggle
}: McpChecklistProps): React.JSX.Element {
  return (
    <ul data-testid="agent-mcp-list" className="flex flex-col divide-y divide-border">
      {servers.map((server) => {
        const blocked = server.sideEffects && !allowSideEffects
        const unavailable = blocked || !server.enabled
        const count = toolCounts[server.id]

        return (
          <li key={server.id}>
            <label
              data-testid="agent-mcp-item"
              data-server-id={server.id}
              data-blocked={blocked ? 'true' : 'false'}
              className={clsx(
                'flex items-start gap-2.5 px-3 py-2.5',
                unavailable ? 'opacity-55' : 'cursor-pointer hover:bg-bg-hover/50'
              )}
            >
              <input
                type="checkbox"
                data-testid="agent-mcp-checkbox"
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
                checked={value.includes(server.id)}
                disabled={unavailable}
                onChange={(event) => onToggle(server.id, event.target.checked)}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    data-testid="agent-mcp-name"
                    className="truncate text-[13px] text-fg-secondary"
                  >
                    {server.name}
                  </span>
                  <Badge>{server.transport}</Badge>
                  {server.sideEffects ? (
                    <Badge data-testid="agent-mcp-side-effects" tone="accent" font="sans">
                      {sideEffectsLabel}
                    </Badge>
                  ) : null}
                  {count === undefined ? null : (
                    <span
                      data-testid="agent-mcp-tools"
                      className="ml-auto shrink-0 text-[11px] text-fg-faint"
                    >
                      {toolsLabel(count)}
                    </span>
                  )}
                </span>
                {blocked ? (
                  <span data-testid="agent-mcp-hint" className="text-[11px] leading-relaxed text-fg-faint">
                    {sideEffectsBlockedLabel}
                  </span>
                ) : null}
                {!server.enabled ? (
                  <span className="text-[11px] text-fg-faint">{disabledLabel}</span>
                ) : null}
              </span>
            </label>
          </li>
        )
      })}
    </ul>
  )
}
