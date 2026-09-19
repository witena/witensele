/**
 * Downloads the Anthropic CLI (`ant`) that ships inside the app.
 *
 * ## Why the app ships it
 *
 * Signing in to Anthropic delegates to `ant` (see
 * `src/main/providers/anthropic-cli.ts`). Until this script existed a user with
 * no `ant` was shown a `brew install` command instead of a browser; with the
 * binary in the bundle, Sign in opens the browser on a machine that has never
 * heard of Homebrew. `ant` is MIT-licensed and Anthropic publishes prebuilt,
 * checksummed archives, which is what makes redistributing it both allowed and
 * verifiable.
 *
 * ## What it does
 *
 * For each macOS architecture in `build/ant-release.json` it downloads the
 * release archive, **refuses it unless the SHA-256 matches the pinned one**,
 * and unpacks the binary into `vendor/ant/<arch>/`. The archive carries no
 * licence file, so the MIT notice that has to ship with the binary is committed
 * as `build/ant.LICENSE` instead. That folder is gitignored; `electron-builder.yml` copies
 * `vendor/ant/${arch}` into `Contents/Resources/bin`, and a development run
 * reads `vendor/ant/<process.arch>` directly.
 *
 * Both architectures are fetched, because one `npm run dist` builds both dmgs.
 * A folder whose `.version` marker already names the pinned checksum is left
 * alone, so the hook costs nothing after the first run.
 *
 * Upgrading `ant` is an edit to `build/ant-release.json`: the version, the two
 * file names and the two checksums, all of which are in the release's
 * GoReleaser-generated Homebrew cask.
 *
 * ## Strict and optional
 *
 * `--optional` turns every failure into a warning. `predev` and `prebuild` pass
 * it, because a checkout with no network must still run and build — the app
 * falls back to an `ant` on `PATH`, and to the install hint after that. The
 * `predist*` hooks do not pass it: a dmg without the binary would be the bug
 * this script exists to fix, shipped silently.
 *
 * `WITENA_ANT_VENDOR_DIR` overrides the output folder, for the test.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const release = JSON.parse(readFileSync(join(repoRoot, 'build', 'ant-release.json'), 'utf8'))
const vendorDir = process.env['WITENA_ANT_VENDOR_DIR'] ?? join(repoRoot, 'vendor', 'ant')
const optional = process.argv.includes('--optional')

const BINARY = 'ant'
const MARKER = '.version'

function markerOf(asset) {
  return `${release.version} ${asset.sha256}\n`
}

function isCurrent(directory, asset) {
  const marker = join(directory, MARKER)
  return (
    existsSync(join(directory, BINARY)) &&
    existsSync(marker) &&
    readFileSync(marker, 'utf8') === markerOf(asset)
  )
}

async function fetchArch(arch, asset) {
  const directory = join(vendorDir, arch)
  if (isCurrent(directory, asset)) {
    console.log(`[ant] ${arch}: ${release.version} already present`)
    return
  }

  const url = `${release.homepage}/releases/download/v${release.version}/${asset.file}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())

  const digest = createHash('sha256').update(archive).digest('hex')
  if (digest !== asset.sha256) {
    throw new Error(`${asset.file} has SHA-256 ${digest}, expected ${asset.sha256}`)
  }

  const scratch = mkdtempSync(join(tmpdir(), 'witena-ant-'))
  try {
    const zip = join(scratch, asset.file)
    writeFileSync(zip, archive)
    const unpacked = join(scratch, 'unpacked')
    mkdirSync(unpacked)
    execFileSync('/usr/bin/unzip', ['-q', zip, '-d', unpacked])
    if (!existsSync(join(unpacked, BINARY))) {
      throw new Error(`${asset.file} does not contain ${BINARY}`)
    }

    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true })
    copyFileSync(join(unpacked, BINARY), join(directory, BINARY))
    chmodSync(join(directory, BINARY), 0o755)
    writeFileSync(join(directory, MARKER), markerOf(asset))
    console.log(`[ant] ${arch}: ${release.version} -> ${directory}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.platform !== 'darwin') {
  console.log('[ant] skipped: the bundled CLI is only shipped in the macOS build')
} else {
  try {
    for (const [arch, asset] of Object.entries(release.assets)) await fetchArch(arch, asset)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (!optional) {
      console.error(`[ant] ${message}`)
      process.exit(1)
    }
    console.warn(`[ant] not bundled (${message}); sign-in will look for ant on PATH`)
  }
}
