/**
 * The history transform, which is the piece of the product most likely to be
 * broken silently: a wrong role or a missing prefix does not throw, it just makes
 * every agent answer slightly worse.
 *
 * Pure input → output, no database and no model, so every rule in `history.ts`
 * gets a case of its own.
 */
import { describe, expect, it } from 'vitest'
import type { Agent, Message, MessagePart, MessageStatus, SenderType } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import { PASS_TOKEN } from '@shared/markers'
import {
  DEFAULT_USER_NAME,
  MAX_TOOL_RESULT_CHARS,
  SYSTEM_SENDER_NAME,
  toModelMessages, YOUR_TURN_TEXT } from './history'

function agent(id: string, name: string): Agent {
  return {
    id,
    userId: LOCAL_USER_ID,
    createdAt: 0,
    updatedAt: 0,
    name,
    avatar: { kind: 'initial', text: name.slice(0, 1), color: '#4a3a2f' },
    description: `${name} description`,
    systemPrompt: `You are ${name}.`,
    providerId: 'provider-1',
    modelId: 'model-1',
    params: {},
    skillNames: [],
    mcpServerIds: [],
    memoryEnabled: false,
    role: 'participant'
  }
}

const ada = agent('agent-ada', 'Ada')
const bob = agent('agent-bob', 'Bob')
const agentsById = { [ada.id]: ada, [bob.id]: bob }

let seq = 0

function message(
  senderType: SenderType,
  senderId: string,
  parts: MessagePart[],
  status: MessageStatus = 'done'
): Message {
  seq += 1
  return {
    id: `m${seq}`,
    userId: LOCAL_USER_ID,
    createdAt: seq,
    updatedAt: seq,
    chatId: 'chat-1',
    senderType,
    senderId,
    parts,
    status,
    round: senderType === 'user' ? 0 : 1,
    mentions: []
  }
}

const text = (value: string): MessagePart[] => [{ type: 'text', text: value }]

