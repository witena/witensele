/**
 * The templates are data, so this is a set of invariants rather than examples:
 * everything the first-run card and `agents.create` assume about an entry is
 * asserted once here, and a template that breaks an assumption fails before it
 * reaches a screen.
 *
 * The assertion that is *not* here is that every template has a description in
 * both locale files — that lives in `src/renderer/src/i18n/locales.test.ts`,
 * where the two trees are already loaded and flattened, exactly as the MCP
 * presets do it.
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_TEMPLATES,
  getAgentTemplate,
  suggestedModel,
  type AgentTemplate
} from './agent-templates'

const byId = (id: string): AgentTemplate => {
  const template = getAgentTemplate(id)
  if (!template) throw new Error(`missing template: ${id}`)
  return template
}

describe('AGENT_TEMPLATES', () => {
  it('offers a short list, not a catalogue', () => {
    expect(AGENT_TEMPLATES.length).toBeGreaterThanOrEqual(2)
    expect(AGENT_TEMPLATES.length).toBeLessThanOrEqual(3)
  })

  it('has unique ids and unique names', () => {
    const ids = AGENT_TEMPLATES.map((template) => template.id)
    expect(ids).toEqual([...new Set(ids)])

    // `agents.create` refuses a name another agent already holds, so two
    // templates sharing one would make the second tile fail on click.
    const names = AGENT_TEMPLATES.map((template) => template.name.toLowerCase())
    expect(names).toEqual([...new Set(names)])
  })

  it('carries a name every `@mention` rule accepts', () => {
    for (const template of AGENT_TEMPLATES) {
      expect(template.name.trim(), template.id).toBe(template.name)
      expect(template.name.length, template.id).toBeGreaterThan(0)
      // The three rules `src/main/handlers/agents.ts` enforces on a name.
      expect(template.name.includes('@'), template.id).toBe(false)
    }
  })

  it('carries a stored prompt and description in English', () => {
    for (const template of AGENT_TEMPLATES) {
      expect(template.systemPrompt.length, template.id).toBeGreaterThan(40)
      expect(template.description.length, template.id).toBeGreaterThan(0)
      // Stored content is committed English (CLAUDE.md rule #1); only
      // `zh-CN.json` may hold CJK.
      expect(/[㐀-鿿]/.test(template.systemPrompt), template.id).toBe(false)
      expect(/[㐀-鿿]/.test(template.description), template.id).toBe(false)
    }
  })

  it('keeps every model hint lowercase, so the substring match is meaningful', () => {
    for (const template of AGENT_TEMPLATES) {
      expect(template.modelHints.length, template.id).toBeGreaterThan(0)
      for (const hint of template.modelHints) {
        expect(hint, `${template.id}: ${hint}`).toBe(hint.toLowerCase())
      }
    }
  })

  it('points every palette index at a colour the agent editor offers', () => {
    for (const template of AGENT_TEMPLATES) {
      expect(Number.isInteger(template.paletteIndex), template.id).toBe(true)
      expect(template.paletteIndex, template.id).toBeGreaterThanOrEqual(0)
      // `AGENT_AVATAR_COLORS` has eight entries; the renderer falls back to the
      // default pair for anything else, so this is a readability rule.
      expect(template.paletteIndex, template.id).toBeLessThan(8)
    }
  })

  it('finds a template by id and answers undefined for anything else', () => {
    expect(byId('assistant').name).toBe('Assistant')
    expect(getAgentTemplate('nope')).toBeUndefined()
  })
})

describe('suggestedModel', () => {
  const assistant = byId('assistant')
  const critic = byId('critic')

  it('prefers the earliest hint that matches, not the first model', () => {
    expect(suggestedModel(assistant, ['deepseek-r1:70b', 'qwen2.5:3b-instruct'])).toBe(
      'qwen2.5:3b-instruct'
    )
    expect(suggestedModel(critic, ['qwen2.5:3b-instruct', 'deepseek-r1:7b'])).toBe('deepseek-r1:7b')
  })

  it('matches case-insensitively, because model ids are not normalised', () => {
    expect(suggestedModel(assistant, ['GPT-4O-MINI'])).toBe('GPT-4O-MINI')
  })

  it('falls back to the provider’s own first model when nothing matches', () => {
    expect(suggestedModel(assistant, ['llama3.2', 'phi4'])).toBe('llama3.2')
  })

  it('answers undefined for a provider with no models', () => {
    expect(suggestedModel(assistant, [])).toBeUndefined()
  })
})
