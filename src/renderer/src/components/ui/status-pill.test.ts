/**
 * The status-pill tone mapping, in plain Node.
 *
 * Same guard as `presence-dot.test.ts` and for the same reason: the mapping from
 * a domain tone to design tokens is the only logic in the component, and a fourth
 * `StatusTone` added later would otherwise render transparent rather than fail.
 * The literal-class assertion is the important one — Tailwind scans source text,
 * so a composed class name compiles and then does nothing.
 */
import { describe, expect, it } from 'vitest'
import { statusDotClass, statusToneClass, type StatusTone } from './status-pill'

const TONES: StatusTone[] = ['ok', 'warn', 'idle']

describe('statusToneClass', () => {
  it('maps every tone to a surface and a foreground', () => {
    expect(statusToneClass('ok')).toBe('bg-status-ok-surface text-status-ok')
    expect(statusToneClass('warn')).toBe('bg-status-warn-surface text-status-warn')
    expect(statusToneClass('idle')).toBe('bg-status-idle-surface text-status-idle')
  })

  it('gives each tone its own pair', () => {
    expect(new Set(TONES.map(statusToneClass)).size).toBe(TONES.length)
  })

  it('emits literal utilities, never an interpolated class name', () => {
    for (const tone of TONES) {
      expect(statusToneClass(tone), tone).toMatch(/^bg-status-[a-z]+-surface text-status-[a-z]+$/)
    }
  })
})

describe('statusDotClass', () => {
  it('reuses the presence tokens so the dots match the rest of the app', () => {
    expect(statusDotClass('ok')).toBe('bg-presence-available')
    expect(statusDotClass('warn')).toBe('bg-presence-away')
    expect(statusDotClass('idle')).toBe('bg-presence-offline')
  })

  it('gives each tone its own colour', () => {
    expect(new Set(TONES.map(statusDotClass)).size).toBe(TONES.length)
  })
})
