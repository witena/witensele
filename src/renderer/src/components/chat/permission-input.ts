/**
 * What a permission prompt shows about the call it is holding.
 *
 * The card is the **only** description of what is about to happen to the user's
 * files, so this transform has one job: say what the tool was actually asked,
 * without interpreting it. The rules per tool, and the reason for each:
 *
 * | Tool | Shown |
 * |---|---|
 * | `run_command` | The command line **verbatim**, in monospace, never truncated |
 * | `write_file` | The path, plus a preview of the content that will be written |
 * | `edit_file` | The path, plus the unified diff the tool already computed |
 * | anything else | The raw JSON of the arguments |
 *
 * `run_command` is verbatim because the shell is not sandboxed
 * (`docs/features/executor/context.md`, "Open questions"): `cwd` is confined and
 * the command is not, so the prompt is the entire boundary. A summarised,
 * shortened or prettified command line would be a boundary that lies. Every
 * other body may be capped — a 200 KB file preview helps nobody — and says so
 * with `truncated`.
 *
 * Nothing here is translated: a path, a command and a diff are **data**, the same
 * rule the working-directory chip follows. The labels around them are the card's,
 * and they are `t()` keys.
 */

/** How much of a `write_file` body the card previews, in characters. */
export const CONTENT_PREVIEW_CHARS = 1_200

/** How the body should be drawn. `diff` is highlighted; the rest is plain. */
export type PermissionBodyKind = 'command' | 'content' | 'diff' | 'json'

export interface PermissionInputView {
  /** The path the call names, when it names one. Shown above the body. */
  path?: string | undefined
  kind: PermissionBodyKind
  /** The text of the body, already capped for everything but a command. */
  body: string
  /** True when `body` is shorter than what the model sent. */
  truncated: boolean
}

/** `JSON.stringify` that never throws: a cycle or a BigInt becomes a marker. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function cap(text: string, max: number): { body: string; truncated: boolean } {
  return text.length > max
    ? { body: text.slice(0, max), truncated: true }
    : { body: text, truncated: false }
}

/** A field of the tool's arguments, when it is a non-empty string. */
function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Describes one pending call for the card.
 *
 * Falls back to the raw JSON whenever the arguments are not the shape the tool's
 * schema promises — a model that sent `write_file` without a `content` string is
 * exactly the case where the user should see what it really sent.
 */
export function describePermissionInput(toolName: string, input: unknown): PermissionInputView {
  if (toolName === 'run_command') {
    const command = stringField(input, 'command')
    if (command) return { kind: 'command', body: command, truncated: false }
  }

  if (toolName === 'write_file') {
    const path = stringField(input, 'path')
    const content = (input as { content?: unknown } | null)?.content
    if (path !== undefined && typeof content === 'string') {
      const { body, truncated } = cap(content, CONTENT_PREVIEW_CHARS)
      return { path, kind: 'content', body, truncated }
    }
  }

  if (toolName === 'edit_file') {
    const path = stringField(input, 'path')
    const patch = stringField(input, 'patch')
    if (path !== undefined && patch !== undefined) {
      return { path, kind: 'diff', body: patch, truncated: false }
    }
  }

  return { kind: 'json', body: safeJson(input), truncated: false }
}
