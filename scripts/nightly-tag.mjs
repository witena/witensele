/**
 * Tags `origin/main` for a nightly build when it has moved since the last
 * release, and pushes the tag. `.github/workflows/release.yml` does the rest.
 *
 * It is meant to be run once a day by a scheduler on the owner's machine, and
 * it has to be run by a *person's* credentials: a tag pushed with a workflow's
 * `GITHUB_TOKEN` triggers no workflow, so a cron job inside GitHub Actions could
 * not start the release this way.
 *
 * It works on refs only — `git fetch`, `git show origin/main:package.json`,
 * `git tag <name> origin/main` — and never touches the working tree, so it is
 * safe to run while a branch with uncommitted work is checked out.
 *
 * The version is `<next patch>-nightly.<yyyymmdd>`: above the last stable
 * release and below the next one in semver order, and nothing is committed to
 * `main` to get it — `release.yml` writes it into the build from the tag name.
 * A pre-release version also puts the build on electron-updater's `nightly`
 * channel (`nightly-mac.yml`), which a stable install never reads.
 *
 *   node scripts/nightly-tag.mjs            # tag and push if main moved
 *   node scripts/nightly-tag.mjs --dry-run  # say what it would do
 *
 * Exit code 0 for "tagged" and for "nothing to do"; non-zero only for an error.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Nightly drafts kept on GitHub; older ones are deleted together with their tags. */
export const KEPT_NIGHTLY_DRAFTS = 3

/** `1.2.3` (any pre-release suffix ignored) → `1.2.4-nightly.20260920`. */
export function nightlyVersion(baseVersion, date) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(baseVersion)
  if (!match) throw new Error(`Not a semver version: ${String(baseVersion)}`)
  const [, major, minor, patch] = match
  const stamp =
    String(date.getUTCFullYear()) +
    String(date.getUTCMonth() + 1).padStart(2, '0') +
    String(date.getUTCDate()).padStart(2, '0')
  return `${major}.${minor}.${Number(patch) + 1}-nightly.${stamp}`
}

/**
 * What to do, from what the repository looks like. Pure, so it can be tested
 * without a repository.
 *
 * @param {{ mainSha: string, baseVersion: string, date: Date,
 *           releaseTags: { name: string, sha: string }[] }} input
 *   `releaseTags` is every `v*` tag with the commit it points at.
 */
export function decide({ mainSha, baseVersion, date, releaseTags }) {
  const already = releaseTags.find((tag) => tag.sha === mainSha)
  if (already) return { action: 'skip', reason: `main is already released as ${already.name}` }

  const tag = `v${nightlyVersion(baseVersion, date)}`
  if (releaseTags.some((existing) => existing.name === tag)) {
    return { action: 'skip', reason: `${tag} already exists; one nightly a day` }
  }
  return { action: 'tag', tag }
}

/** The nightly draft releases to delete: all but the newest `keep`. */
export function staleNightlyDrafts(releases, keep = KEPT_NIGHTLY_DRAFTS) {
  return releases
    .filter((release) => release.isDraft && /-nightly\.\d{8}$/.test(release.tagName))
    .sort((a, b) => (a.tagName < b.tagName ? 1 : -1))
    .slice(keep)
    .map((release) => release.tagName)
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const dryRun = process.argv.includes('--dry-run')
  const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim()

  run('git', ['fetch', '--quiet', '--tags', '--prune', 'origin'])
  const mainSha = run('git', ['rev-parse', 'origin/main'])
  const baseVersion = JSON.parse(run('git', ['show', 'origin/main:package.json'])).version
  const releaseTags = run('git', ['tag', '--list', 'v*'])
    .split('\n')
    .filter(Boolean)
    .map((name) => ({ name, sha: run('git', ['rev-list', '-n', '1', name]) }))

  const decision = decide({ mainSha, baseVersion, date: new Date(), releaseTags })
  if (decision.action === 'skip') {
    console.log(`[nightly] nothing to do: ${decision.reason}`)
    return
  }

  console.log(`[nightly] ${decision.tag} -> ${mainSha.slice(0, 7)}${dryRun ? ' (dry run)' : ''}`)
  if (dryRun) return

  run('git', ['tag', '-a', decision.tag, '-m', `Witena ${decision.tag.slice(1)}`, mainSha])
  run('git', ['push', 'origin', decision.tag])

  // Drafts are invisible to everyone but the owner, and a nightly nobody
  // published is superseded by the next one; without this they pile up forever.
  const releases = JSON.parse(run('gh', ['release', 'list', '--limit', '100', '--json', 'tagName,isDraft']))
  for (const stale of staleNightlyDrafts(releases)) {
    console.log(`[nightly] deleting the unpublished draft ${stale}`)
    run('gh', ['release', 'delete', stale, '--yes', '--cleanup-tag'])
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
