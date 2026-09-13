/**
 * The agent form's "Memory across chats" panel: the entry list, and an editor
 * for whichever file is open.
 *
 * Two levels, matching what is on disk. The list is `MEMORY.md`'s entries plus
 * the index itself as the first row, because the index is a file the user is
 * allowed to edit by hand — it is what goes into every system prompt, so being
 * able to prune it is the main way a user corrects an agent that remembered the
 * wrong thing. Clicking a row opens it in a textarea with Save and Delete.
 *
 * ## Why it loads on open rather than subscribing
 *
 * `memory_save` writes during a turn and emits no event (see
 * `src/main/memory/tools.ts`): nothing on screen depends on it, and a store plus
 * a subscription for a list nobody is looking at would be machinery for its own
 * sake. The panel therefore re-reads when it opens, which is the moment the user
 * asked to see it.
 *
 * ## Why the editor is a plain textarea
 *
 * The content is markdown the agent wrote for itself. Rendering it would hide
 * the frontmatter the note carries (`title`, `createdAt`) and the exact index
 * syntax the backend parses, which are precisely the parts a user editing by
 * hand must see.
 */
import { Brain, Trash2 } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemoryEntry } from '@shared/types'
import { Button, EmptyState, IconButton, TextArea } from '../ui'
import { translateError } from '../../i18n/errors'
import { isDirty, MEMORY_INDEX_PATH, useMemoryStore } from '../../stores/memory'

/** `2026-09-13`, in the viewer's locale-independent short form. */
function formatDate(createdAt: number): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return ''
  return new Date(createdAt).toISOString().slice(0, 10)
}

export interface MemoryPanelProps {
  /** The saved agent whose memory this is; absent while creating a new one. */
  agentId: string | undefined
}

export function MemoryPanel({ agentId }: MemoryPanelProps): React.JSX.Element {
  const { t } = useTranslation()

  const entries = useMemoryStore((state) => state.entries)
  const status = useMemoryStore((state) => state.status)
  const error = useMemoryStore((state) => state.error)
  const errorCode = useMemoryStore((state) => state.errorCode)
  const openPath = useMemoryStore((state) => state.openPath)
  const draft = useMemoryStore((state) => state.draft)
  const saved = useMemoryStore((state) => state.saved)
  const saving = useMemoryStore((state) => state.saving)

  useEffect(() => {
    const store = useMemoryStore.getState()
    if (agentId) void store.load(agentId)
    else store.reset()
  }, [agentId])

  // An agent that has not been saved yet has no id, so it has no memory folder
  // and nothing to show.
  if (!agentId) {
    return (
      <EmptyState
        size="sm"
        icon={Brain}
        title={t('agents.memoryUnsavedTitle')}
        description={t('agents.memoryUnsavedDescription')}
      />
    )
  }

  const store = (): ReturnType<typeof useMemoryStore.getState> => useMemoryStore.getState()
  const dirty = isDirty({ openPath, draft, saved })

  if (openPath !== null) {
    return (
      <div data-testid="memory-editor" data-path={openPath} className="flex h-full flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-mono text-[11px] text-fg-dim">{openPath}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button data-testid="memory-close" onClick={() => store().closeFile()}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              data-testid="memory-save"
              disabled={!dirty || saving}
              onClick={() => void store().save()}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>

        <div className="flex min-h-[140px] flex-1 rounded-md border border-border-strong bg-bg-elevated px-2.5 py-2">
          <TextArea
            data-testid="memory-content"
            aria-label={t('agents.memoryContent')}
            value={draft}
            onChange={(event) => store().setDraft(event.target.value)}
            className="h-full font-mono"
          />
        </div>

        {error ? (
          <p data-testid="memory-error" className="text-[11px] text-danger">
            {translateError(t, { code: errorCode ?? 'internal', message: error })}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <ul data-testid="memory-list" className="flex flex-col divide-y divide-border">
        {/* The index first: it is what every prompt carries. */}
        <li>
          <button
            type="button"
            data-testid="memory-index"
            onClick={() => void store().open(MEMORY_INDEX_PATH)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover/50 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">
              {MEMORY_INDEX_PATH}
            </span>
            <span className="shrink-0 text-[11px] text-fg-faint">
              {t('agents.memoryEntryCount', { entries: entries.length })}
            </span>
          </button>
        </li>

        {entries.map((entry: MemoryEntry) => (
          <li key={entry.path} className="flex items-center gap-1 pr-2">
            <button
              type="button"
              data-testid="memory-entry"
              data-path={entry.path}
              onClick={() => void store().open(entry.path)}
              className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover/50 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
            >
              <span
                data-testid="memory-entry-title"
                className="min-w-0 flex-1 truncate text-[13px] text-fg-secondary"
              >
                {entry.title}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-fg-faint">
                {formatDate(entry.createdAt)}
              </span>
            </button>
            <IconButton
              data-testid="memory-delete"
              label={t('common.delete')}
              onClick={() => void store().remove(entry.path)}
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
            </IconButton>
          </li>
        ))}
      </ul>

      {entries.length === 0 && status !== 'loading' ? (
        <EmptyState
          size="sm"
          icon={Brain}
          title={t('agents.memoryEmptyTitle')}
          description={t('agents.memoryEmptyDescription')}
        />
      ) : null}

      {error ? (
        <p data-testid="memory-error" className="px-3 py-2 text-[11px] text-danger">
          {translateError(t, { code: errorCode ?? 'internal', message: error })}
        </p>
      ) : null}
    </div>
  )
}
