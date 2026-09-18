/**
 * The group briefing: the paragraph appended to every agent's own system prompt
 * that teaches it the rules of a multi-agent chat.
 *
 * Four things it has to say, straight from "One agent turn" in `docs/PLAN.md`:
 * who is in the room (name plus description), which of them *you* are, that the
 * other members' turns arrive as `[name]:` prefixed user messages rather than as
 * assistant turns, and the two protocol tokens — `@name` to call on someone and
 * `[PASS]` to abstain. Since S5.10 a fifth, when the chat has one: the **goal**
 * — what the group is working towards, in the user's own words. Since S5.12 a
 * sixth, for one round only: that this round is a **review** of what the
 * executor just changed, judged against that goal. Since S5.14 a seventh, in the
 * rules themselves: how a reply says whether the discussion is **finished** —
 * `[AGREED]` or `[CONTINUE]` — and, for the single turn that ends such a
 * discussion, a **closing** block that replaces the rules with "write the
 * group's conclusion for the user".
 *
 * It exists in **both languages** and follows the UI language (PLAN, "Bilingual
 * UI"): a Chinese-first model reads a Chinese briefing far more reliably than a
 * translated-in-its-head English one, and an English-first model the reverse.
 * The two wordings live in `briefing.en.ts` and `briefing.zh-CN.ts`; this module
 * only picks between them, so adding a third language is a file plus a case.
 *
 * This is model-facing text, **not UI copy**: it never reaches the renderer, so
 * it is not an i18n key and `briefing.zh-CN.ts` is the one `.ts` file in the
 * repository allowed to contain Chinese (see `docs/features/agent-turn/`).
 */
import type { Agent, ChatGoal, Language } from '@shared/types'
import { buildEnglishBriefing } from './briefing.en'
import { buildChineseBriefing } from './briefing.zh-CN'

/** The two fields of a member the briefing prints. */
export interface BriefingMember {
  name: string
  description: string
}

export interface GroupBriefingInput {
  /** Already resolved to a concrete language; `'system'` is not accepted here. */
  language: Language
  /** The agent this briefing is written for. */
  self: BriefingMember
  /** Everyone in the chat, `self` included, in speaking order. */
  members: BriefingMember[]
  /**
   * True when this turn has the memory tools attached (S3.3).
   *
   * It adds **one sentence** to the rules, in both languages: remember durable
   * facts with `memory_save`. It belongs in the briefing rather than in the
   * `Memory` section of the prompt because it is a rule of how to behave in the
   * group, and because the rules are the part of the prompt a model actually
   * follows — a habit stated once among the other habits is followed far more
   * often than one appended after a data dump.
   */
  memoryEnabled?: boolean
  /**
   * What this chat is working towards (S5.10), or nothing.
   *
   * It goes in the **briefing** rather than in a section of its own because it
   * is the same class of thing as the roster and the protocol: a rule of the
   * room, which every member is held to, not reference material one of them may
   * reach for. A model that runs out of attention has to lose the skills index
   * before it loses what it is here to do.
   *
   * A `codebase` goal also carries a rule the group cannot see from the goal
   * itself — that the executor makes the change afterwards — because PLAN.md's
   * one-writer decision is invisible to a participant otherwise, and a model
   * told to change a codebase will otherwise write the change out in prose as
   * if it had.
   */
  goal?: ChatGoal | null
  /**
   * True for the members of a hand-off's **review** round (S5.12).
   *
   * The round exists since S5.6 and until now said nothing about itself: every
   * reviewer was handed the executor's message plus its diffs and left to guess
   * what it was being asked. What it is being asked is the thing the goal
   * answers — *does this change do what this chat is for* — so the two travel
   * together, and the review block is written immediately after the goal in both
   * languages so "the goal above" is one line up rather than a page away.
   *
   * The executor never gets it: it is not reviewing, it wrote the thing, and its
   * own section already tells it what to do (`buildExecutorSection`). The runner
   * sets this for the review round's speakers only, which is everybody else.
   */
  reviewing?: boolean
  /**
   * True for the single **closing** turn that ends a discussion the group agreed
   * on (S5.14).
   *
   * It replaces the closure-marker rule with the opposite instruction: this turn
   * is not part of the discussion, it is the answer handed back to the user, so
   * it states the conclusion in a few lines, adds no new argument and writes no
   * marker at all. The runner gives it to one member — the first in speaking
   * order — immediately after the `consensus` notice.
   *
   * Since S5.18 the block also carries the **goal**, because what a conclusion
   * has to *be* depends on it: in a `document` chat the conclusion is the
   * deliverable's content, which the executor writes to the configured file
   * straight afterwards, so the speaker must write that content in full and must
   * not address the executor or name a file of its own. See `closingSection` in
   * either language module for the failure that rule was written against.
   *
   * Never set together with `reviewing`: a review round is a hand-off's, and a
   * hand-off's rounds are not what the consensus rule looks at.
   */
  closing?: boolean
}

