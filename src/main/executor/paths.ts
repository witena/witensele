/**
 * Path confinement for the executor's tools.
 *
 * Every path an executor tool touches comes from a language model, so this is a
 * real input-validation boundary rather than a formality: the chat's `workdir`
 * is the whole world the executor may see, and nothing outside it may be read,
 * written, listed or searched.
 *
 * ## The four ways out, all closed here
 *
 * | Attempt | Closed by |
 * |---|---|
 * | `../../etc/passwd` | resolving against the folder and comparing prefixes |
 * | `/etc/passwd` | the same comparison — an absolute path is resolved, not rejected |
 * | `link` → `/etc`, then reading `link/passwd` | `realpathSync` of the target |
 * | `link` → `/etc`, then **writing** `link/new` (target does not exist yet) | `realpathSync` of the deepest ancestor that does exist, with the missing tail appended |
 *
 * The fourth row is the one a simpler implementation gets wrong. `existsSync`
 * is false for a file that is about to be created, so realpathing *the target*
 * proves nothing about a write; the check has to climb to the nearest existing
 * directory and realpath that instead.
 *
 * ## Why absolute paths inside the folder are allowed
 *
 * `skills/loader.ts`'s `resolveInside` refuses every absolute path, because a
 * skill's bundled files are always named relatively. An executor is different:
 * it is told the working directory in its briefing, it reads absolute paths out
 * of compiler output and `git status`, and refusing them would mean a model that
 * pasted back a path this app printed gets an error. So an absolute path is
 * resolved like any other and then held to the same boundary — inside is fine,
 * outside is not.
 *
 * ## The workdir is re-resolved on every call
 *
 * `chats.update` validated the folder when the user picked it (S5.2), which says
 * nothing about whether it is still there now. Every resolution starts with
 * `realpathSync(workdir)`, so a folder that was renamed or unmounted fails as a
 * missing working directory rather than as a mysterious write into a path that
 * no longer means what it did.
 *
 * No electron here, and no context: the functions take a directory string
 * (CLAUDE.md rule #5).
 */
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { validation } from '../errors'

/** A path the executor is allowed to touch. */
export interface ResolvedPath {
  /** The absolute path to hand to `node:fs`. */
  absolute: string
  /**
   * The same path relative to the working directory, `.` for the folder itself.
   *
   * What the diff headers, the tool results and the permission prompt show: an
   * executor's messages are about *this project*, and the user's home directory
   * prefix on every line is noise they cannot act on.
   */
  relative: string
}

/** True when `target` is `root` itself or lives underneath it. */
export function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

/**
 * The real path of `target`, computed so that it also works for a path that does
 * not exist yet.
 *
 * Climbs to the deepest existing ancestor, resolves *that* through
 * `realpathSync`, and re-appends the segments that were missing. For an existing
 * file this is exactly `realpathSync(target)`; for `folder/link/new.txt` where
 * `link` is a symlink and `new.txt` is not there yet, it is the resolved `link`
 * plus `new.txt` — which is the thing the boundary check has to see.
 */
export function realPathOf(target: string): string {
  const missing: string[] = []
  let current = target

  for (;;) {
    if (existsSync(current)) {
      return missing.length === 0 ? realpathSync(current) : join(realpathSync(current), ...missing)
    }
    const parent = dirname(current)
    // `dirname('/')` is `'/'`: the root itself does not exist, which on a sane
    // filesystem cannot happen, but the loop must still terminate.
    if (parent === current) return target
    missing.unshift(basename(current))
    current = parent
  }
}

/** The working directory's own real path, or a refusal the model can read. */
export function realWorkdir(workdir: string): string {
  if (typeof workdir !== 'string' || workdir.trim().length === 0) {
    throw validation('This chat has no working directory')
  }
  try {
    return realpathSync(workdir)
  } catch {
    throw validation(`The working directory no longer exists: ${workdir}`, { path: workdir })
  }
}

/**
 * `input` resolved inside `workdir`, or a refusal.
 *
 * `input` may be relative to the folder or absolute; either way the result is
 * inside the folder or the call throws. An empty path means the folder itself,
 * which is what makes `list_dir` and `search_files` callable with no argument.
 */
export function resolveInWorkdir(workdir: string, input: string | undefined): ResolvedPath {
  const root = realWorkdir(workdir)
  const wanted = typeof input === 'string' ? input.trim() : ''
  const target = wanted.length === 0 ? root : isAbsolute(wanted) ? resolve(wanted) : resolve(root, wanted)

  if (!isInside(root, target) || !isInside(root, realPathOf(target))) {
    throw validation(`That path is outside the working directory: ${wanted || input || '.'}`, {
      path: wanted
    })
  }

  const rel = relative(root, target)
  return { absolute: target, relative: rel.length === 0 ? '.' : rel }
}
