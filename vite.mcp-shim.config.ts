/**
 * The fourth build target: `witena-mcp`, the stdio shim.
 *
 * `out/mcp-shim/witena-mcp.cjs` is one self-contained file, and every word of
 * that is a requirement rather than a preference:
 *
 * | Requirement | Why |
 * |---|---|
 * | **One file** | WP-9 ships it as `Contents/Resources/mcp/witena-mcp.cjs`, beside a `sh` launcher and nothing else. A build with sibling chunks would need every one of them listed in `extraResources` and kept in step |
 * | **No `node_modules` at run time** | The shim runs from inside a signed, notarized bundle that contains no `node_modules`. An unresolved `require('@modelcontextprotocol/sdk')` there is a server that fails to start, in the user's IDE, with no way to fix it |
 * | **CommonJS** | It is executed by the app's own binary with `ELECTRON_RUN_AS_NODE=1` and a `.cjs` extension, which is the one spelling that needs neither a `package.json` beside it nor an ESM loader flag |
 * | **`node:` builtins external** | They are the runtime's, and inlining them is not possible anyway |
 *
 * So `ssr.noExternal: true` pulls the SDK and zod in, `inlineDynamicImports`
 * collapses the SDK's lazy imports into the one file, and the only externals
 * are the builtins.
 *
 * Not part of `electron.vite.config.ts` because electron-vite's three targets
 * are main, preload and renderer, and this is none of them — the same reason
 * `vite.server.config.ts` stands on its own. `npm run build` runs both.
 */
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared')
    }
  },
  // Bundle every dependency. Vite's SSR build externalizes `node_modules` by
  // default, which is right for `npm run server` (it runs next to its own
  // `node_modules`) and wrong for a file that is copied into an app bundle.
  ssr: {
    noExternal: true
  },
  build: {
    target: 'node22',
    outDir: 'out/mcp-shim',
    emptyOutDir: true,
    // Read by a human exactly once — when a stack trace points at it — and the
    // file is not shipped over a network, so minifying it buys nothing and
    // costs every future debugging session.
    minify: false,
    ssr: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/mcp-shim/index.ts'),
      external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: {
        entryFileNames: 'witena-mcp.cjs',
        format: 'cjs',
        inlineDynamicImports: true
      }
    }
  }
})
