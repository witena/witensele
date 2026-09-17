/**
 * The rule this whole step exists to prove: **nothing the server host reaches
 * imports electron.**
 *
 * CLAUDE.md rule #5 has been asserted by reading since S1.1. Now there is a second
 * host for the same backend, and the rule becomes a property a test can check:
 * start at every module under `src/server/`, follow every relative and `@shared`
 * import transitively, and fail on the first `electron` specifier in the closure.
 *
 * It is a source scan rather than a bundle scan on purpose. A bundler would tell
 * us the same thing only after a build, would need the build to be configured
 * correctly first, and would name a chunk rather than the file that did it. This
 * names the file and the file that imported it, which is the sentence the person
 * who broke the rule needs.
 *
 * What it does **not** do is resolve bare specifiers into `node_modules`: a
 * dependency that imports electron would be an `electron` entry in that package's
 * own manifest, not our rule to enforce, and walking the dependency tree would
 * make a unit test read thousands of files.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Repository root, from `<root>/src/server/`. */
const ROOT = resolve(import.meta.dirname, '../..')
const SERVER_DIR = join(ROOT, 'src/server')
const SHARED_DIR = join(ROOT, 'src/shared')

/** `import … from 'x'`, `export … from 'x'`, `import('x')` and `require('x')`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

/** Bare `import 'x'` with no bindings, which the pattern above does not see. */
const SIDE_EFFECT_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/gm

/**
 * Every production `.ts` file under a directory.
 *
 * `*.test.ts` is excluded, and not only because this file would otherwise report
 * the `'electron'` literals in its own fixtures below: a test is not shipped, is
 * not part of the host, and a suite that one day wanted to assert something
 * *about* electron would be failed by its own guard. The rule is about the code
 * the server runs.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path))
      continue
    }
    if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path)
  }
  return out
}

/** Every specifier a file imports, in source order. */
export function specifiersOf(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(SPECIFIER)) found.push(match[1] as string)
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) found.push(match[1] as string)
  return found
}

/**
 * Resolves one specifier to a file inside this repository, or `null` for a
 * package.
 *
 * Only the two forms the repository actually uses are resolved — a relative path
 * and the `@shared/*` alias — because those are the only ones that can carry our
 * own code, and a resolver that guessed at more would quietly start skipping
 * files it failed to find.
 */
export function resolveLocal(fromFile: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@shared/')) {
    base = join(SHARED_DIR, specifier.slice('@shared/'.length))
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier)
  } else {
    return null
  }

  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** True for `electron` itself and for any submodule path of it. */
export function isElectronSpecifier(specifier: string): boolean {
  return specifier === 'electron' || specifier.startsWith('electron/')
}

describe('the server host is Electron-free', () => {
  it('imports electron nowhere in its transitive source closure', () => {
    const queue = sourceFiles(SERVER_DIR)
    const seen = new Set(queue)
    /** `<importer> → electron`, collected rather than thrown so one run names them all. */
    const offences: string[] = []
    /** Every repository file the server reaches, for the assertion below. */
    const closure: string[] = []

    while (queue.length > 0) {
      const file = queue.shift() as string
      closure.push(relative(ROOT, file))
      const source = readFileSync(file, 'utf8')

      for (const specifier of specifiersOf(source)) {
        if (isElectronSpecifier(specifier)) {
          offences.push(`${relative(ROOT, file)} imports '${specifier}'`)
          continue
        }
        const target = resolveLocal(file, specifier)
        if (!target || seen.has(target)) continue
        seen.add(target)
        queue.push(target)
      }
    }

    expect(offences).toEqual([])

    // A closure that collapsed to the server's own files would make the assertion
    // above vacuously true — the interesting claim is that it reaches deep into
    // `src/main/` and still finds nothing.
    expect(closure).toContain('src/main/app-context.ts')
    expect(closure).toContain('src/main/orchestration/chat-runner.ts')
    expect(closure).toContain('src/main/handlers/index.ts')
    expect(closure.length).toBeGreaterThan(40)
  })

  it('would notice an electron import, in any of its spellings', () => {
    // The guard on the guard: the scan above is only worth having if it can fail.
    const spellings = [
      "import { app } from 'electron'",
      "const { app } = require('electron')",
      "export { shell } from 'electron'",
      "const later = await import('electron')",
      "import 'electron/main'"
    ]
    for (const line of spellings) {
      expect(specifiersOf(line).some(isElectronSpecifier)).toBe(true)
    }
  })

  it('resolves the two local specifier forms and ignores packages', () => {
    const here = join(SERVER_DIR, 'http.ts')
    expect(resolveLocal(here, './user')).toBe(join(SERVER_DIR, 'user.ts'))
    expect(resolveLocal(here, '@shared/backend')).toBe(join(SHARED_DIR, 'backend.ts'))
    expect(resolveLocal(here, '../main/handlers')).toBe(join(ROOT, 'src/main/handlers/index.ts'))
    expect(resolveLocal(here, 'ws')).toBeNull()
    expect(resolveLocal(here, 'node:http')).toBeNull()
  })
})
