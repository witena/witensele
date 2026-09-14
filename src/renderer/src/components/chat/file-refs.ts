/**
 * Finding the file paths inside a message, so they can be clicked (S5.7).
 *
 * Models write paths in prose — "I changed `src/main/index.ts:42`", "the failure
 * is in test/run.ts" — and none of them arrive as a `FileRefPart`. This module is
 * the detector that turns those tokens into chips, and it is pure text: no DOM,
 * no `node:path` (the renderer project has no Node types — see `lib/workdir.ts`
 * for the same rule), no filesystem.
 *
 * ## The two halves
 *
 * `absoluteInWorkdir` is the resolver: a token, relative or absolute, against the
 * chat's folder, answering with the absolute path when it stays inside and `null`
 * when it does not. `diff-block.tsx` and `tool-card.tsx` use it directly, because
 * they already know they are holding a path and only need it absolutised.
 *
 * `findFileRefs` is the detector, and it is the harder half, because it is
 * looking at arbitrary prose. Its job is not to find every path — it is to
 * **never draw a chip on something that is not one**. A missed reference is a
 * path the user copies by hand, which is what they do today; a wrong one is a
 * button that opens a file nobody mentioned.
 *
 * ## What is rejected, and why each rule is there
 *
 * | Token | Rejected by |
 * |---|---|
 * | `https://example.com/a/b.ts` | a `://` anywhere in it |
 * | `mailto:someone@example.com` | a `:` left in the path after the `:line` suffix is taken off |
 * | `1.2:3` (a version, not a path) | the extension `2` has no letter in it |
 * | `C:\Users\ada\a.ts` | a backslash, and the drive-letter prefix |
 * | `and/or`, `read/write` in prose | no extension on the last segment |
 * | `someone@example.com` | an `@` in a token that has no separator at all |
 * | `/etc/passwd` | it resolves outside the chat's folder |
 * | `src/main.ts,` at the end of a sentence | the trailing comma is stripped first, and the rest is a path |
 *
 * The one rule that pulls the most weight is the **extension** rule: a relative
 * token has to end in a `.ext` of one to ten characters with at least one ASCII
 * letter in it. That is what separates `README.md` from `1.2`, and `src/a.ts`
 * from `and/or`. It is also why `Makefile` and `LICENSE` are never chips — a
 * known limitation, accepted because the alternative is chips on ordinary words.
 *
 * ## Lexical, not resolved
 *
 * Containment is computed by normalising `.` and `..` and comparing prefixes.
 * The renderer cannot follow a symlink or stat a file, so this cannot be the
 * security boundary and is not asked to be: `system.openInEditor` re-resolves
 * every path through `realpathSync` in the main process
 * (`src/main/editor/open.ts`), which is where a symlink out of the folder is
 * actually caught. This half exists to decide what to *draw*.
 */
import type { FileRefPart } from '@shared/types'

/** A reference found in a message body, with where it sat in the text. */
export interface DetectedFileRef extends FileRefPart {
  /** The absolute path to hand to `system.openInEditor`. */
  absolute: string
  /** Index of the first character of the token in the source text. */
  start: number
  /** Index one past its last character. */
  end: number
}

/** Punctuation a path may be wrapped in when it sits in a sentence. */
const LEADING_PUNCTUATION = new Set(['(', '[', '{', '"', "'", '`', '<'])
const TRAILING_PUNCTUATION = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  ')',
  ']',
  '}',
  '"',
  "'",
  '`',
  '>'
])

/** `path:42` split into its two halves. A path may legally contain no colon. */
const LINE_SUFFIX = /^(.*?):(\d{1,7})$/

/**
 * The last segment's extension: a dot, then one to ten word characters, at the
 * very end, with at least one ASCII letter among them.
 */
const EXTENSION = /\.(?=[^.]*[A-Za-z])[A-Za-z0-9_]{1,10}$/

/** A Windows drive prefix, which is never a path this app can open. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/

/** Every run of non-whitespace in the text, with its offset. */
const TOKEN = /\S+/g

/** True for a path string that starts at the filesystem root. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/')
}

/**
 * `segments` with `.` dropped and `..` applied, or `null` when a `..` climbs
 * above the first element.
 *
 * Returning `null` rather than clamping at the root is what makes
 * `folder/../../etc` a refusal instead of a path that quietly became `/etc`.
 */
function normalizeSegments(segments: readonly string[]): string[] | null {
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') {
      out.push(segment)
      continue
    }
    if (out.length === 0) return null
    out.pop()
  }
  return out
}

