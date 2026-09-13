/**
 * The MCP server registry: the list, the editor draft, and the three things only
 * a live connection can answer (test, tools, log).
 *
 * Shaped exactly like `stores/providers.ts`, and for the same reason — a server
 * is not saveable field by field. Switching transport rewrites which half of the
 * record means anything, the command and its arguments are edited as one block of
 * text, and "does this configuration work" has to be answerable **before** the
 * record exists. So the editor works on a `McpServerInput` copy (`draft`) and
 * only `saveDraft` touches the backend; `McpServerRef` is what lets both the
 * draft and the saved row be probed through one method.
 *
 * ## Two caches that are not the same thing
 *
 * - `testResults` is the answer to "I pressed Test just now". Runtime only, and
 *   keyed by server id (or `DRAFT_TEST_KEY` for an unsaved form).
 * - `tools` is the tool list of each server, read through `mcp.tools`, which uses
 *   the **pooled** connection. The agent editor needs a tool count per server, and
 *   asking through the probe instead would spawn one child process per card.
 *
 * Both are dropped on a reload, because both describe a process that may not be
 * running any more.
 */
import { create } from 'zustand'
import type { McpServerRef } from '@shared/backend'
import type {
  BackendErrorCode,
  McpConnectionTestResult,
  McpServer,
  McpServerInput,
  McpToolInfo
} from '@shared/types'
import { BackendClientError } from '../lib/backend'
import { getBackend } from '../lib/backend-provider'

export type McpStatus = 'idle' | 'loading' | 'ready' | 'error'

/** `idle` shows the "pick or add one" placeholder; the other two show the form. */
export type McpEditorMode = 'idle' | 'create' | 'edit'

/** Key the last probe result of an unsaved draft is remembered under. */
export const DRAFT_TEST_KEY = 'draft'

/** What a fresh "Add server" form starts from: a stdio server with nothing in it. */
export function emptyDraft(): McpServerInput {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    enabled: true,
    sideEffects: false
  }
}

