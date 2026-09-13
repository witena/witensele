/**
 * Test fixtures for the storage layer.
 *
 * Every test opens its **own temporary file database** rather than `':memory:'`:
 * the acceptance criterion for S1.2 is that migrations and CRUD work against a
 * real file with WAL enabled, and only a file can be closed and reopened to prove
 * that the migrator is idempotent.
 *
 * Not imported by any production module — nothing under `src/main/` pulls this in,
 * so it never reaches the bundle.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentInput, McpServerInput, ProviderInput } from '@shared/types'
import type { DatabaseHandle } from './database'
import { openDatabase } from './database'
import type { Repositories } from './repositories'
import { createRepositories } from './repositories'
import type { MessageCreateInput } from './repositories/messages'

/** Stand-in for electron `safeStorage`: reversible, obviously not a real cipher. */
export const fakeEncrypt = (plain: string): string => `cipher(${plain})`

export interface TestDatabase {
  dir: string
  path: string
  handle: DatabaseHandle
  repos: Repositories
  /** Closes the current handle and reopens the same file, migrations included. */
  reopen(): TestDatabase
  /** Closes the handle and removes the temporary directory. */
  cleanup(): void
}

/** Opens a fresh database in a new temporary directory. */
export function createTestDatabase(): TestDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'witena-db-'))
  const path = join(dir, 'witena.db')
  return openTestDatabase(dir, path)
}

function openTestDatabase(dir: string, path: string): TestDatabase {
  const handle = openDatabase(path)
  const self: TestDatabase = {
    dir,
    path,
    handle,
    repos: createRepositories(handle.db, { encrypt: fakeEncrypt }),
    reopen() {
      handle.close()
      const next = openTestDatabase(dir, path)
      Object.assign(self, next)
      return self
    },
    cleanup() {
      self.handle.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return self
}

/**
 * Busy-waits until `Date.now()` reports a different millisecond.
 *
 * Ordering by `updatedAt` is only meaningful between distinct timestamps, and two
 * writes in one test run can easily land in the same millisecond. Message
 * ordering does not need this — that is what `seq` is for.
 */
export function tick(): void {
  const start = Date.now()
  while (Date.now() === start) {
    /* spin, typically well under a millisecond */
  }
}

/* -------------------------------------------------------------------------- */
/* Input builders                                                              */
/* -------------------------------------------------------------------------- */

export function providerInput(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    type: 'openai-compatible',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    presetId: 'deepseek',
    models: ['deepseek-chat'],
    ...overrides
  }
}

export function agentInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    name: 'Ada',
    avatar: { kind: 'initial', text: 'A', color: '#c2653a' },
    description: 'Systems thinker',
    systemPrompt: 'You are Ada.',
    providerId: 'provider-1',
    modelId: 'deepseek-chat',
    params: { temperature: 0.7 },
    skillNames: [],
    mcpServerIds: [],
    memoryEnabled: false,
    role: 'participant',
    ...overrides
  }
}

/**
 * Overrides that may set a field to an explicit `undefined`, i.e. *remove* it.
 *
 * `Partial<McpServerInput>` cannot express that under
 * `exactOptionalPropertyTypes`, and "an http server has no command" is exactly
 * what several cases are about.
 */
export type McpServerOverrides = { [K in keyof McpServerInput]?: McpServerInput[K] | undefined }

export function mcpServerInput(overrides: McpServerOverrides = {}): McpServerInput {
  return {
    name: 'everything',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    env: { NODE_ENV: 'production' },
    enabled: true,
    sideEffects: false,
    ...overrides
    // The spread reintroduces `| undefined` on every field it may cover; the
    // record is still a complete `McpServerInput` at runtime.
  } as McpServerInput
}

export function messageInput(
  chatId: string,
  overrides: Partial<MessageCreateInput> = {}
): MessageCreateInput {
  return {
    chatId,
    senderType: 'user',
    senderId: 'local',
    parts: [{ type: 'text', text: 'hello' }],
    status: 'done',
    round: 0,
    mentions: [],
    ...overrides
  }
}
