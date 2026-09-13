/**
 * `describeToolCall` and its two halves.
 *
 * No tool exists until S3.1, so these fixtures are the only thing standing
 * between the tool card and its first real call: they are the shapes an MCP
 * server actually returns (a content-block list, a bare array, a scalar, an
 * error) written out by hand.
 */
import { describe, expect, it } from 'vitest'
import type { ToolCallPart, ToolResultPart } from '@shared/types'
import {
  ARGS_PREVIEW_MAX,
  collectToolCalls,
  countToolResults,
  describeToolCall,
  previewToolArgs
} from './tool-call'

/** The mockup's card: `memory_search("timeouts")`, one result. */
const SEARCH_CALL: ToolCallPart = {
  type: 'tool-call',
  toolCallId: 'call-1',
  toolName: 'memory_search',
  input: { query: 'timeout defaults', limit: 3 }
}

const SEARCH_RESULT: ToolResultPart = {
  type: 'tool-result',
  toolCallId: 'call-1',
  output: { content: [{ type: 'text', text: 'Ollama cold start can reach 40 s' }] }
}

const FAILED_RESULT: ToolResultPart = {
  type: 'tool-result',
  toolCallId: 'call-1',
  output: { message: 'server not reachable' },
  isError: true
}

describe('previewToolArgs', () => {
  it('prints an object as key: value pairs in declaration order', () => {
    expect(previewToolArgs({ query: 'timeouts', limit: 3 })).toBe('query: "timeouts", limit: 3')
  })

  it('prints a bare string argument as itself', () => {
    expect(previewToolArgs('timeouts')).toBe('"timeouts"')
  })

  it('summarises nested values rather than expanding them', () => {
    expect(previewToolArgs({ files: ['a', 'b'], options: { deep: true } })).toBe(
      'files: [2], options: {…}'
    )
  })

  it('is empty for an absent input', () => {
    expect(previewToolArgs(undefined)).toBe('')
    expect(previewToolArgs(null)).toBe('')
  })

  it('truncates to the preview budget', () => {
    const preview = previewToolArgs({ text: 'x'.repeat(200) })
    expect(preview).toHaveLength(ARGS_PREVIEW_MAX)
    expect(preview.endsWith('…')).toBe(true)
  })
})

describe('countToolResults', () => {
  it('counts an array', () => {
    expect(countToolResults(['a', 'b', 'c'])).toBe(3)
  })

  it('counts the MCP content-block shape', () => {
    expect(countToolResults({ content: [{ type: 'text' }, { type: 'text' }] })).toBe(2)
  })

  it('counts a results or items wrapper', () => {
    expect(countToolResults({ results: [1] })).toBe(1)
    expect(countToolResults({ items: [] })).toBe(0)
  })

  it('treats any other value as a single result', () => {
    expect(countToolResults('done')).toBe(1)
    expect(countToolResults({ ok: true })).toBe(1)
    expect(countToolResults(0)).toBe(1)
  })

  it('says nothing when there is no output', () => {
    expect(countToolResults(undefined)).toBeNull()
    expect(countToolResults(null)).toBeNull()
  })
})

describe('describeToolCall', () => {
  it('labels an MCP tool with its server', () => {
    const described = describeToolCall({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'echo',
      input: { message: 'hi' },
      serverId: 'server-1',
      serverName: 'everything'
    })

    expect(described.label).toBe('everything \u00b7 echo')
    expect(described.serverName).toBe('everything')
    // `toolName` stays the bare name, which is what a spec addresses a card by.
    expect(described.toolName).toBe('echo')
  })

  it('labels a tool with no server with its bare name', () => {
    expect(describeToolCall(SEARCH_CALL).label).toBe(SEARCH_CALL.toolName)
    expect(describeToolCall(SEARCH_CALL).serverName).toBeUndefined()
  })

  it('is running while no result has arrived', () => {
    const described = describeToolCall(SEARCH_CALL)
    expect(described.state).toBe('running')
    expect(described.resultCount).toBeNull()
    expect(described.outputJson).toBeNull()
    expect(described.toolName).toBe('memory_search')
    expect(described.argsPreview).toBe('query: "timeout defaults", limit: 3')
  })

  it('is done with a count once the result is there', () => {
    const described = describeToolCall(SEARCH_CALL, SEARCH_RESULT)
    expect(described.state).toBe('done')
    expect(described.resultCount).toBe(1)
    expect(described.outputJson).toContain('Ollama cold start')
  })

  it('is an error with no count when the tool failed', () => {
    const described = describeToolCall(SEARCH_CALL, FAILED_RESULT)
    expect(described.state).toBe('error')
    // An error payload is the failure, not a list of results.
    expect(described.resultCount).toBeNull()
    expect(described.outputJson).toContain('server not reachable')
  })

  it('pretty-prints the input for the expanded card', () => {
    expect(describeToolCall(SEARCH_CALL).inputJson).toBe(
      '{\n  "query": "timeout defaults",\n  "limit": 3\n}'
    )
  })

  it('survives an input that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const described = describeToolCall({ ...SEARCH_CALL, input: cyclic })
    expect(described.state).toBe('running')
    expect(typeof described.inputJson).toBe('string')
  })
})

describe('collectToolCalls', () => {
  it('pairs every call with its result by id, not by position', () => {
    const second: ToolCallPart = {
      type: 'tool-call',
      toolCallId: 'call-2',
      toolName: 'read_file',
      input: { path: 'PLAN.md' }
    }
    // The results come back in the opposite order, as parallel calls do.
    const calls = collectToolCalls([
      SEARCH_CALL,
      second,
      { type: 'tool-result', toolCallId: 'call-2', output: ['a'] } satisfies ToolResultPart,
      SEARCH_RESULT
    ])

    expect(calls.map((call) => call.toolCallId)).toEqual(['call-1', 'call-2'])
    expect(calls[0]?.resultCount).toBe(1)
    expect(calls[1]?.toolName).toBe('read_file')
    expect(calls[1]?.state).toBe('done')
  })

  it('ignores every other kind of part', () => {
    expect(collectToolCalls([{ type: 'text' }, { type: 'reasoning' }])).toEqual([])
  })

  it('leaves an unanswered call running', () => {
    expect(collectToolCalls([SEARCH_CALL])[0]?.state).toBe('running')
  })
})
