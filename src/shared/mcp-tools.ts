/**
 * What Witena offers when it is the MCP **server**.
 *
 * PLAN.md "Witena as an MCP server" puts a stdio shim in front of a local HTTP
 * endpoint, and the shim answers `tools/list` *without* waking the app — opening
 * an IDE must not launch Witena. So the tool definitions cannot live in
 * `src/main/mcp-endpoint/`: the shim would need a second, hand-written copy of
 * them, and two copies drift the first time one is edited.
 *
 * They live here instead, and both halves import the same module:
 *
 * | Side | Uses |
 * |---|---|
 * | The shim (`src/mcp-shim/`) | `MCP_TOOLS` for its offline `tools/list`, `MCP_SERVER_NAME`, `CLIENT_HEADER`, `MCP_PATH` |
 * | The endpoint (`src/main/mcp-endpoint/`) | `MCP_TOOLS` for its own `tools/list`, `MCP_TOOL_INPUTS` to validate `tools/call` arguments, the caps and the result type |
 *
 * One zod schema per tool is the single definition: `z.infer` gives the endpoint
 * its argument type, `z.toJSONSchema` gives both sides the wire schema, and
 * `.parse` gives the endpoint its validation. Hand-written JSON Schema beside a
 * zod schema would be the same drift one directory further down.
 *
 * **The descriptions are prompts.** Every reader of this file's `description`
 * strings is a coding agent deciding whether to call the tool and what to put in
 * it, so they are written at it: what the group can and cannot do, that the
 * *caller* applies the conclusion, and what `status: "running"` means. They are
 * not UI copy and never go through `t()` — the calling model is not the user and
 * has no language setting (CLAUDE.md rule 4 covers the renderer, not this).
 *
 * This module imports `zod` and nothing else of ours, because the shim bundles
 * it: anything it reached for would be bundled too.
 */
import { z } from 'zod'

/**
 * The server name every client namespaces the tools with (`mcp__witena__*`).
 *
 * Lower case because that is what the client-side prefix uses verbatim, and
 * because `claude mcp add <name>` / `codex mcp add <name>` take it as an
 * identifier rather than as a label.
 */
export const MCP_SERVER_NAME = 'witena'

/** The one path the endpoint answers on; everything else belongs to its host. */
export const MCP_PATH = '/mcp'

/**
 * The header the shim puts `initialize.clientInfo.name` into, so the endpoint
 * can say *who* asked.
 *
 * Lower-case, because `node:http` lower-cases incoming header names and the
 * endpoint reads `req.headers[CLIENT_HEADER]` directly. It is display data from
 * an untrusted process, not an identity: WP-13 sanitises it before it reaches a
 * transcript, and nothing is ever authorised by it.
 */
export const CLIENT_HEADER = 'x-witena-client'

/**
 * The six discussion tools, in the order `tools/list` presents them.
 *
 * The order is the order a caller meets them in: find the room, find the people,
 * ask, wait, read, stop. `list_committees` joins it in WP-14, once Phase 9 has
 * committees to list.
 */
