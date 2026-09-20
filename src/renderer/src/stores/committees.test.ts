/**
 * The committees store against a fake `BackendClient`.
 *
 * Same approach as `agents.test.ts`: no jsdom, no React, no Electron. Three
 * things are worth proving and are hard to see by reading the store — **the
 * draft lifecycle** (open, edit, save, reopen; `dirty` going true and back to
 * false; a create turning into an edit of the row it produced), **the member
 * list**, which is part of the entity and is therefore written by the same
 * `save` rather than by a call of its own, and **the failure path**, because a
 * refusal's `details` is what tells the page to say "this committee already has
 * an executor" instead of "invalid request".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendClient, BackendMethod } from '@shared/backend'
import type { Committee, CommitteeInput, CommitteePatch } from '@shared/types'
import { LOCAL_USER_ID, MAX_COMMITTEE_NAME_CHARS } from '@shared/types'
import { BackendClientError } from '../lib/backend'
import { resetBackend, setBackend } from '../lib/backend-provider'
import {
  draftFromCommittee,
  emptyCommitteeDraft,
  isDraftValid,
  useCommitteesStore,
  validateDraft
} from './committees'

interface Call {
  method: BackendMethod
  input: unknown
}

function committeeFrom(id: string, input: CommitteeInput, updatedAt = 0): Committee {
  return { id, userId: LOCAL_USER_ID, createdAt: 0, updatedAt, ...input }
}

function draft(overrides: Partial<CommitteeInput> = {}): CommitteeInput {
  return { ...emptyCommitteeDraft(), name: 'Architecture review', ...overrides }
}

/** A backend that stores rows, and optionally refuses one method. */
function fakeBackend(
  initial: Committee[] = [],
  refuse?: { method: BackendMethod; error: BackendClientError }
): { client: BackendClient; calls: Call[] } {
  const calls: Call[] = []
  let rows = [...initial]
  let nextId = 1

  const client: BackendClient = {
    invoke: (async (method: BackendMethod, input: unknown) => {
      calls.push({ method, input })
      if (refuse && refuse.method === method) throw refuse.error
      if (method === 'committees.list') return rows
      if (method === 'committees.create') {
        const created = committeeFrom(`c${nextId++}`, (input as { input: CommitteeInput }).input)
        rows = [created, ...rows]
        return created
      }
      if (method === 'committees.update') {
        const { id, patch } = input as { id: string; patch: CommitteePatch }
        const updated = { ...(rows.find((row) => row.id === id) as Committee), ...patch }
        rows = rows.map((row) => (row.id === id ? updated : row))
        return updated
      }
      if (method === 'committees.delete') {
        rows = rows.filter((row) => row.id !== (input as { id: string }).id)
        return undefined
      }
      throw new Error(`unexpected method ${method}`)
    }) as BackendClient['invoke'],
    subscribe: () => () => undefined
  }

  return { client, calls }
}

/** The store is a module singleton; every test starts from the same blank slate. */
function resetStore(): void {
  useCommitteesStore.setState({
    committees: [],
    status: 'idle',
    error: undefined,
    errorCode: undefined,
    errorDetails: undefined,
    selectedId: null,
    mode: 'idle',
    draft: null,
    dirty: false,
    saving: false
  })
}

beforeEach(resetStore)
afterEach(resetBackend)

describe('validateDraft', () => {
  it('accepts a named committee, with or without members', () => {
    expect(isDraftValid(validateDraft(draft()))).toBe(true)
    expect(isDraftValid(validateDraft(draft({ memberAgentIds: ['a1', 'a2'] })))).toBe(true)
  })

  it('refuses a name that is empty or only whitespace', () => {
    expect(validateDraft(draft({ name: '' })).name).toBe('required')
    expect(validateDraft(draft({ name: '   ' })).name).toBe('required')
  })

  it('refuses a name past the cap, measured on the trimmed name', () => {
    const long = 'x'.repeat(MAX_COMMITTEE_NAME_CHARS + 1)
    expect(validateDraft(draft({ name: long })).name).toBe('tooLong')
    // The handler trims before it measures, so the store has to as well.
    expect(validateDraft(draft({ name: `  ${'x'.repeat(MAX_COMMITTEE_NAME_CHARS)}  ` }))).toEqual({})
  })
})

