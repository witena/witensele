/**
 * The skills library: `<skillsDir>/<folder>/SKILL.md` plus whatever resources
 * the author bundled beside it.
 *
 * The format is the open **Agent Skills** one: a folder whose `SKILL.md` carries
 * YAML frontmatter (`name`, `description`, optionally `version` and `tags`) and
 * a markdown body. Nothing about it is Witena-specific, which is the point — a
 * skill written for another agent runtime can be dropped in unchanged.
 *
 * ## Progressive disclosure
 *
 * Only `name` and `description` reach the system prompt. The body is fetched by
 * the agent with `read_skill` and the bundled files with `read_skill_file`
 * (`src/main/skills/tools.ts`). A dozen skills therefore cost a dozen lines of
 * context rather than a dozen documents, and the agent pays for the full text of
 * exactly the one it decided it needs.
 *
 * ## Rules this module enforces
 *
 * - **A skill without a `description` is skipped**, and reported in the warning
 *   list rather than dropped silently: the description is the *only* thing the
 *   model sees, so a skill without one can never be chosen and the user has to
 *   be told which folder it was.
 * - **`name` falls back to the folder name.** A hand-written SKILL.md that only
 *   has a description is still usable, and the folder name is what the user sees
 *   on disk anyway.
 * - **Nothing is read from outside the skill folder.** Every path a caller
 *   supplies goes through `resolveInside`, which rejects `..`, absolute paths
 *   and symlinks that leave the folder. The names come from a model, so this is
 *   a real input-validation boundary rather than a formality.
 * - **Hidden files are invisible.** `.DS_Store`, `.git` and friends are noise at
 *   best and a way to read a stray credential file at worst.
 *
 * This module imports no electron and knows no context: it is handed a directory
 * (CLAUDE.md rule #5), which is what lets every case below be tested against a
 * temporary folder.
 */
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  type Dirent
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import matter from 'gray-matter'
import type { SkillDetail, SkillMeta, SkillWarning } from '@shared/types'
import { notFound, validation } from '../errors'

/** The one file that makes a folder a skill. */
export const SKILL_FILE = 'SKILL.md'

/**
 * How many bundled files are listed per skill.
 *
 * A skill that ships a whole checked-out repository would otherwise walk it on
 * every scan and hand a model a listing nobody can use. The cap is a listing
 * cap, not a storage one: file 201 is still readable by name.
 */
export const MAX_SKILL_FILES = 200

/** How deep the resource walk goes, so a symlink loop cannot spin forever. */
const MAX_WALK_DEPTH = 8

/** Largest resource `readSkillFile` will return, in bytes. */
export const MAX_SKILL_FILE_BYTES = 200 * 1024

/** Bytes inspected when deciding whether a file is text. */
const BINARY_SNIFF_BYTES = 8_000

/* -------------------------------------------------------------------------- */
/* Cache                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Parsed skills per directory.
 *
 * The scan runs on **every agent turn** (the prompt needs each enabled skill's
 * description), so re-reading and re-parsing every SKILL.md each time would put
 * a directory walk in front of every model call. The cache is keyed by the
 * resolved directory rather than held on a context so the two callers that
 * exist — handlers and `agent-turn.ts` — share one, and it is dropped by the two
 * operations that can change what is on disk: `importSkill` and `deleteSkill`.
 *
 * A file edited by hand outside the app is therefore not noticed until an import
 * or a delete. That is the accepted cost; Settings → Skills is where a user
 * would notice, and it is one click away from a reload.
 */
const cache = new Map<string, ScanResult>()

/** Forgets one directory's parsed skills, or all of them when no path is given. */
export function invalidateSkillCache(skillsDir?: string): void {
  if (skillsDir === undefined) cache.clear()
  else cache.delete(resolve(skillsDir))
}

/* -------------------------------------------------------------------------- */
/* Scanning                                                                    */
/* -------------------------------------------------------------------------- */

export interface ScanResult {
  skills: SkillMeta[]
  /** Folders that look like a skill but could not be used. */
  warnings: SkillWarning[]
}

/** Frontmatter `tags`, which may legitimately be a list or one comma-separated string. */
function toTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tags = value.filter((entry): entry is string => typeof entry === 'string')
    return tags.length > 0 ? tags : undefined
  }
  if (typeof value === 'string') {
    const tags = value
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
    return tags.length > 0 ? tags : undefined
  }
  return undefined
}

function toText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number') return String(value)
  return undefined
}

/** True for a directory entry nobody should ever see (`.DS_Store`, `.git`, …). */
function isHidden(name: string): boolean {
  return name.startsWith('.')
}

/**
 * Parses one skill folder.
 *
 * Returns the meta, or the reason the folder cannot be used. Never throws for a
 * bad skill: one unreadable folder must not stop the other nine from loading.
 */
