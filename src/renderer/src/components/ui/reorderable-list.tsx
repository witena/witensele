/**
 * A list whose rows can be dragged into another order.
 *
 * Extracted from `components/chat/member-panel.tsx` in S9.2, when the committee
 * editor needed the same interaction on the same kind of list. The panel's own
 * behaviour, DOM and test ids are unchanged: this component renders exactly the
 * row wrapper the panel used to write inline, and nothing else — no container
 * element, because the rows are laid out by the caller's own flex column and a
 * wrapper would swallow its `gap`.
 *
 * ## Why the native HTML5 drag events
 *
 * Unchanged from the panel's own reasoning, and worth keeping here: a list of at
 * most a handful of rows, inside an Electron window that is always Chromium, is
 * `draggable` plus `dragstart` / `dragover` / `drop` in about twenty lines and no
 * dependency. The index arithmetic — the only part that can silently be wrong —
 * lives in `lib/reorder.ts` and is unit-tested there.
 *
 * Dragging is a pointer-only interaction, so a caller whose list must also be
 * reorderable from the keyboard renders its own move-up / move-down controls
 * inside the row and calls the same `onReorder`; the committee editor does.
 */
import clsx from 'clsx'
import { useState, type ReactNode } from 'react'

export interface ReorderableListProps<T> {
  /** The rows, in their current order. */
  items: readonly T[]
  /** Stable identity: the React key, the drag payload and the row's id attribute. */
  itemId: (item: T) => string
  /** Called with the dragged row's index and the index it was dropped on. */
  onReorder: (from: number, to: number) => void
  /** `data-testid` every row wrapper carries. */
  rowTestId: string
  /**
   * The attribute each row's id is written to, so a test can select one row.
   *
   * Defaults to the `data-agent-id` both current callers use; it is a prop
   * because nothing about this component is specific to agents.
   */
  idAttribute?: string | undefined
  /** `title` on every row — "drag to change the order", in the caller's words. */
  rowTitle?: string | undefined
  /** The row wrapper's classes; `opacity-50` is added while it is being dragged. */
  rowClassName?: string | undefined
  /** The row's contents. The wrapper, its handlers and its classes are ours. */
  children: (item: T, index: number) => ReactNode
}

export function ReorderableList<T>({
  items,
  itemId,
  onReorder,
  rowTestId,
  idAttribute = 'data-agent-id',
  rowTitle,
  rowClassName,
  children
}: ReorderableListProps<T>): React.JSX.Element {
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  return (
    <>
      {items.map((item, index) => {
        const id = itemId(item)
        return (
          <div
            key={id}
            data-testid={rowTestId}
            {...{ [idAttribute]: id }}
            draggable
            title={rowTitle}
            onDragStart={(event) => {
              // Chromium refuses to start a drag without payload; the index
              // itself is kept in React state because the drop target needs it
              // synchronously.
              event.dataTransfer.setData('text/plain', id)
              event.dataTransfer.effectAllowed = 'move'
              setDragIndex(index)
            }}
            onDragEnd={() => setDragIndex(null)}
            onDragOver={(event) => {
              // Without this the drop event never fires: the default is "not a
              // target".
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
            }}
            onDrop={(event) => {
              event.preventDefault()
              if (dragIndex !== null) onReorder(dragIndex, index)
              setDragIndex(null)
            }}
            className={clsx(rowClassName, dragIndex === index && 'opacity-50')}
          >
            {children(item, index)}
          </div>
        )
      })}
    </>
  )
}
