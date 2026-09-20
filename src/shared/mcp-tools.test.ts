/**
 * The MCP tool contract, which two processes and four later work packages read.
 *
 * What is worth testing here is not that zod works. It is the three things that
 * would go unnoticed until an IDE was talking to a running app:
 *
 * 1. **The wire shape.** `tools/list` is served twice — by the shim without the
 *    app, by the endpoint with it — and an `inputSchema` that is not a JSON
 *    Schema object is rejected by the client, not by us.
 * 2. **The rules that are not field types.** `start_discussion` accepts exactly
 *    one of `chatId` and `agents`, and `title` / `workdir` only when it is
 *    creating the chat. Those live in refinements, which `z.toJSONSchema` cannot
 *    express, so the *only* thing that enforces them is `.parse` — here and in
 *    WP-3.
 * 3. **The link round trip.** `DiscussionResult.url` is produced by `chatUrl`
 *    and consumed, after a trip through the operating system, by `parseChatUrl`.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import {
  chatUrl,
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  MCP_PROMPT_INPUTS,
  MCP_PROMPT_NAMES,
  MCP_PROMPTS,
  MCP_TOOL_INPUTS,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  MIN_WAIT_SECONDS,
  parseChatUrl,
  renderPrompt
} from './mcp-tools'

/** A valid `randomUUID()` output, which is what every chat id in the database is. */
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

/**
 * The module's own text, for the import assertion at the bottom.
 *
 * Read through Vite's `?raw` rather than `node:fs`, because `src/shared/**` is
 * compiled by `tsconfig.web.json` too and that project has no `node` types —
 * the same trick `brand-mark.test.ts` uses on the renderer side.
 */
const SOURCE: string = Object.values(
  import.meta.glob<string>('./mcp-tools.ts', { query: '?raw', import: 'default', eager: true })
)[0]

describe('MCP_TOOLS', () => {
  it('lists exactly the seven names, in MCP_TOOL_NAMES order', () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES])
    // WP-14's addition sits beside the other two read-only finders, before the
    // tool a caller reaches for once it has chosen who to ask.
    expect(MCP_TOOL_NAMES.indexOf('list_committees')).toBeLessThan(
      MCP_TOOL_NAMES.indexOf('start_discussion')
    )
  })

  it('has a zod input for every name and no extras', () => {
    expect(Object.keys(MCP_TOOL_INPUTS).sort()).toEqual([...MCP_TOOL_NAMES].sort())
  })

  it('infers each tool its own argument type, which is what the endpoint codes against', () => {
    // The point of declaring MCP_TOOL_INPUTS with `satisfies` instead of an
    // annotation: an annotation would widen every entry to
    // `ZodObject<ZodRawShape>` and hand WP-3 an index signature.
    expectTypeOf<
      z.infer<(typeof MCP_TOOL_INPUTS)['start_discussion']>['question']
    >().toEqualTypeOf<string>()
    expectTypeOf<
      z.infer<(typeof MCP_TOOL_INPUTS)['get_discussion']>['detail']
    >().toEqualTypeOf<'conclusion' | 'transcript'>()
    expectTypeOf<
      z.infer<(typeof MCP_TOOL_INPUTS)['stop_discussion']>
    >().toEqualTypeOf<{ chatId: string }>()
  })

  it('gives every tool a JSON Schema object as its input schema', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object' })
      expect(tool.inputSchema.properties, tool.name).toBeTypeOf('object')
      // `$schema` is dropped: a client that re-describes the tool for its own
      // provider can refuse unknown top-level keys.
      expect(tool.inputSchema).not.toHaveProperty('$schema')
    }
  })

  it('gives every tool a title and a description written for the calling model', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.title.length, tool.name).toBeGreaterThan(0)
      expect(tool.description.length, tool.name).toBeGreaterThan(40)
    }
  })

  it('tells the caller, in start_discussion, who applies the conclusion and what running means', () => {
    const description = MCP_TOOLS.find((tool) => tool.name === 'start_discussion')?.description ?? ''
    expect(description).toContain('context')
    expect(description).toContain('you are the one who applies it')
    expect(description).toContain('wait_for_discussion')
  })

  it('describes the fields, since the schema is the only documentation a model gets', () => {
    const schema = MCP_TOOLS.find((tool) => tool.name === 'start_discussion')?.inputSchema
    const properties = (schema as { properties: Record<string, { description?: string }> }).properties
    for (const field of [
      'question',
      'context',
      'chatId',
      'committee',
      'agents',
      'workdir',
      'maxWaitSeconds'
    ]) {
      expect(properties[field]?.description, field).toBeTruthy()
    }
  })

  it('tells the caller what a committee is for, in list_committees and in start_discussion', () => {
    const listing = MCP_TOOLS.find((tool) => tool.name === 'list_committees')
    expect(listing?.description).toContain('`committee`')
    expect(listing?.description).toContain('start_discussion')
    // Read-only, like the other two finders: nothing it says may read as a way
    // to start something.
    expect(listing?.description).toMatch(/read-only/i)

    const start = MCP_TOOLS.find((tool) => tool.name === 'start_discussion')?.description ?? ''
    expect(start).toContain('list_committees')
    expect(start).toContain('mutually exclusive')
  })
})