function parseSkillFolder(skillsDir: string, folder: string): SkillMeta | SkillWarning {
  const path = join(skillsDir, folder)
  const file = join(path, SKILL_FILE)

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { folder, reason: 'unreadable' }
  }

  let parsed: { data: Record<string, unknown>; content: string }
  try {
    parsed = matter(raw) as { data: Record<string, unknown>; content: string }
  } catch {
    // Malformed YAML. The same answer as an unreadable file from the user's
    // point of view: the folder is there and the app will not use it.
    return { folder, reason: 'unreadable' }
  }

  const description = toText(parsed.data['description'])
  if (description === undefined) return { folder, reason: 'missing-description' }

  const version = toText(parsed.data['version'])
  const tags = toTags(parsed.data['tags'])

  return {
    name: toText(parsed.data['name']) ?? folder,
    description,
    path,
    folder,
    ...(version !== undefined ? { version } : {}),
    ...(tags !== undefined ? { tags } : {}),
    fileCount: walkSkillFiles(path).length
  }
}

/** Every skill in the directory, plus the folders that were skipped and why. */
export function scanSkillsWithWarnings(skillsDir: string): ScanResult {
  const root = resolve(skillsDir)
  const cached = cache.get(root)
  if (cached) return cached

  const result: ScanResult = { skills: [], warnings: [] }

  let entries: string[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !isHidden(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    // No skills directory at all is the normal state of a fresh installation,
    // not an error: the answer is an empty library.
    cache.set(root, result)
    return result
  }

  for (const folder of entries) {
    if (!existsSync(join(root, folder, SKILL_FILE))) continue
    const parsed = parseSkillFolder(root, folder)
    if ('reason' in parsed) result.warnings.push(parsed)
    else result.skills.push(parsed)
  }

  cache.set(root, result)
  return result
}

/** Every usable skill in the directory. The warnings are available separately. */
export function scanSkills(skillsDir: string): SkillMeta[] {
  return scanSkillsWithWarnings(skillsDir).skills
}

/**
 * The skill a model or the UI named, matched on `name` first and on the folder
 * second, both case-insensitively.
 *
 * Resolving through the scan rather than joining the name onto the directory is
 * deliberate: the name comes from a language model, and a scan can only ever
 * return a folder that exists inside the library.
 */
export function findSkill(skillsDir: string, name: string): SkillMeta {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw validation('A skill name is required')
  }
  const wanted = name.trim().toLowerCase()
  const skills = scanSkills(skillsDir)
  const match =
    skills.find((skill) => skill.name.toLowerCase() === wanted) ??
    skills.find((skill) => skill.folder.toLowerCase() === wanted)
  if (!match) throw notFound('Skill', name)
  return match
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

/** True when `target` is `root` itself or lives underneath it. */
function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

/**
 * `relPath` resolved inside `root`, or a rejection.
 *
 * Three ways out of a directory, all closed here: an absolute path, a `..`
 * segment, and a symlink pointing elsewhere. The first two are answered by
 * resolving and comparing prefixes; the third needs `realpathSync`, because the
 * resolved path of a symlink is still inside the folder — only what it points at
 * is not.
 */
export function resolveInside(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.trim().length === 0) {
    throw validation('A path is required')
  }
  if (isAbsolute(relPath)) throw validation('An absolute path is not allowed', { path: relPath })

  const realRoot = realpathSync(root)
  const target = resolve(realRoot, relPath)
  if (!isInside(realRoot, target)) {
    throw validation('That path leaves the folder', { path: relPath })
  }
  if (existsSync(target) && !isInside(realRoot, realpathSync(target))) {
    throw validation('That path leaves the folder', { path: relPath })
  }
  return target
}

/* -------------------------------------------------------------------------- */
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

/** Depth-first walk of a skill folder's resources, capped at `MAX_SKILL_FILES`. */
function walkSkillFiles(skillPath: string): string[] {
  const found: string[] = []

  const walk = (directory: string, depth: number): void => {
    if (found.length >= MAX_SKILL_FILES || depth > MAX_WALK_DEPTH) return

    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_SKILL_FILES) return
      if (isHidden(entry.name)) continue
      // A symlink is not followed at all: it is the one entry whose target may
      // be anywhere on the disk, and a skill has no reason to ship one.
      if (entry.isSymbolicLink()) continue

      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const rel = relative(skillPath, full)
      if (rel === SKILL_FILE) continue
      found.push(rel)
    }
  }

  walk(skillPath, 0)
  return found
}

/**
 * The skill's bundled resources, as paths relative to its folder.
 *
 * `SKILL.md` itself is excluded (it is `read_skill`'s job), as are hidden files
 * and symlinks, and the list stops at `MAX_SKILL_FILES`.
 */
export function listSkillFiles(skillsDir: string, name: string): string[] {
  return walkSkillFiles(findSkill(skillsDir, name).path)
}

/** True when a buffer holds a NUL byte in its first `BINARY_SNIFF_BYTES`. */
function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES)
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

/**
 * One bundled resource, as text.
 *
 * Rejects a path that leaves the folder, a file over `MAX_SKILL_FILE_BYTES` and
 * anything that is not text: all three end up in a model's context window, and a
 * megabyte of PNG there is a wasted turn rather than a useful error.
 */