/** What a language module is given: the briefing input minus the language. */
export interface BriefingInput {
  self: BriefingMember
  members: BriefingMember[]
  memoryEnabled: boolean
  goal: ChatGoal | null
  reviewing: boolean
  closing: boolean
}

/** The shape both language modules implement. */
export type BriefingBuilder = (input: BriefingInput) => string

/**
 * The three protocol markers, identical in both languages and re-exported here
 * so the two briefing modules keep importing them from the file that teaches
 * them.
 *
 * They are **defined** in `@shared/markers` because the renderer needs the same
 * literals: a trailing marker is stripped from a reply that has real content in
 * front of it (S4.3 for `[PASS]`, S5.14 for the other two), and that rule has to
 * read identically on both sides of the IPC boundary. See that module's header
 * for why a marker is stripped at display time rather than at persist time.
 */
export { AGREED_TOKEN, CONTINUE_TOKEN, PASS_TOKEN } from '@shared/markers'

/** Reduces an `Agent` record to what the briefing needs. */
export function toBriefingMember(agent: Agent): BriefingMember {
  return { name: agent.name, description: agent.description }
}

/**
 * Builds the briefing in the requested language.
 *
 * `self` is matched against `members` **by name**, because that is the identity
 * the model sees: the prompt never mentions a UUID, and two members cannot share
 * a display name without the `[name]:` protocol becoming ambiguous anyway.
 */
export function buildGroupBriefing(input: GroupBriefingInput): string {
  const { language, self, members } = input
  const roster = members.length > 0 ? members : [self]
  const build: BriefingBuilder = language === 'zh-CN' ? buildChineseBriefing : buildEnglishBriefing
  return build({
    self,
    members: roster,
    memoryEnabled: input.memoryEnabled === true,
    goal: input.goal ?? null,
    reviewing: input.reviewing === true,
    closing: input.closing === true
  })
}

/**
 * `AppSettings.language` → a concrete language for the briefing.
 *
 * The backend has no `navigator`, so `'system'` is resolved from the Node/ICU
 * locale (`Intl.DateTimeFormat().resolvedOptions().locale`) rather than from the
 * renderer's answer — the briefing is assembled before any window is involved,
 * and a renderer round trip inside a turn would be a needless dependency.
 * Anything that is not a Chinese locale resolves to English, which matches the
 * renderer's own rule in `src/renderer/src/i18n/index.ts`.
 */
export function resolveMainLanguage(setting: Language | 'system'): Language {
  if (setting === 'zh-CN' || setting === 'en') return setting
  return systemLanguage()
}

/** The host's locale, defaulting to English when ICU cannot answer. */
function systemLanguage(): Language {
  try {
    const locale = new Intl.DateTimeFormat().resolvedOptions().locale
    return /^zh\b/i.test(locale) ? 'zh-CN' : 'en'
  } catch {
    return 'en'
  }
}
