/**
 * The two rules the transcript reads a message through.
 *
 * `wasStopped` is what tells "you pressed Stop" from "the model died", and
 * `messageText` is what every row renders — including the S4.3 rule that a
 * trailing `[PASS]` on a real answer is protocol noise and not content.
 */
import { describe, expect, it } from 'vitest'
import { PASS_TOKEN } from '@shared/markers'
import type { Message, MessagePart } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import { ABORTED_MESSAGE_ERROR, messageText, wasStopped } from './message-view'

function message(parts: MessagePart[], overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    userId: LOCAL_USER_ID,
    createdAt: 1,
    updatedAt: 1,
    chatId: 'chat-1',
    senderType: 'agent',
    senderId: 'agent-1',
    parts,
    status: 'done',
    round: 1,
    mentions: [],
    ...overrides
  }
}

const text = (value: string): MessagePart[] => [{ type: 'text', text: value }]

describe('wasStopped', () => {
  it('is true only for an errored message the user aborted', () => {
    expect(
      wasStopped(message([], { status: 'error', error: ABORTED_MESSAGE_ERROR }))
    ).toBe(true)
    expect(wasStopped(message([], { status: 'error', error: 'HTTP 500' }))).toBe(false)
    expect(wasStopped(message([], { status: 'done' }))).toBe(false)
  })
})

describe('messageText', () => {
  it('joins every text part and ignores the others', () => {
    expect(
      messageText(
        message([
          { type: 'reasoning', text: 'private' },
          { type: 'text', text: 'Hello ' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: {} },
          { type: 'text', text: 'there.' }
        ])
      )
    ).toBe('Hello there.')
  })

  it('strips a trailing [PASS] from an answer that had content', () => {
    expect(messageText(message(text(`Use exponential backoff. ${PASS_TOKEN}`)))).toBe(
      'Use exponential backoff.'
    )
  })

  it('leaves a bare [PASS] alone, because that one is a real abstention', () => {
    expect(messageText(message(text(PASS_TOKEN), { status: 'passed' }))).toBe(PASS_TOKEN)
  })

  it('is empty for a message with no text parts', () => {
    expect(messageText(message([]))).toBe('')
  })
})
