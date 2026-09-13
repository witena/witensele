/**
 * The chat's materials, in front of the group before anyone speaks (S5.11).
 *
 * `ChatGoal.materials` (S5.10) is the list of files and folders the user marked
 * as the starting point. PLAN.md ("Chat goal and workspace") says what has to
 * happen with it: *their contents are placed in every member's context ahead of
 * the first round, within the context budget, so the discussion opens grounded
 * instead of with a request for the material.*
 *
 * This module is that sentence. It reads the marked paths, lays them out as the
 * `Materials` section of the system prompt, and — the part that makes it safe to
 * do at all — stops before the section eats the window.
 *
 * ## The budget
 *
 * ```
 * budget = contextWindow * MATERIALS_BUDGET_SHARE      // 25 %
 * ```
 *
 * A quarter of the window, measured with the same `estimateTokens` the history
 * is measured with (S4.2), so the two numbers are comparable and one policy
 * explains both. The share is a **fixed fraction rather than what is left over**
 * after the history, because the materials are assembled once per turn while the
 * history grows all chat long: a leftover-based rule would inline a file in round
 * one and silently drop it in round six, and a group that was quoting a document
 * would stop being able to.
 *
 * Items are taken in **list order** until one does not fit, and everything from
 * there on is listed by path with the note that `read_file` fetches it. The
 * stopping rule is deliberately "the rest", not "whatever else fits": a
 * contiguous prefix is a thing a user can predict from the order they wrote, and
 * skipping over a large file to inline three small ones behind it produces a
 * selection nobody can explain. Each item is capped at `MAX_MATERIAL_FILE_BYTES`
 * first, so one enormous file cannot be more than a fraction of the budget
 * anyway.
 *
 * ## What is never inlined
 *
 * - **Binary files.** Detected by extension and then by the same null-byte probe
 *   `read_file` uses (`looksBinary`); they are listed, never inlined, because a
 *   PNG spent as tokens is both useless and expensive.
 * - **A path that no longer exists.** Materials were validated when the goal was
 *   saved (S5.10) and a file can be deleted afterwards. It is dropped silently
 *   rather than listed: listing it would tell the model to `read_file` something
 *   that will answer "no such file".
 *
 * Pure except for reading the files it was pointed at: no electron, no database,
 * no `AppContext` (CLAUDE.md rule #5).
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveInWorkdir } from '../executor/paths'
import { READ_FILE_TOOL, TRUNCATION_MARKER, looksBinary } from '../executor/tools'
import { formatTree, walkTree } from '../executor/workspace'
import { estimateTokens } from './context-budget'

/** The share of the model's context window the materials may occupy. */
export const MATERIALS_BUDGET_SHARE = 0.25

/** Largest amount of one file that is inlined, in bytes. */
export const MAX_MATERIAL_FILE_BYTES = 64 * 1024

/** How many files of one marked folder are considered, in walk order. */
export const MAX_MATERIAL_FOLDER_FILES = 50

/**
 * Extensions that are binary whatever the first bytes say.
 *
 * The null-byte probe is the real test and catches everything this list does;
 * the list exists so a 40 MB video is not read into memory to discover it.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tiff', 'avif', 'heic',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'so', 'dylib', 'dll', 'exe', 'bin', 'o', 'a', 'class', 'wasm',
  'sqlite', 'db', 'pyc', 'DS_Store'
])

/** True when the path's extension alone settles it. */
export function hasBinaryExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/**
 * Whether a file should be inlined as text: the extension first, the bytes
 * second. Returns the text when it is safe to inline, `null` when it is not.
 */
export function readMaterialText(absolute: string, path: string): string | null {
  if (hasBinaryExtension(path)) return null
  let buffer: Buffer
  try {
    buffer = readFileSync(absolute)
  } catch {
    return null
  }
  if (looksBinary(buffer)) return null
  if (buffer.byteLength > MAX_MATERIAL_FILE_BYTES) {
    return `${buffer.subarray(0, MAX_MATERIAL_FILE_BYTES).toString('utf8')}\n${TRUNCATION_MARKER}`
  }
  return buffer.toString('utf8')
}

/** One thing the section may carry: a file's text, or a folder's listing. */
interface MaterialItem {
  /** Path relative to the folder, as the user's goal spells it. */
  path: string
  /** The rendered block, ready to be measured and joined. */
  block: string
  /** Listed rather than inlined whatever the budget says. */
  binary: boolean
}

export interface MaterialsInput {
  /** The chat's folder; every material path is resolved inside it. */
  workdir: string
  /** `ChatGoal.materials`, in the order the user listed them. */
  materials: readonly string[]
  /** The model's context window; the budget is a share of it. */
  contextWindow: number
  /** Override for the share, for the tests. Defaults to `MATERIALS_BUDGET_SHARE`. */
  share?: number
}

