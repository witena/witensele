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
  MCP_TOOL_INPUTS,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  MIN_WAIT_SECONDS,
  parseChatUrl
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
  it('lists exactly the six names, in MCP_TOOL_NAMES order', () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES])
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
    for (const field of ['question', 'context', 'chatId', 'agents', 'workdir', 'maxWaitSeconds']) {
      expect(properties[field]?.description, field).toBeTruthy()
    }
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

  it('refuses neither chatId nor agents', () => {
    expect(input.safeParse({ question: 'q' }).success).toBe(false)
  })

  it('treats an empty agents array as "not given" rather than as a group of nobody', () => {
    expect(input.safeParse({ question: 'q', agents: [] }).success).toBe(false)
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
  it('lets list_chats take an optional query and list_agents take nothing', () => {
    expect(MCP_TOOL_INPUTS.list_chats.safeParse({}).success).toBe(true)
    expect(MCP_TOOL_INPUTS.list_chats.safeParse({ query: 'sharding' }).success).toBe(true)
    expect(MCP_TOOL_INPUTS.list_agents.safeParse({}).success).toBe(true)
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
