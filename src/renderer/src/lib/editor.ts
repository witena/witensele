/**
 * The one call the transcript makes to open a file (S5.7).
 *
 * Three surfaces reach for it — the `path:line` chip, the diff header and the
 * file tool cards — and all three want exactly the same thing, so the
 * `BackendClient` call lives here rather than three times in JSX. It is not a
 * zustand store because there is no state: the backend keeps nothing, the
 * platform reports nothing back, and the only thing a caller does with the
 * result is paint its own button red for a second.
 *
 * `getBackend()` rather than `window.witena`, like every other call in the
 * renderer (CLAUDE.md rule #6).
 */
import { getBackend } from './backend-provider'

export interface OpenInEditorRequest {
  /** Absolute. The detector (`components/chat/file-refs.ts`) produces it. */
  path: string
  /** 1-based; omitted opens the top of the file. */
  line?: number | undefined
  /** The chat the reference came from; its folder confines the path. */
  chatId?: string | undefined
}

/**
 * Opens one file, rejecting when the backend refused the path or the platform
 * refused the URL.
 *
 * Rejects rather than swallowing, because the caller is a control the user just
 * clicked: a path outside the folder and an editor that is not installed are
 * both things they need to see, and only the component knows where to show it.
 */
export async function openInEditor(request: OpenInEditorRequest): Promise<void> {
  await getBackend().invoke('system.openInEditor', {
    path: request.path,
    ...(request.line === undefined ? {} : { line: request.line }),
    ...(request.chatId === undefined ? {} : { chatId: request.chatId })
  })
}
