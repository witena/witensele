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
import { AGREED_TOKEN, CONTINUE_TOKEN, PASS_TOKEN } from './briefing'

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

/**
 * The `This round is a review` block (S5.12), or nothing.
 *
 * It comes **after** the goal, and that placement is the whole design: the
 * reviewer's question is "does what the executor just did satisfy the goal", and
 * a briefing that asked it a page above the goal would be two facts the model has
 * to put together itself. With a goal it says so; without one — a hand-off in a
 * chat that never set a goal is perfectly legal — it falls back to the
 * conclusion the transcript holds, because "judge it against the goal above"
 * would then point at nothing.
 */
function reviewSection(goal: ChatGoal | null): string[] {
  return [
    '',
    'This round is a review:',
    '- The executor of this chat has just changed files in the working directory. Its message above says what it changed, and the diff of each file is part of that message.',
    goal
      ? '- Read what it changed and judge it against the goal of this chat, not against what you would have written yourself: say whether it does what the goal asks, and name the file where it does not.'
      : '- Read what it changed and judge it against the conclusion the group reached above, not against what you would have written yourself: say whether it does what was agreed, and name the file where it does not.',
    '- If something is missing or wrong, say so precisely and mention the executor with @ so it can fix it. If it is right, say so in one sentence instead of restating it.'
  ]
}

/**
 * The `This is the closing turn` block (S5.14, S5.18), or nothing.
 *
 * It is the one block that **replaces** the discussion rules rather than adding
 * to them, so it is written last and says so in its first line: the group has
 * already agreed, this turn is the answer handed back to the human, and the
 * habits the rules above teach — disagree precisely, mention the next speaker,
 * end with a marker — are all wrong for it. Saying "no marker" explicitly is not
 * redundant: a model that has just written `[AGREED]` twice will write it a
 * third time unless it is told not to.
 *
 * S5.18 added the **goal's half**, and it exists because of a failure a user hit:
 * a closing turn in a `document` chat wrote a summary and ended with "please
 * have the executor write the text above to conclusion.md" — a file name the
 * model invented, ignoring the deliverable the chat was configured with. The
 * goal *is* in the prompt (`goalSection` above), but a closing turn told only
 * "state the conclusion" treats the deliverable as somebody else's business. So
 * this block names the file, says who writes it and when, and forbids each of
 * the three things that closing turn did: address the executor, invent a file
 * name, ask anybody to save anything. For a `codebase` goal the same sentence
 * without a file: the executor implements this afterwards, so it has to be
 * written to be built from. A `discussion` goal — and a chat with no goal at all
 * — gets neither, and a test asserts the word `executor` never reaches it: there
 * is nobody to hand it to, and naming one would invent a step.
 */
function closingSection(goal: ChatGoal | null): string[] {
  const lines = [
    '',
    'This is the closing turn:',
    '- The group has agreed and the discussion is over. You are writing the answer the human reads, not another turn of the debate.',
    '- State the conclusion the group reached, in a few lines. Say what was decided and the reasons that survived; if something was left open, say what it is.'
  ]
  if (goal?.kind === 'document' && goal.deliverable) {
    lines.push(
      `- This chat produces the file ${goal.deliverable}, and the executor of this chat writes that file from this message as soon as you have finished. So write the **content** of the deliverable here, in full, as it should read in the file — not a summary of it and not a plan for writing it.`,
      `- Do not address the executor, do not ask anyone to save or write anything, and never name a file of your own: the only file this chat produces is ${goal.deliverable}, and it is written for you.`
    )
  } else if (goal?.kind === 'codebase') {
    lines.push(
      '- The executor of this chat makes the change afterwards, from this message. So say what should change and why, precisely enough to be built from, and do not address the executor or ask anyone to do anything.'
    )
  }
  lines.push(
    '- Do not introduce a new argument, do not mention another member with @, and do not end with a marker of any kind.'
  )
  return lines
}

export const buildEnglishBriefing: BriefingBuilder = ({
  self,
  members,
  memoryEnabled,
  goal,
  reviewing,
  closing
}) => {
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
    // S5.14: the rule that lets a discussion end by itself. It is stated as the
    // last thing a reply does, in both languages, because that is where the
    // runner reads it from — a marker in the middle of a paragraph is prose.
    ...(closing
      ? []
      : [
          `- End every reply with one marker on its own last line and write nothing after it: ${AGREED_TOKEN} if you have nothing more to add and accept the position the group has reached, or ${CONTINUE_TOKEN} if the discussion is not finished. Once everyone writes ${AGREED_TOKEN} the discussion stops and the group's conclusion goes to the user.`
        ]),
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
    ...(goal ? goalSection(goal) : []),
    // S5.12, and after the goal for the reason `reviewSection` gives: it is the
    // only block here that is about *this round* rather than about the chat, so
    // it is the last thing the model reads before the transcript.
    ...(reviewing ? reviewSection(goal) : []),
    // S5.14, last of all: it is the only block that contradicts the rules above,
    // and the instruction a model follows is the one it read most recently. It
    // takes the goal too (S5.18): the conclusion of a `document` chat *is* the
    // deliverable's content, and saying so is the last thing the model reads.
    ...(closing ? closingSection(goal) : [])
  ].join('\n')
}
