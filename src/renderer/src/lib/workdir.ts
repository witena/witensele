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

/**
 * An absolute path from a native dialog, as a path relative to `workdir` — or
 * `null` when it does not lie inside it (S5.10).
 *
 * A goal stores **relative** paths (`ChatGoal`), because the folder can be
 * moved, restored from a backup or cloned onto another machine and an absolute
 * path would then name something else. The dialogs know no such thing: they
 * return what the platform gave them. So this is the conversion, and it is also
 * where "you picked something outside this chat's folder" is discovered — no
 * dialog on any platform this runs on can be confined to a directory.
 *
 * `null` is returned for three cases that are all the same answer to the user:
 * there is no folder bound, the path is somewhere else entirely, and the path is
 * the folder itself (a goal names things *in* the folder, never the folder).
 *
 * Separators are normalised to `/` on the way out, so the same goal reads
 * identically wherever it is opened. The comparison is **exact**: both strings
 * come from one dialog rooted at this folder, so a case-insensitive filesystem
 * cannot make them differ, and case-folding a path here would be a guess about
 * the volume it lives on.
 */
export function relativeToWorkdir(
  workdir: string | null | undefined,
  absolute: string
): string | null {
  if (!workdir) return null
  const root = workdir.replace(/[/\\]+$/, '')
  if (root.length === 0 || absolute.length <= root.length + 1) return null
  const separator = absolute.charAt(root.length)
  if (!absolute.startsWith(root) || (separator !== '/' && separator !== '\\')) return null

  const relative = absolute.slice(root.length + 1).replace(/\\/g, '/').replace(/\/+$/, '')
  return relative.length > 0 ? relative : null
}
