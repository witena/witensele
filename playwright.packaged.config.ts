/**
 * Playwright configuration for `e2e/packaged.spec.ts` (`npm run e2e:packaged`).
 *
 * Separate from `playwright.config.ts` on purpose. The ordinary suite runs the
 * **built dev app** in `out/` and is expected to pass on any checkout;
 * `packaged.spec.ts` runs the **shipped binary** and therefore needs a dmg that
 * `npm run dist` has already produced and mounted. Folding it into `npm run e2e`
 * would make the everyday command depend on a twelve-minute packaging step, so
 * the ordinary config ignores the file and this one is the only way to run it.
 *
 * The app under test comes from `WITENA_APP_PATH`; the spec explains what it
 * expects to find there.
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'packaged.spec.ts',
  workers: 1,
  fullyParallel: false,
  // A packaged app is launched from a mounted disk image copy and then asked to
  // complete a real model reply; both are slower than the dev-build specs.
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  forbidOnly: !!process.env['CI'],
  retries: 0
})
