/**
 * Turning a `tool-call` / `tool-result` pair into the one-line card the mockup
 * draws: a wrench, `toolName(argsPreview)`, and a right-hand summary that reads
 * "running…", "n results" or "error".
 *
 * Keeping the whole rule here as a pure function is what lets it be tested
 * against fixtures instead of against a live MCP server.
 *
 * ## The name the card shows
 *
 * A tool from an MCP server is stored with its **own** name (`echo`) plus the
 * server it came from, because the `everything__echo` key the model was shown is
 * an implementation detail of keeping two servers apart (see
 * `src/main/mcp/tools.ts`). The card prints `serverName · toolName` when there is
 * a server and the bare name when there is not — which is what the built-in
 * tools of S3.2 and S3.3 will look like.
 *
 * ## What "n results" counts
 *
 * The MVP cannot know the shape of a tool's output: it is whatever the tool's
 * JSON schema says. So the count is a small ladder of the shapes that actually
 * occur, falling back to "one result" for a scalar and to none for an absent
 * output:
 *
 * | Output | Count |
 * |---|---|
 * | `[a, b, c]` | 3 — the common list-shaped result |
 * | `{ content: [...] }` | the length of `content` — the MCP content-block shape |
 * | `{ results: [...] }` / `{ items: [...] }` | the length of that array |
 * | anything else that is not `undefined` / `null` | 1 |
 * | `undefined` / `null` | `null`, and the card says nothing about results |
 *
 * A wrong count here is cosmetic; the expanded card always shows the real JSON.
 *
 * ## The executor's own tools (S5.5)
 *
 * `write_file(path: "src/a.ts", content: "…")` is a card nobody can read at a
 * glance, and the argument that matters is always the same one: the path, the
 * query, or the command line. `EXECUTOR_PREVIEW_ARG` names it per tool and the
 * value is printed **bare**, without the `key: ` prefix and without JSON quotes,
 * so the line reads `write_file(src/a.ts)` and `run_command(npm test)`.
 *
 * The preview is still capped at `ARGS_PREVIEW_MAX`, including for
 * `run_command`: this is a one-line summary of a call that already happened, not
 * the permission prompt. The prompt is the security boundary and shows the
 * command verbatim (`permission-input.ts`); the expanded card below shows the
 * whole input as JSON either way.
 *
 * ## The file a card is about (S5.7)
 *
 * `read_file`, `write_file` and `edit_file` are each about exactly one file, and
 * that file is the thing a reader of the transcript most often wants open in
 * front of them. `filePath` carries it — the path the *model* typed, which may be
 * relative to the chat's folder — and the card turns it into an "open" icon.
 * `list_dir`, `search_files`, `run_command` and `git_diff` are deliberately not
 * in the set: a folder, a query and a command line are not a file to open.
 */
import type { ToolCallPart, ToolResultPart } from '@shared/types'

/**
 * The one argument worth printing for each built-in executor tool.
 *
 * Keyed by the tool's own name, which is what the transcript stores: these tools
 * have no MCP server behind them, so there is no prefix to strip. A tool missing
 * from this table — or a call whose argument is not a string — falls back to the
 * generic `key: value` preview.
 */
export const EXECUTOR_PREVIEW_ARG: Record<string, string> = {
  read_file: 'path',
  list_dir: 'path',
  search_files: 'query',
  write_file: 'path',
  edit_file: 'path',
  run_command: 'command',
  git_diff: 'path'
}

/**
 * The built-in tools whose `path` argument names a file worth opening (S5.7).
 *
 * A subset of `EXECUTOR_PREVIEW_ARG`'s keys, and separate from it on purpose:
 * `list_dir` and `git_diff` also take a `path`, and neither of them is a file.
 */
export const EXECUTOR_OPENABLE_TOOLS = ['read_file', 'write_file', 'edit_file'] as const

/** How long `argsPreview` may get before it is cut. Roughly the mockup's width. */
export const ARGS_PREVIEW_MAX = 48

/** What the card's right-hand side says. */
export type ToolCallState = 'running' | 'done' | 'error'

/** Everything `ToolCard` needs, and nothing that needs React to compute. */
export interface ToolCallDescription {
  toolCallId: string
  toolName: string
  /** The MCP server the tool came from, absent for a built-in tool. */
  serverName?: string | undefined
  /** `serverName · toolName`, or just the name — what the card's line shows. */
  label: string
  /** The arguments, flattened to one short line for the collapsed card. */
  argsPreview: string
  state: ToolCallState
  /** How many results the output holds, or `null` when that cannot be said. */
  resultCount: number | null
  /** Pretty-printed input, for the expanded card. */
  inputJson: string
  /** Pretty-printed output, or `null` while the call is still running. */
  outputJson: string | null
  /**
   * The one file this call is about, as the model wrote it, or `null`.
   *
   * Relative or absolute — resolving it against the chat's folder is the card's
   * job, because only the card knows which chat it is in.
   */
  filePath: string | null
}

