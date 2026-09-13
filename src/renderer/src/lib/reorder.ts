/**
 * Moving one item of a list to another index.
 *
 * Extracted from the member panel's drag-and-drop for one reason: the drop
 * handler is the part of that interaction nobody can test by reading it — the
 * index arithmetic of "remove, then insert" is off by one in exactly one
 * direction — while the DOM events around it are trivial. Keeping the arithmetic
 * here means `reorder.test.ts` covers the only thing that can be wrong, with no
 * renderer, no jsdom and no drag simulation.
 *
 * Pure and generic: it returns a new array and never mutates the input, because
 * the caller hands the result straight to `chats.members.set` and to a zustand
 * store, both of which compare by reference.
 */

/**
 * A copy of `list` with the item at `from` moved to index `to`.
 *
 * Out-of-range indices and a no-op move return a copy unchanged rather than
 * throwing: a drop outside the list is an ordinary outcome of dragging, not a
 * programming error worth crashing the panel for.
 */
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (from < 0 || from >= next.length) return next
  if (to < 0 || to >= next.length) return next
  if (from === to) return next

  // `splice` returns the removed slice; the list has already shrunk by one, so
  // `to` is now the index the item should land on in the *shortened* list, which
  // is what "move above the item currently at `to`" means when dragging upwards
  // and "move below it" when dragging downwards.
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved as T)
  return next
}
