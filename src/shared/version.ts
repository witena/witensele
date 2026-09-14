/** Application name, shared by main / preload / renderer. */
export const APP_NAME = 'Witena'

/**
 * Kept in sync with package.json by `scripts/sync-version.mjs`, which npm's
 * `version` lifecycle script runs during `npm version <patch|minor|major>`.
 * `src/main/packaging.test.ts` fails if the two ever disagree.
 */
export const APP_VERSION = '0.1.0'
