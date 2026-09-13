/**
 * Day separators.
 *
 * Every case here is a calendar-boundary case, because that is the only thing
 * the function can get wrong: "within 24 hours" and "yesterday" are different
 * questions, and a transcript that answers the first one reads as broken at
 * nine in the morning.
 */
import { describe, expect, it } from 'vitest'
import type { Message } from '@shared/types'
import { buildTranscriptRows, dayBucket, startOfDay } from './transcript-rows'

const NOW = new Date('2026-09-13T10:00:00').getTime()
const HOUR = 60 * 60 * 1000

function message(id: string, createdAt: number): Message {
  return {
    id,
    userId: 'local',
    createdAt,
    updatedAt: createdAt,
    chatId: 'chat-1',
    senderType: 'user',
    senderId: 'local',
    parts: [{ type: 'text', text: id }],
    status: 'done',
    round: 0,
    mentions: []
  }
}

describe('dayBucket', () => {
  it('calls today anything since local midnight', () => {
    expect(dayBucket(new Date('2026-09-13T00:00:00').getTime(), NOW)).toBe('today')
    expect(dayBucket(NOW, NOW)).toBe('today')
  })

  it('calls yesterday the calendar day before, not the last 24 hours', () => {
    // 23:50 yesterday is ten hours ago and must still read as yesterday.
    expect(dayBucket(new Date('2026-09-12T23:50:00').getTime(), NOW)).toBe('yesterday')
    expect(dayBucket(new Date('2026-09-12T00:05:00').getTime(), NOW)).toBe('yesterday')
  })

  it('falls back to a date for anything older', () => {
    expect(dayBucket(new Date('2026-09-11T23:59:00').getTime(), NOW)).toBe('date')
  })

  it('keeps a timestamp from the future in today', () => {
    expect(dayBucket(NOW + 5 * HOUR, NOW)).toBe('today')
  })
})

describe('buildTranscriptRows', () => {
  it('is empty for an empty transcript', () => {
    expect(buildTranscriptRows([], NOW)).toEqual([])
  })

  it('opens even a single-day transcript with a separator', () => {
    const rows = buildTranscriptRows([message('a', NOW)], NOW)
    expect(rows.map((row) => row.kind)).toEqual(['day', 'message'])
    expect(rows[0]).toMatchObject({ kind: 'day', bucket: 'today' })
  })

  it('inserts one separator per calendar day, in order', () => {
    const rows = buildTranscriptRows(
      [
        message('old', new Date('2026-09-10T09:00:00').getTime()),
        message('old-2', new Date('2026-09-10T18:00:00').getTime()),
        message('yesterday', new Date('2026-09-12T21:00:00').getTime()),
        message('today', NOW)
      ],
      NOW
    )

    expect(rows.map((row) => (row.kind === 'day' ? row.bucket : row.message.id))).toEqual([
      'date',
      'old',
      'old-2',
      'yesterday',
      'yesterday',
      'today',
      'today'
    ])
  })

  it('gives every row a unique, stable key', () => {
    const rows = buildTranscriptRows(
      [message('a', NOW), message('b', NOW), message('c', NOW - 48 * HOUR)],
      NOW
    )
    const keys = rows.map((row) => row.key)
    expect(new Set(keys).size).toBe(keys.length)
    // A message keeps its id as its key, so re-rendering never remounts it.
    expect(keys).toContain('a')
  })

  it('keys a separator by the day it opens', () => {
    const day = startOfDay(NOW)
    const rows = buildTranscriptRows([message('a', NOW)], NOW)
    expect(rows[0]?.key).toBe(`day-${day}`)
  })
})
