/**
 * Turning a command policy verdict into the line the permission card shows.
 *
 * The backend classifies a `run_command` line in
 * `src/main/executor/command-policy.ts` and sends a **code** —
 * `'git-push'`, `'recursive-delete'` — with the `permission.requested` event. It
 * cannot send a sentence: it does not know the UI language, and a sentence
 * chosen in the main process would be frozen in whatever language was active
 * (CLAUDE.md rule #4, the same contract `notices.*` follows).
 *
 * So the mapping lives here, as a `switch` of **literal** `t()` calls rather
 * than a key table. That is deliberate and it is what `used-keys.test.ts` can
 * see: a table would compute `chat.commandRisk.${reason}` and the guard would
 * have no way to tell that all sixteen keys exist.
 */
import type { TFunction } from 'i18next'
import type { CommandRiskReason } from '@shared/types'

/** The one sentence explaining why this command is being asked about again. */
export function commandRiskLabel(t: TFunction, reason: CommandRiskReason): string {
  switch (reason) {
    case 'privilege-escalation':
      return t('chat.commandRisk.privilegeEscalation')
    case 'disk-write':
      return t('chat.commandRisk.diskWrite')
    case 'shutdown':
      return t('chat.commandRisk.shutdown')
    case 'fork-bomb':
      return t('chat.commandRisk.forkBomb')
    case 'destructive-delete':
      return t('chat.commandRisk.destructiveDelete')
    case 'destructive-permissions':
      return t('chat.commandRisk.destructivePermissions')
    case 'recursive-delete':
      return t('chat.commandRisk.recursiveDelete')
    case 'git-push':
      return t('chat.commandRisk.gitPush')
    case 'git-reset-hard':
      return t('chat.commandRisk.gitResetHard')
    case 'git-clean':
      return t('chat.commandRisk.gitClean')
    case 'history-rewrite':
      return t('chat.commandRisk.historyRewrite')
    case 'package-publish':
      return t('chat.commandRisk.packagePublish')
    case 'download-to-shell':
      return t('chat.commandRisk.downloadToShell')
    case 'command-substitution':
      return t('chat.commandRisk.commandSubstitution')
    case 'outside-workdir':
      return t('chat.commandRisk.outsideWorkdir')
    case 'background-process':
      return t('chat.commandRisk.backgroundProcess')
  }
}