/** The editor copy of a stored server. */
export function draftFromServer(server: McpServer): McpServerInput {
  return {
    name: server.name,
    transport: server.transport,
    ...(server.command !== undefined ? { command: server.command } : {}),
    args: [...(server.args ?? [])],
    env: { ...(server.env ?? {}) },
    ...(server.url !== undefined ? { url: server.url } : {}),
    enabled: server.enabled,
    sideEffects: server.sideEffects
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function classify(cause: unknown): BackendErrorCode {
  return cause instanceof BackendClientError ? cause.code : 'internal'
}

/* -------------------------------------------------------------------------- */
/* Text ⇄ structure                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `args` as one line per argument.
 *
 * A single text field split on spaces would be wrong the first time an argument
 * contains one (`--root /Users/me/My Files`), and a chip list is the wrong shape
 * for something that is edited as an ordered block. One line per argument is what
 * every MCP client's own configuration UI settled on.
 */
export function argsToText(args: readonly string[] | undefined): string {
  return (args ?? []).join('\n')
}

export function textToArgs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** `env` and http headers as `KEY=VALUE` lines. */
export function envToText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

/**
 * `KEY=VALUE` lines back to an object.
 *
 * Splits on the **first** `=` only, so a value may contain one (a URL with a
 * query string, a base64 token). A line with no `=` is dropped rather than
 * stored with an empty value, which would silently blank a real variable.
 */
export function textToEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return env
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export interface McpState {
  /** Backend-owned mirror of the `mcp_servers` table, oldest first. */
  servers: McpServer[]
  status: McpStatus
  /** Developer-facing detail of the last failure; the UI shows translated copy. */
  error?: string | undefined
  errorCode?: BackendErrorCode | undefined
  selectedId: string | null
  mode: McpEditorMode
  /** The editor's working copy. `null` when the editor is closed. */
  draft: McpServerInput | null
  /** Last probe per server id, plus `DRAFT_TEST_KEY`. Runtime only. */
  testResults: Record<string, McpConnectionTestResult>
  /** Tool list per server id, from the pooled connection. Runtime only. */
  tools: Record<string, McpToolInfo[]>
  /** stderr tail per server id, shown behind "Show log". */
  logs: Record<string, string[]>
  testing: boolean
  saving: boolean

  /** Reads the list. Never rejects: failures land in `status` / `error`. */
  load: () => Promise<void>
  create: (input: McpServerInput) => Promise<McpServer>
  update: (id: string, patch: Partial<McpServerInput>) => Promise<McpServer>
  remove: (id: string) => Promise<void>
  /** Runs one probe and remembers the result. Never rejects. */
  testConnection: (ref: McpServerRef) => Promise<McpConnectionTestResult>
  /** Reads one server's tools through the pool. Never rejects; caches on success. */
  loadTools: (id: string) => Promise<McpToolInfo[]>
  /** Reads every enabled server's tools, for the agent editor's counts. */
  loadAllTools: () => Promise<void>
  loadLog: (id: string) => Promise<string[]>

  startCreate: () => void
  startEdit: (id: string) => void
  closeEditor: () => void
  patchDraft: (patch: Partial<McpServerInput>) => void
  /** Creates or updates from the draft. Never rejects; sets `error` on failure. */
  saveDraft: () => Promise<McpServer | null>
}

/** Where a probe result belongs: the saved row it is about, or the draft. */
function testKey(ref: McpServerRef, selectedId: string | null): string {
  if ('id' in ref) return ref.id
  return selectedId ?? DRAFT_TEST_KEY
}

export const useMcpStore = create<McpState>()((set, get) => ({
  servers: [],
  status: 'idle',
  error: undefined,
  errorCode: undefined,
  selectedId: null,
  mode: 'idle',
  draft: null,
  testResults: {},
  tools: {},
  logs: {},
  testing: false,
  saving: false,

  async load() {
    set({ status: 'loading', error: undefined, errorCode: undefined })
    try {
      const servers = await getBackend().invoke('mcp.list')
      set({ servers, status: 'ready', error: undefined, errorCode: undefined })
    } catch (cause) {
      set({ status: 'error', error: describe(cause), errorCode: classify(cause) })
    }
  },

  async create(input) {
    const created = await getBackend().invoke('mcp.create', { input })
    set((state) => ({
      servers: [...state.servers, created],
      error: undefined,
      errorCode: undefined
    }))
    return created
  },

  async update(id, patch) {
    const updated = await getBackend().invoke('mcp.update', { id, patch })
    set((state) => ({
      servers: state.servers.map((server) => (server.id === id ? updated : server)),
      // The connection may have been dropped by the update, so a cached tool
      // list is no longer a fact about anything.
      tools: dropKey(state.tools, id),
      error: undefined,
      errorCode: undefined
    }))
    return updated
  },

  async remove(id) {
    await getBackend().invoke('mcp.delete', { id })
    set((state) => {
      const closing = state.selectedId === id
      return {
        servers: state.servers.filter((server) => server.id !== id),
        testResults: dropKey(state.testResults, id),
        tools: dropKey(state.tools, id),
        logs: dropKey(state.logs, id),
        ...(closing ? { selectedId: null, mode: 'idle' as const, draft: null } : {}),
        error: undefined,
        errorCode: undefined
      }
    })
  },

  async testConnection(ref) {
    set({ testing: true })
    const key = testKey(ref, get().selectedId)
    try {
      const result = await getBackend().invoke('mcp.testConnection', { server: ref })
      set((state) => ({
        testResults: { ...state.testResults, [key]: result },
        // A successful probe is also a tool list, so the card can show a count
        // without a second round trip.
        ...(result.ok && key !== DRAFT_TEST_KEY
          ? { tools: { ...state.tools, [key]: result.tools } }
          : {})
      }))
      return result
    } catch (cause) {
      // The handler answers with a value rather than a rejection for a server it
      // could not reach, but validation and the transport still reject.
      const result: McpConnectionTestResult = {
        ok: false,
        error: { code: classify(cause), message: describe(cause) }
      }
      set((state) => ({ testResults: { ...state.testResults, [key]: result } }))
      return result
    } finally {
      set({ testing: false })
    }
  },

  async loadTools(id) {
    try {
      const tools = await getBackend().invoke('mcp.tools', { id })
      set((state) => ({ tools: { ...state.tools, [id]: tools } }))
      return tools
    } catch {
      // A server that will not connect has no tools to show; the card says
      // "not tested" rather than the page failing to render.
      return []
    }
  },

  async loadAllTools() {
    const servers = get().servers.filter((server) => server.enabled)
    await Promise.all(servers.map((server) => get().loadTools(server.id)))
  },

  async loadLog(id) {
    try {
      const lines = await getBackend().invoke('mcp.log', { id })
      set((state) => ({ logs: { ...state.logs, [id]: lines } }))
      return lines
    } catch {
      return []
    }
  },

  startCreate() {
    set({ mode: 'create', selectedId: null, draft: emptyDraft(), error: undefined, errorCode: undefined })
  },

  startEdit(id) {
    const server = get().servers.find((candidate) => candidate.id === id)
    if (!server) return
    set({
      mode: 'edit',
      selectedId: id,
      draft: draftFromServer(server),
      error: undefined,
      errorCode: undefined
    })
  },

  closeEditor() {
    set({ mode: 'idle', selectedId: null, draft: null })
  },

  patchDraft(patch) {
    const draft = get().draft
    if (!draft) return
    set({ draft: { ...draft, ...patch } })
  },

  async saveDraft() {
    const { draft, mode, selectedId } = get()
    if (!draft) return null

    set({ saving: true, error: undefined, errorCode: undefined })
    try {
      if (mode === 'edit' && selectedId) {
        const updated = await get().update(selectedId, draft)
        set({ draft: draftFromServer(updated) })
        return updated
      }
      const created = await get().create(draft)
      // Stay on the record that was just created: the user usually tests next.
      set({ mode: 'edit', selectedId: created.id, draft: draftFromServer(created) })
      // A probe run against the draft belongs to the row it became, so the card
      // shows "connected" instead of going back to "not tested" after Save.
      set((state) => {
        const probe = state.testResults[DRAFT_TEST_KEY]
        if (!probe) return {}
        return {
          testResults: { ...dropKey(state.testResults, DRAFT_TEST_KEY), [created.id]: probe },
          ...(probe.ok ? { tools: { ...state.tools, [created.id]: probe.tools } } : {})
        }
      })
      return created
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
      return null
    } finally {
      set({ saving: false })
    }
  }
}))

/** A copy of `record` without `key`. */
function dropKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record
  return rest
}
