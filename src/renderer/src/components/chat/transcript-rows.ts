/**
 * Day separators: the "Today / Yesterday / 3 May" lines the transcript puts
 * between messages written on different calendar days.
 *
 * The list is virtualized (react-virtuoso), which means it renders a **flat
 * array of rows**, not a nested structure: a separator has to be a row of its
 * own or the virtualizer cannot measure it. So the grouping is expressed as a
 * pure `Message[] → TranscriptRow[]` transform, testable without a DOM and
 * without react-virtuoso.
 *
 * Calendar days in the **viewer's** local timezone, exactly like `groupChats` in
 * `stores/chats.ts`: a message sent at 23:50 has to read as yesterday the next
 * morning rather than as "9 hours ago".
 */
import type { Message } from '@shared/types'

/** Which of the three labels a separator carries. */
export type DayBucket = 'today' | 'yesterday' | 'date'

/** A row of the virtualized transcript: either a separator or a message. */
export type TranscriptRow =
  | { kind: 'day'; key: string; bucket: DayBucket; timestamp: number }
  | { kind: 'message'; key: string; message: Message }

const DAY_MS = 24 * 60 * 60 * 1000

/** Local midnight of the day `timestamp` falls in. */
export function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Which label a day gets.
 *
 * A timestamp in the future (a clock change, a record stamped by a machine a
 * minute ahead) still reads as today rather than as a date nobody expected.
 */
export function dayBucket(timestamp: number, now: number = Date.now()): DayBucket {
  const today = startOfDay(now)
  if (timestamp >= today) return 'today'
  if (timestamp >= today - DAY_MS) return 'yesterday'
  return 'date'
}

/**
 * Interleaves day separators into an oldest-first message list.
 *
 * One separator per calendar day, including before the very first message — the
 * transcript of a chat started last week should say so at the top rather than
 * only where the day happens to change.
 *
 * Row keys are stable and unique: a separator is keyed by the day it opens and a
 * message by its id, which is what keeps react-virtuoso from re-mounting rows
 * as the list grows.
 */
export function buildTranscriptRows(
  messages: readonly Message[],
  now: number = Date.now()
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let currentDay: number | null = null

  for (const message of messages) {
    const day = startOfDay(message.createdAt)
    if (day !== currentDay) {
      currentDay = day
      rows.push({ kind: 'day', key: `day-${day}`, bucket: dayBucket(day, now), timestamp: day })
    }
    rows.push({ kind: 'message', key: message.id, message })
  }

  return rows
}
