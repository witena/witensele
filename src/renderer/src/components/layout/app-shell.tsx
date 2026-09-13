/**
 * The frame every page lives in: the navigation rail on the left, the current
 * page filling the rest.
 *
 * The page is chosen from the store rather than by a router — see `stores/ui.ts`
 * for why there is no router. Mounting one page at a time is intentional: a
 * hidden Chats page would keep its subscriptions alive and keep streaming into a
 * view nobody is looking at, once S1.7 gives it any.
 *
 * The lookup is a `Record` rather than a `switch` returning JSX, because a switch
 * whose arms are adjacent elements reads to the `used-keys` guard as a hard-coded
 * text node between two tags. Its header calls that heuristic out; this is the
 * cheaper side of the trade.
 */
import { ChatsPage } from '../../pages/chats-page'
import { AgentsPage } from '../../pages/agents-page'
import { SettingsPage } from '../../pages/settings-page'
import { useUiStore, type Page } from '../../stores/ui'
import { NavRail } from './nav-rail'

const PAGE_COMPONENTS: Record<Page, () => React.JSX.Element> = {
  chats: ChatsPage,
  agents: AgentsPage,
  settings: SettingsPage
}

export function AppShell(): React.JSX.Element {
  const page = useUiStore((state) => state.page)
  const CurrentPage = PAGE_COMPONENTS[page]

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-base font-sans text-fg">
      <NavRail />
      <CurrentPage />
    </div>
  )
}
