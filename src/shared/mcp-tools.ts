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
 * | The shim (`src/mcp-shim/`) | `MCP_TOOLS` for its offline `tools/list`, `MCP_PROMPTS` and `renderPrompt` for its offline `prompts/list` and `prompts/get`, `MCP_SERVER_NAME`, `CLIENT_HEADER`, `MCP_PATH` |
 * | The endpoint (`src/main/mcp-endpoint/`) | `MCP_TOOLS` for its own `tools/list`, `MCP_TOOL_INPUTS` to validate `tools/call` arguments, the same `MCP_PROMPTS` / `renderPrompt`, the caps and the result type |
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
 * The seven discussion tools, in the order `tools/list` presents them.
 *
 * The order is the order a caller meets them in: find the room, find the people,
 * find the standing groups, ask, wait, read, stop. `list_committees` joined it
 * in WP-14, when Phase 9 gave Witena committees to list.
 */
export const MCP_TOOL_NAMES = [
  'list_chats',
  'list_agents',
  'list_committees',
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

const listCommitteesInput = z.object({})

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
 *
 * Since WP-14 the first rule is *exactly one of* an existing `chatId` **or** a
 * new group, where a new group is `committee`, `agents`, or both — the same "a
 * committee plus single agents" shape S9.3's New chat dialog offers. The
 * alternation is still binary, so one refinement still states it: `committee`
 * together with `chatId` fails the same check `agents` together with `chatId`
 * does, and for the same reason — a chat's membership is decided once, when it
 * is created.
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
        'Continue an existing discussion instead of starting one. Mutually exclusive with `committee` and `agents`.'
      ),
    committee: z
      .string()
      .min(1)
      .optional()
      .describe(
        'A standing group to convene, as a name or id from `list_committees`. Starts a new chat with that committee’s members, in its own order. May be combined with `agents` to add people to it; mutually exclusive with `chatId`.'
      ),
    agents: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Who to ask, as names or ids from `list_agents`. Starts a new chat with these members, added after `committee`’s when both are given. Mutually exclusive with `chatId`.'
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
    (input) =>
      (input.chatId !== undefined) !==
      (input.committee !== undefined || (input.agents?.length ?? 0) > 0),
    {
      message:
        'Pass exactly one of `chatId` (continue an existing discussion) or a new group (`committee`, a non-empty `agents`, or both).'
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
  list_committees: listCommitteesInput,
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
      'List the agents configured in Witena — name, role and the model each one runs on. Call it before `start_discussion` to choose who should be in the group, then pass those names as `agents`. Agents flagged as executors cannot be invited individually: you are the executor.'
  },
  list_committees: {
    title: 'List Witena committees',
    description:
      'List the standing groups the user has saved in Witena — name, description, and members in speaking order. A committee is the user’s own answer to "who should look at this", so prefer one over assembling a group by hand: pass its name or id as `committee` on `start_discussion` and the whole group is convened at once, and add anybody it is missing with `agents` in the same call. Read-only: it starts nothing and costs nothing.'
  },
  start_discussion: {
    title: 'Ask a Witena group',
    description: [
      'Put a question to a group of Witena agents and wait for their answer. Several models discuss it with each other over a few rounds and either agree on a conclusion or return their disagreement.',
      'Start a new group by convening a saved `committee` (a name or id from `list_committees`), by naming individual members in `agents` (names or ids from `list_agents`), or by both at once — the committee’s members first, then the extras. Or continue an existing discussion by passing its `chatId`. A new group and a `chatId` are mutually exclusive: pass exactly one of the two.',
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

/* -------------------------------------------------------------------------- */
/* Prompts (WP-15)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The prompts Witena offers, which today is one.
 *
 * An MCP prompt is a *user-invoked* template: in Claude Code it appears as the
 * slash command `/mcp__witena__consult`, and what it expands to is a message
 * addressed to the coding agent, not to Witena. So `consult` is not another way
 * to call `start_discussion` — it is the sentence that teaches the agent to call
 * it properly: bring the real material as `context`, and keep waiting rather
 * than treating `running` as a failure.
 *
 * WP-0b measured which clients ask for this at all: Claude Code sends
 * `prompts/list` on every session start, Codex never sends it and carries no
 * handler for prompts. The prompt is therefore a Claude-Code-only extra, and
 * nothing in this feature is allowed to depend on it — the tools stand on their
 * own, and the resource is the half that both clients fetch.
 */
export const MCP_PROMPT_NAMES = ['consult'] as const

export type McpPromptName = (typeof MCP_PROMPT_NAMES)[number]

/**
 * One argument of a prompt, in MCP's own shape.
 *
 * Prompt arguments are **strings and only strings** on the wire (`prompts/get`
 * takes `arguments?: { [key: string]: string }`), which is why `agents` below is
 * a comma-separated list rather than the array `start_discussion` takes. The
 * expansion tells the agent to split it.
 */
export interface McpPromptArgument {
  name: string
  description: string
  required: boolean
}

export interface McpPromptDefinition {
  name: McpPromptName
  title: string
  description: string
  arguments: McpPromptArgument[]
}

/**
 * `consult`'s arguments, as the wire declares them and as both sides parse them.
 *
 * Everything is a string because that is all MCP allows, and `question` is the
 * only required one: a user typing `/mcp__witena__consult` has a question and
 * usually nothing else, and choosing who to ask is work the agent can do with
 * `list_agents`.
 *
 * `committee` arrived with WP-14, in the same commit as `start_discussion`'s own
 * `committee` field — WP-15 left it out on purpose, because an argument that
 * expanded into an instruction to pass `committee` to a tool that had no such
 * field would have been a prompt that teaches a model to fail. It obeys the
 * tool's rule rather than a looser one of its own: `chat` continues a
 * discussion, `committee` and `agents` start one, and the two sides do not mix.
 */
const consultPromptInput = z.object({
  question: z.string().min(1),
  chat: z.string().min(1).optional(),
  committee: z.string().min(1).optional(),
  agents: z.string().min(1).optional()
})

/** The zod input per prompt; the shape `renderPrompt` parses `arguments` with. */
export const MCP_PROMPT_INPUTS = {
  consult: consultPromptInput
} satisfies { [N in McpPromptName]: z.ZodObject<z.ZodRawShape> }

const CONSULT_ARGUMENTS: McpPromptArgument[] = [
  {
    name: 'question',
    description: 'What you want the group to decide. One question, stated plainly.',
    required: true
  },
  {
    name: 'chat',
    description:
      'The chatId of an existing Witena discussion to continue, from list_chats. Leave it out to start a new group.',
    required: false
  },
  {
    name: 'committee',
    description:
      'The name of a saved Witena committee to convene, from list_committees. May be combined with `agents` to add people to it; do not combine it with `chat`.',
    required: false
  },
  {
    name: 'agents',
    description:
      'Who to ask, as a comma-separated list of agent names from list_agents. Leave it out to let the assistant choose, and do not combine it with `chat`.',
    required: false
  }
]

export const MCP_PROMPTS: readonly McpPromptDefinition[] = [
  {
    name: 'consult',
    title: 'Consult a Witena group',
    description:
      'Put the question to a group of Witena agents, wait for them to finish arguing, and come back with their conclusion.',
    arguments: CONSULT_ARGUMENTS
  }
]

/** One message of a prompt expansion. Plain JSON, so the SDK is not imported. */
export interface McpPromptMessage {
  role: 'user'
  content: { type: 'text'; text: string }
}

/**
 * What `prompts/get` answers, or why it cannot.
 *
 * A result rather than a throw because the two sides report a refusal
 * differently — the endpoint and the shim each turn `ok: false` into their own
 * `McpError` — and because this module may not import the SDK that defines one.
 */
export type PromptRendering =
  | { ok: true; description: string; messages: McpPromptMessage[] }
  | { ok: false; message: string }

/**
 * `prompts/get`, for both sides.
 *
 * The shim answers this without any I/O at all: the expansion is a function of
 * the arguments and nothing else, the app would produce the same text, and a
 * `prompts/list` on every Claude Code session start must never be the thing that
 * launches Witena. Sharing the function is what makes "the same text" a fact
 * rather than an intention.
 */
export function renderPrompt(
  name: string,
  args: Record<string, unknown> | undefined
): PromptRendering {
  if (name !== 'consult') {
    return {
      ok: false,
      message: `Unknown prompt: ${name}. Witena offers: ${MCP_PROMPT_NAMES.join(', ')}.`
    }
  }

  const parsed = consultPromptInput.safeParse(args ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.map((segment) => String(segment)).join('.') ?? ''
    return {
      ok: false,
      message:
        path.length > 0
          ? `${path}: ${issue?.message ?? 'is not valid'}`
          : (issue?.message ?? 'The arguments are not valid.')
    }
  }

  const { question, chat, committee, agents } = parsed.data
  if (chat !== undefined && (committee !== undefined || agents !== undefined)) {
    return {
      ok: false,
      message:
        'Pass either `chat` (continue an existing discussion) or a new group (`committee`, `agents`, or both), not both — start_discussion takes exactly one of them.'
    }
  }

  return {
    ok: true,
    description: `Consult a Witena group about: ${question}`,
    messages: [
      { role: 'user', content: { type: 'text', text: consultText(question, chat, committee, agents) } }
    ]
  }
}

/**
 * The expansion, addressed to the coding agent that is reading it.
 *
 * Numbered because it is a procedure and the failure mode it exists to prevent
 * is skipping step 2 or giving up at step 3: a model that asks a group a
 * question without pasting the code gets a generic answer, and one that reads
 * `status: "running"` as an error abandons a discussion that was about to
 * conclude.
 */
function consultText(
  question: string,
  chat: string | undefined,
  committee: string | undefined,
  agents: string | undefined
): string {
  const fields: string[] = []
  if (committee !== undefined) fields.push(`\`committee: ${JSON.stringify(committee)}\``)
  if (agents !== undefined) {
    fields.push(
      `\`agents: ${JSON.stringify(
        agents
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      )}\``
    )
  }

  const who =
    chat !== undefined
      ? `Continue the existing discussion: pass \`chatId: ${JSON.stringify(chat)}\` to \`start_discussion\` (no \`committee\`, no \`agents\`).`
      : fields.length > 0
        ? `Start a new group with exactly these members: pass ${fields.join(
            ' and '
          )} to \`start_discussion\`. If a name is not exact, call \`list_committees\` and \`list_agents\` first and use the names they return.`
        : 'Call `list_committees` first: if one of the saved groups fits this question, convene it by passing its name as `committee` to `start_discussion`. Otherwise call `list_agents` and choose the two to four agents whose role fits, then pass their names as `agents`.'

  return [
    'Ask a Witena group about the question below and bring their answer back to me. Witena runs several models as a group chat: they argue for a few rounds and either agree on a conclusion or hand back their disagreement.',
    `Question: ${question}`,
    'Do this:',
    [
      `1. ${who}`,
      '2. Put the material the group needs into `context`: the actual code, the diff, the failing output, the design notes. The agents cannot see my files, and a question without its material gets a generic answer.',
      '3. `status: "running"` is not a failure — it means the group is still talking. Call `wait_for_discussion` with the same `chatId` and repeat for as long as it keeps coming back `running`.',
      '4. Then report what came back: `concluded` — give me the conclusion and, if it is code, apply it yourself, because the group only reads and argues and you are the one who writes. `ended` — the group did not agree, so give me each member\'s position; the disagreement is the answer. `needs-attention` — tell me to open the `url` in Witena. `error` or `stopped` — say what happened and do not retry blindly.'
    ].join('\n'),
    'Every result carries a `hint` saying what to do next; follow it.'
  ].join('\n\n')
}

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
