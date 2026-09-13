/**
 * `reorder`, which is the whole of the member panel's drag-and-drop that can be
 * wrong.
 *
 * The interesting cases are the two directions: dragging *down* has to land the
 * item after the row it was dropped on, dragging *up* before it, and both fall
 * out of "remove first, then insert at the same index" — which is exactly the
 * step a reader cannot verify by eye.
 */
import { describe, expect, it } from 'vitest'
import { reorder } from './reorder'

const list = ['a', 'b', 'c', 'd']

describe('reorder', () => {
  it('moves an item down the list', () => {
    expect(reorder(list, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves an item up the list', () => {
    expect(reorder(list, 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves an item to the very front and to the very back', () => {
    expect(reorder(list, 2, 0)).toEqual(['c', 'a', 'b', 'd'])
    expect(reorder(list, 0, 3)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('swaps neighbours in both directions', () => {
    expect(reorder(list, 1, 0)).toEqual(['b', 'a', 'c', 'd'])
    expect(reorder(list, 0, 1)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('returns an unchanged copy for a no-op move', () => {
    const result = reorder(list, 2, 2)

    expect(result).toEqual(list)
    expect(result).not.toBe(list)
  })

  it('returns an unchanged copy for an out-of-range index', () => {
    expect(reorder(list, -1, 2)).toEqual(list)
    expect(reorder(list, 1, 9)).toEqual(list)
    expect(reorder([], 0, 0)).toEqual([])
  })

  it('never mutates the input', () => {
    const source = [...list]
    reorder(source, 0, 3)

    expect(source).toEqual(list)
  })
})
