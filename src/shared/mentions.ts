/**
 * `@mention` parsing, shared by the main process and the renderer.
 *
 * It lives in `src/shared/` rather than in `orchestration/` because both halves
 * of the app have to agree on it *exactly*: the backend resolves a reply's
 * mentions into the next round's speakers, and the composer highlights and
 * pre-resolves the same tokens while the user is still typing. Two
 * implementations of "what counts as a mention" would drift the day someone
 * renames an agent to `Ann Lee`.
 *
 * ## The rules
 *
 * | Rule | Why |
 * |---|---|
 * | `@` + a **member's display name** | A name is the identity the models see; `agents.create` already forbids `@` inside one |
 * | **Longest name first** | With members `Ann` and `Ann Lee`, `@Ann Lee` is Ann Lee. Tokenising on whitespace cannot express that, and a Chinese name has no whitespace to tokenise on |
 * | **Case-insensitive** | Models re-type a name from memory and rarely preserve case |
 * | An ASCII name must end on a **word boundary** | `@Anna` is not `@Ann`. A CJK name has no word boundary, so any following character ends it |
 * | The `@` itself must not follow a word character | `ada@example.com` is an address, not a mention of `example` |
 * | `@all` / `@everyone` | The keyword every member answers to. A member actually named "all" wins over the keyword, because a name is more specific |
 *
 * Results are **agent ids in order of first appearance, deduplicated**. The order
 * matters: it is the order the runner falls back to when two mentions name two
 * members that are not in the chat's member order.
 *
 * Nothing here throws, allocates a regular expression from user input, or knows
 * what a round is — scheduling on top of these ids is `orchestration`'s job
 * (`src/main/orchestration/scheduling.ts`).
 */

/** The two fields a mention is resolved against. */
export interface MentionMember {
  agentId: string
  name: string
}

/** Keywords that mean "every member of this chat", without the leading `@`. */
export const MENTION_ALL_KEYWORDS = ['all', 'everyone'] as const

/** One `@…` token found in a text, and the members it resolves to. */
export interface MentionSpan {
  /** Index of the `@`. */
  start: number
  /** Index just past the last character of the name. */
  end: number
  /** Agent ids this token names; more than one only for `@all` / `@everyone`. */
  agentIds: string[]
}

/** A piece of a text split by `splitMentions`; `agentIds` is absent for plain text. */
export interface MentionSegment {
  text: string
  agentIds?: string[]
}

interface Candidate {
  /** Lower-cased name or keyword, without the `@`. */
  token: string
  agentIds: string[]
}

/** True for the characters that may not sit directly beside an ASCII name. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char)
}

/**
 * The match candidates, longest first.
 *
 * Member names are pushed before the keywords and `Array.prototype.sort` is
 * stable, so a member literally named "all" is preferred over the keyword at the
 * same length.
 */
function buildCandidates(members: readonly MentionMember[]): Candidate[] {
  const candidates: Candidate[] = []
  for (const member of members) {
    const token = member.name.trim().toLowerCase()
    if (token.length === 0) continue
    candidates.push({ token, agentIds: [member.agentId] })
  }

  const everyone = members.map((member) => member.agentId)
  if (everyone.length > 0) {
    for (const keyword of MENTION_ALL_KEYWORDS) {
      candidates.push({ token: keyword, agentIds: everyone })
    }
  }

  return candidates.sort((left, right) => right.token.length - left.token.length)
}

/**
 * Every `@…` token in `text`, in the order they appear.
 *
 * The scan is a plain left-to-right walk rather than a regular expression: a name
 * may contain spaces, dots and CJK, and building a pattern out of user data would
 * need escaping for no gain.
 */
export function findMentions(text: string, members: readonly MentionMember[]): MentionSpan[] {
  const candidates = buildCandidates(members)
  if (candidates.length === 0) return []

  const lower = text.toLowerCase()
  const spans: MentionSpan[] = []

  let index = 0
  while (index < text.length) {
    if (text[index] !== '@' || isWordChar(text[index - 1])) {
      index += 1
      continue
    }

    const match = candidates.find((candidate) => {
      const start = index + 1
      if (!lower.startsWith(candidate.token, start)) return false
      // An ASCII name has to end on a word boundary; a name that ends in a CJK
      // character (or punctuation) is already unambiguous.
      const last = candidate.token[candidate.token.length - 1]
      if (!isWordChar(last)) return true
      return !isWordChar(text[start + candidate.token.length])
    })

    if (!match) {
      index += 1
      continue
    }

    const end = index + 1 + match.token.length
    spans.push({ start: index, end, agentIds: match.agentIds })
    index = end
  }

  return spans
}

/**
 * The agent ids mentioned in `text`, in order of first appearance, deduplicated.
 *
 * This is the function both sides call: `ChatRunner` on a user message and on
 * every finished reply, the composer on what the user typed.
 */
export function parseMentions(text: string, members: readonly MentionMember[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const span of findMentions(text, members)) {
    for (const agentId of span.agentIds) {
      if (seen.has(agentId)) continue
      seen.add(agentId)
      result.push(agentId)
    }
  }
  return result
}

/**
 * `text` split into plain pieces and mention tokens, for the renderer.
 *
 * Pure and array-shaped so the highlighting component stays four lines and the
 * rule itself is tested here rather than through the DOM.
 */
export function splitMentions(text: string, members: readonly MentionMember[]): MentionSegment[] {
  const spans = findMentions(text, members)
  if (spans.length === 0) return text.length > 0 ? [{ text }] : []

  const segments: MentionSegment[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) segments.push({ text: text.slice(cursor, span.start) })
    segments.push({ text: text.slice(span.start, span.end), agentIds: span.agentIds })
    cursor = span.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments
}
