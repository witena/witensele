/**
 * The three rules the conclusion card, the header chip and the chat list share
 * (S5.16).
 *
 * All three are pure functions of a transcript or of a chat's configuration, so
 * every case here is the case a screen would have to be clicked through
 * otherwise: several conclusions in one chat, a conclusion whose first line is a
 * heading, a chat that has none, and the four ways "Write to the deliverable"
 * can be unavailable.
 */
import { describe, expect, it } from 'vitest'
import type { ChatGoal, Message, MessagePart } from '@shared/types'
import {
  PREVIEW_MAX_CHARS,
  conclusionPreview,
  deliverableBlocker,
  latestConclusion
} from './conclusion'

let seq = 0

function message(parts: MessagePart[], senderType: Message['senderType'] = 'agent'): Message {
  seq += 1
  return {
    id: `m${seq}`,
    userId: 'local',
    createdAt: seq,
    updatedAt: seq,
    chatId: 'chat-1',
    senderType,
    senderId: senderType === 'agent' ? 'agent-ada' : 'local',
    parts,
    status: 'done',
    round: 1,
    mentions: []
  }
}

const conclusion = (text: string): Message =>
  message([{ type: 'conclusion' }, { type: 'text', text }])

describe('latestConclusion', () => {
  it('is null for a transcript with none', () => {
    expect(latestConclusion([])).toBeNull()
    expect(latestConclusion([message([{ type: 'text', text: 'Hello' }])])).toBeNull()
  })

  it('finds the last one, because a chat can agree more than once', () => {
    const first = conclusion('The first answer.')
    const second = conclusion('The second answer.')

    expect(latestConclusion([first, message([{ type: 'text', text: 'and then' }]), second])).toBe(
      second
    )
  })

  it('ignores a flag on anything that is not an agent message', () => {
    const forged = message([{ type: 'conclusion' }, { type: 'text', text: 'Not mine' }], 'user')

    expect(latestConclusion([forged])).toBeNull()
  })
})

describe('conclusionPreview', () => {
  it('is the first non-empty line', () => {
    expect(conclusionPreview([conclusion('We ship the small one.\n\nBecause it is testable.')])).toBe(
      'We ship the small one.'
    )
  })

  it('skips a leading heading marker rather than previewing punctuation', () => {
    expect(conclusionPreview([conclusion('## What we decided\n\nShip the small one.')])).toBe(
      'What we decided'
    )
  })

  it('caps a long line with an ellipsis', () => {
    const preview = conclusionPreview([conclusion('x'.repeat(PREVIEW_MAX_CHARS + 50))])
    expect(preview).toHaveLength(PREVIEW_MAX_CHARS + 1)
    expect(preview?.endsWith('…')).toBe(true)
  })

  it('is null for a chat with no conclusion, and for one with no text', () => {
    expect(conclusionPreview([message([{ type: 'text', text: 'Hello' }])])).toBeNull()
    expect(conclusionPreview([message([{ type: 'conclusion' }])])).toBeNull()
  })
})

describe('deliverableBlocker', () => {
  const documentGoal: ChatGoal = {
    kind: 'document',
    description: 'Write the report',
    deliverable: 'docs/REPORT.md',
    materials: []
  }
  const executor = [{ role: 'executor' as const }]

  it('offers the action when the chat can deliver', () => {
    expect(
      deliverableBlocker({
        workdir: '/tmp/project',
        members: executor,
        running: false,
        goal: documentGoal
      })
    ).toBeNull()
  })

  it('reports the same four refusals, in the backend’s order', () => {
    const base = {
      workdir: '/tmp/project',
      members: executor,
      running: false,
      goal: documentGoal
    }

    expect(deliverableBlocker({ ...base, workdir: null })).toBe('handoff_no_workdir')
    expect(deliverableBlocker({ ...base, members: [{ role: 'participant' }] })).toBe(
      'handoff_no_executor'
    )
    expect(deliverableBlocker({ ...base, goal: null })).toBe('handoff_no_deliverable')
    // A chat that has a goal but no file to write is the same refusal: the
    // action names a deliverable, and a `codebase` goal has none.
    expect(
      deliverableBlocker({
        ...base,
        goal: { kind: 'codebase', description: 'Rework the parser', materials: [] }
      })
    ).toBe('handoff_no_deliverable')
    expect(deliverableBlocker({ ...base, running: true })).toBe('handoff_run_active')
  })

  it('reports the deliverable before the run, because that one outlives it', () => {
    expect(
      deliverableBlocker({
        workdir: '/tmp/project',
        members: executor,
        running: true,
        goal: null
      })
    ).toBe('handoff_no_deliverable')
  })
})
