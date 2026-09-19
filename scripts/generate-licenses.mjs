/**
 * Writes the licence list Settings → About renders (S7.5).
 *
 * ## Why it is generated and not committed
 *
 * The list is *derived*: it is exactly what `node_modules` says about the
 * transitive closure of `package.json`'s `dependencies`. A hand-maintained copy
 * would be wrong the first time a dependency is added, upgraded or dropped, and
 * nothing would fail — a stale licence list looks identical to a correct one.
 * So the file is produced from the installed tree and **gitignored**
 * (`src/renderer/src/generated/`), and the `pretypecheck` / `pretest` /
 * `prebuild` hooks in `package.json` run this script, which means every path
 * that needs the file makes it first: a clean `npm ci && npm run typecheck` on
 * CI, a developer's `npm test`, and `npm run build` before packaging.
 *
 * ## What it collects
 *
 * `dependencies` only — the production closure, which is what ships inside the
 * app — never `devDependencies`. Every package is resolved by reading
 * `node_modules/<name>/package.json` from the project root, which is where npm
 * hoists it; a package that cannot be resolved is reported rather than guessed
 * at, because a missing entry in a licence list is the one error that must not
 * pass silently.
 *
 * Both licence spellings are handled: the modern `license` string (or
 * `{ type }` object) and the legacy `licenses` array npm used before 2014.
 * `UNKNOWN` is written when a manifest declares neither, so the About screen
 * shows the gap instead of hiding it.
 *
 * Overridable with two environment variables, which is how
 * `src/main/licenses.test.ts` drives it against a fixture tree:
 *
 * - `WITENA_LICENSES_ROOT` — the project to read (default: the repository root)
 * - `WITENA_LICENSES_OUT`  — where to write (default: the generated file)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const root = process.env['WITENA_LICENSES_ROOT'] ?? repoRoot
const out =
  process.env['WITENA_LICENSES_OUT'] ??
  join(repoRoot, 'src', 'renderer', 'src', 'generated', 'licenses.json')

/** `package.json` of one installed package, or `null` when it is not there. */
function readManifest(directory) {
  const file = join(directory, 'package.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (cause) {
    throw new Error(`${file} is not valid JSON: ${cause.message}`)
  }
}

/** The SPDX-ish string a manifest declares, in either of npm's two spellings. */
function licenseOf(manifest) {
  const { license, licenses } = manifest
  if (typeof license === 'string' && license.trim().length > 0) return license.trim()
  if (license && typeof license === 'object' && typeof license.type === 'string') {
    return license.type
  }
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter((type) => typeof type === 'string' && type.length > 0)
    if (types.length > 0) return types.join(' OR ')
  }
  return 'UNKNOWN'
}

/** A homepage worth linking to: the declared one, else the repository URL. */
function homepageOf(manifest) {
  if (typeof manifest.homepage === 'string' && manifest.homepage.startsWith('http')) {
    return manifest.homepage
  }
  const url = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  if (typeof url !== 'string') return undefined
  // `git+https://github.com/x/y.git` → `https://github.com/x/y`
  const cleaned = url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://')
  return cleaned.startsWith('http') ? cleaned : undefined
}

/**
 * Every production dependency, transitively, sorted by name.
 *
 * Breadth-first over each manifest's own `dependencies`, so a package pulled in
 * only by a dependency is listed too — it ships in the app exactly like a
 * direct one. `optionalDependencies` and `peerDependencies` are left out: the
 * first may not be installed at all and the second is the consumer's problem.
 */
export function collectLicenses(projectRoot) {
  const rootManifest = readManifest(projectRoot)
  if (!rootManifest) throw new Error(`${projectRoot} has no package.json`)

  const modules = join(projectRoot, 'node_modules')
  const seen = new Map()
  const missing = []
  const queue = Object.keys(rootManifest.dependencies ?? {})

  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue

    const manifest = readManifest(join(modules, name))
    if (!manifest) {
      seen.set(name, null)
      missing.push(name)
      continue
    }

    seen.set(name, {
      name,
      version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
      license: licenseOf(manifest),
      ...(homepageOf(manifest) ? { homepage: homepageOf(manifest) } : {})
    })

    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!seen.has(dependency)) queue.push(dependency)
    }
  }

  const packages = [...seen.values()]
    .filter((entry) => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name))

  return { packages, missing }
}

const { packages, missing } = collectLicenses(root)
if (missing.length > 0) {
  // Loud, not fatal: an incomplete `node_modules` (a pruned install, a package
  // that only exists on another platform) must not stop a build, but a licence
  // list quietly missing three entries is worse than no list at all.
  console.warn(`[licenses] not installed, so not listed: ${missing.join(', ')}`)
}

// The one thing in the bundle that `node_modules` does not know about: the
// Anthropic CLI `scripts/fetch-ant.mjs` downloads (MIT, so its notice has to be
// shown like any dependency's). Read from the same pin the download uses, and
// only for the real project — a fixture tree ships no such binary.
if (root === repoRoot) {
  const ant = JSON.parse(readFileSync(join(repoRoot, 'build', 'ant-release.json'), 'utf8'))
  packages.push({
    name: ant.name,
    version: ant.version,
    license: ant.license,
    homepage: ant.homepage
  })
  packages.sort((a, b) => a.name.localeCompare(b.name))
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify({ packages }, null, 2)}\n`)
console.log(`[licenses] ${packages.length} packages -> ${out}`)
