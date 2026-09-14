/**
 * Copies `package.json`'s version into `src/shared/version.ts`.
 *
 * `npm version <patch|minor|major>` bumps the manifest and then makes the
 * commit and the tag itself. `APP_VERSION` is a second copy of that number —
 * `src/shared/` is imported by main, preload and renderer alike and pulling
 * `package.json` into those bundles to read one field is not worth it — so it
 * has to be rewritten in between. That is exactly what npm's `version`
 * lifecycle script is for: it runs after the bump and before the commit, and a
 * file staged there is part of the tagged commit.
 *
 * `src/main/packaging.test.ts` asserts the two agree, so a drift fails the
 * suite instead of introducing Witena to every MCP server under a version it
 * stopped being three releases ago (`src/main/mcp/manager.ts` sends it in the
 * client handshake).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const versionFile = join(root, 'src', 'shared', 'version.ts')

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  throw new Error(`package.json has no semver version: ${String(version)}`)
}

const source = readFileSync(versionFile, 'utf8')
const updated = source.replace(
  /export const APP_VERSION = '[^']*'/,
  `export const APP_VERSION = '${version}'`
)
if (updated === source && !source.includes(`APP_VERSION = '${version}'`)) {
  throw new Error(`Could not find APP_VERSION in ${versionFile}`)
}

writeFileSync(versionFile, updated)
console.log(`APP_VERSION -> ${version}`)
