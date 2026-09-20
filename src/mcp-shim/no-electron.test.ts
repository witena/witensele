/**
 * The rule, for the file that ships inside the bundle: **the shim reaches
 * nothing but the SDK, zod and `@shared/`.**
 *
 * It is the same scan `src/server/no-electron.test.ts` and
 * `src/main/mcp-endpoint/no-electron.test.ts` run, with two more things to fail
 * on, because the shim's failure mode is worse than either of theirs. It is
 * bundled into one `.cjs` by `vite.mcp-shim.config.ts` with every dependency
 * inlined, and it runs from inside a signed bundle that has no `node_modules`:
 *
 * | Reached | What the user sees |
 * |---|---|
 * | `electron` | The bundler pulls Electron's module shim into the file, or the run-as-node process throws on a module only the browser process has |
 * | `better-sqlite3` | A native `.node` binary that cannot be inlined at all — an MCP server that fails to start in the IDE |
 * | anything under `src/main/` | The whole backend, its database and its Electron imports, dragged in behind one convenient type import |
 *
 * The last one is the realistic mistake: `import type { HandlerMap }` costs
 * nothing at runtime but is indistinguishable from a value import to a scan,
 * and to a reader. The shim has no business with main-process types, so the
 * rule is the directory, not the `type` keyword.
 *
 * As in the sibling files, bare specifiers are not resolved into
 * `node_modules` — a dependency that imports electron is that package's
 * manifest to answer for — but the *set* of bare specifiers is checked against
 * an allowlist, which is the part that keeps the bundle small.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Repository root, from `<root>/src/mcp-shim/`. */
const ROOT = resolve(import.meta.dirname, '../..')
const SHIM_DIR = join(ROOT, 'src/mcp-shim')
const SHARED_DIR = join(ROOT, 'src/shared')

/** `import … from 'x'`, `export … from 'x'`, `import('x')` and `require('x')`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

/** Bare `import 'x'` with no bindings, which the pattern above does not see. */
const SIDE_EFFECT_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/gm

/**
 * Every package the shim may bundle.
 *
 * The SDK because it is the protocol, zod because `@shared/mcp-tools` defines
 * the tool inputs with it, and nothing else: every addition here is roughly its
 * own weight added to a file that is copied into the app bundle and read by an
 * IDE on every project it opens.
 */
const ALLOWED_PACKAGES = [/^@modelcontextprotocol\/sdk(\/|$)/, /^zod(\/|$)/]

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:')
}

/** Every production `.ts` file under a directory; tests are not bundled. */
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

function isElectronSpecifier(specifier: string): boolean {
  return specifier === 'electron' || specifier.startsWith('electron/')
}

function isNativeSpecifier(specifier: string): boolean {
  return specifier === 'better-sqlite3' || specifier.startsWith('better-sqlite3/')
}

describe('the shim bundles only what it may', () => {
  /** The scan, run once and asserted from several angles below. */
  function walk(): { offences: string[]; closure: string[]; packages: Set<string> } {
    const queue = sourceFiles(SHIM_DIR)
    const offences: string[] = []
    const closure: string[] = []
    const packages = new Set<string>()
    const seen = new Set(queue)

    while (queue.length > 0) {
      const file = queue.shift() as string
      const shown = relative(ROOT, file)
      closure.push(shown)
      const source = readFileSync(file, 'utf8')

      for (const specifier of specifiersOf(source)) {
        if (isElectronSpecifier(specifier)) {
          offences.push(`${shown} imports '${specifier}'`)
          continue
        }
        if (isNativeSpecifier(specifier)) {
          offences.push(`${shown} imports the native module '${specifier}'`)
          continue
        }

        const target = resolveLocal(file, specifier)
        if (target === null) {
          if (!isNodeBuiltin(specifier)) packages.add(specifier)
          continue
        }
        if (relative(ROOT, target).startsWith('src/main/')) {
          offences.push(`${shown} imports '${specifier}', which is under src/main/`)
          continue
        }
        if (seen.has(target)) continue
        seen.add(target)
        queue.push(target)
      }
    }

    return { offences, closure, packages }
  }

  it('reaches no electron, no native module and nothing under src/main/', () => {
    const { offences, closure } = walk()
    expect(offences).toEqual([])

    // The claim is only worth making because the closure is the real one: the
    // entry point, both halves of the lookup and WP-1's two shared modules.
    expect(closure).toContain('src/mcp-shim/index.ts')
    expect(closure).toContain('src/mcp-shim/server.ts')
    expect(closure).toContain('src/mcp-shim/connect.ts')
    expect(closure).toContain('src/mcp-shim/launch.ts')
    expect(closure).toContain('src/shared/mcp-tools.ts')
    expect(closure).toContain('src/shared/mcp-discovery.ts')
  })

  it('imports no package outside the SDK and zod', () => {
    const { packages } = walk()
    const unexpected = [...packages].filter(
      (name) => !ALLOWED_PACKAGES.some((allowed) => allowed.test(name))
    )
    expect(unexpected).toEqual([])
    // And it really does reach the SDK, so the allowlist is not vacuous.
    expect([...packages].some((name) => name.startsWith('@modelcontextprotocol/sdk'))).toBe(true)
  })

  it('would notice each of the three, in any of their spellings', () => {
    // The guard on the guard: a scan is only worth having if it can fail.
    for (const line of [
      "import { app } from 'electron'",
      "const { app } = require('electron')",
      "export { shell } from 'electron'",
      "const later = await import('electron')",
      "import 'electron/main'"
    ]) {
      expect(specifiersOf(line).some(isElectronSpecifier)).toBe(true)
    }
    expect(specifiersOf("import Database from 'better-sqlite3'").some(isNativeSpecifier)).toBe(true)
    // A main-process import is caught by where it resolves, not by its text, so
    // the check is that a real file there is reachable from this directory.
    expect(resolveLocal(join(SHIM_DIR, 'index.ts'), '../main/app-context')).toBe(
      join(ROOT, 'src/main/app-context.ts')
    )
  })
})
