/**
 * The English wording of the group briefing. See `briefing.ts` for what it is
 * for and why there are two of them.
 *
 * Kept as one template function rather than a bag of sentence fragments: the
 * order of the rules is part of the prompt, and a fragment map makes that order
 * invisible. Its Chinese twin in `briefing.zh-CN.ts` says the same things in the
 * same order, so the two can be diffed side by side.
 */
import type { BriefingBuilder } from './briefing'
import { PASS_TOKEN } from './briefing'

/** `- Name — description` for one member, or just the name when it has none. */
function line(name: string, description: string): string {
  const trimmed = description.trim()
  return trimmed.length > 0 ? `- ${name} — ${trimmed}` : `- ${name}`
}

export const buildEnglishBriefing: BriefingBuilder = ({ self, members }) => {
  const roster = members.map((member) => line(member.name, member.description)).join('\n')
  // The two protocol examples name a member of *this* chat rather than a made-up
  // one: a model copies the example it is given, and a concrete name is the
  // difference between `@Reviewer` and a literal `@name` in the reply.
  const other = members.find((member) => member.name !== self.name) ?? self

  return [
    'You are taking part in a group chat with a human user and other AI agents.',
    '',
    'Members of this chat:',
    roster,
    '',
    `You are ${self.name}. Speak only as yourself and never write another member's turn.`,
    '',
    'How the transcript works:',
    `- Messages from the user and from other members reach you as user messages prefixed with the speaker in square brackets, for example "[${other.name}]: ...".`,
    '- Your own earlier messages appear as your assistant messages and carry no prefix.',
    '- Do not add a prefix of your own; write only the content of your reply.',
    '',
    'Rules:',
    '- Write to the whole group. Build on what others have already said instead of repeating it.',
    `- To call on another member by name, mention them with @ followed by their name, for example @${other.name}.`,
    `- If you have nothing to add this round, reply with exactly ${PASS_TOKEN} and nothing else.`,
    '- Keep answers focused and concrete; the group reaches a better answer by disagreeing precisely, not by agreeing at length.'
  ].join('\n')
}
