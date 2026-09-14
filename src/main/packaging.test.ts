/**
 * The release manifest: what `.github/workflows/release.yml` will build when a
 * `v*` tag is pushed (S7.2).
 *
 * The subject is a YAML file rather than a module, so this asserts only the
 * three facts a workflow depends on and a careless edit could silently drop:
 * both architectures, the publish feed, and an artifact name that keeps the two
 * dmgs apart. Everything else about the bundle — asar unpacking, extra
 * resources, the icon — is proven by a real build, which is what
 * `e2e/packaged.spec.ts` is for.
 *
 * The YAML is parsed with `gray-matter`, the frontmatter parser the skills
 * loader already depends on: wrapping the document in `---` delimiters hands it
 * to the same js-yaml gray-matter carries, which is cheaper than a dependency
 * added for one test.
 *
 * It lives under `src/main/` rather than beside the version constant it checks
 * because `src/shared/` is compiled by `tsconfig.web.json` too, and that project
 * has no `@types/node` — `node:fs` does not resolve there. Nothing here imports
 * electron (CLAUDE.md rule 5); it reads two files off disk.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'
import { describe, expect, it } from 'vitest'
import { APP_VERSION } from '@shared/version'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readYaml(relativePath: string): Record<string, unknown> {
  const text = readFileSync(join(repoRoot, relativePath), 'utf8')
  return matter(`---\n${text}\n---\n`).data
}

interface MacTarget {
  target: string
  arch: string[]
}

describe('electron-builder.yml', () => {
  const config = readYaml('electron-builder.yml')
  const mac = config['mac'] as { target: MacTarget[] }

  it('builds a dmg for both macOS architectures', () => {
    // Two dmgs rather than a universal binary: PLAN.md, "Local release".
    expect(mac.target).toHaveLength(1)
    expect(mac.target[0]?.target).toBe('dmg')
    expect(mac.target[0]?.arch).toEqual(['arm64', 'x64'])
  })

  it('names the artifacts so the two architectures cannot collide', () => {
    const dmg = config['dmg'] as { artifactName: string }
    expect(dmg.artifactName).toContain('${arch}')
    expect(dmg.artifactName).toContain('${version}')
  })

  it('publishes draft GitHub Releases', () => {
    // A draft is what makes a tag safe: CI packages, a human publishes.
    const publish = config['publish'] as { provider: string; releaseType: string }
    expect(publish.provider).toBe('github')
    expect(publish.releaseType).toBe('draft')
  })

  it('is still unsigned, so the README keeps its Gatekeeper note (S7.3)', () => {
    const unsigned = config['mac'] as { identity: string | null; hardenedRuntime: boolean }
    expect(unsigned.identity).toBeNull()
    expect(unsigned.hardenedRuntime).toBe(false)
  })
})

describe('the released version number', () => {
  it('matches package.json, which `npm version` bumps', () => {
    // `scripts/sync-version.mjs` runs in npm's `version` lifecycle and keeps
    // these two equal; this test is what notices when it does not.
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      version: string
    }
    expect(APP_VERSION).toBe(manifest.version)
  })
})
