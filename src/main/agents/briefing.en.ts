/**
 * The English wording of the group briefing. See `briefing.ts` for what it is
 * for and why there are two of them.
 *
 * Kept as one template function rather than a bag of sentence fragments: the
 * order of the rules is part of the prompt, and a fragment map makes that order
 * invisible. Its Chinese twin in `briefing.zh-CN.ts` says the same things in the
 * same order, so the two can be diffed side by side.
 */
import type { ChatGoal } from '@shared/types'
import type { BriefingBuilder } from './briefing'
import { PASS_TOKEN } from './briefing'

/** `- Name — description` for one member, or just the name when it has none. */
function line(name: string, description: string): string {
  const trimmed = description.trim()
  return trimmed.length > 0 ? `- ${name} — ${trimmed}` : `- ${name}`
}

/**
 * The `Goal of this chat` section (S5.10), or nothing when the chat has none.
 *
 * One sentence for the kind, then the user's description **verbatim** — it is
 * the one part of the whole prompt they wrote themselves, and paraphrasing it
 * would be the app rewriting the brief. The kind's sentence is what turns three
 * words into an instruction: `document` names the file, and `codebase` says who
 * is allowed to make the change, which is PLAN.md's one-writer rule and is
 * otherwise invisible to a participant.
 */
function goalSection(goal: ChatGoal): string[] {
  const lines = ['', 'Goal of this chat:']
  if (goal.kind === 'document') {
    lines.push('- The group is producing one document, and the discussion is how it gets written.')
  } else if (goal.kind === 'codebase') {
    lines.push('- The group is changing the code in the working directory of this chat.')
  } else {
    lines.push('- The group is discussing this until it reaches a conclusion; nothing is written anywhere.')
  }
  lines.push(`- What the user asked for: ${goal.description.trim()}`)
  if (goal.kind === 'document' && goal.deliverable) {
    lines.push(
      `- The deliverable is the file ${goal.deliverable}, relative to the working directory. Judge every answer by whether it makes that file better.`
    )
  }
  if (goal.kind === 'codebase') {
    lines.push(
      '- You do not change any file yourself. The executor of this chat makes the change after the discussion, from the conclusion you reach, so say what should change and why rather than pretending to have changed it.'
    )
  }
  return lines
}

export const buildEnglishBriefing: BriefingBuilder = ({ self, members, memoryEnabled, goal }) => {
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
    '- Keep answers focused and concrete; the group reaches a better answer by disagreeing precisely, not by agreeing at length.',
    // S3.3: only when the memory tools are actually attached this turn, so the
    // briefing never asks for a tool the model has not been given.
    ...(memoryEnabled
      ? [
          '- When you learn something durable about the user or the project — a name, a constraint, a decision the group settled — save it with the memory_save tool so you still know it in other chats.'
        ]
      : []),
    // Last, and deliberately so: the rules say how to behave, and this says what
    // for. The thing a model should still be following at the end of a long
    // prompt is the one it was given a chat for.
    ...(goal ? goalSection(goal) : [])
  ].join('\n')
}
