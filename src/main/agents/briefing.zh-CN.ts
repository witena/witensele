/**
 * The Chinese wording of the group briefing. See `briefing.ts` for what it is
 * for and why there are two of them.
 *
 * **This is the only `.ts` file in the repository that may contain Chinese.**
 * CLAUDE.md rule #1 keeps committed source English and confines product Chinese
 * to `src/renderer/src/locales/zh-CN.json`; this file is the documented
 * exception, because its content is neither source prose nor UI copy — it is a
 * **prompt sent to a model**, and a Chinese-first model follows a Chinese prompt
 * far more reliably than an English one it has to translate first. It is not a
 * locale file for the same reason: nothing here ever reaches the renderer, so it
 * has no i18n key and no English counterpart in `en.json`.
 *
 * It says the same things in the same order as `briefing.en.ts`, so the two can
 * be diffed side by side when either changes.
 */
import type { ChatGoal } from '@shared/types'
import type { BriefingBuilder } from './briefing'
import { AGREED_TOKEN, CONTINUE_TOKEN, PASS_TOKEN } from './briefing'

/** One roster line, or just the name when the member has no description. */
function line(name: string, description: string): string {
  const trimmed = description.trim()
  return trimmed.length > 0 ? `- ${name} — ${trimmed}` : `- ${name}`
}

/** The goal section (S5.10); says the same things in the same order as `briefing.en.ts`. */
function goalSection(goal: ChatGoal): string[] {
  const lines = ['', '本群的目标:']
  if (goal.kind === 'document') {
    lines.push('- 这个群要产出一份文档,讨论是为了把它写出来。')
  } else if (goal.kind === 'codebase') {
    lines.push('- 这个群要修改本群工作目录里的代码。')
  } else {
    lines.push('- 这个群讨论到得出结论为止,不往任何地方写东西。')
  }
  lines.push(`- 用户的要求是:${goal.description.trim()}`)
  if (goal.kind === 'document' && goal.deliverable) {
    lines.push(
      `- 产出文件是工作目录下的 ${goal.deliverable}。判断每一条发言好不好,就看它有没有让这个文件变得更好。`
    )
  }
  if (goal.kind === 'codebase') {
    lines.push(
      '- 你自己不改任何文件。讨论结束后,由本群的 executor 按你们得出的结论去改,所以请说清楚应该改什么、为什么改,不要装作已经改过了。'
    )
  }
  return lines
}

/** The review block (S5.12); says the same things in the same order as `briefing.en.ts`. */
function reviewSection(goal: ChatGoal | null): string[] {
  return [
    '',
    '这一轮是复核:',
    '- 本群的 executor 刚刚改动了工作目录里的文件。它上面那条消息说了改了什么,每个文件的 diff 也在那条消息里。',
    goal
      ? '- 读它改了什么,并对照本群的目标来判断,而不是对照你自己会怎么写:说清楚它有没有做到目标要求的事,做不到的地方指出是哪个文件。'
      : '- 读它改了什么,并对照上面大家得出的结论来判断,而不是对照你自己会怎么写:说清楚它有没有做到说好的事,做不到的地方指出是哪个文件。',
    '- 如果有缺漏或者做错了,就具体说出来,并用 @ 点名 executor 让它去改。如果没问题,用一句话说没问题,不要把它做的事再复述一遍。'
  ]
}

/** The closing block (S5.14); says the same things in the same order as `briefing.en.ts`. */
function closingSection(): string[] {
  return [
    '',
    '这是收尾发言:',
    '- 大家已经达成一致,讨论到此结束。你现在写的是交给用户看的答案,不是又一轮辩论。',
    '- 用几行话说清楚大家得出的结论:定下来的是什么,站得住的理由是什么;如果还有没定的地方,说明是哪一点。',
    '- 不要提出新的论点,不要用 @ 点名其他成员,也不要在结尾写任何标记。'
  ]
}

export const buildChineseBriefing: BriefingBuilder = ({
  self,
  members,
  memoryEnabled,
  goal,
  reviewing,
  closing
}) => {
  const roster = members.map((member) => line(member.name, member.description)).join('\n')
  // The two protocol examples name a member of *this* chat; see `briefing.en.ts`.
  const other = members.find((member) => member.name !== self.name) ?? self

  return [
    '你正在参加一个群聊,群里有一位人类用户和其他 AI agent。',
    '',
    '本群成员:',
    roster,
    '',
    `你是 ${self.name}。只以自己的身份发言,不要替其他成员发言。`,
    '',
    '关于对话记录:',
    `- 用户和其他成员的发言会以 user 消息的形式送到你这里,并在方括号里标明发言者,例如「[${other.name}]: ……」。`,
    '- 你自己之前的发言以 assistant 消息出现,没有前缀。',
    '- 你回复时不要自己加前缀,直接写正文。',
    '',
    '规则:',
    '- 面向整个群发言。在别人已经说过的内容上继续推进,不要重复。',
    `- 想点名某位成员时,用 @ 加上他的名字,例如 @${other.name}。`,
    `- 如果这一轮你没有新的补充,就只回复 ${PASS_TOKEN},不要写别的内容。`,
    '- 回答要具体、聚焦。群体之所以能得出更好的答案,靠的是精确地提出分歧,而不是长篇附和。',
    // S5.14: the rule that lets a discussion end by itself; see `briefing.en.ts`.
    ...(closing
      ? []
      : [
          `- 每条回复的最后都要单独一行写一个标记,后面不要再写任何东西:如果你没有别的要补充了,并且认可大家目前达成的结论,就写 ${AGREED_TOKEN};如果讨论还没结束,就写 ${CONTINUE_TOKEN}。一旦所有人都写了 ${AGREED_TOKEN},讨论就会停止,并把大家的结论交给用户。`
        ]),
    // S3.3: only when the memory tools are actually attached this turn, so the
    // briefing never asks for a tool the model has not been given.
    ...(memoryEnabled
      ? [
          '- 当你了解到关于用户或项目的长期有效的信息 —— 名字、约束条件、群里定下来的结论 —— 就用 memory_save 工具记下来,这样你在别的群聊里也还记得。'
        ]
      : []),
    // S5.10: last, for the same reason as in `briefing.en.ts`.
    ...(goal ? goalSection(goal) : []),
    // S5.12: after the goal, for the same reason as in `briefing.en.ts`.
    ...(reviewing ? reviewSection(goal) : []),
    // S5.14: last of all, for the same reason as in `briefing.en.ts`.
    ...(closing ? closingSection() : [])
  ].join('\n')
}
