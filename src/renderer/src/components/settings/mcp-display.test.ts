import { describe, expect, it } from 'vitest'
import type { McpConnectionTestResult, McpServer } from '@shared/types'
import { mcpEndpoint, mcpStatus, mcpStatusTone } from './mcp-display'

/**
 * A stored server.
 *
 * The overrides admit an explicit `undefined` so a case can *remove* a field —
 * `Partial<McpServer>` cannot express that under `exactOptionalPropertyTypes`,
 * and "an http server has no command" is exactly what several cases are about.
 */
type ServerOverrides = { [K in keyof McpServer]?: McpServer[K] | undefined }

function server(overrides: ServerOverrides = {}): McpServer {
  return {
    id: 'server-1',
    userId: 'local',
    createdAt: 0,
    updatedAt: 0,
    name: 'everything',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    enabled: true,
    sideEffects: false,
    ...overrides
    // The spread reintroduces `| undefined` on every field it may cover; the
    // record is still a complete `McpServer` at runtime.
  } as McpServer
}

const ok: McpConnectionTestResult = { ok: true, latencyMs: 12, tools: [{ name: 'echo' }] }
const failed: McpConnectionTestResult = {
  ok: false,
  error: { code: 'mcp_error', message: 'boom' }
}

describe('mcpStatus', () => {
  it('is untested until a probe has run', () => {
    expect(mcpStatus(server(), undefined)).toBe('untested')
  })

  it('follows the probe when the server is enabled', () => {
    expect(mcpStatus(server(), ok)).toBe('connected')
    expect(mcpStatus(server(), failed)).toBe('failed')
  })

  it('reports a disabled server as disabled even after a successful probe', () => {
    expect(mcpStatus(server({ enabled: false }), ok)).toBe('disabled')
  })
})

describe('mcpStatusTone', () => {
  it('maps each status onto a pill tone', () => {
    expect(mcpStatusTone('connected')).toBe('ok')
    expect(mcpStatusTone('failed')).toBe('warn')
    expect(mcpStatusTone('untested')).toBe('idle')
    expect(mcpStatusTone('disabled')).toBe('idle')
  })
})

describe('mcpEndpoint', () => {
  it('shows the command and its first argument', () => {
    expect(mcpEndpoint(server())).toBe('npx -y')
  })

  it('shows the command alone when there are no arguments', () => {
    expect(mcpEndpoint(server({ args: [] }))).toBe('npx')
  })

  it('reduces a url to host and path', () => {
    expect(
      mcpEndpoint(server({ transport: 'http', command: undefined, url: 'https://example.com/mcp' }))
    ).toBe('example.com/mcp')
    expect(
      mcpEndpoint(server({ transport: 'http', command: undefined, url: 'https://example.com/' }))
    ).toBe('example.com')
  })

  it('says nothing rather than crashing on an empty or unparseable record', () => {
    expect(mcpEndpoint(server({ command: '' }))).toBe('—')
    expect(mcpEndpoint(server({ transport: 'http', command: undefined }))).toBe('—')
    expect(mcpEndpoint(server({ transport: 'http', command: undefined, url: 'nope' }))).toBe('nope')
  })
})
