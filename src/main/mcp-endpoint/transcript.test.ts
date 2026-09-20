/**
 * The markdown a calling model reads when it asks for the arguments rather than
 * the verdict.
 *
 * Pure input, pure output, so the cases are hand-built rows: the point is the
 * *shape* of the rendering — the headers, what is marked, what is summarised and
 * what is dropped — and building it from a real run would only make the same
 * assertions harder to read.
 */
import { describe, expect, it } from 'vitest'
import { AGREED_TOKEN } from '@shared/markers'
import type { Message, MessagePart, MessageStatus } from '@shared/types'
import { renderTranscript } from './transcript'

const NAMES = new Map([
  ['agent-ada', 'Ada'],
  ['agent-lin', 'Lin']
])

let counter = 0

function message(
  senderType: Message['senderType'],
  senderId: string,
  parts: MessagePart[],
  extra: { round?: number; status?: MessageStatus; error?: string } = {}
): Message {
  counter += 1
  return {
    id: `message-${counter}`,
    userId: 'local',
    createdAt: 0,
    updatedAt: 0,
    chatId: 'chat-1',
    senderType,
    senderId,
    parts,
    status: extra.status ?? 'done',
    round: extra.round ?? 0,
    mentions: [],
    ...(extra.error === undefined ? {} : { error: extra.error })
  } as Message
}

describe('renderTranscript', () => {
  it('renders a whole discussion the way a calling model reads it', () => {
    const transcript = [
      message('user', 'local', [{ type: 'text', text: 'Is this migration safe?' }]),
      message(
        'agent',
        'agent-ada',
        [
          { type: 'reasoning', text: 'The user probably means the index rebuild.' },
          { type: 'text', text: `It is, if the index is rebuilt first. ${AGREED_TOKEN}` },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'read_file',
            input: { path: 'migrate.sql' },
            serverName: 'workspace'
          }
        ],
        { round: 1 }
      ),
      message('agent', 'agent-lin', [{ type: 'text', text: 'Agreed.' }], { round: 1 }),
      message(
        'agent',
        'agent-lin',
        [{ type: 'conclusion' }, { type: 'text', text: 'Rebuild the index, then migrate.' }],
        { round: 2 }
      )
    ]

    expect(renderTranscript(transcript, { title: 'Migration', names: NAMES })).toBe(
      [
        '# Migration',
        '',
        '**User**',
        '',
        'Is this migration safe?',
        '',
        '**Ada** (round 1)',
        '',
        'It is, if the index is rebuilt first.',
        '',
        '_called `workspace · read_file`_',
        '',
        '**Lin** (round 1)',
        '',
        'Agreed.',
        '',
        '**Lin** (round 2) — conclusion',
        '',
        'Rebuild the index, then migrate.'
      ].join('\n')
    )
  })

  it('says what happened to a turn that did not answer', () => {
    const transcript = [
      message('agent', 'agent-ada', [], { round: 1, status: 'passed' }),
      message('agent', 'agent-lin', [], { round: 1, status: 'skipped' }),
      message('agent', 'agent-lin', [], { round: 2, status: 'error', error: 'provider exploded' }),
      message('system', 'system', [{ type: 'system-notice', key: 'runFailed' }])
    ]

    expect(renderTranscript(transcript, { names: NAMES })).toBe(
      [
        '**Ada** (round 1) — passed',
        '',
        '**Lin** (round 1) — no reply',
        '',
        '**Lin** (round 2) — failed',
        '',
        '_error: provider exploded_',
        '',
        '**Witena**',
        '',
        '_(runFailed)_'
      ].join('\n')
    )
  })

  it('marks a tool call that failed, and names an agent it has no name for', () => {
    const transcript = [
      message(
        'agent',
        'agent-unknown',
        [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'write_file',
            input: {}
          },
          { type: 'tool-result', toolCallId: 'call-1', output: 'denied', isError: true }
        ],
        { round: 1 }
      )
    ]

    expect(renderTranscript(transcript, { names: NAMES })).toBe(
      ['**agent-unknown** (round 1)', '', '_called `write_file` — failed_'].join('\n')
    )
  })

  it('says so rather than returning nothing for an empty transcript', () => {
    expect(renderTranscript([], { names: NAMES })).toBe('_Nothing has been said yet._')
  })
})
