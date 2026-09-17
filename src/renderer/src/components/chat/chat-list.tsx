/**
 * The left column's list: chats grouped Today / Yesterday / Earlier, each row a
 * title plus an "N members" subtitle, exactly as in the mockup.
 *
 * Two interactions beyond selection, both reachable two ways so neither is
 * hidden:
 *
 * - **Rename** turns the row into an input in place. Enter commits, Escape and
 *   blur cancel — cancel-on-blur rather than commit-on-blur, because a click
 *   elsewhere is far more often "never mind" than "save this".
 * - **Delete** is a two-step confirm on the same control ("click again to
 *   confirm"), the pattern Settings → Providers already uses. A modal for a chat
 *   that takes one click to recreate would be heavier than the mistake.
 *
 * The menu opens from the row's kebab button *or* from a right-click on the row,
 * because a right-click is what people try first in a list like this.
 *
 * Since S5.16 the subtitle is the chat's **conclusion** when it has one — the
 * first line of it, behind the translated label — and the member count only
 * otherwise. What a discussion decided is what a user scans this column for; the
 * number of agents in it is a fact they already know.
 */
import clsx from 'clsx'
import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { Chat } from '@shared/types'
import { groupChats, type ChatGroupId } from '../../stores/chats'
import type { ConclusionPreviews } from './conclusion'
import { Button, IconButton, Input } from '../ui'

/** Literal `t()` calls so the used-keys guard can see all three headings. */
function groupLabel(t: TFunction, id: ChatGroupId): string {
  switch (id) {
    case 'today':
      return t('chat.today')
    case 'yesterday':
      return t('chat.yesterday')
    case 'earlier':
      return t('chat.earlier')
  }
}

export interface ChatListProps {
  chats: Chat[]
  selectedId: string | null
  /** Member count per chat id; absent means "not loaded", which renders as 0. */
  memberCounts: Record<string, number>
  /**
   * The first line of a chat's conclusion, per chat id (S5.16).
   *
   * Absent — every chat, until its transcript has been read — leaves the row
   * showing the member count. The preview replaces that count rather than
   * joining it, because the row is one line: what a chat concluded is a better
   * answer to "which one was this" than how many agents are in it, and the count
   * is on the screen anyway the moment the chat is opened.
   */
  conclusionPreviews?: ConclusionPreviews
  onSelect: (chatId: string) => void
  onRename: (chatId: string, title: string) => void
  onDelete: (chatId: string) => void
}

export function ChatList(props: ChatListProps): React.JSX.Element {
  const { t } = useTranslation()
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  // One open menu at a time, and a click anywhere else closes it.
  useEffect(() => {
    if (menuFor === null) return
    const close = (): void => {
      setMenuFor(null)
      setConfirmingId(null)
    }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuFor])

  const groups = groupChats(props.chats)

  return (
    <div className="flex flex-col gap-0.5 px-2 py-2">
      {groups.map((group) => (
        <section key={group.id} className="flex flex-col gap-0.5">
          <h3 className="px-2.5 pt-3 pb-1 text-[11px] tracking-[0.04em] text-fg-faint uppercase">
            {groupLabel(t, group.id)}
          </h3>

          {group.chats.map((chat) => {
            const selected = chat.id === props.selectedId
            const renaming = renamingId === chat.id
            const preview = props.conclusionPreviews?.[chat.id]

            if (renaming) {
              return (
                <RenameRow
                  key={chat.id}
                  chat={chat}
                  onCommit={(title) => {
                    setRenamingId(null)
                    props.onRename(chat.id, title)
                  }}
                  onCancel={() => setRenamingId(null)}
                />
              )
            }

            return (
              <div key={chat.id} className="relative">
                <button
                  type="button"
                  data-testid="chat-item"
                  data-selected={selected}
                  onClick={() => props.onSelect(chat.id)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    // Stop the document listener installed above from closing it
                    // in the same tick it was opened.
                    event.stopPropagation()
                    props.onSelect(chat.id)
                    setMenuFor(chat.id)
                    setConfirmingId(null)
                  }}
                  className={clsx(
                    'group flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left',
                    selected ? 'bg-bg-hover text-fg' : 'text-fg-muted hover:bg-bg-hover/60'
                  )}
                >
                  <span data-testid="chat-item-title" className="w-full truncate text-[13px]">
                    {chat.title}
                  </span>
                  {preview === undefined ? (
                    <span className="text-[11px] text-fg-faint">
                      {t('chat.memberCount', { members: props.memberCounts[chat.id] ?? 0 })}
                    </span>
                  ) : (
                    // The label is translated, the sentence is the group's own
                    // words: `chat.conclusionPreview` interpolates it rather than
                    // concatenating two nodes, so a language that puts the label
                    // last can (S5.16).
                    <span
                      data-testid="chat-item-conclusion"
                      className="w-full truncate text-[11px] text-fg-faint"
                    >
                      {t('chat.conclusionPreview', { text: preview })}
                    </span>
                  )}
                </button>

                <IconButton
                  size="sm"
                  label={t('chat.chatOptions')}
                  data-testid="chat-item-menu"
                  className="absolute top-1.5 right-1.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenuFor((open) => (open === chat.id ? null : chat.id))
                    setConfirmingId(null)
                  }}
                >
                  <MoreHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
                </IconButton>

                {menuFor === chat.id ? (
                  <div
                    role="menu"
                    data-testid="chat-item-actions"
                    onClick={(event) => event.stopPropagation()}
                    className="absolute top-8 right-1.5 z-10 flex min-w-[148px] flex-col gap-1 rounded-lg border border-border-strong bg-bg-elevated p-1 shadow-lg"
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="chat-rename"
                      className="justify-start"
                      onClick={() => {
                        setMenuFor(null)
                        setRenamingId(chat.id)
                      }}
                    >
                      {t('chat.rename')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="chat-delete"
                      className="justify-start text-danger hover:text-danger"
                      onClick={() => {
                        if (confirmingId !== chat.id) {
                          setConfirmingId(chat.id)
                          return
                        }
                        setMenuFor(null)
                        setConfirmingId(null)
                        props.onDelete(chat.id)
                      }}
                    >
                      {confirmingId === chat.id ? t('chat.deleteConfirm') : t('chat.deleteChat')}
                    </Button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}

interface RenameRowProps {
  chat: Chat
  onCommit: (title: string) => void
  onCancel: () => void
}

/** The row while it is being renamed: the same box, holding an input. */
function RenameRow({ chat, onCommit, onCancel }: RenameRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(chat.title)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  return (
    <div className="px-1 py-1">
      <Input
        ref={input}
        value={value}
        data-testid="chat-rename-input"
        aria-label={t('chat.renameChat')}
        onChange={(event) => setValue(event.target.value)}
        onBlur={onCancel}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onCommit(value)
          }
          if (event.key === 'Escape') onCancel()
        }}
      />
    </div>
  )
}