export const MCP_TOOL_NAMES = [
  'list_chats',
  'list_agents',
  'start_discussion',
  'wait_for_discussion',
  'get_discussion',
  'stop_discussion'
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

/** Shortest wait a caller may ask for. Below this, waiting is not worth a call. */
export const MIN_WAIT_SECONDS = 5

/** Longest single wait. Ten minutes is past every client's own tool timeout. */
export const MAX_WAIT_SECONDS = 600

/**
 * The default wait, chosen against the tightest client timeout the design knows
 * of: Codex gives a tool call ~60 s, so a tool that answers at 50 s answers
 * *before* the client gives up, with `status: "running"` and an invitation to
 * call `wait_for_discussion` again. WP-0b measures the real numbers and may move
 * this one; nothing else in the design depends on its value.
 */
export const DEFAULT_WAIT_SECONDS = 50

/**
 * The cap on `question` + `context` together, in characters.
 *
 * Generous on purpose — a diff worth discussing is large — but finite, because
 * the text becomes a user message that every agent in the group pays for on
 * every round. The tool names the cap in its error so the caller can trim rather
 * than guess.
 */
export const MAX_DISCUSSION_INPUT_CHARS = 200_000

/**
 * The cap on one `positions` entry. A discussion that ended without consensus
 * returns every member's last word, and `n` unbounded essays would crowd out the
 * caller's own context. A cut entry is flagged `truncated`, never silently.
 */
export const MAX_POSITION_CHARS = 4_000

/**
 * How a discussion stands, from the caller's point of view.
 *
 * | Status | Means | What the caller does |
 * |---|---|---|
 * | `running` | The deadline came first; the group is still talking | Call `wait_for_discussion` again |
 * | `concluded` | The group agreed and a conclusion was written | Apply it |
 * | `ended` | The run finished without a conclusion (`max-rounds`) | Read `positions`: the disagreement is the answer |
 * | `stopped` | Somebody stopped the run — `stop_discussion`, or the user in the app | Decide whether to ask again |
 * | `error` | The run failed; `error` says how | Report it; do not retry blindly |
 * | `needs-attention` | The chat is waiting for the *user* to answer a permission prompt | Tell the user to open `url`; the run has not stopped |
 *
 * `running` is not a failure and neither is `ended`, which is the distinction the
 * tool descriptions spend the most words on.
 */
export type DiscussionStatus =
  | 'running'
  | 'concluded'
  | 'ended'
  | 'stopped'
  | 'error'
  | 'needs-attention'

/**
 * What every waiting tool returns, as structured content beside its text block.
 *
 * One shape for `start_discussion`, `wait_for_discussion` and `get_discussion`,
 * so a caller that learned to read one has learned to read all three.
 */
export interface DiscussionResult {
  status: DiscussionStatus
  chatId: string
  /** `witena://chat/<id>` */
  url: string
  /** Highest round reached by the run this result describes; 0 before round 1. */
  round: number
  conclusion?: { messageId: string; agentName: string; markdown: string }
  /** Present when `status` is `ended`: the last say of each participant. */
  positions?: { agentName: string; markdown: string; truncated: boolean }[]
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  /** Present when `status` is `error`. English, for the calling model. */
  error?: string
  /** One English sentence telling the calling model what to do next. */
  hint: string
}

const chatIdField = z.string().min(1).describe('The `chatId` of the discussion, as an earlier result or `list_chats` returned it.')

const maxWaitSecondsField = z
  .int()
  .min(MIN_WAIT_SECONDS)
  .max(MAX_WAIT_SECONDS)
  .optional()
  .describe(
    `How long to wait for an answer before returning with status "running", in seconds (${MIN_WAIT_SECONDS}-${MAX_WAIT_SECONDS}, default ${DEFAULT_WAIT_SECONDS}). Keep it under your own tool timeout.`
  )

const listChatsInput = z.object({
  query: z
    .string()
    .optional()
    .describe('Case-insensitive filter over chat titles and member names. Omit to list everything.')
})

const listAgentsInput = z.object({})

/**
 * `start_discussion`'s shape, with the three rules that cannot be expressed as
 * field types.
 *
 * The refinements are checks on the object rather than a wrapper, which is a zod
 * 4 property this file leans on twice: `MCP_TOOL_INPUTS` stays a map of
 * `ZodObject`s, and `z.toJSONSchema` still produces `type: 'object'` with the
 * fields in it. A custom check has no JSON Schema representation, so the wire
 * schema describes the fields and the *message* of a refusal describes the rule
 * — which is the right way round for a model, which reads the error.
 */
const startDiscussionInput = z
  .object({
    question: z
      .string()
      .min(1)
      .describe('What you want the group to decide. One question, stated plainly.'),
    context: z
      .string()
      .optional()
      .describe(
        'The material the group needs: the relevant code, the diff, the error output, the design notes. The agents cannot see your files, and a question without its material gets a generic answer.'
      ),
    chatId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Continue an existing discussion instead of starting one. Mutually exclusive with `agents`.'
      ),
    agents: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Who to ask, as names or ids from `list_agents`. Starts a new chat with exactly these members. Mutually exclusive with `chatId`.'
      ),
    title: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Title for the new chat. Defaults to the first line of `question`. Only valid when starting a new chat.'
      ),
    workdir: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Absolute path of the project the group may read while it discusses — normally the repository you are working in. Only valid when starting a new chat; an existing chat keeps its own.'
      ),
    rounds: z
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('How many rounds the group may take before it must stop. Defaults to the chat setting.'),
    maxWaitSeconds: maxWaitSecondsField
  })
  .refine(
    (input) => (input.chatId !== undefined) !== ((input.agents?.length ?? 0) > 0),
    {
      message:
        'Pass exactly one of `chatId` (continue an existing discussion) or a non-empty `agents` (start a new one).'
    }
  )
  .refine((input) => input.chatId === undefined || input.title === undefined, {
    message: '`title` names a new chat, so it cannot be combined with `chatId`.'
  })
  .refine((input) => input.chatId === undefined || input.workdir === undefined, {
    message:
      '`workdir` is set when a chat is created, so it cannot be combined with `chatId`. An existing chat keeps the folder it was given.'
  })

