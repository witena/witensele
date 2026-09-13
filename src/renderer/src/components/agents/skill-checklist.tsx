/**
 * The agent form's "Skills" block: one checkbox per skill in the library, plus a
 * row for every name the agent lists that no longer resolves to a folder.
 *
 * Those extra rows are the point of the component. Skills are bound **by name**,
 * not by id, so a folder the user renamed or moved leaves the agent pointing at
 * nothing. Dropping the name silently would unconfigure the agent behind the
 * user's back; showing it with a "missing" tag says what happened and leaves the
 * binding intact, so re-importing the folder restores the agent (the backend
 * skips an unresolved name when it assembles the prompt — see `enabledSkills` in
 * `src/main/agents/agent-turn.ts`).
 *
 * A native `<input type="checkbox">` inside a `<label>`, exactly like
 * `McpChecklist`: a genuine multi-select, and the native control brings the
 * role, the keyboard behaviour and the label association for free.
 */
import clsx from 'clsx'
import type { SkillMeta } from '@shared/types'
import { Badge } from '../ui'

export interface SkillChecklistProps {
  skills: readonly SkillMeta[]
  /** Currently selected skill names. */
  value: readonly string[]
  /** Selected names with no folder behind them any more. */
  missing: readonly string[]
  /** Already translated tag for a name that no longer resolves. */
  missingLabel: string
  /** Already translated `n files`, given the count. */
  filesLabel: (count: number) => string
  onToggle: (name: string, checked: boolean) => void
}

export function SkillChecklist({
  skills,
  value,
  missing,
  missingLabel,
  filesLabel,
  onToggle
}: SkillChecklistProps): React.JSX.Element {
  /** A selected name matches a skill by its own name or by its folder. */
  const isChecked = (skill: SkillMeta): boolean =>
    value.some((name) => {
      const wanted = name.trim().toLowerCase()
      return wanted === skill.name.toLowerCase() || wanted === skill.folder.toLowerCase()
    })

  return (
    <ul data-testid="agent-skill-list" className="flex flex-col divide-y divide-border">
      {skills.map((skill) => (
        <li key={skill.folder}>
          <label
            data-testid="agent-skill-item"
            data-skill={skill.name}
            data-missing="false"
            className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 hover:bg-bg-hover/50"
          >
            <input
              type="checkbox"
              data-testid="agent-skill-checkbox"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
              checked={isChecked(skill)}
              onChange={(event) => onToggle(skill.name, event.target.checked)}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  data-testid="agent-skill-name"
                  className="truncate text-[13px] text-fg-secondary"
                >
                  {skill.name}
                </span>
                {skill.version ? <Badge>{skill.version}</Badge> : null}
                {skill.fileCount > 0 ? (
                  <span
                    data-testid="agent-skill-files"
                    className="ml-auto shrink-0 text-[11px] text-fg-faint"
                  >
                    {filesLabel(skill.fileCount)}
                  </span>
                ) : null}
              </span>
              {/* The description is what the model is shown, so the user reads it too. */}
              <span className="line-clamp-2 text-[11px] leading-relaxed text-fg-faint">
                {skill.description}
              </span>
            </span>
          </label>
        </li>
      ))}

      {missing.map((name) => (
        <li key={`missing:${name}`}>
          <label
            data-testid="agent-skill-item"
            data-skill={name}
            data-missing="true"
            className={clsx('flex items-start gap-2.5 px-3 py-2.5 opacity-55')}
          >
            <input
              type="checkbox"
              data-testid="agent-skill-checkbox"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
              checked
              onChange={() => onToggle(name, false)}
            />
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span data-testid="agent-skill-name" className="truncate text-[13px] text-fg-secondary">
                {name}
              </span>
              <Badge data-testid="agent-skill-missing" tone="accent" font="sans">
                {missingLabel}
              </Badge>
            </span>
          </label>
        </li>
      ))}
    </ul>
  )
}