/** `JSON.stringify` that never throws: a cycle or a BigInt becomes a marker. */
function safeJson(value: unknown, indent?: number): string {
  try {
    const json = JSON.stringify(value, null, indent)
    // `JSON.stringify(undefined)` is `undefined`, not a string.
    return json ?? String(value)
  } catch {
    return String(value)
  }
}

/** One argument value, compact enough to sit inside the preview line. */
function previewValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null || value === undefined) return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  if (typeof value === 'object') return '{…}'
  return safeJson(value)
}

/**
 * The `argsPreview` half of `toolName(argsPreview)`.
 *
 * A single string argument prints as itself (`memory_search("timeouts")`), which
 * is the case the mockup shows; an object prints as `key: value` pairs in
 * declaration order, because a tool's first argument is nearly always the one
 * worth reading.
 */
export function previewToolArgs(
  input: unknown,
  max: number = ARGS_PREVIEW_MAX,
  toolName?: string
): string {
  const primary = toolName === undefined ? undefined : EXECUTOR_PREVIEW_ARG[toolName]
  const bare =
    primary !== undefined && input !== null && typeof input === 'object'
      ? (input as Record<string, unknown>)[primary]
      : undefined
  if (typeof bare === 'string') {
    const single = bare.replace(/\s+/g, ' ').trim()
    return single.length > max ? `${single.slice(0, max - 1)}…` : single
  }

  const full =
    input === undefined || input === null
      ? ''
      : typeof input === 'object' && !Array.isArray(input)
        ? Object.entries(input as Record<string, unknown>)
            .map(([key, value]) => `${key}: ${previewValue(value)}`)
            .join(', ')
        : previewValue(input)

  return full.length > max ? `${full.slice(0, max - 1)}…` : full
}

/**
 * The `path` argument of a built-in file tool, or `null` for anything else.
 *
 * `serverName` is the gate, exactly as it is for `argsPreview`: an MCP server
 * that happens to expose a tool called `write_file` is not this executor tool and
 * its arguments mean whatever that server says they mean.
 */
export function openableFilePath(part: ToolCallPart): string | null {
  if (part.serverName) return null
  if (!(EXECUTOR_OPENABLE_TOOLS as readonly string[]).includes(part.toolName)) return null
  const input = part.input
  if (input === null || typeof input !== 'object') return null
  const path = (input as Record<string, unknown>).path
  return typeof path === 'string' && path.trim().length > 0 ? path.trim() : null
}

/** The result count, or `null` when the output says nothing countable. */
export function countToolResults(output: unknown): number | null {
  if (output === undefined || output === null) return null
  if (Array.isArray(output)) return output.length
  if (typeof output === 'object') {
    const record = output as Record<string, unknown>
    for (const key of ['content', 'results', 'items'] as const) {
      const value = record[key]
      if (Array.isArray(value)) return value.length
    }
  }
  return 1
}

/**
 * Describes one tool call, with its result when it already has one.
 *
 * Called with the `tool-call` part alone while the model is still waiting, and
 * with both parts once the matching `tool-result` has arrived.
 */
export function describeToolCall(
  part: ToolCallPart,
  result?: ToolResultPart | undefined
): ToolCallDescription {
  const state: ToolCallState = !result ? 'running' : result.isError === true ? 'error' : 'done'

  return {
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    ...(part.serverName ? { serverName: part.serverName } : {}),
    label: part.serverName ? `${part.serverName} · ${part.toolName}` : part.toolName,
    // The tool's own name, not the label: an MCP tool called `write_file` comes
    // from a server and is not this executor tool, so it keeps the generic
    // preview — `serverName` is what tells them apart, and it is on the part.
    argsPreview: previewToolArgs(
      part.input,
      ARGS_PREVIEW_MAX,
      part.serverName ? undefined : part.toolName
    ),
    state,
    // An errored call's output is the error itself, not a list of results.
    resultCount: result && state !== 'error' ? countToolResults(result.output) : null,
    inputJson: safeJson(part.input, 2),
    outputJson: result ? safeJson(result.output, 2) : null,
    filePath: openableFilePath(part)
  }
}

/**
 * Every tool call in a message's parts, each paired with its result.
 *
 * The pairing is by `toolCallId` rather than by position, because a parallel
 * tool call returns its results in whatever order the calls finish.
 */
export function collectToolCalls(
  parts: readonly (ToolCallPart | ToolResultPart | { type: string })[]
): ToolCallDescription[] {
  const results = new Map<string, ToolResultPart>()
  for (const part of parts) {
    if (part.type === 'tool-result') {
      const typed = part as ToolResultPart
      results.set(typed.toolCallId, typed)
    }
  }

  const calls: ToolCallDescription[] = []
  for (const part of parts) {
    if (part.type !== 'tool-call') continue
    const typed = part as ToolCallPart
    calls.push(describeToolCall(typed, results.get(typed.toolCallId)))
  }
  return calls
}
