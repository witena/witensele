/**
 * The pure half of the MCP feature: naming, schema wrapping and result mapping.
 *
 * No client, no transport, no child process — `toAiTools` takes its `call` as an
 * argument, so every rule it applies is checked against a fake here rather than
 * against a live server in `manager.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_SLUG,
  McpToolError,
  renderToolResult,
  sanitizeToolSegment,
  serverSlug,
  toAiTools,
  toToolInfo,
  toolKey,
  type McpCallResult,
  type McpToolDefinition
} from './tools'

const ECHO: McpToolDefinition = {
  name: 'echo',
  description: 'Echoes back the input',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message']
  }
}

/** A `call` that records what it was asked and answers with plain text. */
function fakeCall(result: McpCallResult = { content: [{ type: 'text', text: 'ok' }] }) {
  return vi.fn(async () => result)
}

describe('sanitizeToolSegment', () => {
  it('keeps letters, digits, underscore and dash', () => {
    expect(sanitizeToolSegment('abc-XYZ_09')).toBe('abc-XYZ_09')
  })

  it('replaces everything a provider rejects in a tool name', () => {
    expect(sanitizeToolSegment('files.read v2')).toBe('files_read_v2')
    expect(sanitizeToolSegment('@scope/pkg')).toBe('_scope_pkg')
  })
})

describe('serverSlug', () => {
  it('trims the underscores a leading symbol leaves behind', () => {
    expect(serverSlug('@modelcontextprotocol/everything')).toBe(
      '_modelcontextprotocol_everything'.replace(/^_+/, '')
    )
  })

  it('falls back when nothing survives sanitizing', () => {
    expect(serverSlug('…')).toBe(FALLBACK_SLUG)
    expect(serverSlug('')).toBe(FALLBACK_SLUG)
  })
})

describe('toolKey', () => {
  it('joins the sanitized halves with a double underscore', () => {
    expect(toolKey('everything', 'echo')).toBe('everything__echo')
    expect(toolKey('My Files', 'read.file')).toBe('My_Files__read_file')
  })
})

describe('toAiTools', () => {
  it('keys the tool by server slug and keeps the original name in the origin', () => {
    const { tools, origins } = toAiTools('server-1', 'everything', [ECHO], fakeCall())

    expect(Object.keys(tools)).toEqual(['everything__echo'])
    expect(origins['everything__echo']).toEqual({
      serverId: 'server-1',
      serverName: 'everything',
      toolName: 'echo'
    })
  })

  it('wraps the MCP input schema untouched', () => {
    const { tools } = toAiTools('server-1', 'everything', [ECHO], fakeCall())

    const wrapped = tools['everything__echo']
    expect(wrapped?.description).toBe('Echoes back the input')
    // `jsonSchema()` keeps the original object reachable as `.jsonSchema`.
    expect((wrapped?.inputSchema as { jsonSchema: unknown }).jsonSchema).toEqual(ECHO.inputSchema)
  })

  it('calls the server with the tool own name, not the prefixed key', async () => {
    const call = fakeCall()
    const { tools } = toAiTools('server-1', 'everything', [ECHO], call)

    await runTool(tools['everything__echo'], { message: 'hi' })

    expect(call).toHaveBeenCalledWith('echo', { message: 'hi' })
  })

  it('joins text blocks into the value the model receives', async () => {
    const { tools } = toAiTools(
      'server-1',
      'everything',
      [ECHO],
      fakeCall({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })
    )

    await expect(runTool(tools['everything__echo'], {})).resolves.toBe('one\n\ntwo')
  })

  it('summarizes an image instead of inlining its base64', async () => {
    const { tools } = toAiTools(
      'server-1',
      'everything',
      [ECHO],
      fakeCall({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] })
    )

    await expect(runTool(tools['everything__echo'], {})).resolves.toBe('[image image/png]')
  })

  it('renders a resource as its inline text, or as its uri when there is none', async () => {
    expect(
      renderToolResult({ content: [{ type: 'resource', resource: { uri: 'file:///a', text: 'body' } }] })
    ).toBe('body')
    expect(renderToolResult({ content: [{ type: 'resource', resource: { uri: 'file:///a' } }] })).toBe(
      'file:///a'
    )
  })

  it('falls back to structuredContent when there are no content blocks', () => {
    expect(renderToolResult({ content: [], structuredContent: { count: 2 } })).toBe('{"count":2}')
  })

  it('throws on isError so the SDK emits a tool-error part', async () => {
    const { tools } = toAiTools(
      'server-1',
      'everything',
      [ECHO],
      fakeCall({ isError: true, content: [{ type: 'text', text: 'no such path' }] })
    )

    await expect(runTool(tools['everything__echo'], {})).rejects.toBeInstanceOf(McpToolError)
    await expect(runTool(tools['everything__echo'], {})).rejects.toThrow('no such path')
  })

  it('keeps the first of two tools whose names sanitize to the same key', () => {
    const { tools } = toAiTools(
      'server-1',
      'everything',
      [
        { name: 'a.b', inputSchema: { type: 'object' } },
        { name: 'a b', inputSchema: { type: 'object' } }
      ],
      fakeCall()
    )

    expect(Object.keys(tools)).toEqual(['everything__a_b'])
  })
})

describe('toToolInfo', () => {
  it('carries names and descriptions and drops the schema', () => {
    expect(toToolInfo([ECHO, { name: 'add', inputSchema: { type: 'object' } }])).toEqual([
      { name: 'echo', description: 'Echoes back the input' },
      { name: 'add' }
    ])
  })
})

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Runs a wrapped tool's `execute`.
 *
 * The AI SDK types `execute` as optional and hands it a second options argument
 * the wrapper ignores; this keeps that noise out of every assertion above.
 */
async function runTool(wrapped: unknown, input: Record<string, unknown>): Promise<unknown> {
  const execute = (wrapped as { execute: (input: unknown, options: unknown) => Promise<unknown> })
    .execute
  return execute(input, {})
}