describe('start_discussion input', () => {
  const input = MCP_TOOL_INPUTS.start_discussion

  it('accepts a new chat named by agents', () => {
    const parsed = input.safeParse({ question: 'Should we shard?', agents: ['Ada', 'Lin'] })
    expect(parsed.success).toBe(true)
  })

  it('accepts an existing chat named by id', () => {
    expect(input.safeParse({ question: 'And now?', chatId: UUID }).success).toBe(true)
  })

  it('refuses both chatId and agents', () => {
    const parsed = input.safeParse({ question: 'q', chatId: UUID, agents: ['Ada'] })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toContain('exactly one')
  })

  it('refuses neither chatId nor a new group', () => {
    expect(input.safeParse({ question: 'q' }).success).toBe(false)
  })

  it('treats an empty agents array as "not given" rather than as a group of nobody', () => {
    expect(input.safeParse({ question: 'q', agents: [] }).success).toBe(false)
  })

  it('accepts a committee on its own, and a committee with extra agents', () => {
    expect(input.safeParse({ question: 'q', committee: 'Architecture review' }).success).toBe(true)
    // WP-14: the new-chat form is *at least one of* `committee` and `agents`,
    // which is S9.3's "a committee plus single agents" dialog shape.
    expect(input.safeParse({ question: 'q', committee: 'Review', agents: ['Ada'] }).success).toBe(
      true
    )
    // An empty `agents` beside a committee is still "not given", and the
    // committee alone carries the object.
    expect(input.safeParse({ question: 'q', committee: 'Review', agents: [] }).success).toBe(true)
  })

  it('refuses a committee together with chatId, because membership is decided once', () => {
    const parsed = input.safeParse({ question: 'q', chatId: UUID, committee: 'Review' })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toContain('exactly one')
  })

  it('refuses an empty committee name rather than reading it as "no committee"', () => {
    expect(input.safeParse({ question: 'q', committee: '' }).success).toBe(false)
  })

  it('refuses title together with chatId', () => {
    const parsed = input.safeParse({ question: 'q', chatId: UUID, title: 'Sharding' })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toContain('`title`')
  })

  it('refuses workdir together with chatId', () => {
    const parsed = input.safeParse({ question: 'q', chatId: UUID, workdir: '/repo' })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toContain('`workdir`')
  })

  it('accepts title and workdir on a new chat', () => {
    const parsed = input.safeParse({
      question: 'q',
      agents: ['Ada'],
      title: 'Sharding',
      workdir: '/repo'
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses an empty question', () => {
    expect(input.safeParse({ question: '', agents: ['Ada'] }).success).toBe(false)
  })

  it('bounds rounds at one to ten whole rounds', () => {
    const ok = (rounds: number): boolean =>
      input.safeParse({ question: 'q', agents: ['Ada'], rounds }).success
    expect(ok(1)).toBe(true)
    expect(ok(10)).toBe(true)
    expect(ok(0)).toBe(false)
    expect(ok(11)).toBe(false)
    expect(ok(1.5)).toBe(false)
  })
})

describe('the wait bounds', () => {
  it('has a default inside its own range', () => {
    expect(DEFAULT_WAIT_SECONDS).toBeGreaterThanOrEqual(MIN_WAIT_SECONDS)
    expect(DEFAULT_WAIT_SECONDS).toBeLessThanOrEqual(MAX_WAIT_SECONDS)
  })

  it.each(['start_discussion', 'wait_for_discussion'] as const)(
    'bounds maxWaitSeconds on %s',
    (name) => {
      const base =
        name === 'start_discussion'
          ? { question: 'q', agents: ['Ada'] }
          : { chatId: UUID }
      const ok = (maxWaitSeconds: number): boolean =>
        MCP_TOOL_INPUTS[name].safeParse({ ...base, maxWaitSeconds }).success
      expect(ok(MIN_WAIT_SECONDS)).toBe(true)
      expect(ok(MAX_WAIT_SECONDS)).toBe(true)
      expect(ok(MIN_WAIT_SECONDS - 1)).toBe(false)
      expect(ok(MAX_WAIT_SECONDS + 1)).toBe(false)
      expect(ok(30.5)).toBe(false)
      // Absent is legal; the tool applies DEFAULT_WAIT_SECONDS.
      expect(MCP_TOOL_INPUTS[name].safeParse(base).success).toBe(true)
    }
  )
})

describe('the other inputs', () => {
  it('lets list_chats take an optional query, and the other two finders take nothing', () => {
    expect(MCP_TOOL_INPUTS.list_chats.safeParse({}).success).toBe(true)
    expect(MCP_TOOL_INPUTS.list_chats.safeParse({ query: 'sharding' }).success).toBe(true)
    expect(MCP_TOOL_INPUTS.list_agents.safeParse({}).success).toBe(true)
    expect(MCP_TOOL_INPUTS.list_committees.safeParse({}).success).toBe(true)
  })

  it('requires a chatId on get_discussion and stop_discussion', () => {
    expect(MCP_TOOL_INPUTS.stop_discussion.safeParse({}).success).toBe(false)
    expect(MCP_TOOL_INPUTS.stop_discussion.safeParse({ chatId: UUID }).success).toBe(true)
    expect(MCP_TOOL_INPUTS.get_discussion.safeParse({ chatId: UUID }).success).toBe(false)
  })

  it('accepts only the two detail levels get_discussion renders', () => {
    const ok = (detail: string): boolean =>
      MCP_TOOL_INPUTS.get_discussion.safeParse({ chatId: UUID, detail }).success
    expect(ok('conclusion')).toBe(true)
    expect(ok('transcript')).toBe(true)
    expect(ok('everything')).toBe(false)
  })

  it('takes afterMessageId on get_discussion', () => {
    expect(
      MCP_TOOL_INPUTS.get_discussion.safeParse({
        chatId: UUID,
        detail: 'transcript',
        afterMessageId: 'm1'
      }).success
    ).toBe(true)
  })
})

describe('chatUrl and parseChatUrl', () => {
  it('round-trips a chat id', () => {
    expect(chatUrl(UUID)).toBe(`witena://chat/${UUID}`)
    expect(parseChatUrl(chatUrl(UUID))).toBe(UUID)
  })

  it('accepts the upper-case spelling of the same uuid', () => {
    expect(parseChatUrl(`witena://chat/${UUID.toUpperCase()}`)).toBe(UUID.toUpperCase())
  })

  it('refuses another scheme', () => {
    expect(parseChatUrl(`https://chat/${UUID}`)).toBeNull()
    expect(parseChatUrl(`witenax://chat/${UUID}`)).toBeNull()
    expect(parseChatUrl(`witena:/chat/${UUID}`)).toBeNull()
  })

  it('refuses another path', () => {
    expect(parseChatUrl(`witena://agent/${UUID}`)).toBeNull()
    expect(parseChatUrl(`witena://chat/${UUID}/messages`)).toBeNull()
    expect(parseChatUrl(`witena://chat/${UUID}/`)).toBeNull()
    expect(parseChatUrl(`witena://chat/${UUID}?focus=1`)).toBeNull()
    expect(parseChatUrl(`witena://chat/${UUID}#last`)).toBeNull()
  })

  it('refuses anything that is not a uuid', () => {
    expect(parseChatUrl('witena://chat/')).toBeNull()
    expect(parseChatUrl('witena://chat/not-a-uuid')).toBeNull()
    expect(parseChatUrl(`witena://chat/${UUID.slice(0, -1)}`)).toBeNull()
    expect(parseChatUrl(`witena://chat/${UUID}0`)).toBeNull()
    expect(parseChatUrl(`witena://chat/${UUID.replace('3f', 'zz')}`)).toBeNull()
    expect(parseChatUrl('')).toBeNull()
  })
})

/**
 * The `consult` prompt (WP-15).
 *
 * Two processes answer `prompts/get` with this one function — the shim without
 * the app, the endpoint with it — so what is worth pinning is the wire shape
 * MCP requires (arguments are *strings*, and a prompt is a `name` plus an
 * argument table) and the three sentences the expansion exists to say.
 */
describe('MCP_PROMPTS and renderPrompt', () => {
  /** The expansion's text, or the refusal's message, for a set of arguments. */
  function expand(args: Record<string, unknown> | undefined): string {
    const rendered = renderPrompt('consult', args)
    if (!rendered.ok) return rendered.message
    const content = rendered.messages[0]?.content
    return content?.type === 'text' ? content.text : ''
  }

  it('offers exactly one prompt, with a zod input beside it', () => {
    expect(MCP_PROMPTS.map((prompt) => prompt.name)).toEqual([...MCP_PROMPT_NAMES])
    expect(Object.keys(MCP_PROMPT_INPUTS).sort()).toEqual([...MCP_PROMPT_NAMES].sort())
  })

  it('declares its arguments the way MCP declares them, not as a JSON Schema', () => {
    // `prompts/list` carries `{ name, description?, required? }` per argument,
    // and `prompts/get` sends every value as a string. A JSON Schema here would
    // be ignored by the client and would invite a non-string field.
    const consult = MCP_PROMPTS[0]
    expect(consult?.title.length).toBeGreaterThan(0)
    expect(consult?.description.length).toBeGreaterThan(0)
    expect(consult?.arguments.map((argument) => [argument.name, argument.required])).toEqual([
      ['question', true],
      ['chat', false],
      ['committee', false],
      ['agents', false]
    ])
    for (const argument of consult?.arguments ?? []) {
      expect(argument.description.length).toBeGreaterThan(0)
    }
  })

  it('tells the agent the three things the prompt exists to say', () => {
    const text = expand({ question: 'Is this migration safe?' })
    // The question itself, so the expansion stands alone as a message.
    expect(text).toContain('Is this migration safe?')
    // Pass the material, or the group answers in generalities.
    expect(text).toContain('`context`')
    // `running` is not a failure.
    expect(text).toContain('wait_for_discussion')
    expect(text).toMatch(/running.*not a failure/i)
    // And the caller is the executor.
    expect(text).toMatch(/you are the one who writes/i)
    // With nobody named, choosing the group is the agent's first step — and
    // since WP-14 the first question is whether the user already saved one.
    expect(text).toContain('list_committees')
    expect(text).toContain('list_agents')
  })

  it('turns a comma-separated agents argument into the array the tool takes', () => {
    const text = expand({ question: 'Well?', agents: 'Ada, Lin , ' })
    expect(text).toContain('`agents: ["Ada","Lin"]`')
    expect(text).not.toContain('list_agents and choose')
  })

  it('convenes a committee, alone or with extra agents', () => {
    const alone = expand({ question: 'Well?', committee: 'Architecture review' })
    expect(alone).toContain('`committee: "Architecture review"`')
    expect(alone).not.toContain('`agents:')

    // The same "a committee plus single agents" shape the tool accepts, so the
    // expansion cannot teach a model something `start_discussion` refuses.
    const both = expand({ question: 'Well?', committee: 'Architecture review', agents: 'Ada' })
    expect(both).toContain('`committee: "Architecture review"`')
    expect(both).toContain('`agents: ["Ada"]`')
  })

  it('continues an existing chat when one is named', () => {
    const text = expand({ question: 'And now?', chat: 'chat-1' })
    expect(text).toContain('`chatId: "chat-1"`')
    expect(text).toContain('no `agents`')
    expect(text).toContain('no `committee`')
  })

  it('describes itself with the question, so a client can label the expansion', () => {
    const rendered = renderPrompt('consult', { question: 'Is this migration safe?' })
    expect(rendered.ok && rendered.description).toContain('Is this migration safe?')
    expect(rendered.ok && rendered.messages[0]?.role).toBe('user')
  })

  it('refuses the argument sets start_discussion would refuse, in the same words', () => {
    expect(renderPrompt('consult', {}).ok).toBe(false)
    expect(expand({})).toContain('question')
    expect(expand({ question: 'Well?', chat: 'c', agents: 'Ada' })).toContain('not both')
    expect(expand({ question: 'Well?', chat: 'c', committee: 'Review' })).toContain('not both')
  })

  it('refuses a prompt it does not have, naming the ones it does', () => {
    const rendered = renderPrompt('summon', { question: 'Well?' })
    expect(rendered.ok).toBe(false)
    expect(rendered.ok ? '' : rendered.message).toContain('consult')
  })
})

describe('what the module is allowed to import', () => {
  it('reaches for zod and nothing else, because the shim bundles it', () => {
    expect(SOURCE.length).toBeGreaterThan(0)
    const specifiers = [...SOURCE.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
    expect(specifiers).toEqual(['zod'])
    expect(SOURCE).not.toMatch(/['"]node:/)
    expect(SOURCE).not.toMatch(/['"](?:\.\.\/)*main\//)
    expect(SOURCE).not.toMatch(/@renderer\//)
  })
})
