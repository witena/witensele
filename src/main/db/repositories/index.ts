/**
 * The storage layer as one injectable object.
 *
 * Services (the IPC handlers in S1.3, `ChatRunner` and `AgentTurn` later) receive
 * a `Repositories` instead of reaching for a module-level database handle, which
 * is what keeps them Electron-free and testable against a temporary file.
 */
import type { DrizzleDb } from '../database'
import type { Encrypt } from './providers'
import { createProviderRepository, type ProviderRepository } from './providers'
import { createAgentRepository, type AgentRepository } from './agents'
import { createMcpServerRepository, type McpServerRepository } from './mcpServers'
import { createChatRepository, type ChatRepository } from './chats'
import { createMessageRepository, type MessageRepository } from './messages'
import {
  createPermissionGrantRepository,
  type PermissionGrantRepository
} from './permissionGrants'
import { createSettingsRepository, type SettingsRepository } from './settings'

export interface Repositories {
  providers: ProviderRepository
  agents: AgentRepository
  mcpServers: McpServerRepository
  chats: ChatRepository
  messages: MessageRepository
  /** "Always allow in this chat", persisted and revocable since S5.15. */
  permissionGrants: PermissionGrantRepository
  settings: SettingsRepository
}

export interface RepositoryOptions {
  /**
   * Turns a plaintext API key into the ciphertext stored in `providers`.
   * Injected rather than imported so this layer never touches electron's
   * `safeStorage`; decryption stays in the main process (see `providers.ts`).
   */
  encrypt: Encrypt
}

export function createRepositories(db: DrizzleDb, options: RepositoryOptions): Repositories {
  return {
    providers: createProviderRepository(db, options.encrypt),
    agents: createAgentRepository(db),
    mcpServers: createMcpServerRepository(db),
    chats: createChatRepository(db),
    messages: createMessageRepository(db),
    permissionGrants: createPermissionGrantRepository(db),
    settings: createSettingsRepository(db)
  }
}

export type { ProviderRepository, Encrypt } from './providers'
export type { AgentRepository } from './agents'
export type { McpServerRepository } from './mcpServers'
export type { ChatRepository } from './chats'
export { CHAT_SEARCH_LIMIT, DEFAULT_CHAT_TITLE, escapeLike } from './chats'
export type {
  MessageRepository,
  MessageCreateInput,
  MessagePatch,
  MessageListQuery
} from './messages'
export { DEFAULT_MESSAGE_PAGE_SIZE } from './messages'
export type { PermissionGrantRepository } from './permissionGrants'
export type { SettingsRepository } from './settings'
