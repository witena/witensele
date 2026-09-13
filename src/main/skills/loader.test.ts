/**
 * The skills loader against a real temporary directory.
 *
 * Nothing here is mocked: the point of the module is what it does to files, so
 * the cases write folders, symlinks and binary blobs and assert on what comes
 * back. The traversal cases in particular are security assertions — the skill
 * name and the file path both arrive from a language model — so they are written
 * as "this specific escape is refused", not as "some error happens".
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_SKILL_FILES,
  MAX_SKILL_FILE_BYTES,
  deleteSkill,
  importSkill,
  invalidateSkillCache,
  listSkillFiles,
  readSkill,
  readSkillFile,
  scanSkills,
  scanSkillsWithWarnings,
  seedSkills
} from './loader'

let root: string
let skills: string

/** Writes `<skills>/<folder>/SKILL.md` with the given frontmatter and body. */
function writeSkill(folder: string, frontmatter: string, body = 'Body text.'): string {
  const dir = join(skills, folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
  invalidateSkillCache(skills)
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'witena-skills-'))
  skills = join(root, 'skills')
  mkdirSync(skills, { recursive: true })
  invalidateSkillCache()
})

afterEach(() => {
  invalidateSkillCache()
  rmSync(root, { recursive: true, force: true })
})

describe('scanSkills', () => {
  it('parses name, description, version and tags out of the frontmatter', () => {
    writeSkill(
      'architecture-review',
      'name: architecture-review\ndescription: Review a design\nversion: 1.2.0\ntags:\n  - review\n  - design'
    )

    expect(scanSkills(skills)).toEqual([
      {
        name: 'architecture-review',
        description: 'Review a design',
        path: join(skills, 'architecture-review'),
        folder: 'architecture-review',
        version: '1.2.0',
        tags: ['review', 'design'],
        fileCount: 0
      }
    ])
  })

  it('falls back to the folder name when the frontmatter has none', () => {
    writeSkill('code-review', 'description: Read a diff')

    expect(scanSkills(skills)[0]?.name).toBe('code-review')
  })

  it('accepts tags written as one comma-separated string', () => {
    writeSkill('a', 'description: A\ntags: review, design')

    expect(scanSkills(skills)[0]?.tags).toEqual(['review', 'design'])
  })

  it('skips a skill with no description and reports the folder', () => {
    writeSkill('nameless', 'name: Nameless')
    writeSkill('usable', 'description: Usable')

    const result = scanSkillsWithWarnings(skills)

    expect(result.skills.map((skill) => skill.folder)).toEqual(['usable'])
    expect(result.warnings).toEqual([{ folder: 'nameless', reason: 'missing-description' }])
  })

  it('reports a folder whose frontmatter is malformed rather than throwing', () => {
    const dir = join(skills, 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: [unclosed\n---\nbody\n', 'utf8')

    expect(scanSkillsWithWarnings(skills).warnings).toEqual([
      { folder: 'broken', reason: 'unreadable' }
    ])
  })

  it('ignores folders without a SKILL.md and hidden folders', () => {
    mkdirSync(join(skills, 'not-a-skill'), { recursive: true })
    writeSkill('.hidden', 'description: Should not be listed')
    writeSkill('real', 'description: Real')

    expect(scanSkills(skills).map((skill) => skill.folder)).toEqual(['real'])
  })

  it('answers with an empty library when the directory does not exist', () => {
    expect(scanSkills(join(root, 'nothing-here'))).toEqual([])
  })

  it('caches until something changes it on disk', () => {
    writeSkill('one', 'description: One')
    expect(scanSkills(skills)).toHaveLength(1)

    // Written behind the cache's back: the loader cannot see it yet.
    const dir = join(skills, 'two')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: Two\n---\n', 'utf8')
    expect(scanSkills(skills)).toHaveLength(1)

    invalidateSkillCache(skills)
    expect(scanSkills(skills)).toHaveLength(2)
  })
})

describe('listSkillFiles', () => {
  it('lists bundled files by relative path, excluding SKILL.md and hidden files', () => {
    const dir = writeSkill('bundle', 'description: Bundled')
    writeFileSync(join(dir, 'checklist.md'), '# Checklist\n', 'utf8')
    writeFileSync(join(dir, '.DS_Store'), 'junk', 'utf8')
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'references', 'rules.md'), '# Rules\n', 'utf8')
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'config'), 'secret', 'utf8')
    invalidateSkillCache(skills)

    expect(listSkillFiles(skills, 'bundle')).toEqual(['checklist.md', join('references', 'rules.md')])
  })

  it('does not follow a symlink out of the skill folder', () => {
    const dir = writeSkill('linky', 'description: Linky')
    writeFileSync(join(root, 'outside.txt'), 'secret', 'utf8')
    symlinkSync(join(root, 'outside.txt'), join(dir, 'outside.txt'))
    invalidateSkillCache(skills)

    expect(listSkillFiles(skills, 'linky')).toEqual([])
  })

  it('stops at the file cap', () => {
    const dir = writeSkill('many', 'description: Many')
    for (let index = 0; index < MAX_SKILL_FILES + 20; index += 1) {
      writeFileSync(join(dir, `file-${String(index).padStart(4, '0')}.md`), 'x', 'utf8')
    }
    invalidateSkillCache(skills)

    expect(listSkillFiles(skills, 'many')).toHaveLength(MAX_SKILL_FILES)
    expect(scanSkills(skills)[0]?.fileCount).toBe(MAX_SKILL_FILES)
  })

  it('rejects an unknown skill with not_found', () => {
    expect(() => listSkillFiles(skills, 'nope')).toThrow(
      expect.objectContaining({ code: 'not_found' })
    )
  })
})