describe('committees store', () => {
  it('loads the list and reports ready', async () => {
    const rows = [committeeFrom('c1', draft({ memberAgentIds: ['a1'] }))]
    const { client, calls } = fakeBackend(rows)
    setBackend(client)

    await useCommitteesStore.getState().load()

    expect(useCommitteesStore.getState().committees).toEqual(rows)
    expect(useCommitteesStore.getState().status).toBe('ready')
    expect(calls.map((call) => call.method)).toEqual(['committees.list'])
  })

  it('records a failed load as an error rather than rejecting', async () => {
    const { client } = fakeBackend([], {
      method: 'committees.list',
      error: new BackendClientError({ code: 'internal', message: 'boom' })
    })
    setBackend(client)

    await expect(useCommitteesStore.getState().load()).resolves.toBeUndefined()

    expect(useCommitteesStore.getState().status).toBe('error')
    expect(useCommitteesStore.getState().errorCode).toBe('internal')
  })

  it('creates from an empty draft and stays on the row it produced', async () => {
    const { client, calls } = fakeBackend()
    setBackend(client)

    useCommitteesStore.getState().startCreate()
    // A new record has nothing stored to differ from, so Save is gated on
    // validity alone.
    expect(useCommitteesStore.getState().dirty).toBe(true)
    expect(useCommitteesStore.getState().draftErrors().name).toBe('required')

    useCommitteesStore.getState().patchDraft({ name: '  Architecture review  ' })
    const created = await useCommitteesStore.getState().save()

    expect(created?.name).toBe('Architecture review')
    expect(calls.at(-1)?.method).toBe('committees.create')
    // The editor is now editing that committee, clean.
    expect(useCommitteesStore.getState().mode).toBe('edit')
    expect(useCommitteesStore.getState().selectedId).toBe(created?.id)
    expect(useCommitteesStore.getState().dirty).toBe(false)
    expect(useCommitteesStore.getState().committees).toHaveLength(1)
  })

  it('refuses to save an invalid draft without calling the backend', async () => {
    const { client, calls } = fakeBackend()
    setBackend(client)

    useCommitteesStore.getState().startCreate()
    expect(await useCommitteesStore.getState().save()).toBeNull()
    expect(calls).toEqual([])
  })

  it('edits members in order and writes the whole list on save', async () => {
    const stored = committeeFrom('c1', draft({ memberAgentIds: ['a1'] }))
    const { client, calls } = fakeBackend([stored])
    setBackend(client)

    await useCommitteesStore.getState().load()
    useCommitteesStore.getState().startEdit('c1')
    expect(useCommitteesStore.getState().dirty).toBe(false)

    useCommitteesStore.getState().addMember('a2')
    useCommitteesStore.getState().addMember('a3')
    // Adding the same agent twice is ignored: the handler refuses duplicates.
    useCommitteesStore.getState().addMember('a2')
    expect(useCommitteesStore.getState().draft?.memberAgentIds).toEqual(['a1', 'a2', 'a3'])
    expect(useCommitteesStore.getState().dirty).toBe(true)

    useCommitteesStore.getState().moveMember(2, 0)
    useCommitteesStore.getState().removeMember('a1')
    expect(useCommitteesStore.getState().draft?.memberAgentIds).toEqual(['a3', 'a2'])

    const saved = await useCommitteesStore.getState().save()

    expect(calls.at(-1)).toEqual({
      method: 'committees.update',
      input: {
        id: 'c1',
        patch: { name: 'Architecture review', description: '', memberAgentIds: ['a3', 'a2'] }
      }
    })
    expect(saved?.memberAgentIds).toEqual(['a3', 'a2'])
    expect(useCommitteesStore.getState().committees[0]?.memberAgentIds).toEqual(['a3', 'a2'])
    expect(useCommitteesStore.getState().dirty).toBe(false)
  })

  it('goes back to clean when an edit is typed and then undone', async () => {
    const stored = committeeFrom('c1', draft({ memberAgentIds: ['a1'] }))
    const { client } = fakeBackend([stored])
    setBackend(client)

    await useCommitteesStore.getState().load()
    useCommitteesStore.getState().startEdit('c1')

    useCommitteesStore.getState().patchDraft({ name: 'Other' })
    expect(useCommitteesStore.getState().dirty).toBe(true)
    useCommitteesStore.getState().patchDraft({ name: stored.name })
    expect(useCommitteesStore.getState().dirty).toBe(false)

    // The member list counts as part of the record, order included.
    useCommitteesStore.getState().addMember('a2')
    expect(useCommitteesStore.getState().dirty).toBe(true)
    useCommitteesStore.getState().removeMember('a2')
    expect(useCommitteesStore.getState().dirty).toBe(false)
  })

  it('keeps a refusal as a code plus its details, and does not touch the list', async () => {
    const stored = committeeFrom('c1', draft())
    const { client } = fakeBackend([stored], {
      method: 'committees.update',
      error: new BackendClientError({
        code: 'validation',
        message: 'two executors',
        details: { reason: 'second_executor' }
      })
    })
    setBackend(client)

    await useCommitteesStore.getState().load()
    useCommitteesStore.getState().startEdit('c1')
    useCommitteesStore.getState().addMember('a2')

    expect(await useCommitteesStore.getState().save()).toBeNull()

    const state = useCommitteesStore.getState()
    expect(state.errorCode).toBe('validation')
    // `translateFailure` reads the reason out of these details; without it the
    // page could only say "the request was rejected as invalid".
    expect(state.errorDetails).toEqual({ reason: 'second_executor' })
    expect(state.saving).toBe(false)
    // The draft is kept so the user can fix it, and the stored row is untouched.
    expect(state.draft?.memberAgentIds).toEqual(['a2'])
    expect(state.committees[0]).toEqual(stored)
  })

  it('removes a committee and closes the editor when it was the open one', async () => {
    const first = committeeFrom('c1', draft())
    const second = committeeFrom('c2', draft({ name: 'Incident review' }))
    const { client, calls } = fakeBackend([first, second])
    setBackend(client)

    await useCommitteesStore.getState().load()
    useCommitteesStore.getState().startEdit('c1')
    await useCommitteesStore.getState().remove('c1')

    expect(calls.at(-1)).toEqual({ method: 'committees.delete', input: { id: 'c1' } })
    expect(useCommitteesStore.getState().committees).toEqual([second])
    expect(useCommitteesStore.getState().mode).toBe('idle')
    expect(useCommitteesStore.getState().draft).toBeNull()
  })

  it('leaves the editor alone when another committee is deleted', async () => {
    const first = committeeFrom('c1', draft())
    const second = committeeFrom('c2', draft({ name: 'Incident review' }))
    const { client } = fakeBackend([first, second])
    setBackend(client)

    await useCommitteesStore.getState().load()
    useCommitteesStore.getState().startEdit('c2')
    await useCommitteesStore.getState().remove('c1')

    expect(useCommitteesStore.getState().selectedId).toBe('c2')
    expect(useCommitteesStore.getState().draft).toEqual(draftFromCommittee(second))
  })

  it('reports a failed delete without dropping the row', async () => {
    const stored = committeeFrom('c1', draft())
    const { client } = fakeBackend([stored], {
      method: 'committees.delete',
      error: new BackendClientError({ code: 'not_found', message: 'gone' })
    })
    setBackend(client)

    await useCommitteesStore.getState().load()
    await useCommitteesStore.getState().remove('c1')

    expect(useCommitteesStore.getState().errorCode).toBe('not_found')
    expect(useCommitteesStore.getState().committees).toEqual([stored])
  })

  it('ignores an edit of a committee it does not hold', () => {
    useCommitteesStore.getState().startEdit('nope')
    expect(useCommitteesStore.getState().mode).toBe('idle')
    expect(useCommitteesStore.getState().draft).toBeNull()
  })
})
