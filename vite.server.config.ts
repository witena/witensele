/**
 * The build for `npm run server`.
 *
 * A build rather than `node src/server/index.ts` for one concrete reason: the
 * migrators inline their SQL with `import.meta.glob(… '?raw')`, which is a Vite
 * primitive. electron-vite resolves it for the desktop main process and vitest
 * resolves it for the tests, and this config is the third resolver — so all three
 * hosts run the same migration code rather than two of them running it and the
 * server running an approximation.
 *
 * It also resolves `@shared/*`, which plain `node --experimental-strip-types`
 * would not, and it leaves every dependency external so `better-sqlite3` stays a
 * runtime `require` of the platform binary rather than something rollup tries to
 * inline.
 */
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { dependencies } from './package.json'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared')
    }
  },
  build: {
    target: 'node22',
    outDir: 'out/server',
    emptyOutDir: true,
    // No minification and no manifest: this output is read by a human exactly
    // twice — when a stack trace points at it, and when the image is built.
    minify: false,
    ssr: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/server/index.ts'),
      // Every runtime dependency stays external. Bundling `pg` or `ws` would save
      // nothing (the server is not shipped over a network) and bundling
      // `better-sqlite3` would break it outright.
      external: [
        ...Object.keys(dependencies),
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`)
      ],
      output: {
        entryFileNames: 'index.js',
        format: 'es'
      }
    }
  }
})
