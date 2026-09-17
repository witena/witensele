/**
 * Day separators.
 *
 * Every case here is a calendar-boundary case, because that is the only thing
 * the function can get wrong: "within 24 hours" and "yesterday" are different
 * questions, and a transcript that answers the first one reads as broken at
 * nine in the morning.
 */
import { describe, expect, it } from 'vitest'
import type { Message, MessagePart } from '@shared/types'
import {
  buildTranscriptRows,
  collectDiffs,
  collectFileRefs,
  countDiffLines,
  formatFileRef,
  isConclusion,
  dayBucket,
  startOfDay
} from './transcript-rows'

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

  it('marks the row of a conclusion, and only that row (S5.16)', () => {
    const ordinary = message('ordinary', NOW)
    const conclusion = {
      ...message('conclusion', NOW),
      senderType: 'agent' as const,
      parts: [{ type: 'conclusion' as const }, { type: 'text' as const, text: 'We decided.' }]
    }

    const rows = buildTranscriptRows([ordinary, conclusion], NOW)

    expect(
      rows.filter((row) => row.kind === 'message').map((row) => [row.message.id, row.conclusion])
    ).toEqual([
      ['ordinary', false],
      ['conclusion', true]
    ])
  })
})

describe('isConclusion', () => {
  it('reads the flag wherever it sits, and says no when there is none', () => {
    expect(isConclusion([{ type: 'conclusion' }, { type: 'text', text: 'x' }])).toBe(true)
    expect(isConclusion([{ type: 'text', text: 'x' }, { type: 'conclusion' }])).toBe(true)
    expect(isConclusion([{ type: 'text', text: 'x' }])).toBe(false)
    expect(isConclusion([])).toBe(false)
  })
})

/**
 * The two part kinds a message row draws as blocks of its own (S5.5).
 *
 * Both are order-sensitive — the transcript claims to show what the executor did
 * and in which order — and both have to survive being mixed in with text, tool
 * calls and notices, which is how a real executor message is shaped.
 */
describe('collectDiffs', () => {
  it('is empty for a message with no diff parts', () => {
    expect(collectDiffs([{ type: 'text', text: 'Done.' }])).toEqual([])
  })

  it('keeps the diff parts in order and drops everything else', () => {
    const parts: MessagePart[] = [
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'write_file', input: {} },
      { type: 'tool-result', toolCallId: 'call-1', output: { patch: 'ignored' } },
      { type: 'text', text: 'I added two files.' },
      { type: 'diff', path: 'a.ts', patch: '--- a.ts\n+++ a.ts\n+one\n' },
      { type: 'diff', path: 'b.ts', patch: '--- b.ts\n+++ b.ts\n+two\n' }
    ]

    expect(collectDiffs(parts).map((part) => part.path)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('collectFileRefs', () => {
  it('keeps a line number when there is one and tolerates none', () => {
    const refs = collectFileRefs([
      { type: 'file-ref', path: 'src/main.ts', line: 42 },
      { type: 'text', text: 'and' },
      { type: 'file-ref', path: 'README.md' }
    ])

    expect(refs).toEqual([
      { type: 'file-ref', path: 'src/main.ts', line: 42 },
      { type: 'file-ref', path: 'README.md' }
    ])
  })

  it('de-duplicates the same reference and keeps the first position', () => {
    const refs = collectFileRefs([
      { type: 'file-ref', path: 'src/main.ts', line: 42 },
      { type: 'file-ref', path: 'src/main.ts', line: 7 },
      { type: 'file-ref', path: 'src/main.ts', line: 42 }
    ])

    // Same file, different line, is a different reference; the exact repeat is
    // the one that is dropped.
    expect(refs.map((part) => part.line)).toEqual([42, 7])
  })
})

describe('countDiffLines', () => {
  it('counts changed lines and ignores the file headers', () => {
    const patch = [
      'Index: a.ts',
      '===================================================================',
      '--- a.ts',
      '+++ a.ts',
      '@@ -1,2 +1,3 @@',
      ' kept',
      '-gone',
      '+new',
      '+also new'
    ].join('\n')

    expect(countDiffLines(patch)).toEqual({ added: 2, removed: 1 })
  })

  it('counts a concatenation of two patches for the same file', () => {
    const one = '--- a.ts\n+++ a.ts\n+one\n'
    const two = '--- a.ts\n+++ a.ts\n-one\n+two\n'

    expect(countDiffLines(one + two)).toEqual({ added: 2, removed: 1 })
  })

  it('is zero for an empty patch', () => {
    expect(countDiffLines('')).toEqual({ added: 0, removed: 0 })
  })
})

describe('formatFileRef', () => {
  it('appends the line when there is one', () => {
    expect(formatFileRef({ type: 'file-ref', path: 'src/main.ts', line: 42 })).toBe(
      'src/main.ts:42'
    )
  })

  it('leaves a reference without a line as the bare path', () => {
    expect(formatFileRef({ type: 'file-ref', path: 'README.md' })).toBe('README.md')
  })
})