const waitForDiscussionInput = z.object({
  chatId: chatIdField,
  maxWaitSeconds: maxWaitSecondsField
})

const getDiscussionInput = z.object({
  chatId: chatIdField,
  detail: z
    .enum(['conclusion', 'transcript'])
    .describe(
      '`conclusion` for the same result shape the waiting tools return; `transcript` for the whole discussion as markdown.'
    ),
  afterMessageId: z
    .string()
    .min(1)
    .optional()
    .describe('Return only what was said after this message. Use it to follow a long discussion in pieces.')
})

const stopDiscussionInput = z.object({ chatId: chatIdField })

/**
 * The zod input schema per tool; `z.infer<typeof MCP_TOOL_INPUTS['…']>` gives the
 * argument type the endpoint's tool implementation receives.
 *
 * Declared with `satisfies` rather than an annotation on purpose: an annotation
 * of `{ [N in McpToolName]: z.ZodObject<z.ZodRawShape> }` would widen every entry
 * and `z.infer` would hand every tool an index signature instead of its fields.
 */
export const MCP_TOOL_INPUTS = {
  list_chats: listChatsInput,
  list_agents: listAgentsInput,
  start_discussion: startDiscussionInput,
  wait_for_discussion: waitForDiscussionInput,
  get_discussion: getDiscussionInput,
  stop_discussion: stopDiscussionInput
} satisfies { [N in McpToolName]: z.ZodObject<z.ZodRawShape> }

export interface McpToolDefinition {
  name: McpToolName
  title: string
  description: string
  inputSchema: Record<string, unknown>
}

