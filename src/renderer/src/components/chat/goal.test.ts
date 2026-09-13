/**
 * `goalChipState`: the four states of the header's goal chip (S5.10).
 *
 * The one that matters is the fourth, because it is the only one that is a
 * button — a chip that offered to open a file which is not there yet would be a
 * click that can only fail.
 */
import { describe, expect, it } from 'vitest'
import type { ChatGoal } from '@shared/types'
import { goalChipState } from './goal'

const discussion: ChatGoal = { kind: 'discussion', description: 'Decide the API shape', materials: [] }
const codebase: ChatGoal = { kind: 'codebase', description: 'Split the runner', materials: [] }
const document: ChatGoal = {
  kind: 'document',
  description: 'Write the Q3 report',
  deliverable: 'docs/reports/q3.md',
  materials: []
}

describe('goalChipState', () => {
  it('draws nothing at all for a chat with no goal', () => {
    expect(goalChipState(null)).toBeNull()
    expect(goalChipState(undefined)).toBeNull()
  })

  it('reports the kind, and nothing to open, for a discussion', () => {
    expect(goalChipState(discussion)).toEqual({
      kind: 'discussion',
      fileName: null,
      path: null,
      delivered: false,
      openPath: null
    })
  })

  it('reports the kind for a codebase goal, whatever the status says', () => {
    // A `document` status cannot belong to a `codebase` goal, but a stale answer
    // from the query that raced a kind change can arrive looking like one.
    expect(goalChipState(codebase, { deliverable: '/w/a.md', delivered: true })).toEqual({
      kind: 'codebase',
      fileName: null,
      path: null,
      delivered: false,
      openPath: null
    })
  })

  it('carries the deliverable’s file name, and the whole relative path beside it', () => {
    expect(goalChipState(document, { deliverable: '/w/docs/reports/q3.md', delivered: false })).toEqual(
      {
        kind: 'document',
        fileName: 'q3.md',
        path: 'docs/reports/q3.md',
        delivered: false,
        openPath: null
      }
    )
  })

  it('becomes openable only once the file is really there', () => {
    expect(goalChipState(document, { deliverable: '/w/docs/reports/q3.md', delivered: true })).toEqual(
      {
        kind: 'document',
        fileName: 'q3.md',
        path: 'docs/reports/q3.md',
        delivered: true,
        openPath: '/w/docs/reports/q3.md'
      }
    )
  })

  it('is not delivered while the query has not answered yet', () => {
    // The status is loaded after the chat is selected. Drawing "delivered" for
    // that beat and then taking it back would be worse than starting in the
    // state a document is in far more often.
    expect(goalChipState(document)?.delivered).toBe(false)
    expect(goalChipState(document)?.openPath).toBeNull()
    expect(goalChipState(document)?.fileName).toBe('q3.md')
  })

  it('has nothing to open for a document whose deliverable was never resolved', () => {
    const orphan: ChatGoal = { kind: 'document', description: 'x', materials: [] }
    expect(goalChipState(orphan, { deliverable: null, delivered: false })).toEqual({
      kind: 'document',
      fileName: null,
      path: null,
      delivered: false,
      openPath: null
    })
  })
})
