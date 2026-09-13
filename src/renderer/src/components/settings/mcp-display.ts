/**
 * Pure display rules for an MCP server card: its status, its tone and the one
 * line that says where it is.
 *
 * Separated from the card for the same reason as `provider-display.ts`: these are
 * the parts worth a unit test, and a test that has to mount React to check that a
 * disabled server outranks a failed probe is a test nobody writes.
 */
import type { McpConnectionTestResult, McpServer } from '@shared/types'
import type { StatusTone } from '../ui'

/**
 * What the pill says.
 *
 * `disabled` wins over everything, including a probe that succeeded a moment
 * ago: a disabled server is not going to answer an agent, and reporting it as
 * "connected" would be a lie the user acts on.
 */
export type McpStatus = 'disabled' | 'connected' | 'failed' | 'untested'

export function mcpStatus(
  server: McpServer,
  result: McpConnectionTestResult | undefined
): McpStatus {
  if (!server.enabled) return 'disabled'
  if (!result) return 'untested'
  return result.ok ? 'connected' : 'failed'
}

export function mcpStatusTone(status: McpStatus): StatusTone {
  switch (status) {
    case 'connected':
      return 'ok'
    case 'failed':
      return 'warn'
    case 'disabled':
    case 'untested':
      return 'idle'
  }
}

/**
 * The monospace line under the name: the command, or the host of the URL.
 *
 * The full argument list is deliberately not shown — `npx -y @scope/pkg --root
 * /very/long/path` would wrap to three lines on every card — and the URL is
 * reduced to its origin plus path for the same reason.
 */
export function mcpEndpoint(server: McpServer): string {
  if (server.transport === 'stdio') {
    const command = server.command?.trim() ?? ''
    const first = server.args?.[0]
    if (command.length === 0) return '—'
    return first ? `${command} ${first}` : command
  }
  const url = server.url?.trim() ?? ''
  if (url.length === 0) return '—'
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}
