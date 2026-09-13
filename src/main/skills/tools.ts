/**
 * The two built-in skill tools: `read_skill` and `read_skill_file`.
 *
 * They are the second half of progressive disclosure. The system prompt lists
 * every enabled skill as `name — description` and nothing more; when the agent
 * decides one of them applies, it calls `read_skill` for the full instructions
 * and `read_skill_file` for whatever the skill bundled beside them.
 *
 * ## Why these are attached regardless of the side-effects rule
 *
 * `collectAgentTools` withholds a `sideEffects` MCP server from every agent that
 * is not an `executor` (PLAN.md, "Future extension"). These two tools are not
 * subject to that rule because they are **read-only and confined**: they can
 * reach exactly the files under `userData/skills/`, which the user put there on
 * purpose for the agent to read, and they change nothing. The rule exists to
 * stop several models writing over each other's work; a read of a document the
 * user imported is the opposite of that.
 *
 * The confinement is enforced in `loader.ts` (`resolveInside`), not here: the
 * skill name and the path both come from a language model, so they are untrusted
 * input, and a traversal attempt is answered with an error the model sees rather
 * than with a file.
 *
 * ## Schemas
 *
 * Declared as raw JSON Schema through the AI SDK's `jsonSchema()` helper, the
 * same way MCP tools are wrapped in `mcp/tools.ts`. A zod schema would be
 * idiomatic too, but one schema dialect in the tool layer is one thing to check
 * against a provider when a model starts refusing a call.
 */
import { jsonSchema, tool, type ToolSet } from 'ai'
import type { SkillMeta } from '@shared/types'
import { listSkillFiles, readSkill, readSkillFile } from './loader'

/** Tool the agent calls to read one skill's full instructions. */
export const READ_SKILL_TOOL = 'read_skill'

/** Tool the agent calls to read a file the skill ships beside `SKILL.md`. */
export const READ_SKILL_FILE_TOOL = 'read_skill_file'

/** How many bundled file names are appended to a `read_skill` answer. */
const LISTED_FILES = 40

/**
 * The `Skills` section of the system prompt: one line per enabled skill.
 *
 * Model-facing text, so it is English only and not an i18n key — the same rule
 * the group briefing follows, minus the bilingual treatment, because this is a
 * list of user-authored names rather than instructions to follow.
 */
export function buildSkillsSection(skills: readonly SkillMeta[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((skill) => `- ${skill.name} — ${skill.description}`)
  return [
    'Skills available to you:',
    ...lines,
    '',
    `Only the names and descriptions above are loaded. When one of them applies, call ${READ_SKILL_TOOL} with its name to read the full instructions, and ${READ_SKILL_FILE_TOOL} for any file it refers to. Do not guess at a skill's contents.`
  ].join('\n')
}

/**
 * `read_skill` / `read_skill_file`, bound to one skills directory and to the
 * names this agent has enabled.
 *
 * `allowed` is the agent's own `skillNames`: a skill the user did not tick is
 * not readable, so a model cannot help itself to another agent's instructions by
 * guessing a name. A name that no longer exists on disk is simply not in the
 * list, and the tool answers with the names that are.
 */
export function buildSkillTools(skillsDir: string, skills: readonly SkillMeta[]): ToolSet {
  if (skills.length === 0) return {}

  const byName = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill]))
  const known = (): string => skills.map((skill) => skill.name).join(', ')

  /** The enabled skill a call named, or a rejection the model can act on. */
  const resolve = (name: unknown): SkillMeta => {
    const wanted = typeof name === 'string' ? name.trim().toLowerCase() : ''
    const skill = byName.get(wanted)
    if (!skill) throw new Error(`Unknown skill: ${String(name)}. Available skills: ${known()}`)
    return skill
  }

  return {
    [READ_SKILL_TOOL]: tool({
      description:
        'Read the full instructions of one of the skills listed in your system prompt. Use it before following a skill you have only seen the description of.',
      inputSchema: jsonSchema<{ name: string }>({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The skill name exactly as it is listed.' }
        },
        required: ['name'],
        additionalProperties: false
      }),
      execute: async ({ name }) => {
        const skill = resolve(name)
        const detail = readSkill(skillsDir, skill.name)
        const files = detail.files.slice(0, LISTED_FILES)
        const listing =
          files.length > 0
            ? `\n\nFiles bundled with this skill (read one with ${READ_SKILL_FILE_TOOL}):\n${files
                .map((file) => `- ${file}`)
                .join('\n')}`
            : ''
        return `# ${detail.meta.name}\n\n${detail.body}${listing}`
      }
    }),

    [READ_SKILL_FILE_TOOL]: tool({
      description:
        "Read one of the files bundled with a skill. The path is relative to the skill's own folder, exactly as read_skill listed it.",
      inputSchema: jsonSchema<{ name: string; path: string }>({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The skill the file belongs to.' },
          path: { type: 'string', description: "Path relative to the skill's folder." }
        },
        required: ['name', 'path'],
        additionalProperties: false
      }),
      execute: async ({ name, path }) => {
        const skill = resolve(name)
        try {
          return readSkillFile(skillsDir, skill.name, path)
        } catch (error) {
          // The available names are worth more to a model than the failure is:
          // a wrong path is almost always a guessed one.
          const files = listSkillFiles(skillsDir, skill.name).slice(0, LISTED_FILES)
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(
            files.length > 0
              ? `${detail}. Files in ${skill.name}: ${files.join(', ')}`
              : `${detail}. ${skill.name} bundles no files.`
          )
        }
      }
    })
  }
}
