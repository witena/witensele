/**
 * The protocol markers a reply may end with, and the one rule about where they
 * may appear.
 *
 * There are three of them, and they answer two different questions:
 *
 * | Marker | Question | Effect |
 * |---|---|---|
 * | `[PASS]` | *Do you want this turn at all?* | A reply that is **only** the token is an abstention: status `passed`, dimmed in the UI, dropped from the history transform, and it schedules nobody |
 * | `[AGREED]` | *Is the discussion finished?* | Ends an ordinary reply that has nothing left to add and accepts the position on the table |
 * | `[CONTINUE]` | the same question | Ends an ordinary reply that does not |
 *
 * `[PASS]` is PLAN's ("Orchestration"); the other two are S5.14's, and they are
 * what lets a discussion **stop by itself**: a round in which every participant
 * ended with `[AGREED]` is the group saying it is done, and `ChatRunner` answers
 * it with one closing turn and the floor back to the user, rather than running
 * the remaining `maxAutoRounds` of models agreeing with each other at length.
 *
 * ## Why the markers are stripped at read time and never from the stored parts
 *
 * Smaller models routinely answer the question and then append a marker as a
 * sign-off — "…so I would keep the retry budget. [AGREED]". That message is not
 * an abstention: it carries real content, it stays `done`, and it keeps driving
 * the next round. All that is wrong with it is the characters at the end, which
 * are protocol noise in the transcript and, fed back through the history
 * transform, teach every later speaker that ending a real answer that way is
 * normal prose.
 *
 * So a trailing marker is stripped **at the two places the text is read** — the
 * renderer's `messageText` and `history.ts`'s `partsToText` — and never from the
 * stored parts. The database keeps what the model actually wrote, which is what
 * a bug report about a model's behaviour needs, and no migration is owed to rows
 * written before any of these rules existed.
 *
 * It lives in `src/shared/` because both halves need the identical rule: the
 * main process decides the status and the next round with it, the renderer
 * decides what to draw with it, and two copies would disagree the first time one
 * was edited.
 *
 * (This module was `@shared/pass` until S5.14, when it grew the second pair of
 * markers and the name stopped describing it.)
 */

/** The abstention token, as the briefing teaches it in both languages. */
export const PASS_TOKEN = '[PASS]'

/** "I have nothing to add and I accept the position on the table" (S5.14). */
export const AGREED_TOKEN = '[AGREED]'

/** "The discussion is not finished" (S5.14). */
export const CONTINUE_TOKEN = '[CONTINUE]'

/**
 * Which of the two closure markers a reply ended with, as `ChatRunner` reads it.
 *
 * `null` — no marker at all — is deliberately **not** the same as `'continue'`
 * at the call site: a round in which nobody wrote a marker is a round the model
 * did not follow the protocol in, and the runner treats that as "keep going"
 * rather than as agreement, which is the conservative half of the rule.
 */
export type ClosureMarker = 'agreed' | 'continue'

/**
 * Matches one marker when it is the **last** thing in the text, with optional
 * trailing whitespace and an optional trailing sentence mark after it.
 *
 * The trailing punctuation is allowed because a model that has just written a
 * paragraph often punctuates the token like the rest of its prose (`[PASS].`),
 * and a marker the regex misses by one full stop is a marker the user still
 * sees. The alternation is anchored with `$`, so a marker in the middle of a
 * sentence — the briefing quoting itself, a model explaining the protocol — is
 * left exactly where it is.
 *
 * Case-**sensitive**, like the `[PASS]` rule it grew out of: the briefing prints
 * the tokens in capitals in both languages, and a lowercase `[pass]` in the
 * middle of prose is far more likely to be a model talking about the protocol
 * than a model using it.
 */
const TRAILING_MARKER = /\s*\[(?:PASS|AGREED|CONTINUE)\]\s*[.!。！]?\s*$/

/** The same alternation, capturing which of the two closure markers matched. */
const TRAILING_CLOSURE = /\s*\[(AGREED|CONTINUE)\]\s*[.!。！]?\s*$/

/**
 * True when the whole message is the abstention token and nothing else.
 *
 * This is the test `AgentTurn` uses to choose the `passed` status, so it is
 * deliberately strict: leading and trailing whitespace are ignored and nothing
 * else is. `[AGREED]` on its own is **not** an abstention — it is a member that
 * spoke and said it is done — so it is not accepted here.
 */
export function isPassOnly(text: string): boolean {
  return text.trim() === PASS_TOKEN
}

/**
 * The closure marker this reply ends with, or `null`.
 *
 * Only the very end counts, for the reason `TRAILING_MARKER` gives: a briefing
 * that names the tokens, or a model that explains them, must not be read as a
 * vote. A pure abstention answers `null` too — `[PASS]` says nothing about
 * whether the group is finished, and `planFromReplies` already drops it.
 */
export function closureMarker(text: string): ClosureMarker | null {
  const match = TRAILING_CLOSURE.exec(text)
  if (!match) return null
  return match[1] === 'AGREED' ? 'agreed' : 'continue'
}

/**
 * The text with its trailing protocol markers removed, when there is real
 * content in front of them.
 *
 * A message that is *only* markers is returned unchanged: `[PASS]` alone is an
 * abstention the caller decides the status from, and handing back an empty
 * string would make it indistinguishable from a message that never arrived — and
 * a bare `[AGREED]` is a member that said only that, which the user is better
 * off seeing than not.
 *
 * The loop is what handles the model that writes two of them (`… [AGREED]
 * [PASS]`): each pass removes the last one, and the "something has to be left"
 * rule is applied to the result rather than to each step.
 */
export function stripTrailingMarkers(text: string): string {
  let current = text
  for (;;) {
    if (!TRAILING_MARKER.test(current)) break
    const stripped = current.replace(TRAILING_MARKER, '')
    // Only strip when something is left; a marker preceded by nothing but
    // whitespace is the "only markers" case, reached through a different shape.
    if (stripped.trim().length === 0) break
    current = stripped
  }
  return current === text ? text : current
}
