/**
 * Naming a chat's working directory on screen.
 *
 * The header chip and the settings row both show the **folder's own name** with
 * the full path in a `title`, because a path is long, its interesting half is at
 * the end, and 288px of panel cannot hold `/Users/someone/code/projects/witena`.
 *
 * This is `node:path`'s `basename` written out by hand on purpose: the renderer
 * project deliberately has no Node types (`tsconfig.web.json` lists only
 * `vite/client`), so nothing under `src/renderer/` may import `node:path` — and
 * a pure function is what lets the rule "a trailing slash is not a folder called
 * empty string" be unit-tested without a filesystem.
 */

/**
 * The last segment of a path, or the whole thing when it has no separator.
 *
 * Both separators are honoured even though the product is macOS-only: the path
 * comes from a native dialog today, but it is stored in the database and a
 * Windows build would read the same rows back. A path that is nothing but
 * separators (`/`, the filesystem root) has no last segment, so it prints as
 * itself rather than as a blank chip.
 */
export function folderName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  if (trimmed.length === 0) return path
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return separator === -1 ? trimmed : trimmed.slice(separator + 1)
}
