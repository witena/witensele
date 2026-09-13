/**
 * Playwright configuration for the Electron end-to-end harness.
 *
 * Only `e2e/` is run here; unit tests stay with vitest (`npm test`). Playwright
 * drives the real Electron binary, so no browser download is needed — `npx
 * playwright install` is not part of the setup.
 *
 * The build is not run by a `globalSetup`: `npm run e2e` is
 * `npm run build && playwright test`, so a failing build fails the command
 * before any Electron process is spawned.
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  // Two files in `e2e/` are not part of the suite and have their own config:
  // `packaged.spec.ts` needs a dmg that `npm run dist` has already produced
  // (`npm run e2e:packaged`), and `demo.record.ts` is a screen recording, not a
  // test (`npm run demo`). Both would otherwise fail or hang an ordinary
  // `npm run e2e`.
  testIgnore: ['packaged.spec.ts', 'demo.record.ts'],
  // One Electron app at a time: they would share the userData override otherwise.
  workers: 1,
  fullyParallel: false,
  // Launching Electron and loading the renderer is slower than a browser page.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  // CI must never silently pass because someone left a `.only` in a spec.
  forbidOnly: !!process.env['CI'],
  retries: 0
})