export function readSkillFile(skillsDir: string, name: string, relPath: string): string {
  const skill = findSkill(skillsDir, name)
  const target = resolveInside(skill.path, relPath)

  let stats
  try {
    stats = statSync(target)
  } catch {
    throw notFound('Skill file', relPath)
  }
  if (!stats.isFile()) throw notFound('Skill file', relPath)
  if (stats.size > MAX_SKILL_FILE_BYTES) {
    throw validation(
      `That file is ${Math.round(stats.size / 1024)} KB; the limit is ${MAX_SKILL_FILE_BYTES / 1024} KB`,
      { path: relPath }
    )
  }

  const buffer = readFileSync(target)
  if (looksBinary(buffer)) {
    throw validation('That file is not text', { path: relPath })
  }
  return buffer.toString('utf8')
}

/** The skill's frontmatter, body and file list — what `skills.read` answers with. */
export function readSkill(skillsDir: string, name: string): SkillDetail {
  const meta = findSkill(skillsDir, name)
  const raw = readFileSync(join(meta.path, SKILL_FILE), 'utf8')
  const parsed = matter(raw) as { content: string }
  return { meta, body: parsed.content.trim(), files: walkSkillFiles(meta.path) }
}

/* -------------------------------------------------------------------------- */
/* Import and delete                                                           */
/* -------------------------------------------------------------------------- */

export interface ImportSkillOptions {
  /** Replaces a skill folder of the same name instead of refusing. */
  overwrite?: boolean
}

/**
 * Copies a skill folder into the library.
 *
 * The source is validated **before** anything is copied — it must be a folder,
 * it must contain `SKILL.md`, and that file must declare a description — so a
 * refused import leaves no half-written folder behind. The destination folder
 * name is the source's own, because that is the name the user recognizes and
 * because a name derived from the frontmatter would collide the moment two
 * skills share a title.
 */
export function importSkill(
  skillsDir: string,
  sourcePath: string,
  options: ImportSkillOptions = {}
): SkillMeta {
  if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
    throw validation('A source folder is required')
  }

  const source = resolve(sourcePath)
  let stats
  try {
    stats = statSync(source)
  } catch {
    throw notFound('Folder', sourcePath)
  }
  if (!stats.isDirectory()) throw validation('A skill must be imported as a folder', { sourcePath })
  if (!existsSync(join(source, SKILL_FILE))) {
    throw validation(`That folder has no ${SKILL_FILE}`, { sourcePath })
  }

  const folder = basename(source)
  // Parsed from the source, so a skill with no description is refused before a
  // single byte is written.
  const parsedSource = parseSkillFolder(resolve(source, '..'), folder)
  if ('reason' in parsedSource) {
    throw validation(
      parsedSource.reason === 'missing-description'
        ? `${SKILL_FILE} must declare a description`
        : `${SKILL_FILE} could not be read`,
      { sourcePath }
    )
  }

  const root = resolve(skillsDir)
  const target = join(root, folder)
  if (existsSync(target)) {
    if (options.overwrite !== true) {
      throw validation(`A skill folder named "${folder}" already exists`, { folder })
    }
    rmSync(target, { recursive: true, force: true })
  }

  // `dereference` so a source folder whose files are symlinks lands as real
  // files: the library must not hold a pointer into a directory the user may
  // move or delete tomorrow.
  cpSync(source, target, { recursive: true, dereference: true })
  invalidateSkillCache(root)

  return findSkill(root, parsedSource.name)
}

/** Removes a skill folder. Agents keep the name; the editor marks it missing. */
export function deleteSkill(skillsDir: string, name: string): void {
  const skill = findSkill(skillsDir, name)
  rmSync(skill.path, { recursive: true, force: true })
  invalidateSkillCache(skillsDir)
}

/* -------------------------------------------------------------------------- */
/* First-launch seeding                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Copies the skills bundled with the application into an empty library.
 *
 * Only when the library is **empty**: a user who deleted the sample must not
 * find it back on the next launch, and a user who edited it must keep the edit.
 * Returns the folder names that were copied, for the log line.
 */
export function seedSkills(sourceDir: string, skillsDir: string): string[] {
  const root = resolve(skillsDir)
  if (scanSkillsWithWarnings(root).skills.length > 0) return []
  if (existsSync(root) && readdirSync(root).some((entry) => !isHidden(entry))) return []

  let folders: string[]
  try {
    folders = readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !isHidden(entry.name))
      .map((entry) => entry.name)
  } catch {
    // A build without bundled skills is not a failure; there is simply nothing
    // to seed.
    return []
  }

  const copied: string[] = []
  for (const folder of folders) {
    if (!existsSync(join(sourceDir, folder, SKILL_FILE))) continue
    cpSync(join(sourceDir, folder), join(root, folder), { recursive: true, dereference: true })
    copied.push(folder)
  }

  invalidateSkillCache(root)
  return copied
}
