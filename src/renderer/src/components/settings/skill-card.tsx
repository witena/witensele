/**
 * One skill in the settings list: name, description, version, tags, how many
 * files it bundles and which folder it came from.
 *
 * A single selection `<button>`, like `ProviderCard` and unlike `McpCard`: a
 * skill has no switch to flip, so nothing inside the card is a second control
 * and the whole card can be the click target.
 *
 * The description is shown in full rather than truncated to one line. It is the
 * only thing a model ever sees of a skill (progressive disclosure), so the user
 * choosing whether to keep it has to read exactly what the agent will read.
 *
 * Every label arrives already translated, like every other primitive here.
 */
import clsx from 'clsx'
import type { SkillMeta } from '@shared/types'
import { Badge } from '../ui'

export interface SkillCardProps {
  skill: SkillMeta
  selected: boolean
  /** Already translated `n files`, or absent when the skill bundles none. */
  filesLabel?: string | undefined
  onSelect: () => void
}

export function SkillCard({
  skill,
  selected,
  filesLabel,
  onSelect
}: SkillCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="skill-card"
      data-skill={skill.name}
      data-folder={skill.folder}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={clsx(
        'flex w-full flex-col gap-2 rounded-[10px] border bg-bg-elevated px-4 py-3.5 text-left transition-colors',
        'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
        selected ? 'border-accent' : 'border-border-strong hover:border-fg-faint'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span data-testid="skill-card-name" className="truncate text-sm font-semibold text-fg">
          {skill.name}
        </span>
        {skill.version ? <Badge data-testid="skill-card-version">{skill.version}</Badge> : null}
        {(skill.tags ?? []).map((tag) => (
          <Badge key={tag} data-testid="skill-card-tag" tone="accent" font="sans">
            {tag}
          </Badge>
        ))}
      </div>

      <p
        data-testid="skill-card-description"
        className="line-clamp-3 text-xs leading-relaxed text-fg-muted"
      >
        {skill.description}
      </p>

      <div className="flex min-w-0 items-center gap-2">
        <span
          data-testid="skill-card-folder"
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-faint"
        >
          {skill.folder}
        </span>
        {filesLabel ? (
          <span data-testid="skill-card-files" className="shrink-0 text-[11px] text-fg-dim">
            {filesLabel}
          </span>
        ) : null}
      </div>
    </button>
  )
}
