/**
 * The composer's `@` autocomplete, as pure functions.
 *
 * The popover itself is twenty lines of JSX; everything that can be wrong lives
 * here: where the token the caret sits in starts, which members it matches, and
 * what the textarea looks like after one is picked.
 *
 * ## When the popover opens
 *
 * A `@` at the very start of the text, or after whitespace. `ada@example.com`
 * therefore opens nothing, which is the same boundary rule
 * `@shared/mentions.ts` applies when it *resolves* a mention — the two have to
 * agree or the composer would offer a completion the backend then ignores.
 *
 * The query may contain spaces, because a member can be called `Ann Lee` and a
 * completion that stopped at the space could never reach her. It is bounded
 * instead: no newline, and at most `MAX_QUERY_LENGTH` characters, so a whole
 * paragraph typed after a stray `@` does not keep a popover open behind it. The
 * popover closes on its own as soon as nothing matches.
 *
 * ## Which member wins
 *
 * `filterMentionCandidates` returns matches **longest name first**, the same
 * order `@shared/mentions.ts` tries its candidates in. With members `Ann` and
 * `Ann Lee` and the query `Ann`, the list therefore offers `Ann Lee` first —
 * which is the one the parser would have picked if the user had typed the whole
 * thing out.
 */
import { MENTION_ALL_KEYWORDS, type MentionMember } from '@shared/mentions'

/** Longest `@…` token the popover will still consider a query. */
export const MAX_QUERY_LENGTH = 40

/** The `@…` token the caret is inside. */
export interface MentionQuery {
  /** Index of the `@`. */
  start: number
  /** Index just past the query, which is always the caret. */
  end: number
  /** What was typed after the `@`, verbatim. */
  query: string
}

/** True for a character that may precede an opening `@`. */
function isBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char)
}

/**
 * The `@…` token the caret sits in, or `null`.
 *
 * The scan walks **backwards** from the caret: forward scanning would have to
 * decide where a token ends, and the caret already answers that.
 */
export function extractMentionQuery(text: string, caret: number): MentionQuery | null {
  const position = Math.max(0, Math.min(caret, text.length))

  for (let index = position - 1; index >= 0 && position - index <= MAX_QUERY_LENGTH + 1; index -= 1) {
    const char = text[index] as string
    // A newline ends the search: a mention never spans two lines.
    if (char === '\n') return null
    if (char !== '@') continue
    if (!isBoundary(text[index - 1])) return null
    return { start: index, end: position, query: text.slice(index + 1, position) }
  }

  return null
}

/** One row of the popover. `agentId` is absent for the `@all` keyword. */
export interface MentionCandidate {
  /** The name inserted, without the `@`. */
  name: string
  /** The member this row names; absent on the "everyone" row. */
  agentId?: string
}

/**
 * The rows the popover shows for `query`, longest name first.
 *
 * An empty query lists everyone, which is what makes a bare `@` useful. The
 * `@all` keyword is appended rather than sorted in, so the members a user
 * actually wants stay at the top of the list.
 */
export function filterMentionCandidates(
  members: readonly MentionMember[],
  query: string
): MentionCandidate[] {
  const needle = query.trim().toLowerCase()

  const matched = members
    .filter((member) => member.name.toLowerCase().startsWith(needle))
    .map((member): MentionCandidate => ({ name: member.name, agentId: member.agentId }))
    // Longest first, so `Ann Lee` is offered ahead of `Ann` for the query `Ann`.
    .sort((left, right) => right.name.length - left.name.length)

  const [everyone] = MENTION_ALL_KEYWORDS
  const keyword = everyone as string
  if (members.length > 0 && keyword.startsWith(needle)) matched.push({ name: keyword })

  return matched
}

/** The textarea after a completion is accepted. */
export interface MentionInsertion {
  text: string
  /** Where the caret goes: just past the trailing space. */
  caret: number
}

/**
 * Replaces the `@…` token at `span` with `@name `.
 *
 * The trailing space is not cosmetic: it is what closes the popover and what
 * makes the next `@` a fresh token rather than part of this name.
 */
export function insertMention(text: string, span: MentionQuery, name: string): MentionInsertion {
  const token = `@${name} `
  // An existing space right after the caret must not become a double space.
  const tail = text.slice(span.end).startsWith(' ') ? text.slice(span.end + 1) : text.slice(span.end)
  return { text: `${text.slice(0, span.start)}${token}${tail}`, caret: span.start + token.length }
}

/**
 * Appends `@name ` at the caret, for the chip row under the textarea.
 *
 * Unlike `insertMention` nothing is replaced: the chips are a shortcut for
 * someone who has not typed an `@` at all. A space is inserted first when the
 * caret is not already on a boundary, so `hello@Ada` can never be produced.
 */
export function appendMention(text: string, caret: number, name: string): MentionInsertion {
  const position = Math.max(0, Math.min(caret, text.length))
  const head = text.slice(0, position)
  const separator = head.length > 0 && !isBoundary(head[head.length - 1]) ? ' ' : ''
  const token = `${separator}@${name} `
  const tail = text.slice(position).startsWith(' ') ? text.slice(position + 1) : text.slice(position)
  return { text: `${head}${token}${tail}`, caret: position + token.length }
}
