/**
 * The pure transforms the transcript is drawn from: the day separators between
 * messages, and the two part kinds a message row renders as blocks of their own.
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
 *
 * ## Diffs and file references (S5.5)
 *
 * `collectDiffs` and `collectFileRefs` live here for the same reason the day
 * grouping does: they are `MessagePart[] → something` transforms with cases
 * worth testing (a part in the middle of the text, a message with none, a
 * message with several), and `message-item.tsx` is markup that should not also
 * be the place those cases are decided.
 *
 * ## The conclusion (S5.16)
 *
 * A message row also says whether it is the group's **conclusion** —
 * `isConclusion(parts)`, the one reading of the `ConclusionPart` flag the
 * backend stores on a closing turn. It is part of the row model rather than a
 * check inside the component for the same reason everything else here is.
 */
import type { DiffPart, FileRefPart, Message, MessagePart } from '@shared/types'

/** Which of the three labels a separator carries. */
export type DayBucket = 'today' | 'yesterday' | 'date'

/** A row of the virtualized transcript: either a separator or a message. */
export type TranscriptRow =
  | { kind: 'day'; key: string; bucket: DayBucket; timestamp: number }
  | {
      kind: 'message'
      key: string
      message: Message
      /**
       * True when this message is the group's conclusion (S5.16).
       *
       * Decided in the row model rather than inside `MessageItem`, because it is
       * the same kind of statement the day separator is — a property of the row
       * the list is drawing — and because a boolean computed here is a unit test
       * while the same `if` inside the component is not (the renderer suite runs
       * in `node`, with no DOM).
       */
      conclusion: boolean
    }

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
    rows.push({
      kind: 'message',
      key: message.id,
      message,
      conclusion: isConclusion(message.parts)
    })
  }

  return rows
}

/**
 * Whether these parts carry the conclusion flag (S5.16).
 *
 * The whole reading of `ConclusionPart`: it is a marker with no content, so
 * "does it exist" is all there is to ask. Its position — first, as the backend
 * stores it — is deliberately not asserted here: a reader that insisted on
 * `parts[0]` would break the day a second flag part is added in front of it.
 */
export function isConclusion(parts: readonly MessagePart[]): boolean {
  return parts.some((part) => part.type === 'conclusion')
}

/**
 * The `diff` parts of one message, in the order the backend appended them.
 *
 * One per **file**: the turn concatenates several writes to the same path before
 * it stores them (`diffPartsFrom` in `src/main/agents/agent-turn.ts`), so a
 * duplicate path here would be a backend bug rather than something to merge a
 * second time in the renderer.
 */
export function collectDiffs(parts: readonly MessagePart[]): DiffPart[] {
  return parts.filter((part): part is DiffPart => part.type === 'diff')
}

/**
 * The `file-ref` parts of one message, de-duplicated by `path:line`.
 *
 * De-duplicated because the same reference pointed at twice is one file to open,
 * and a row of identical chips reads as a rendering mistake. The first
 * occurrence keeps its position.
 */
export function collectFileRefs(parts: readonly MessagePart[]): FileRefPart[] {
  const seen = new Set<string>()
  const refs: FileRefPart[] = []
  for (const part of parts) {
    if (part.type !== 'file-ref') continue
    const key = `${part.path}:${part.line ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(part)
  }
  return refs
}

/**
 * How many lines a unified diff adds and removes, for the collapsed header.
 *
 * `+++` and `---` are the file headers, not changed lines; counting them would
 * report `+1 -1` for a patch that changed nothing. Everything else is counted by
 * its first character, which is all a unified diff encodes.
 */
export function countDiffLines(patch: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

/** `src/main.ts:42`, or the bare path when the reference carries no line. */
export function formatFileRef(part: FileRefPart): string {
  return part.line === undefined ? part.path : `${part.path}:${part.line}`
}
