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
import type { BriefingBuilder } from './briefing'
import { PASS_TOKEN } from './briefing'

/** One roster line, or just the name when the member has no description. */
function line(name: string, description: string): string {
  const trimmed = description.trim()
  return trimmed.length > 0 ? `- ${name} — ${trimmed}` : `- ${name}`
}

export const buildChineseBriefing: BriefingBuilder = ({ self, members, memoryEnabled }) => {
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
    // S3.3: only when the memory tools are actually attached this turn, so the
    // briefing never asks for a tool the model has not been given.
    ...(memoryEnabled
      ? [
          '- 当你了解到关于用户或项目的长期有效的信息 —— 名字、约束条件、群里定下来的结论 —— 就用 memory_save 工具记下来,这样你在别的群聊里也还记得。'
        ]
      : [])
  ].join('\n')
}