describe('readSkill', () => {
  it('returns the body without the frontmatter, plus the file list', () => {
    const dir = writeSkill('doc', 'description: Doc', '# Heading\n\nThe instructions.')
    writeFileSync(join(dir, 'extra.md'), 'more', 'utf8')
    invalidateSkillCache(skills)

    const detail = readSkill(skills, 'doc')

    expect(detail.body).toBe('# Heading\n\nThe instructions.')
    expect(detail.body).not.toContain('description:')
    expect(detail.files).toEqual(['extra.md'])
    expect(detail.meta.name).toBe('doc')
  })

  it('finds a skill by its folder name as well as its frontmatter name', () => {
    writeSkill('folder-name', 'name: Pretty Name\ndescription: Either way')

    expect(readSkill(skills, 'Pretty Name').meta.folder).toBe('folder-name')
    expect(readSkill(skills, 'folder-name').meta.name).toBe('Pretty Name')
  })
})

describe('readSkillFile', () => {
  it('reads a bundled file', () => {
    const dir = writeSkill('reader', 'description: Reader')
    writeFileSync(join(dir, 'checklist.md'), '# Checklist\n1. First item\n', 'utf8')
    invalidateSkillCache(skills)

    expect(readSkillFile(skills, 'reader', 'checklist.md')).toContain('First item')
  })

  it('refuses a path that climbs out with ..', () => {
    writeSkill('guard', 'description: Guard')
    writeFileSync(join(root, 'secret.txt'), 'sk-live-1234', 'utf8')

    expect(() => readSkillFile(skills, 'guard', '../../secret.txt')).toThrow(
      expect.objectContaining({ code: 'validation' })
    )
  })

  it('refuses a path that reaches a sibling skill', () => {
    writeSkill('guard', 'description: Guard')
    writeSkill('other', 'description: Other')

    expect(() => readSkillFile(skills, 'guard', '../other/SKILL.md')).toThrow(
      expect.objectContaining({ code: 'validation' })
    )
  })

  it('refuses an absolute path', () => {
    writeSkill('guard', 'description: Guard')
    writeFileSync(join(root, 'secret.txt'), 'sk-live-1234', 'utf8')

    expect(() => readSkillFile(skills, 'guard', join(root, 'secret.txt'))).toThrow(
      expect.objectContaining({ code: 'validation' })
    )
  })

  it('refuses a symlink that points outside the skill folder', () => {
    const dir = writeSkill('guard', 'description: Guard')
    writeFileSync(join(root, 'secret.txt'), 'sk-live-1234', 'utf8')
    symlinkSync(join(root, 'secret.txt'), join(dir, 'link.txt'))
    invalidateSkillCache(skills)

    expect(() => readSkillFile(skills, 'guard', 'link.txt')).toThrow(
      expect.objectContaining({ code: 'validation' })
    )
  })

  it('refuses a file that is not text', () => {
    const dir = writeSkill('binary', 'description: Binary')
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    invalidateSkillCache(skills)

    expect(() => readSkillFile(skills, 'binary', 'logo.png')).toThrow(/not text/)
  })

  it('refuses a file over the size cap', () => {
    const dir = writeSkill('big', 'description: Big')
    writeFileSync(join(dir, 'huge.md'), 'a'.repeat(MAX_SKILL_FILE_BYTES + 1), 'utf8')
    invalidateSkillCache(skills)

    expect(() => readSkillFile(skills, 'big', 'huge.md')).toThrow(/limit/)
  })

  it('rejects a file that does not exist with not_found', () => {
    writeSkill('empty', 'description: Empty')

    expect(() => readSkillFile(skills, 'empty', 'missing.md')).toThrow(
      expect.objectContaining({ code: 'not_found' })
    )
  })
})

