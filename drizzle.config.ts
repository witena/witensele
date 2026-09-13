/**
 * drizzle-kit configuration, used only by `npm run db:generate`.
 *
 * It generates SQL into `src/main/db/migrations/`, which is then applied by our
 * own migrator (`src/main/db/migrate.ts`) rather than by drizzle-kit: the app
 * ships as a bundle, so migrations are inlined at build time with
 * `import.meta.glob('./migrations/*.sql', { query: '?raw' })` instead of being
 * read from a folder at runtime. drizzle-kit never connects to the database.
 */
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema.ts',
  out: './src/main/db/migrations',
  strict: true,
  verbose: true
})
