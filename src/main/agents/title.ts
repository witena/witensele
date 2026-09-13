/**
 * Naming a chat after it has said something.
 *
 * Every chat is born `New chat` (`DEFAULT_CHAT_TITLE`), which is the right title
 * for a chat with nothing in it and a useless one for a left column holding six
 * of them. S4.3 replaces it once — after the first run that produced a real
 * answer — by asking the first member's own model for a few words.
 *
 * ## The rules this file encodes
 *
 * - **Only the default title is replaced.** The comparison is against
 *   `DEFAULT_CHAT_TITLE` and nothing else, so a chat the user renamed is never
 *   retitled, and a chat created with an explicit title (the member picker can
 *   do that) is left alone too. There is no "was this generated" flag to keep in
 *   sync, and no way for the feature to overwrite something a human typed.
 * - **The model is asked once, cheaply, and may fail.** `maxOutputTokens: 24`,
 *   a 15 second budget, and every error swallowed: a title is a convenience, and
 *   a chat that refused to be named because a provider hiccupped would be a
 *   worse outcome than one called after its own first sentence.
 * - **There is always a title.** When the model fails, times out or answers with
 *   something that sanitises to nothing, the first `FALLBACK_TITLE_CHARS` of the
 *   user's own question is used. It is a worse title and a perfectly good label.
 * - **The language is the conversation's.** The instruction asks for a title *in
 *   the language of the conversation* rather than naming one, because the chat
 *   itself is the only reliable signal — the UI language says what the user reads,
 *   not what they typed.
 *
 * No electron, no database and no `AppContext`: `generateChatTitle` takes a model
 * and two strings, so `ChatRunner` can inject a fake one and
 * `chat-runner.test.ts` can assert the whole path without a provider.
 */
import { generateText, type LanguageModel } from 'ai'
import { stripTrailingPass } from '@shared/pass'

/** Hard cap on a stored title; the left column truncates long ones anyway. */
export const MAX_TITLE_CHARS = 60

/** How much of the user's first message the fallback title keeps. */
export const FALLBACK_TITLE_CHARS = 40

/** Budget for the whole title request, in milliseconds. */
export const TITLE_TIMEOUT_MS = 15_000

/** A title is a few words; anything longer is the model ignoring the instruction. */
export const TITLE_MAX_OUTPUT_TOKENS = 24

/** How much of the exchange is shown to the titling model, per side. */
const PROMPT_EXCERPT_CHARS = 800

/** The instruction, kept here so the test and the docs quote one string. */
export const TITLE_INSTRUCTION =
  'Reply with a title of 3 to 6 words in the language of the conversation, ' +
  'no quotes, no punctuation at the end.'

/**
 * Quote characters a model wraps a title in, straight and typographic.
 *
 * The CJK brackets are written as `\u` escapes rather than as themselves, like
 * every non-Latin literal outside `zh-CN.json` and `briefing.zh-CN.ts`
 * (CLAUDE.md rule #1).
 */
const WRAPPING_QUOTES =
  /^[\s"'`\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u300a\u300b]+|[\s"'`\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u300a\u300b]+$/g

/** Sentence marks a title must not end with, in both scripts. */
const TRAILING_PUNCTUATION =
  /[\s.,;:!?\u3002\uff0c\u3001\uff1b\uff1a\uff01\uff1f\u2026]+$/

/**
 * Turns whatever the model said into something a list row can show.
 *
 * Collapse whitespace (models like to answer on their own line, or with a
 * "Title: " preamble on the line above), strip wrapping quotes, strip trailing
 * punctuation, cut to `MAX_TITLE_CHARS`. Returns `''` when nothing usable is
 * left, which is the caller's signal to fall back.
 */
export function sanitizeTitle(raw: string): string {
  if (typeof raw !== 'string') return ''
  let title = raw.replace(/\s+/g, ' ').trim()
  // A model that explains itself first ("Title: Retry budget tradeoffs") — keep
  // the part after the last such label rather than printing the label.
  title = title.replace(/^(?:title|\u6807\u9898)\s*[:\uff1a]\s*/i, '')
  title = title.replace(WRAPPING_QUOTES, '')
  title = title.replace(TRAILING_PUNCTUATION, '')
  if (title.length > MAX_TITLE_CHARS) {
    title = title.slice(0, MAX_TITLE_CHARS).trimEnd().replace(TRAILING_PUNCTUATION, '')
  }
  return title
}

/**
 * The title used when the model could not produce one: the beginning of the
 * question the user asked.
 *
 * An ellipsis marks the cut, so a truncated label does not read as a complete
 * sentence the user never wrote.
 */
export function fallbackTitle(firstUserMessage: string): string {
  const text = (firstUserMessage ?? '').replace(/\s+/g, ' ').trim()
  if (text.length === 0) return ''
  if (text.length <= FALLBACK_TITLE_CHARS) return text
  return `${text.slice(0, FALLBACK_TITLE_CHARS).trimEnd()}\u2026`
}

export interface GenerateTitleInput {
  /** The first member's model, already built by the runner. */
  model: LanguageModel
  /** The first thing the user said in this chat. */
  question: string
  /** The first finished agent reply. */
  reply: string
  /** The run's signal, so a Stop also abandons the titling request. */
  signal?: AbortSignal | undefined
}

/**
 * Asks a model for a title, or resolves `null` when it could not give one.
 *
 * Injected into `ChatRunner` as `ChatRunnerOptions.generateTitle` so a test can
 * supply a deterministic one; `generateChatTitle` below is the real
 * implementation and the default.
 */
export type GenerateTitle = (input: GenerateTitleInput) => Promise<string | null>

/** Trims one side of the exchange to `PROMPT_EXCERPT_CHARS`. */
function excerpt(text: string): string {
  const clean = stripTrailingPass(text ?? '').trim()
  return clean.length > PROMPT_EXCERPT_CHARS ? clean.slice(0, PROMPT_EXCERPT_CHARS) : clean
}

/**
 * The real title request: one short `generateText` call, never throwing.
 *
 * The exchange goes in the prompt rather than as a two-message conversation so
 * the model is clearly being asked to *label* a transcript rather than to
 * continue it — a model handed `user: …` / `assistant: …` and told to answer
 * short will often answer the question again instead of naming it.
 */
export const generateChatTitle: GenerateTitle = async (input) => {
  const question = excerpt(input.question)
  const reply = excerpt(input.reply)
  if (question.length === 0) return null

  // Two signals: the caller's (Stop) and the budget. `AbortSignal.any` is in
  // Node 20+, which is what electron 3x ships.
  const signals: AbortSignal[] = [AbortSignal.timeout(TITLE_TIMEOUT_MS)]
  if (input.signal) signals.push(input.signal)

  try {
    const result = await generateText({
      model: input.model,
      system: 'You name conversations. You answer with the title and nothing else.',
      prompt: `Conversation:\n\nUser: ${question}\n\nAssistant: ${reply}\n\n${TITLE_INSTRUCTION}`,
      maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.any(signals)
    })
    const title = sanitizeTitle(result.text)
    return title.length > 0 ? title : null
  } catch (error) {
    // Deliberately swallowed: see the header. A debug line rather than a warning
    // because nothing is broken — the chat keeps the fallback title.
    console.debug(
      `[witena] chat title generation failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  }
}
