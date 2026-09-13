import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared')
    }
  },
  test: {
    // Unit tests only. `e2e/` is Playwright's (`npm run e2e`) and must never be
    // picked up here: it launches a real Electron binary.
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'out/**', 'e2e/**'],
    environment: 'node',
    // Vitest stubs every CSS import with an empty module unless this is on, and
    // that stub also swallows `import.meta.glob('../index.css', { query: '?raw' })` —
    // which is how `src/renderer/src/lib/theme.test.ts` reads the design tokens to
    // prove the light palette overrides all of them (S5.8). No plugin is configured
    // here, so "processing" the one CSS file the suite touches is just reading it.
    css: true
  }
})
