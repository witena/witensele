/**
 * The chat goal as a chip in the header, beside the folder chip (S5.10).
 *
 * It answers one question at a glance — what is this chat for — and, for a
 * `document` goal, a second one the user would otherwise have to go to Finder
 * for: has the file been written yet. Once it has, the chip says so and becomes
 * a button that opens it, through the same `openInEditor` path S5.7 gave the
 * file-reference chips.
 *
 * Only a **delivered** document is a button. Opening a file that is not there
 * yet is a click that can only fail — and, depending on the editor, either
 * silently opens an empty buffer or refuses — so the other three states are
 * plain chips, exactly as `FileRefChip` renders a reference it cannot resolve.
 *
 * The chip's own words are `t()` keys; the file name and the path in the
 * tooltip are **data** and are printed as they are stored. Which state to draw
 * is `goalChipState` in `./goal.ts`, which is pure and tested.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatGoal, ChatGoalStatus } from '@shared/types'
import { Badge } from '../ui'
import { openInEditor } from '../../lib/editor'
import { goalChipState } from './goal'

/** How long the chip stays red after a refused open; the same beat as a file chip. */
export const GOAL_CHIP_FAILED_MS = 2_500

export interface GoalChipProps {
  chatId: string
  goal: ChatGoal | null
  status?: ChatGoalStatus | undefined
}

export function GoalChip({ chatId, goal, status }: GoalChipProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const chip = goalChipState(goal, status)
  if (chip === null) return null

  // Literal `t()` calls per branch rather than a key built from `chip.kind`, so
  // `used-keys.test.ts` can see every key this component can render.
  const kindLabel =
    chip.kind === 'document'
      ? t('chat.goalKindDocument')
      : chip.kind === 'codebase'
        ? t('chat.goalKindCodebase')
        : t('chat.goalKindDiscussion')

  const label = chip.fileName
    ? chip.delivered
      ? `${chip.fileName} · ${t('chat.goalDelivered')}`
      : chip.fileName
    : kindLabel

  const title = chip.delivered
    ? t('chat.goalChipTitleDelivered', { path: chip.path })
    : chip.kind === 'document'
      ? t('chat.goalChipTitleDocument', { path: chip.path })
      : chip.kind === 'codebase'
        ? t('chat.goalChipTitleCodebase')
        : t('chat.goalChipTitleDiscussion')

  const badge = (
    <Badge
      tone={chip.delivered ? 'accent' : 'default'}
      font="sans"
      data-testid="chat-goal-chip"
      {...(chip.openPath ? {} : { title })}
      className={failed ? 'text-danger' : undefined}
    >
      {label}
    </Badge>
  )

  if (chip.openPath === null) {
    // `data-*` on the wrapper in both branches, so the end-to-end spec reads the
    // same two attributes whether or not the chip happens to be clickable.
    return (
      <span data-kind={chip.kind} data-delivered="false" className="inline-flex">
        {badge}
      </span>
    )
  }

  const open = (): void => {
    setFailed(false)
    void openInEditor({ path: chip.openPath as string, chatId }).catch(() => {
      setFailed(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setFailed(false), GOAL_CHIP_FAILED_MS)
    })
  }

  return (
    <button
      type="button"
      data-kind={chip.kind}
      data-delivered="true"
      data-path={chip.path}
      title={failed ? t('chat.fileRefFailed') : title}
      onClick={open}
      className="inline-flex rounded focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
    >
      {badge}
    </button>
  )
}
