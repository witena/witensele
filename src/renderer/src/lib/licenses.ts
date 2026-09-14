/**
 * The bundled dependencies' licences, as Settings → About reads them (S7.5).
 *
 * The JSON behind this module is **generated, not committed**:
 * `scripts/generate-licenses.mjs` walks the production closure of
 * `package.json` in `node_modules` and writes `../generated/licenses.json`,
 * which is gitignored. `package.json`'s `pretypecheck`, `pretest` and
 * `prebuild` hooks run it, so every path that needs the file makes it first —
 * see that script's header for why a hand-maintained list was rejected.
 *
 * This module exists so exactly one file knows the JSON's shape: the component
 * imports a typed array, and a change to the generator's output breaks here
 * rather than inside JSX.
 */
import generated from '../generated/licenses.json'

export interface LicenseEntry {
  name: string
  version: string
  /** SPDX-ish, as the package declares it; `UNKNOWN` when it declares nothing. */
  license: string
  /** The package's own page, when its manifest names one worth linking to. */
  homepage?: string | undefined
}

/** Every production dependency, transitively, sorted by name. */
export const BUNDLED_LICENSES: readonly LicenseEntry[] = generated.packages

/**
 * `MIT × 217`-style counts, most common first.
 *
 * The About screen leads with this because it is the answer to the question
 * people actually ask of a licence list — "is there anything unusual in here?" —
 * and 244 rows do not answer it.
 */
export function licenseSummary(
  entries: readonly LicenseEntry[] = BUNDLED_LICENSES
): { license: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.license, (counts.get(entry.license) ?? 0) + 1)
  return [...counts.entries()]
    .map(([license, count]) => ({ license, count }))
    .sort((a, b) => b.count - a.count || a.license.localeCompare(b.license))
}
