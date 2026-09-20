/**
 * The 56px navigation rail: the app mark, Chats, Committees, Agents, and
 * Settings pinned to the bottom.
 *
 * Two things are deliberate:
 *
 * - **The labels are literal `t()` calls**, resolved by a `switch`, not
 *   `t(LABEL_KEYS[page])`. A key assembled at runtime is invisible to the
 *   `used-keys` guard (it says so in its own header), and the rail is exactly the
 *   place where a typo would be noticed last.
 * - **The rail is the window's drag handle.** It is the only surface tall enough
 *   to grab with the system title bar hidden, so it carries `DRAG_REGION` and
 *   every button inside it carries `NO_DRAG`.
 */
import clsx from 'clsx'
import type { TFunction } from 'i18next'
import { MessagesSquare, Settings, Users, UsersRound, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { BrandMark } from '../ui/brand-mark'
import { useUiStore, type Page } from '../../stores/ui'
import { DRAG_REGION, NO_DRAG, TRAFFIC_LIGHT_INSET } from './window-chrome'

const ICONS: Record<Page, LucideIcon> = {
  chats: MessagesSquare,
  committees: UsersRound,
  agents: Users,
  settings: Settings
}

/** Literal keys, so `used-keys.test.ts` can verify every one resolves. */
function navLabel(t: TFunction, page: Page): string {
  switch (page) {
    case 'chats':
      return t('nav.chats')
    case 'committees':
      return t('nav.committees')
    case 'agents':
      return t('nav.agents')
    case 'settings':
      return t('nav.settings')
  }
}

interface NavButtonProps {
  page: Page
  active: boolean
  onSelect: (page: Page) => void
  label: string
}

function NavButton({ page, active, onSelect, label }: NavButtonProps): React.JSX.Element {
  const Icon = ICONS[page]
  return (
    <button
      type="button"
      data-testid={`nav-${page}`}
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(page)}
      className={clsx(
        'flex h-10 w-10 items-center justify-center rounded-[10px] transition-colors',
        'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
        active ? 'bg-bg-hover text-fg' : 'text-fg-dim hover:bg-bg-subtle hover:text-fg-secondary',
        NO_DRAG
      )}
    >
      <Icon aria-hidden="true" strokeWidth={1.8} className="h-5 w-5" />
    </button>
  )
}

export function NavRail(): React.JSX.Element {
  const { t } = useTranslation()
  const page = useUiStore((state) => state.page)
  const setPage = useUiStore((state) => state.setPage)

  return (
    <nav
      aria-label={t('nav.primary')}
      className={clsx(
        'flex w-14 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-bg-rail pb-3.5 select-none',
        TRAFFIC_LIGHT_INSET,
        DRAG_REGION
      )}
    >
      {/*
        The brand mark, not a letter (S7.1). It carries no tile of its own: the
        blades are `currentColor` and `text-fg` is the rail's own foreground, so
        the mark is ink on the light palette and near-white on the dark one with
        no branch and no second asset. `h-7 w-7` is 28 whole pixels square, which
        is what keeps the blades off half-pixels at 1x.
      */}
      <BrandMark className="mt-0.5 mb-3.5 h-7 w-7 text-fg" />

      <NavButton
        page="chats"
        active={page === 'chats'}
        onSelect={setPage}
        label={navLabel(t, 'chats')}
      />
      <NavButton
        page="committees"
        active={page === 'committees'}
        onSelect={setPage}
        label={navLabel(t, 'committees')}
      />
      <NavButton
        page="agents"
        active={page === 'agents'}
        onSelect={setPage}
        label={navLabel(t, 'agents')}
      />

      <div className="flex-1" />

      <NavButton
        page="settings"
        active={page === 'settings'}
        onSelect={setPage}
        label={navLabel(t, 'settings')}
      />
    </nav>
  )
}