describe('toModelMessages', () => {
  it('prefixes the user with their name and keeps the role user', () => {
    const result = toModelMessages({
      self: ada,
      agentsById,
      messages: [message('user', LOCAL_USER_ID, text('What should we build?'))]
    })

    expect(result).toEqual([
      { role: 'user', content: `[${DEFAULT_USER_NAME}]: What should we build?` }
    ])
  })

  it('uses the caller-supplied user name', () => {
    const result = toModelMessages({
      self: ada,
      agentsById,
      userName: 'Jay',
      messages: [message('user', LOCAL_USER_ID, text('Hello'))]
    })

    expect(result).toEqual([{ role: 'user', content: '[Jay]: Hello' }])
  })

  it("turns this agent's own messages into assistant turns with no prefix", () => {
    const result = toModelMessages({
      self: ada,
      agentsById,
      messages: [message('agent', ada.id, text('I would start with the data model.'))]
    })

    expect(result).toEqual([
      { role: 'assistant', content: 'I would start with the data model.' },
      { role: 'user', content: YOUR_TURN_TEXT }
    ])
  })

  it("prefixes another agent's messages with that agent's name, as a user turn", () => {
    const result = toModelMessages({
      self: ada,
      agentsById,
      messages: [message('agent', bob.id, text('Disagree: start with the transport.'))]
    })

    expect(result).toEqual([
      { role: 'user', content: '[Bob]: Disagree: start with the transport.' }
    ])
  })

  it('falls back to the sender id when the agent record is unknown', () => {
    const result = toModelMessages({
      self: ada,
      agentsById: { [ada.id]: ada },
      messages: [message('agent', 'agent-gone', text('Still in the transcript.'))]
    })

    expect(result).toEqual([{ role: 'user', content: '[agent-gone]: Still in the transcript.' }])
  })

  it('merges consecutive user-role messages with a blank line', () => {
    const result = toModelMessages({
      self: ada,
      agentsById,
      messages: [
        message('user', LOCAL_USER_ID, text('First question.')),
        message('agent', bob.id, text('Bob answers.')),
        message('user', LOCAL_USER_ID, text('Follow-up.'))
      ]
    })

    expect(result).toEqual([
      {
        role: 'user',
        content: `[${DEFAULT_USER_NAME}]: First question.\n\n[Bob]: Bob answers.\n\n[${DEFAULT_USER_NAME}]: Follow-up.`
      }
    ])
  })

  it('merges consecutive assistant messages too, and alternates otherwise', () => {
    const result = toModelMessages({
      self: ada,
      agentsById,
      messages: [
        message('user', LOCAL_USER_ID, text('Go.')),
        message('agent', ada.id, text('Part one.')),
        message('agent', ada.id, text('Part two.')),
        message('agent', bob.id, text('Bob here.'))
      ]
    })

    expect(result).toEqual([
      { role: 'user', content: `[${DEFAULT_USER_NAME}]: Go.` },
      { role: 'assistant', content: 'Part one.\n\nPart two.' },
      { role: 'user', content: '[Bob]: Bob here.' }
    ])
  })

  it('drops passed and skipped messages entirely', () => {
    const result = toModelMessages({
      self: ada,
      agentsById,
      messages: [
        message('user', LOCAL_USER_ID, text('Anything to add?')),
        message('agent', bob.id, text('[PASS]'), 'passed'),
        message('agent', 'agent-gone', text('half an ans'), 'skipped')
      ]
    })

    expect(result).toEqual([{ role: 'user', content: `[${DEFAULT_USER_NAME}]: Anything to add?` }])
  })

  it('drops messages with no text, including one that is still streaming', () => {
    const result = toModelMessages({
      self: ada,
      agentsById,
      messages: [
        message('user', LOCAL_USER_ID, text('Question.')),
        message('agent', ada.id, [], 'streaming'),
        message('agent', bob.id, text('   '))
      ]
    })

    expect(result).toEqual([{ role: 'user', content: `[${DEFAULT_USER_NAME}]: Question.` }])
  })

  it('leaves reasoning out of the prompt but keeps the text beside it', () => {
    const result = toModelMessages({
      self: ada,
      agentsById,
      messages: [
        message('agent', ada.id, [
          { type: 'reasoning', text: 'Thinking out loud, privately.' },
          { type: 'text', text: 'The answer is 42.' }
        ])
      ]
    })

    expect(result).toEqual([
      { role: 'assistant', content: 'The answer is 42.' },
      { role: 'user', content: YOUR_TURN_TEXT }
    ])
  })

  it('renders a known system notice as short English text, attributed to system', () => {
    const result = toModelMessages({
      self: ada,
      agentsById,
      messages: [
        message('system', 'system', [
          { type: 'system-notice', key: 'agentSkipped', params: { agent: 'Bob' } }
        ])
      ]
    })

    expect(result).toEqual([
      { role: 'user', content: `[${SYSTEM_SENDER_NAME}]: Bob did not respond and was skipped this round.` }
    ])
  })

  it('skips a system notice whose key it has no rendering for', () => {
    const result = toModelMessages({
      self: ada,
      agentsById,
      messages: [
        message('user', LOCAL_USER_ID, text('Hi.')),
        message('system', 'system', [{ type: 'system-notice', key: 'somethingNewInS3' }])
      ]
    })

    expect(result).toEqual([{ role: 'user', content: `[${DEFAULT_USER_NAME}]: Hi.` }])
  })

  it('gives an empty transcript an empty prompt', () => {
    expect(toModelMessages({ self: ada, agentsById, messages: [] })).toEqual([])
  })

  it('builds a different view of the same transcript for each agent', () => {
    const messages = [
      message('user', LOCAL_USER_ID, text('Question.')),
      message('agent', ada.id, text('Ada answers.')),
      message('agent', bob.id, text('Bob answers.'))
    ]

    expect(toModelMessages({ self: ada, agentsById, messages })).toEqual([
      { role: 'user', content: `[${DEFAULT_USER_NAME}]: Question.` },
      { role: 'assistant', content: 'Ada answers.' },
      { role: 'user', content: '[Bob]: Bob answers.' }
    ])
    expect(toModelMessages({ self: bob, agentsById, messages })).toEqual([
      { role: 'user', content: `[${DEFAULT_USER_NAME}]: Question.\n\n[Ada]: Ada answers.` },
      { role: 'assistant', content: 'Bob answers.' },
      { role: 'user', content: YOUR_TURN_TEXT }
    ])
  })

  it('replays a tool result but not the call that asked for it', () => {
    const result = toModelMessages({
      self: bob,
      agentsById,
      messages: [
        message('agent', ada.id, [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: { text: 'hi' } },
          { type: 'tool-result', toolCallId: 'c1', output: 'hi' },
          { type: 'text', text: 'The tool says hi.' }
        ])
      ]
    })

    const content = String(result[0]?.content)
    expect(content).toContain('[tool result] hi')
    expect(content).toContain('The tool says hi.')
    // The arguments are not replayed: the answer is the part worth keeping.
    expect(content).not.toContain('"text":"hi"')
  })

  it('caps a large tool result so one blob cannot fill every later prompt', () => {
    const huge = 'x'.repeat(MAX_TOOL_RESULT_CHARS * 3)
    const result = toModelMessages({
      self: bob,
      agentsById,
      messages: [
        message('agent', ada.id, [{ type: 'tool-result', toolCallId: 'c1', output: huge }])
      ]
    })

    const content = String(result[0]?.content)
    expect(content.length).toBeLessThan(huge.length)
    expect(content).toContain('[truncated]')
  })

  it('marks a failed tool result as an error rather than as an answer', () => {
    const result = toModelMessages({
      self: bob,
      agentsById,
      messages: [
        message('agent', ada.id, [
          { type: 'tool-result', toolCallId: 'c1', output: 'boom', isError: true }
        ])
      ]
    })

    expect(String(result[0]?.content)).toContain('[tool error] boom')
  })

  it('strips a trailing [PASS] from a reply that had something to say', () => {
    const result = toModelMessages({
      self: bob,
      agentsById,
      messages: [message('agent', ada.id, text(`Use exponential backoff. ${PASS_TOKEN}`))]
    })

    expect(result).toEqual([{ role: 'user', content: '[Ada]: Use exponential backoff.' }])
  })

  it('shows the conclusion’s text and never its flag (S5.16)', () => {
    const result = toModelMessages({
      self: bob,
      agentsById,
      messages: [
        message('agent', ada.id, [
          { type: 'conclusion' },
          { type: 'text', text: 'We will ship the smallest version first.' }
        ])
      ]
    })

    // The mark is the UI's, not the group's: a model that saw one would learn to
    // write its own, and every later speaker would claim to be concluding.
    expect(result).toEqual([
      { role: 'user', content: '[Ada]: We will ship the smallest version first.' }
    ])
  })

  it('never ends with the agent’s own reply: a closing speaker who spoke last', () => {
    // The round ended with Bob agreeing; the consensus notice is stored; Bob is
    // the closing speaker. Without a rendered notice his prompt would end with
    // his own reply, which Anthropic rejects as a prefill.
    const result = toModelMessages({
      self: bob,
      agentsById,
      messages: [
        message('user', 'local', [{ type: 'text', text: 'Which database?' }]),
        message('agent', ada.id, [{ type: 'text', text: 'SQLite. [AGREED]' }]),
        message('agent', bob.id, [{ type: 'text', text: 'SQLite as well. [AGREED]' }]),
        message('system', 'system', [{ type: 'system-notice', key: 'consensus' }])
      ]
    })
    const last = result[result.length - 1]
    expect(last?.role).toBe('user')
    expect(String(last?.content)).toContain('reached agreement')
  })

  it('appends a your-turn line when nothing at all follows the agent’s reply', () => {
    const result = toModelMessages({
      self: bob,
      agentsById,
      messages: [
        message('user', 'local', [{ type: 'text', text: 'Go on.' }]),
        message('agent', bob.id, [{ type: 'text', text: 'First point.' }])
      ]
    })
    expect(result).toEqual([
      { role: 'user', content: '[User]: Go on.' },
      { role: 'assistant', content: 'First point.' },
      { role: 'user', content: YOUR_TURN_TEXT }
    ])
  })

  it('drops a message that is nothing but the flag', () => {
    const result = toModelMessages({
      self: bob,
      agentsById,
      messages: [message('agent', ada.id, [{ type: 'conclusion' }])]
    })

    expect(result).toEqual([])
  })
})
