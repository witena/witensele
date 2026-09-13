/**
 * `skills.*` against a real temporary `userData` directory.
 *
 * The loader's own suite covers the filesystem rules; what is asserted here is
 * the handler layer's share of the work — that the directory comes from the
 * injected `userDataDir` and nowhere else, that bad input is refused before it
 * reaches the disk, and that a deleted skill stays listed on the agents that
 * named it (which is the decision `skills.ts` documents).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppContext } from '../app-context'
import { skillsDir } from '../app-context'
import { agentInput, createTestDatabase, providerInput, type TestDatabase } from '../db/testing'
import { invalidateSkillCache } from '../skills/loader'
import { createTestAppContext } from '../testing'
import { buildHandlers } from './index'

describe('handlers/skills', () => {
  let database: TestDatabase
  let ctx: AppContext
  const handlers = buildHandlers()

  /** Writes a skill folder into the context's own library. */
  function writeSkill(folder: string, frontmatter: string, body = 'Body.'): string {
    const dir = join(skillsDir(ctx), folder)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
    invalidateSkillCache(skillsDir(ctx))
    return dir
  }

  beforeEach(() => {
    database = createTestDatabase()
    ctx = createTestAppContext(database).ctx
    invalidateSkillCache()
  })

  afterEach(() => {
    invalidateSkillCache()
    ctx.close()
  })

  describe('skills.list', () => {
    it('is empty on an installation that has never imported one', async () => {
      await expect(handlers['skills.list'](ctx)).resolves.toEqual({ skills: [], warnings: [] })
    })

    it('reads the library under the injected userDataDir', async () => {
      writeSkill('architecture-review', 'description: Review a design\nversion: 1.0.0')

      const result = await handlers['skills.list'](ctx)

      expect(result.skills).toHaveLength(1)
      expect(result.skills[0]?.path).toBe(join(database.dir, 'skills', 'architecture-review'))
      expect(result.skills[0]?.version).toBe('1.0.0')
    })

    it('reports a folder it had to skip', async () => {
      writeSkill('broken', 'name: Broken')

      const result = await handlers['skills.list'](ctx)

      expect(result.skills).toEqual([])
      expect(result.warnings).toEqual([{ folder: 'broken', reason: 'missing-description' }])
    })
  })

  describe('skills.read', () => {
    it('returns the body and the bundled files', async () => {
      const dir = writeSkill('reader', 'description: Reader', '# Heading\n\nInstructions.')
      writeFileSync(join(dir, 'checklist.md'), '# Checklist\n', 'utf8')
      invalidateSkillCache(skillsDir(ctx))

      const detail = await handlers['skills.read'](ctx, { name: 'reader' })

      expect(detail.body).toContain('Instructions.')
      expect(detail.files).toEqual(['checklist.md'])
    })

    it('rejects an empty name with validation', async () => {
      await expect(handlers['skills.read'](ctx, { name: '  ' })).rejects.toMatchObject({
        code: 'validation'
      })
    })

    it('rejects an unknown name with not_found', async () => {
      await expect(handlers['skills.read'](ctx, { name: 'nope' })).rejects.toMatchObject({
        code: 'not_found'
      })
    })
  })

  describe('skills.import', () => {
    /** A skill folder outside the library, as the folder picker would return. */
    function writeSource(folder: string, frontmatter: string): string {
      const dir = join(database.dir, 'downloads', folder)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nBody\n`, 'utf8')
      return dir
    }

    it('copies the folder into the library', async () => {
      const source = writeSource('imported', 'description: Imported')

      const meta = await handlers['skills.import'](ctx, { sourcePath: source })

      expect(meta.folder).toBe('imported')
      expect((await handlers['skills.list'](ctx)).skills).toHaveLength(1)
    })

    it('refuses a second import of the same folder name', async () => {
      const source = writeSource('twice', 'description: Twice')
      await handlers['skills.import'](ctx, { sourcePath: source })

      await expect(handlers['skills.import'](ctx, { sourcePath: source })).rejects.toMatchObject({
        code: 'validation'
      })
    })

    it('replaces it when overwrite is asked for', async () => {
      const source = writeSource('twice', 'description: First')
      await handlers['skills.import'](ctx, { sourcePath: source })
      writeFileSync(join(source, 'SKILL.md'), '---\ndescription: Second\n---\n\nBody\n', 'utf8')

      const meta = await handlers['skills.import'](ctx, { sourcePath: source, overwrite: true })

      expect(meta.description).toBe('Second')
    })

    it('rejects a missing or non-string source path', async () => {
      await expect(handlers['skills.import'](ctx, { sourcePath: '' })).rejects.toMatchObject({
        code: 'validation'
      })
      await expect(
        handlers['skills.import'](ctx, { sourcePath: 42 as unknown as string })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('rejects a non-boolean overwrite flag', async () => {
      const source = writeSource('flagged', 'description: Flagged')

      await expect(
        handlers['skills.import'](ctx, {
          sourcePath: source,
          overwrite: 'yes' as unknown as boolean
        })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('rejects a folder that does not exist with not_found', async () => {
      await expect(
        handlers['skills.import'](ctx, { sourcePath: join(database.dir, 'nowhere') })
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  })

  describe('skills.delete', () => {
    it('removes the folder', async () => {
      writeSkill('doomed', 'description: Doomed')

      await handlers['skills.delete'](ctx, { name: 'doomed' })

      expect((await handlers['skills.list'](ctx)).skills).toEqual([])
    })

    it('leaves the name on the agents that selected it', async () => {
      writeSkill('doomed', 'description: Doomed')
      const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
      const agent = ctx.repos.agents.create(
        agentInput({ providerId: provider.id, skillNames: ['doomed'] }),
        ctx.userId
      )

      await handlers['skills.delete'](ctx, { name: 'doomed' })

      // Referenced by name, not by id: the binding is kept so re-importing the
      // folder restores the agent, and the editor shows it as missing meanwhile.
      expect(ctx.repos.agents.get(agent.id, ctx.userId).skillNames).toEqual(['doomed'])
    })

    it('rejects an unknown name with not_found', async () => {
      await expect(handlers['skills.delete'](ctx, { name: 'nope' })).rejects.toMatchObject({
        code: 'not_found'
      })
    })
  })
})
