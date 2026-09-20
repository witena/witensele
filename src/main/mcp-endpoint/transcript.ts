/**
 * A discussion as markdown, for `get_discussion { detail: 'transcript' }`.
 *
 * The reader is a coding agent that asked a group a question and now wants the
 * *arguments* rather than the verdict — who said what, in which round, and where
 * the group landed. That is a different job from the renderer's transcript, which
 * draws cards, avatars, streaming states and collapsible reasoning blocks, so
 * this is a second rendering of the same rows rather than a reuse of
 * `transcript-rows.ts`: one produces a React model, the other produces text a
 * model reads, and the two have no shape in common.
 *
 * Four rules, all of them about the reader:
 *
 * | Rule | Why |
 * |---|---|
 * | `**Name** (round n)` headers | The round is the structure of a discussion; a flat list of paragraphs loses who was answering whom |
 * | The conclusion is marked in its header | It is the one message the caller is meant to act on (S5.16's `ConclusionPart`), and a transcript that did not point at it would make the caller re-derive it |
 * | A tool call is one line | The group's tools are how it read the code, not what it decided; the arguments and the result are noise in somebody else's context window |
 * | Reasoning is omitted entirely | A `ReasoningPart` is a model talking to itself. It is not addressed to the group, and passing one model's private thinking to another is the opposite of what the transcript is for |
 *
 * Pure: it takes rows and a name lookup and returns a string, so it is the same
 * function whether the rows came from `loadTranscript` or from a test's fixture.
 * No electron (CLAUDE.md rule 5) and no I/O of any kind.
 */
import { stripTrailingMarkers } from '@shared/markers'
import type { Message } from '@shared/types'

export interface TranscriptOptions {
  /** The chat's title, rendered as the document's heading when given. */
  title?: string
  /** Agent id → display name. An id with no entry is printed as itself. */
  names: Map<string, string>
}

/** What a user message is called. The caller is the one who typed it. */
const USER_LABEL = 'User'

/** What a message with `senderType: 'system'` is called. */
const SYSTEM_LABEL = 'Witena'

/**
 * The discussion as markdown, oldest message first.
 *
 * Messages arrive in the order `loadTranscript` produces them (ascending `seq`)
 * and are rendered in that order; slicing to `afterMessageId` is the caller's
 * job, because only the caller knows which message the model asked to start
 * after.
 */
export function renderTranscript(messages: Message[], options: TranscriptOptions): string {
  const blocks: string[] = []
  if (options.title !== undefined && options.title.trim().length > 0) {
    blocks.push(`# ${options.title.trim()}`)
  }

  for (const message of messages) {
    blocks.push(renderMessage(message, options.names))
  }

  if (blocks.length === 0) return '_Nothing has been said yet._'
  return blocks.join('\n\n')
}

/** One message: its header line, then whatever of it is worth reading. */
function renderMessage(message: Message, names: Map<string, string>): string {
  const lines = [header(message, names)]
  const body = bodyOf(message)
  if (body.length > 0) {
    lines.push('')
    lines.push(...body)
  }
  return lines.join('\n')
}

/**
 * `**Ada** (round 2) — conclusion`.
 *
 * The round is dropped when it is 0, which is what a message sent outside a run
 * carries — the question itself, and any notice written between runs. Writing
 * "(round 0)" would invent a round that never happened.
 */
function header(message: Message, names: Map<string, string>): string {
  const parts = [`**${speakerOf(message, names)}**`]
  if (message.round > 0) parts.push(`(round ${message.round})`)

  const marks: string[] = []
  if (message.parts.some((part) => part.type === 'conclusion')) marks.push('conclusion')
  // A status worth a word of its own. `done` is the ordinary case and says
  // nothing; `streaming` means the group is still talking, which the result's
  // own `status` already says far more precisely.
  if (message.status === 'passed') marks.push('passed')
  if (message.status === 'skipped') marks.push('no reply')
  if (message.status === 'error') marks.push('failed')

  const line = parts.join(' ')
  return marks.length > 0 ? `${line} — ${marks.join(', ')}` : line
}

function speakerOf(message: Message, names: Map<string, string>): string {
  if (message.senderType === 'user') return USER_LABEL
  if (message.senderType === 'system') return SYSTEM_LABEL
  return names.get(message.senderId) ?? message.senderId
}

/**
 * What the message actually said.
 *
 * Text first, as one paragraph, then one line per tool call. A message whose
 * only content was reasoning or a flag renders as its header alone, which is the
 * honest rendering of a turn that said nothing.
 */
function bodyOf(message: Message): string[] {
  const lines: string[] = []

  const text = stripTrailingMarkers(
    message.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('')
  ).trim()
  if (text.length > 0) lines.push(text)

  for (const part of message.parts) {
    if (part.type !== 'tool-call') continue
    if (lines.length > 0) lines.push('')
    lines.push(`_called \`${toolLabel(part.toolName, part.serverName)}\`${failed(message, part.toolCallId) ? ' — failed' : ''}_`)
  }

  for (const part of message.parts) {
    if (part.type !== 'system-notice') continue
    // The backend writes notices as an i18n key plus parameters, never as a
    // sentence (CLAUDE.md rule 4), and this transcript has no translator. The
    // key is the truthful thing to show: it names the event without pretending
    // to be prose somebody wrote.
    if (lines.length > 0) lines.push('')
    lines.push(`_(${part.key})_`)
  }

  if (message.status === 'error' && typeof message.error === 'string' && message.error.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(`_error: ${message.error}_`)
  }

  return lines
}

/** `server · tool`, or just the tool when it came from no server. */
function toolLabel(toolName: string, serverName: string | undefined): string {
  return serverName === undefined ? toolName : `${serverName} · ${toolName}`
}

/** Whether this message carries a failed result for that call. */
function failed(message: Message, toolCallId: string): boolean {
  return message.parts.some(
    (part) => part.type === 'tool-result' && part.toolCallId === toolCallId && part.isError === true
  )
}
