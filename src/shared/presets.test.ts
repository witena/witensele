/**
 * The preset table is data, so its test is a set of invariants rather than a set
 * of examples: anything the rest of the app assumes about an entry is asserted
 * here once, and a new preset that breaks an assumption fails before it reaches
 * a screen.
 */
import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS, getPreset, isLocalPreset, type ProviderPreset } from './presets'

const byId = (id: string): ProviderPreset => {
  const preset = getPreset(id)
  if (!preset) throw new Error(`missing preset: ${id}`)
  return preset
}

describe('PROVIDER_PRESETS', () => {
  it('has unique ids', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id)
    expect(ids).toEqual([...new Set(ids)])
  })

  it('ships the presets the plan names', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'anthropic',
        'openai',
        'google',
        'deepseek',
        'qwen',
        'zhipu',
        'moonshot',
        'minimax',
        'volcengine',
        'siliconflow',
        'openrouter',
        'ollama',
        'lmstudio',
        'custom'
      ])
    )
  })

  it('gives every preset a non-empty name and a valid type', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.name.trim(), preset.id).not.toBe('')
      expect(['anthropic', 'openai', 'google', 'openai-compatible']).toContain(preset.type)
    }
  })

  it('gives every OpenAI-compatible preset except `custom` a base URL', () => {
    // `registry.ts` cannot build a client without one, and `custom` is precisely
    // the entry where the user supplies it.
    const missing = PROVIDER_PRESETS.filter(
      (preset) => preset.type === 'openai-compatible' && preset.id !== 'custom' && !preset.baseUrl
    )
    expect(missing.map((preset) => preset.id)).toEqual([])
    expect(byId('custom').baseUrl).toBeUndefined()
  })

  it('leaves the three first-party adapters on their SDK default endpoint', () => {
    for (const id of ['anthropic', 'openai', 'google']) {
      expect(byId(id).baseUrl, id).toBeUndefined()
    }
  })

  it('never requires a key from a local preset', () => {
    const local = PROVIDER_PRESETS.filter((preset) => preset.local)
    expect(local.map((preset) => preset.id)).toEqual(['ollama', 'lmstudio'])
    for (const preset of local) {
      expect(preset.requiresApiKey, preset.id).toBe(false)
      // A local server's model list is whatever the user has pulled.
      expect(preset.defaultModels, preset.id).toEqual([])
      expect(preset.baseUrl, preset.id).toMatch(/^http:\/\/localhost:/)
    }
  })

  it('points every hosted preset at an https endpoint', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (!preset.baseUrl || preset.local) continue
      expect(preset.baseUrl, preset.id).toMatch(/^https:\/\//)
    }
  })

  it('requires a key from every hosted preset except `custom`', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.local || preset.id === 'custom') continue
      expect(preset.requiresApiKey, preset.id).toBe(true)
    }
    // `custom` may well be another local server, so it demands nothing.
    expect(byId('custom').requiresApiKey).toBe(false)
  })

  it('seeds a model list for every preset that can have one', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.local || preset.id === 'custom') continue
      expect(preset.defaultModels.length, preset.id).toBeGreaterThan(0)
      for (const model of preset.defaultModels) expect(model.trim(), preset.id).not.toBe('')
    }
  })
})

describe('getPreset / isLocalPreset', () => {
  it('finds a preset by id', () => {
    expect(getPreset('deepseek')?.baseUrl).toBe('https://api.deepseek.com/v1')
  })

  it('answers undefined for an unknown or absent id rather than throwing', () => {
    expect(getPreset('nope')).toBeUndefined()
    expect(getPreset(undefined)).toBeUndefined()
    expect(getPreset('')).toBeUndefined()
  })

  it('reports which presets run on this machine', () => {
    expect(isLocalPreset('ollama')).toBe(true)
    expect(isLocalPreset('lmstudio')).toBe(true)
    expect(isLocalPreset('deepseek')).toBe(false)
    expect(isLocalPreset(undefined)).toBe(false)
  })
})
