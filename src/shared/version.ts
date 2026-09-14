/** Application name, shared by main / preload / renderer. */
export const APP_NAME = 'Witena'

/**
 * Kept in sync with package.json by `scripts/sync-version.mjs`, which npm's
 * `version` lifecycle script runs during `npm version <patch|minor|major>`.
 * `src/main/packaging.test.ts` fails if the two ever disagree.
 */
export const APP_VERSION = '0.1.0'

/**
 * Where the source, the releases and the issue tracker live.
 *
 * Shown in Settings → About (S7.5) and nowhere else so far. It is the same
 * repository electron-builder's GitHub publisher derives from the checkout's
 * git remote, written out here because the renderer has neither the remote nor
 * `package.json` to read it from.
 */
export const APP_REPOSITORY_URL = 'https://github.com/witena/witensele'
