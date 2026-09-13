/**
 * `skills.*` — the skills library as the settings page sees it.
 *
 * Thin, like every other namespace file: the filesystem work belongs to
 * `skills/loader.ts`, which is handed a directory and knows nothing about the
 * context. What lives here is the one thing the loader cannot decide — *which*
 * directory, which is `skillsDir(ctx)`, derived from the injected `userDataDir`
 * — plus the input validation every handler owes the renderer.
 *
 * Deleting a skill deliberately does **not** unbind it from the agents that
 * listed it, unlike `mcp.delete`. A skill is referenced by name rather than by
 * id, and the name is what the user would re-import it under: dropping the
 * binding would silently unconfigure every agent the moment a folder is moved,
 * whereas keeping it lets the agent editor show the name with a "missing" tag
 * and the agent turn skip it until it comes back.
 */
import { skillsDir } from '../app-context'
import { validation } from '../errors'
import { deleteSkill, importSkill, readSkill, scanSkillsWithWarnings } from '../skills/loader'
import type { HandlerModule } from './types'

function assertName(input: unknown): asserts input is { name: string } {
  const name = (input as { name?: unknown })?.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw validation('A skill name is required')
  }
}

export const skillHandlers: HandlerModule = {
  'skills.list': async (ctx) => scanSkillsWithWarnings(skillsDir(ctx)),

  'skills.import': async (ctx, input) => {
    const sourcePath = (input as { sourcePath?: unknown })?.sourcePath
    if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
      throw validation('A source folder is required')
    }
    const overwrite = (input as { overwrite?: unknown })?.overwrite
    if (overwrite !== undefined && typeof overwrite !== 'boolean') {
      throw validation('overwrite must be a boolean')
    }
    return importSkill(skillsDir(ctx), sourcePath, { ...(overwrite ? { overwrite } : {}) })
  },

  'skills.read': async (ctx, input) => {
    assertName(input)
    return readSkill(skillsDir(ctx), input.name)
  },

  'skills.delete': async (ctx, input) => {
    assertName(input)
    deleteSkill(skillsDir(ctx), input.name)
  }
}
