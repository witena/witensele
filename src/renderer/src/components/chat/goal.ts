/**
 * What the chat header's goal chip shows (S5.10).
 *
 * Pure, and separate from the JSX for the reason every other `*.ts` beside a
 * component in this folder is: the chip has four states and only one of them is
 * a button, which is exactly the kind of thing that is wrong for a release
 * before anyone notices. Here it is a function with a return value a test can
 * read.
 *
 * The chip does **not** choose its own words. It reports the kind, whether the
 * deliverable is on disk and what to open, and the component turns that into
 * `t()` copy — the same division `handoff.ts` and `tool-call.ts` follow, and
 * what keeps CLAUDE.md rule #4 true of a module that has no `t` to call.
 */
import type { ChatGoal, ChatGoalStatus, GoalKind } from '@shared/types'
import { folderName } from '../../lib/workdir'

export interface GoalChipState {
  kind: GoalKind
  /**
   * The deliverable's **file name** for a `document` goal, or `null`.
   *
   * The name rather than the path, for the reason the folder chip beside it
   * shows the folder's name: `docs/reports/q3.md` does not fit next to a title,
   * and its last segment is the half that identifies it. The whole relative path
   * is in the tooltip.
   */
  fileName: string | null
  /** The deliverable's relative path, for the tooltip. `null` without one. */
  path: string | null
  /** True when the deliverable exists on disk right now. */
  delivered: boolean
  /**
   * The absolute path to open on click, or `null` when the chip is not a button.
   *
   * Only a **delivered** document is openable: opening a file that is not there
   * yet would be a click that can only fail, and the editor would either create
   * an empty buffer or refuse, depending on which editor it is.
   */
  openPath: string | null
}

/**
 * The chip for one chat, or `null` when there is nothing to draw.
 *
 * `status` is `chats.goalStatus`'s answer and may be missing — it is loaded
 * asynchronously after the chat is selected — in which case the goal still draws
 * its kind and its file name, just never "delivered". A chip that flickered
 * between two states while a query resolved would be worse than one that starts
 * in the state it is in far more often.
 */
export function goalChipState(
  goal: ChatGoal | null | undefined,
  status?: ChatGoalStatus | undefined
): GoalChipState | null {
  if (!goal) return null

  const path = goal.kind === 'document' ? (goal.deliverable ?? null) : null
  const delivered = path !== null && status?.delivered === true

  return {
    kind: goal.kind,
    fileName: path === null ? null : folderName(path),
    path,
    delivered,
    openPath: delivered ? (status?.deliverable ?? null) : null
  }
}
