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
    environment: 'node'
  }
})
