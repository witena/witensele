/**
 * The group briefing: the paragraph appended to every agent's own system prompt
 * that teaches it the rules of a multi-agent chat.
 *
 * Four things it has to say, straight from "One agent turn" in `docs/PLAN.md`:
 * who is in the room (name plus description), which of them *you* are, that the
 * other members' turns arrive as `[name]:` prefixed user messages rather than as
 * assistant turns, and the two protocol tokens — `@name` to call on someone and
 * `[PASS]` to abstain.
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
import type { Agent, Language } from '@shared/types'
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
}

/** The shape both language modules implement. */
export type BriefingBuilder = (input: Omit<GroupBriefingInput, 'language'>) => string

/** Token an agent replies with to abstain from a round. Identical in both languages. */
export const PASS_TOKEN = '[PASS]'

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
  return build({ self, members: roster })
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