/** The human-readable half of each definition, in `MCP_TOOL_NAMES` order. */
const TOOL_TEXT: { [N in McpToolName]: { title: string; description: string } } = {
  list_chats: {
    title: 'List Witena chats',
    description:
      'List the group chats in Witena, most recently active first. Use it to find the `chatId` of a discussion you started earlier, or of an existing group you want to ask again. Read-only: it starts nothing and costs nothing.'
  },
  list_agents: {
    title: 'List Witena agents',
    description:
      'List the agents configured in Witena — name, role and the model each one runs on. Call it before `start_discussion` to choose who should be in the group, then pass those names as `agents`. Agents flagged as executors cannot be invited: you are the executor.'
  },
  start_discussion: {
    title: 'Ask a Witena group',
    description: [
      'Put a question to a group of Witena agents and wait for their answer. Several models discuss it with each other over a few rounds and either agree on a conclusion or return their disagreement.',
      'Start a new group by naming its members in `agents` (names or ids from `list_agents`), or continue an existing discussion by passing its `chatId` — exactly one of the two.',
      'Put the material the group needs into `context`: the relevant code, the diff, the failing output, the design notes. The agents cannot see your files, and a question without its material gets a generic answer.',
      'The group only reads and argues; it never edits anything. You are the executor: the conclusion comes back to you and you are the one who applies it.',
      'The call returns within `maxWaitSeconds` whether the group is finished or not. `status: "running"` is not a failure — it means the discussion is still going, so call `wait_for_discussion` with the same `chatId` to keep waiting. `status: "ended"` means the group finished without agreeing; `positions` then holds each member\'s last word, which is the answer. Every result carries a `hint` saying what to do next.'
    ].join('\n\n')
  },
  wait_for_discussion: {
    title: 'Wait for a Witena discussion',
    description:
      'Keep waiting for a discussion that is still running. Pass the `chatId` from an earlier result and repeat the call for as long as `status` comes back `running`. Waits up to `maxWaitSeconds` and returns the same result shape as `start_discussion`. If the discussion has already finished, it answers immediately with the finished result.'
  },
  get_discussion: {
    title: 'Read a Witena discussion',
    description:
      'Read a discussion without waiting for it. `detail: "conclusion"` gives the result shape the waiting tools return, as it stands right now. `detail: "transcript"` gives the whole discussion as markdown — use it when you want the arguments and the reasoning rather than the verdict. `afterMessageId` limits the answer to what was said after that message.'
  },
  stop_discussion: {
    title: 'Stop a Witena discussion',
    description:
      'Stop a discussion that is still running. The chat and everything said so far stay in Witena and can be read with `get_discussion`; only the agents’ remaining turns are cancelled. Use it when the answer is no longer needed or the group is going in circles.'
  }
}

/**
 * The JSON Schema for one tool's input, as both `tools/list` implementations
 * send it.
 *
 * `$schema` is dropped: it is a legal JSON Schema keyword, but a client that
 * re-describes MCP tools as its provider's function-calling schema can reject
 * unknown top-level keys, and the dialect announcement buys a tool schema
 * nothing. `io: 'input'` is what a tool argument is — the distinction is free
 * today (no field has a default or a transform) and correct if one ever gains
 * one.
 */
function inputSchemaFor(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: 'input' })
  return rest as Record<string, unknown>
}

/**
 * The complete `tools/list` payload, built from the two tables above so a tool
 * cannot exist in one and not the other.
 */
export const MCP_TOOLS: readonly McpToolDefinition[] = MCP_TOOL_NAMES.map((name) => ({
  name,
  title: TOOL_TEXT[name].title,
  description: TOOL_TEXT[name].description,
  inputSchema: inputSchemaFor(MCP_TOOL_INPUTS[name])
}))

/** The scheme the app registers, and the one `chatUrl` speaks. */
const CHAT_URL_PREFIX = 'witena://chat/'

/**
 * Exactly the canonical 8-4-4-4-12 form, which is what `randomUUID()` writes and
 * therefore what every chat id in the database is.
 *
 * The version and variant nibbles are deliberately not pinned: this is a syntax
 * check on a link, not proof that a chat exists, and the caller finds that out
 * by looking the id up.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The deep link to a chat: what a `DiscussionResult` carries as `url` and what
 * the app opens through `open-url` (WP-8).
 */
export function chatUrl(chatId: string): string {
  return `${CHAT_URL_PREFIX}${chatId}`
}

/**
 * The chat id in a `witena://chat/<uuid>` link, or `null`.
 *
 * Deliberately strict, and parsed by shape rather than through `new URL`: the
 * argument arrives from the operating system when a user clicks a link, so a
 * trailing path segment, a query string, a fragment, another host or another
 * scheme are all "not a chat link" rather than something to interpret
 * charitably. `null` is the only refusal — the caller (WP-8) selects nothing and
 * shows no error, because an unrecognised link is not the user's mistake to be
 * told about.
 */
export function parseChatUrl(url: string): string | null {
  if (!url.startsWith(CHAT_URL_PREFIX)) return null
  const id = url.slice(CHAT_URL_PREFIX.length)
  return UUID.test(id) ? id : null
}