export interface MaterialsSection {
  /** The section, or `''` when there is nothing to say. */
  text: string
  /** Paths whose contents are in the section. */
  inlined: string[]
  /** Paths named in the section but not included — what `read_file` is for. */
  listed: string[]
  /** `listed.length`; the turn reports it and `ChatRunner` announces it once. */
  omitted: number
  /** Estimated size of `text`, in the same units as `fitHistory`. */
  estimatedTokens: number
}

/** An empty section, which is also what a chat with no materials produces. */
const EMPTY: MaterialsSection = {
  text: '',
  inlined: [],
  listed: [],
  omitted: 0,
  estimatedTokens: 0
}

/** One file's block, headed by its path so the model can cite it. */
function fileBlock(path: string, content: string): string {
  return `--- ${path} ---\n${content.endsWith('\n') ? content : `${content}\n`}`
}

/**
 * Expands one marked path into the items it contributes.
 *
 * A file is one item. A folder is its listing — which is what makes a folder
 * material useful even when its files do not fit — followed by one item per text
 * file in it, so the budget cuts between files rather than in the middle of one.
 */
function itemsFor(workdir: string, path: string): MaterialItem[] {
  let absolute: string
  let relative: string
  try {
    const resolved = resolveInWorkdir(workdir, path)
    absolute = resolved.absolute
    relative = resolved.relative
  } catch {
    // A material that no longer resolves inside the folder is not the group's
    // problem to solve; it was checked when the goal was saved.
    return []
  }

  let directory: boolean
  try {
    directory = statSync(absolute).isDirectory()
  } catch {
    return []
  }

  if (!directory) {
    const text = readMaterialText(absolute, relative)
    if (text === null) return [{ path: relative, block: '', binary: true }]
    return [{ path: relative, block: fileBlock(relative, text), binary: false }]
  }

  const tree = walkTree(absolute)
  const items: MaterialItem[] = [
    {
      path: relative,
      block: `--- ${relative}/ (folder) ---\n${formatTree(tree) || '(empty)'}\n`,
      binary: false
    }
  ]
  let files = 0
  for (const entry of tree.entries) {
    if (entry.directory) continue
    if (files >= MAX_MATERIAL_FOLDER_FILES) break
    files += 1
    const childPath = `${relative}/${entry.path}`
    const text = readMaterialText(join(absolute, entry.path), childPath)
    if (text === null) items.push({ path: childPath, block: '', binary: true })
    else items.push({ path: childPath, block: fileBlock(childPath, text), binary: false })
  }
  return items
}

/**
 * Builds the `Materials` section, or nothing at all.
 *
 * Model-facing English like the rest of the prompt (CLAUDE.md rule #4 governs UI
 * copy, and no user ever reads this). The heading and the two sentences around
 * the content are what stop a model from treating the blocks as a transcript: it
 * has to know that the user put them there and that it should quote them rather
 * than ask for them.
 */
export function buildMaterialsSection(input: MaterialsInput): MaterialsSection {
  if (input.materials.length === 0) return EMPTY

  const budget = Math.max(0, Math.floor(input.contextWindow * (input.share ?? MATERIALS_BUDGET_SHARE)))
  const inlined: string[] = []
  const listed: { path: string; binary: boolean }[] = []
  const blocks: string[] = []
  let used = 0
  /** Set by the first item that did not fit: everything after it is listed. */
  let full = false

  for (const material of input.materials) {
    for (const item of itemsFor(input.workdir, material)) {
      if (item.binary) {
        listed.push({ path: item.path, binary: true })
        continue
      }
      if (full) {
        listed.push({ path: item.path, binary: false })
        continue
      }
      const cost = estimateTokens(item.block)
      if (used + cost > budget) {
        full = true
        listed.push({ path: item.path, binary: false })
        continue
      }
      used += cost
      blocks.push(item.block)
      inlined.push(item.path)
    }
  }

  if (blocks.length === 0 && listed.length === 0) return EMPTY

  const lines = [
    'Materials',
    '',
    'The user marked these as what this chat starts from. What is included below is already in front of you: quote it and work from it rather than asking anyone for it.'
  ]
  if (blocks.length > 0) {
    lines.push('')
    lines.push(blocks.join('\n'))
  }
  if (listed.length > 0) {
    lines.push('')
    lines.push(
      `These were left out to stay inside the context budget. Fetch one with ${READ_FILE_TOOL}(path) when you need it:`
    )
    lines.push('')
    lines.push(
      listed
        .map((entry) => `- ${entry.path}${entry.binary ? ' (binary, not readable as text)' : ''}`)
        .join('\n')
    )
  }

  const text = lines.join('\n')
  return {
    text,
    inlined,
    listed: listed.map((entry) => entry.path),
    omitted: listed.length,
    estimatedTokens: estimateTokens(text)
  }
}
