/**
 * The rule, for the third transport: **nothing the MCP endpoint reaches imports
 * electron.**
 *
 * `src/server/no-electron.test.ts` made CLAUDE.md rule 5 a property a test can
 * check when the Node host arrived; the endpoint is the next module that has to
 * lift out of Electron unchanged (PLAN.md, "Online version": `src/server/http.ts`
 * mounts the same `createMcpEndpoint` at `/mcp` once accounts exist). So the
 * same scan runs from `src/main/mcp-endpoint/`.
 *
 * The scanner is re-stated here rather than imported from the server's copy,
 * although that file exports it: importing a `*.test.ts` module runs its
 * top-level `describe` blocks again inside this file, and the server's suite
 * would be collected and reported twice. Thirty lines of directory walk is the
 * cheaper of the two prices, and it keeps the two guards independent — one can
 * be tightened without silently changing the other.
 *
 * As there, bare specifiers are not resolved into `node_modules`: a dependency
 * that imports electron would be that package's manifest to answer for, and
 * walking the dependency tree would make a unit test read thousands of files.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Repository root, from `<root>/src/main/mcp-endpoint/`. */
const ROOT = resolve(import.meta.dirname, '../../..')
const ENDPOINT_DIR = join(ROOT, 'src/main/mcp-endpoint')
const SHARED_DIR = join(ROOT, 'src/shared')

/** `import … from 'x'`, `export … from 'x'`, `import('x')` and `require('x')`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

/** Bare `import 'x'` with no bindings, which the pattern above does not see. */
const SIDE_EFFECT_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/gm

/** Every production `.ts` file under a directory; tests are not shipped. */
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
function specifiersOf(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(SPECIFIER)) found.push(match[1] as string)
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) found.push(match[1] as string)
  return found
}

/** Resolves one specifier to a file in this repository, or `null` for a package. */
function resolveLocal(fromFile: string, specifier: string): string | null {
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
function isElectronSpecifier(specifier: string): boolean {
  return specifier === 'electron' || specifier.startsWith('electron/')
}

describe('the MCP endpoint is Electron-free', () => {
  it('imports electron nowhere in its transitive source closure', () => {
    const queue = sourceFiles(ENDPOINT_DIR)
    /** `<importer> → electron`, collected rather than thrown so one run names them all. */
    const offences: string[] = []
    /** Every repository file the endpoint reaches, for the assertions below. */
    const closure: string[] = []
    const seen = new Set(queue)

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

    // The claim is only interesting because the closure is deep: the endpoint
    // takes `AppContext` and `HandlerMap`, so it reaches the whole backend and
    // still finds nothing.
    expect(closure).toContain('src/main/mcp-endpoint/server.ts')
    expect(closure).toContain('src/main/mcp-endpoint/guards.ts')
    expect(closure).toContain('src/shared/mcp-tools.ts')
    expect(closure).toContain('src/main/app-context.ts')
    expect(closure).toContain('src/main/orchestration/chat-runner.ts')
    expect(closure.length).toBeGreaterThan(40)
  })

  it('would notice an electron import, in any of its spellings', () => {
    // The guard on the guard: a scan is only worth having if it can fail.
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
})
