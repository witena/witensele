/**
 * The highlighter's contract with `index.css` (S5.8).
 *
 * One assertion, and it is the one that breaks silently: `highlightCode` returns
 * `null` on any failure — an unknown grammar, a bad option, a shiki upgrade that
 * renames something — and `CodeBlock` then renders the plain text it was already
 * showing. That is the right behaviour at runtime and a terrible one in a test
 * suite, because a theme mistake would look exactly like a passing app with
 * slightly duller code blocks. So the markup itself is checked: both CSS
 * variables present, no baked-in `color`, which is what the two rules at the
 * bottom of `index.css` need in order to switch themes without re-highlighting.
 */
import { describe, expect, it } from 'vitest'
import { highlightCode } from './highlighter'

describe('highlightCode', () => {
  it('emits both themes as CSS variables rather than a fixed colour', async () => {
    const html = await highlightCode('const answer = 42\n', 'ts')

    expect(html).not.toBeNull()
    expect(html).toContain('--shiki-light')
    expect(html).toContain('--shiki-dark')
    // `defaultColor: false` is what keeps a literal `color:#…` off the spans; with
    // one baked in, the light theme would only reach blocks rendered after the
    // switch.
    expect(html).not.toMatch(/<span style="color:/)
  })

  it('still answers null for an unknown grammar instead of throwing', async () => {
    await expect(highlightCode('x', 'nope' as never)).resolves.toBeNull()
  })
})
