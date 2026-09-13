/**
 * The two built-in memory tools: `memory_save` and `memory_search`, plus the
 * `Memory` section of the system prompt.
 *
 * ## Why these bypass the side-effects rule
 *
 * `collectAgentTools` withholds a `sideEffects` MCP server from any agent that
 * is not an `executor`, because several models writing to one working directory
 * overwrite each other and nothing is reviewable (PLAN.md, "Future extension").
 * `memory_save` writes, and is still attached to participants, because **the
 * only thing it can write is the agent's own memory folder**:
 * `userData/memory/<agentId>/notes/`, created by this app, read by nobody but
 * this agent, and never a file the user is working on. It cannot reach the
 * user's files, another agent's notes, the network or a shell. The rule protects
 * the user's work; an agent's notebook is not the user's work.
 *
 * The confinement is enforced in `store.ts` — every path is resolved inside the
 * agent's own directory — rather than trusted, because the arguments come from a
 * language model.
 *
 * ## Why a save emits no event
 *
 * A saved note changes nothing that is on screen: the transcript shows the tool
 * card the SDK already produced, and the only view of the notes themselves is
 * the agent editor's memory panel, which loads when it opens. Adding an event
 * would mean a store, a subscription and a re-render for a list nobody is
 * looking at.
 */
import { jsonSchema, tool, type ToolSet } from 'ai'
import type { MemoryStore } from './store'
import { MEMORY_INDEX } from './store'

/** Tool the agent calls to remember something across chats. */
export const MEMORY_SAVE_TOOL = 'memory_save'

/** Tool the agent calls to look through what it has remembered. */
export const MEMORY_SEARCH_TOOL = 'memory_search'

/**
 * How much of `MEMORY.md` reaches the system prompt.
 *
 * The index is carried on **every** turn of every chat, so it is the one part of
 * the prompt that grows without bound as the agent is used. 8 KB is roughly two
 * thousand tokens — enough for a few hundred entries, small enough that it never
 * becomes the reason a context window overflows. Past the cap the index is cut
 * and marked, which is honest: the agent can still find the rest with
 * `memory_search`.
 */
export const MEMORY_PROMPT_MAX_BYTES = 8 * 1024

/** The marker that replaces what did not fit. */
export const MEMORY_TRUNCATED = `… (memory index truncated; use ${MEMORY_SEARCH_TOOL} to find older entries)`

/**
 * The `Memory` section of the system prompt: the index, capped and marked.
 *
 * Cut on a **line** boundary rather than mid-entry: half a markdown link tells
 * the model a note exists at a path it cannot read.
 */
export function buildMemorySection(index: string): string {
  const trimmed = index.trim()
  const body = trimmed.length > 0 ? capIndex(trimmed) : '(empty — nothing has been remembered yet)'

  return [
    `Your memory (${MEMORY_INDEX}), carried across every chat:`,
    '',
    body,
    '',
    `Use ${MEMORY_SEARCH_TOOL} to read what is behind an entry, and ${MEMORY_SAVE_TOOL} to remember a durable fact about the user or the project. Do not save passing details of one conversation.`
  ].join('\n')
}

/** The index, truncated to `MEMORY_PROMPT_MAX_BYTES` on a line boundary. */
function capIndex(index: string): string {
  if (Buffer.byteLength(index, 'utf8') <= MEMORY_PROMPT_MAX_BYTES) return index

  const lines = index.split('\n')
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    const cost = Buffer.byteLength(`${line}\n`, 'utf8')
    if (size + cost > MEMORY_PROMPT_MAX_BYTES) break
    kept.push(line)
    size += cost
  }
  // A single line longer than the whole budget still has to be cut somewhere.
  if (kept.length === 0) kept.push(Buffer.from(index, 'utf8').subarray(0, MEMORY_PROMPT_MAX_BYTES).toString('utf8'))
  return `${kept.join('\n')}\n${MEMORY_TRUNCATED}`
}

/** `memory_save` / `memory_search`, bound to one store and one agent. */
export function buildMemoryTools(store: MemoryStore, agentId: string): ToolSet {
  return {
    [MEMORY_SAVE_TOOL]: tool({
      description:
        'Remember something for later conversations: a durable fact about the user, the project or a decision the group reached. Writes one note and adds it to your memory index.',
      inputSchema: jsonSchema<{ title: string; content: string }>({
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short name for this memory.' },
          content: {
            type: 'string',
            description: 'What to remember, in full sentences, so it reads on its own later.'
          }
        },
        required: ['title', 'content'],
        additionalProperties: false
      }),
      execute: async ({ title, content }) => {
        const entry = store.saveNote(agentId, { title, content })
        return `Saved "${entry.title}" to ${entry.path}.`
      }
    }),

    [MEMORY_SEARCH_TOOL]: tool({
      description:
        'Search your saved memory for a word or phrase. Returns the matching notes with a snippet of each.',
      inputSchema: jsonSchema<{ query: string }>({
        type: 'object',
        properties: { query: { type: 'string', description: 'Text to look for.' } },
        required: ['query'],
        additionalProperties: false
      }),
      execute: async ({ query }) => {
        const hits = store.search(agentId, query)
        if (hits.length === 0) return `Nothing in memory matches "${query}".`
        return hits.map((hit) => `## ${hit.title} (${hit.path})\n${hit.snippet}`).join('\n\n')
      }
    })
  }
}
