/**
 * The `[PASS]` protocol token, and the one rule about where it may appear.
 *
 * PLAN ("Orchestration") says a reply whose body is exactly `[PASS]` is a
 * deliberate abstention: the message is stored with status `passed`, the UI dims
 * it and the history transform drops it. That rule is unchanged.
 *
 * What S4.3 adds is the *other* shape the token turns up in. Smaller models
 * routinely answer the question and then append the token as a sign-off — "…so I
 * would keep the retry budget. [PASS]" — because the briefing told them the token
 * exists and they read it as "end of turn" rather than as "I have nothing to
 * say". That message is **not** an abstention: it carries real content, it must
 * stay `done`, and it must keep driving the next round. All that is wrong with it
 * is the four characters at the end, which are protocol noise in the transcript
 * and, fed back through the history transform, teach every later speaker that
 * ending a real answer with `[PASS]` is normal.
 *
 * So the marker is stripped **at the two places the text is read** — the
 * renderer's `messageText` and `history.ts`'s `partsToText` — and never from the
 * stored parts. The database keeps what the model actually wrote, which is what a
 * bug report about a model's behaviour needs, and no migration is owed to rows
 * written before this rule existed.
 *
 * It lives in `src/shared/` because both halves need the identical rule: the main
 * process decides the status with it and the renderer decides what to draw with
 * it, and two copies would disagree the first time one was edited.
 */

/** The abstention token, as the briefing teaches it in both languages. */
export const PASS_TOKEN = '[PASS]'

/**
 * Matches the token when it is the **last** thing in the text, with optional
 * trailing whitespace and an optional trailing sentence mark after it.
 *
 * The trailing punctuation is allowed because a model that has just written a
 * paragraph often punctuates the token like the rest of its prose (`[PASS].`),
 * and a marker the regex misses by one full stop is a marker the user still sees.
 */
const TRAILING_PASS = /\s*\[PASS\]\s*[.!\u3002\uff01]?\s*$/

/**
 * True when the whole message is the token and nothing else.
 *
 * This is the abstention test `AgentTurn` uses to choose the `passed` status, so
 * it is deliberately strict: leading and trailing whitespace are ignored and
 * nothing else is.
 */
export function isPassOnly(text: string): boolean {
  return text.trim() === PASS_TOKEN
}

/**
 * The text with a trailing `[PASS]` marker removed, when there is real content
 * in front of it.
 *
 * A message that is *only* the token is returned unchanged: it is an abstention,
 * the caller decides it is `passed`, and handing back an empty string here would
 * make a pure abstention indistinguishable from a message that never arrived.
 */
export function stripTrailingPass(text: string): string {
  if (isPassOnly(text)) return text
  if (!TRAILING_PASS.test(text)) return text
  const stripped = text.replace(TRAILING_PASS, '')
  // Only strip when something is left; `[PASS]` preceded by nothing but
  // whitespace is the abstention case again, reached through a different shape.
  return stripped.trim().length > 0 ? stripped : text
}
