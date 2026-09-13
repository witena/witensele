/**
 * Playwright configuration for `e2e/demo.record.ts` (`npm run demo`).
 *
 * `demo.record.ts` is a **screen recording**, not a test: it drives the built
 * app through a scripted tour with human-sized pauses, records the window, and
 * leaves a `.webm` plus four PNGs behind for `docs/assets/`. It asserts only
 * enough to know a step actually happened before moving on.
 *
 * It lives in `e2e/` because it reuses that directory's helpers and the same
 * Electron launcher, but `playwright.config.ts` ignores the file: a tour that
 * waits on two real models for several minutes has no business inside
 * `npm run e2e`.
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'demo.record.ts',
  workers: 1,
  fullyParallel: false,
  // The whole tour is one test, and it waits on two local models several times.
  timeout: 900_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  retries: 0
})