describe('importSkill', () => {
  /** A skill folder somewhere outside the library, as a user would pick it. */
  function writeSource(folder: string, frontmatter: string): string {
    const dir = join(root, 'downloads', folder)
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nBody\n`, 'utf8')
    writeFileSync(join(dir, 'references', 'notes.md'), '# Notes\n', 'utf8')
    return dir
  }

  it('copies the folder and everything in it', () => {
    const source = writeSource('imported', 'name: Imported\ndescription: An imported skill')

    const meta = importSkill(skills, source)

    expect(meta.name).toBe('Imported')
    expect(meta.folder).toBe('imported')
    expect(meta.path).toBe(join(skills, 'imported'))
    expect(listSkillFiles(skills, 'Imported')).toEqual([join('references', 'notes.md')])
    expect(scanSkills(skills)).toHaveLength(1)
  })

  it('refuses a folder that is already there', () => {
    const source = writeSource('twice', 'description: Twice')
    importSkill(skills, source)

    expect(() => importSkill(skills, source)).toThrow(
      expect.objectContaining({ code: 'validation' })
    )
  })

  it('replaces it when overwrite is asked for', () => {
    const source = writeSource('twice', 'description: First version')
    importSkill(skills, source)
    writeFileSync(join(source, 'SKILL.md'), '---\ndescription: Second version\n---\n\nBody\n', 'utf8')

    expect(importSkill(skills, source, { overwrite: true }).description).toBe('Second version')
    expect(scanSkills(skills)).toHaveLength(1)
  })

  it('refuses a folder without a SKILL.md, and copies nothing', () => {
    const source = join(root, 'downloads', 'plain')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'readme.md'), 'nothing here', 'utf8')

    expect(() => importSkill(skills, source)).toThrow(/SKILL\.md/)
    expect(scanSkills(skills)).toEqual([])
  })

  it('refuses a SKILL.md with no description, and copies nothing', () => {
    const source = writeSource('undescribed', 'name: Undescribed')

    expect(() => importSkill(skills, source)).toThrow(/description/)
    expect(scanSkills(skills)).toEqual([])
  })

  it('refuses a file rather than a folder', () => {
    const file = join(root, 'skill.md')
    writeFileSync(file, 'not a folder', 'utf8')

    expect(() => importSkill(skills, file)).toThrow(
      expect.objectContaining({ code: 'validation' })
    )
  })
})

describe('deleteSkill', () => {
  it('removes the folder and drops it from the next scan', () => {
    writeSkill('doomed', 'description: Doomed')
    writeSkill('kept', 'description: Kept')

    deleteSkill(skills, 'doomed')

    expect(scanSkills(skills).map((skill) => skill.folder)).toEqual(['kept'])
  })
})

describe('seedSkills', () => {
  /** The `resources/skills/` folder a build ships. */
  function writeBundle(): string {
    const dir = join(root, 'resources', 'skills', 'sample')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: A sample\n---\n\nBody\n', 'utf8')
    writeFileSync(join(dir, 'checklist.md'), '# Checklist\n', 'utf8')
    return join(root, 'resources', 'skills')
  }

  it('copies the bundled skills into an empty library', () => {
    const bundle = writeBundle()

    expect(seedSkills(bundle, skills)).toEqual(['sample'])
    expect(scanSkills(skills).map((skill) => skill.folder)).toEqual(['sample'])
    expect(listSkillFiles(skills, 'sample')).toEqual(['checklist.md'])
  })

  it('creates the library directory when it does not exist yet', () => {
    const bundle = writeBundle()
    const fresh = join(root, 'fresh', 'skills')

    expect(seedSkills(bundle, fresh)).toEqual(['sample'])
    expect(scanSkills(fresh)).toHaveLength(1)
  })

  it('leaves a library that already has something in it alone', () => {
    const bundle = writeBundle()
    writeSkill('mine', 'description: Mine')

    expect(seedSkills(bundle, skills)).toEqual([])
    expect(scanSkills(skills).map((skill) => skill.folder)).toEqual(['mine'])
  })

  it('does nothing when the build ships no skills', () => {
    expect(seedSkills(join(root, 'no-resources'), skills)).toEqual([])
  })
})
