/**
 * Every reason code has a line, in both languages.
 *
 * The backend sends a code and the card shows a sentence, so a reason with no
 * key would draw either the raw code or nothing at all in the one place the user
 * is being asked to approve something unusual. i18next's own fallback would hide
 * that: `t('chat.commandRisk.unknown')` returns the key, which *looks* like a
 * rendered string. So this reads the locale files directly.
 */
import { describe, expect, it } from 'vitest'
import { COMMAND_RISK_REASONS, type CommandRiskReason } from '@shared/types'
import en from '../../locales/en.json'
import zh from '../../locales/zh-CN.json'
import { commandRiskLabel } from './command-risk'

/** The key `commandRiskLabel` uses for one code, in the shape the files store. */
function camel(reason: CommandRiskReason): string {
  return reason.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

describe('commandRiskLabel', () => {
  it('translates through the key the locale files define', () => {
    const t = ((key: string) => `<${key}>`) as never
    expect(commandRiskLabel(t, 'git-push')).toBe('<chat.commandRisk.gitPush>')
    expect(commandRiskLabel(t, 'privilege-escalation')).toBe(
      '<chat.commandRisk.privilegeEscalation>'
    )
  })

  it.each(COMMAND_RISK_REASONS)('has a non-empty line for %s in both locales', (reason) => {
    const key = camel(reason)
    const english = (en.chat.commandRisk as Record<string, string>)[key]
    const chinese = (zh.chat.commandRisk as Record<string, string>)[key]
    expect(english, `en.json is missing chat.commandRisk.${key}`).toBeTruthy()
    expect(chinese, `zh-CN.json is missing chat.commandRisk.${key}`).toBeTruthy()
  })

  it('defines no line for a code the policy cannot produce', () => {
    const defined = Object.keys(en.chat.commandRisk).sort()
    expect(defined).toEqual([...COMMAND_RISK_REASONS].map(camel).sort())
  })
})
