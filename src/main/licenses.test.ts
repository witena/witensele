/**
 * `scripts/generate-licenses.mjs` against a fixture tree (S7.5).
 *
 * The script is driven the way the build drives it — `node scripts/…` with the
 * two environment overrides — rather than imported, for the reason
 * `anthropic-cli.test.ts` spawns a fake `ant`: what ships is the executable, so
 * the executable is what is tested, and a plain `.mjs` under `scripts/` is not
 * part of either TypeScript project.
 *
 * The fixture is a miniature `node_modules`: a direct dependency, a transitive
 * one nobody lists directly, a scoped package, the legacy `licenses` array, a
 * manifest with no licence at all, and a dependency that is not installed. Each
 * one is a rule the About screen depends on.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const script = join(repoRoot, 'scripts', 'generate-licenses.mjs')

interface LicenseEntry {
  name: string
  version: string
  license: string
  homepage?: string
}

let fixture: string
let output: { packages: LicenseEntry[] }
let warnings: string

function writePackage(root: string, name: string, manifest: Record<string, unknown>): void {
  const directory = join(root, 'node_modules', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
}

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'witena-licenses-'))

  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      dependencies: { alpha: '^1.0.0', '@scope/beta': '^2.0.0', gone: '^1.0.0' },
      // Must not appear in the output: a dev dependency ships in nothing.
      devDependencies: { delta: '^1.0.0' }
    })
  )

  writePackage(fixture, 'alpha', {
    name: 'alpha',
    version: '1.2.3',
    license: 'MIT',
    repository: { url: 'git+https://github.com/example/alpha.git' },
    // Pulls in a package the root never names: it ships all the same.
    dependencies: { gamma: '^1.0.0' }
  })
  writePackage(fixture, '@scope/beta', {
    name: '@scope/beta',
    version: '2.0.0',
    // The spelling npm used before 2014, still found in the wild.
    licenses: [{ type: 'BSD-2-Clause' }, { type: 'Apache-2.0' }],
    homepage: 'https://example.invalid/beta'
  })
  writePackage(fixture, 'gamma', { name: 'gamma', version: '0.4.0', license: { type: 'ISC' } })
  // No licence field at all, and a cycle back to alpha.
  writePackage(fixture, 'delta', { name: 'delta', version: '9.9.9', license: 'MIT' })
  writePackage(fixture, 'epsilon', { name: 'epsilon', version: '1.0.0' })

  // `gone` is declared but never installed; `epsilon` is reachable only through
  // gamma, so add the edge now that both manifests exist.
  writePackage(fixture, 'gamma', {
    name: 'gamma',
    version: '0.4.0',
    license: { type: 'ISC' },
    dependencies: { epsilon: '^1.0.0', alpha: '^1.0.0' }
  })

  const outFile = join(fixture, 'licenses.json')
  // `spawnSync` rather than `execFileSync`: the "declared but not installed"
  // line goes to stderr, which the latter does not hand back.
  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WITENA_LICENSES_ROOT: fixture,
      WITENA_LICENSES_OUT: outFile
    }
  })
  if (run.status !== 0) throw new Error(`generate-licenses failed: ${run.stderr}`)
  warnings = run.stderr
  output = JSON.parse(readFileSync(outFile, 'utf8')) as { packages: LicenseEntry[] }
})

afterAll(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true })
})

const entry = (name: string): LicenseEntry => {
  const found = output.packages.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`missing entry: ${name}`)
  return found
}

describe('generate-licenses', () => {
  it('lists the production closure, sorted, and nothing else', () => {
    expect(output.packages.map((item) => item.name)).toEqual([
      '@scope/beta',
      'alpha',
      'epsilon',
      'gamma'
    ])
  })

  it('leaves devDependencies out', () => {
    expect(output.packages.some((item) => item.name === 'delta')).toBe(false)
  })

  it('follows transitive dependencies without looping on a cycle', () => {
    // gamma is reached only through alpha, epsilon only through gamma, and
    // gamma depends back on alpha.
    expect(entry('gamma').version).toBe('0.4.0')
    expect(entry('epsilon').version).toBe('1.0.0')
  })

  it('reads both licence spellings', () => {
    expect(entry('alpha').license).toBe('MIT')
    expect(entry('gamma').license).toBe('ISC')
    expect(entry('@scope/beta').license).toBe('BSD-2-Clause OR Apache-2.0')
  })

  it('says UNKNOWN rather than hiding a package with no licence', () => {
    expect(entry('epsilon').license).toBe('UNKNOWN')
  })

  it('normalises a git repository URL into a homepage, and prefers a real one', () => {
    expect(entry('alpha').homepage).toBe('https://github.com/example/alpha')
    expect(entry('@scope/beta').homepage).toBe('https://example.invalid/beta')
    expect(entry('gamma').homepage).toBeUndefined()
  })

  it('warns about a declared dependency that is not installed', () => {
    expect(warnings).toContain('gone')
  })
})

describe('the generated file the renderer imports', () => {
  it('exists and carries the repository’s own dependencies', () => {
    // `pretest` in package.json runs the script before vitest, so this is also
    // the check that the hook is still wired up. Read as a file rather than
    // imported: `src/renderer/` belongs to the *other* TypeScript project, and
    // a composite project may not reach into a file it does not list.
    const generated = join(repoRoot, 'src', 'renderer', 'src', 'generated', 'licenses.json')
    const { packages } = JSON.parse(readFileSync(generated, 'utf8')) as {
      packages: LicenseEntry[]
    }
    expect(packages.length).toBeGreaterThan(20)
    expect(packages.some((item) => item.name === 'react')).toBe(true)
    for (const item of packages) expect(item.license, item.name).not.toBe('')
  })
})