/**
 * `token` resolved against `workdir`, or `null` when it lands outside it.
 *
 * `workdir` may be `null` or empty — a chat that is not bound to a folder — in
 * which case an **absolute** token is returned as itself and a relative one is
 * `null`: without a folder there is nothing to resolve it against, and guessing
 * would open a file in whatever directory the app happens to have.
 */
export function absoluteInWorkdir(
  workdir: string | null | undefined,
  token: string
): string | null {
  const path = typeof token === 'string' ? token.trim() : ''
  if (path.length === 0 || path.includes('\\') || WINDOWS_DRIVE.test(path)) return null

  const root = typeof workdir === 'string' ? workdir.trim().replace(/\/+$/, '') : ''
  if (root.length === 0 || !isAbsolutePath(root)) {
    return isAbsolutePath(path) ? normalizedAbsolute(path) : null
  }

  const rootSegments = normalizeSegments(root.split('/'))
  if (rootSegments === null) return null

  const targetSegments = isAbsolutePath(path)
    ? normalizeSegments(path.split('/'))
    : normalizeSegments([...rootSegments, ...path.split('/')])
  if (targetSegments === null) return null

  // Prefix comparison on whole segments, so `/a/project-old` is not inside
  // `/a/project` merely for sharing its first eleven characters.
  if (targetSegments.length < rootSegments.length) return null
  for (let index = 0; index < rootSegments.length; index += 1) {
    if (targetSegments[index] !== rootSegments[index]) return null
  }
  return `/${targetSegments.join('/')}`
}

/** An absolute path with `.` and `..` applied, or `null` if it climbs past `/`. */
function normalizedAbsolute(path: string): string | null {
  const segments = normalizeSegments(path.split('/'))
  return segments === null ? null : `/${segments.join('/')}`
}

/** `src/a.ts:42` split into the path and the line, if it carries one. */
export function splitLineSuffix(token: string): { path: string; line?: number } {
  const match = LINE_SUFFIX.exec(token)
  if (!match?.[1] || !match[2]) return { path: token }
  return { path: match[1], line: Number(match[2]) }
}

/** Strips the punctuation a path picks up from the sentence around it. */
function trimPunctuation(token: string): { text: string; offset: number } {
  let start = 0
  let end = token.length
  while (start < end && LEADING_PUNCTUATION.has(token[start] as string)) start += 1
  while (end > start && TRAILING_PUNCTUATION.has(token[end - 1] as string)) end -= 1
  return { text: token.slice(start, end), offset: start }
}

/**
 * Whether a token is shaped like a path at all, before the folder is consulted.
 *
 * Absolute tokens are taken on shape alone — containment decides the rest.
 * A relative token must end in a real extension, which is the rule that keeps
 * every `and/or` out of the transcript.
 */
function looksLikePath(path: string): boolean {
  if (path.length === 0 || path.includes(':') || path.includes('\\')) return false
  if (WINDOWS_DRIVE.test(path)) return false
  if (path === '.' || path === '..' || path === '/') return false
  if (isAbsolutePath(path)) return true
  // `someone@example.com` passes the extension rule and is not a file. A path
  // with no separator at all has to be a plain filename, and a plain filename
  // does not contain an `@` — while `node_modules/@scope/a.js` still may.
  if (!path.includes('/') && path.includes('@')) return false
  const lastSegment = path.slice(path.lastIndexOf('/') + 1)
  return EXTENSION.test(lastSegment)
}

/**
 * Every file reference in `text` that resolves inside `workdir`, in order.
 *
 * Returns nothing at all when the chat has no folder: with nothing to resolve
 * against, the only tokens that could be chips are absolute ones, and an
 * unconfined absolute path out of a *model* is exactly what rule 2 of
 * `src/main/editor/open.ts` exists to refuse.
 */
export function findFileRefs(text: string, workdir: string | null | undefined): DetectedFileRef[] {
  const root = typeof workdir === 'string' ? workdir.trim() : ''
  if (root.length === 0 || typeof text !== 'string' || text.length === 0) return []

  const refs: DetectedFileRef[] = []
  TOKEN.lastIndex = 0
  for (let match = TOKEN.exec(text); match !== null; match = TOKEN.exec(text)) {
    const raw = match[0]
    if (raw.includes('://')) continue

    const { text: trimmed, offset } = trimPunctuation(raw)
    const { path, line } = splitLineSuffix(trimmed)
    if (!looksLikePath(path)) continue

    const absolute = absoluteInWorkdir(root, path)
    if (absolute === null) continue

    refs.push({
      type: 'file-ref',
      path,
      ...(line === undefined ? {} : { line }),
      absolute,
      start: match.index + offset,
      end: match.index + offset + trimmed.length
    })
  }
  return refs
}
