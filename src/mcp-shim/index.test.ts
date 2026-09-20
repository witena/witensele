/**
 * The shim's request handlers, against a connector that is entirely a fake.
 *
 * `shim.spawn.test.ts` proves the built artefact and `connect.test.ts` proves
 * the file lookup; neither one can state the rule that matters most here,
 * because it is a rule about *what is not called*:
 *
 * > A listing never launches Witena.
 *
 * The fake connector below is the instrument for that. `open()` — the one method
 * that may launch — throws if anything reaches it, so a handler that took the
 * wrong path fails the test by name rather than by timing out twenty seconds
 * later in a bundle. `openIfRunning()` returns whatever the test set, which is
 * how "Witena is not open" and "Witena is open" become two lines instead of two
 * processes.
 *
 * Driven through `InMemoryTransport.createLinkedPair()` so every assertion is
 * about what an MCP *client* receives — the capabilities it negotiated, the
 * shape of a result, the JSON-RPC error of a refusal — rather than about a
 * handler's return value.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  ListResourcesRequest,
  ListResourcesResult,
  ReadResourceRequest,
  ReadResourceResult
} from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import { MCP_PROMPT_NAMES, MCP_TOOL_NAMES } from '@shared/mcp-tools'
import { RESOURCE_UNAVAILABLE_TEXT, type Connector, type EndpointClient } from './connect'
import { createShimServer } from './server'

/** What the fake endpoint was asked, in order. */
interface Traffic {
  opens: number
  openIfRunnings: (string | undefined)[]
  listed: ListResourcesRequest['params'][]
  read: ReadResourceRequest['params'][]
  closes: number
}

const RESOURCES: ListResourcesResult = {
  resources: [
    {
      uri: 'witena://chat/11111111-1111-4111-8111-111111111111',
      name: 'Is this migration safe?',
      mimeType: 'text/markdown'
    }
  ]
}

const CONTENTS: ReadResourceResult = {
  contents: [
    {
      uri: 'witena://chat/11111111-1111-4111-8111-111111111111',
      mimeType: 'text/markdown',
      text: '# Is this migration safe?\n\n**Ada** (round 1)\n\nShip it.'
    }
  ]
}

describe('the shim’s handlers', () => {
  const open: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const close of open.splice(0)) await close()
  })

  /**
   * A shim server on one end of a linked pair, and a connected client on the
   * other. `running` decides whether `openIfRunning` finds an endpoint.
   */
  async function connect(running: boolean): Promise<{ client: Client; traffic: Traffic }> {
    const traffic: Traffic = { opens: 0, openIfRunnings: [], listed: [], read: [], closes: 0 }

    const endpoint: EndpointClient = {
      callTool: async () => ({ content: [] }),
      listResources: async (params) => {
        traffic.listed.push(params)
        return RESOURCES
      },
      readResource: async (params) => {
        traffic.read.push(params)
        return CONTENTS
      },
      close: async () => {
        traffic.closes += 1
      }
    }

    const connector: Connector = {
      open: async () => {
        traffic.opens += 1
        // The instrument: `open()` is the only method that may launch Witena,
        // so a listing that reached it would be the bug this file exists to
        // catch. Nothing in a resource or prompt test may get past this line.
        throw new Error('open() was called: a listing must never launch Witena')
      },
      openIfRunning: async (clientName) => {
        traffic.openIfRunnings.push(clientName)
        return running ? endpoint : null
      }
    }

    const server = createShimServer(connector, () => undefined)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'claude-code', version: '0.0.0-test' })

    await Promise.all([
      server.connect(serverSide as unknown as Transport),
      client.connect(clientSide as unknown as Transport)
    ])
    open.push(async () => {
      await client.close()
      await server.close()
    })

    return { client, traffic }
  }

  /* ---------------------------------------------------------------------- */
  /* What it advertises                                                      */
  /* ---------------------------------------------------------------------- */

  it('advertises the three capabilities it serves, and no notifications', async () => {
    const { client } = await connect(false)
    const capabilities = client.getServerCapabilities()

    expect(capabilities?.tools).toEqual({})
    expect(capabilities?.resources).toEqual({})
    expect(capabilities?.prompts).toEqual({})
    // The endpoint is stateless, so there is nothing to subscribe to and
    // nothing that could announce a change afterwards.
    expect(capabilities?.resources?.subscribe).toBeUndefined()
    expect(capabilities?.resources?.listChanged).toBeUndefined()
    expect(capabilities?.prompts?.listChanged).toBeUndefined()
  })

  /* ---------------------------------------------------------------------- */
  /* Prompts: no I/O at all                                                  */
  /* ---------------------------------------------------------------------- */

  it('lists and expands the prompt without touching the connector', async () => {
    const { client, traffic } = await connect(false)

    const listed = await client.listPrompts()
    expect(listed.prompts.map((prompt) => prompt.name)).toEqual([...MCP_PROMPT_NAMES])
    expect(listed.prompts[0]?.arguments?.map((argument) => argument.name)).toEqual([
      'question',
      'chat',
      'committee',
      'agents'
    ])

    const got = await client.getPrompt({
      name: 'consult',
      arguments: { question: 'Is this migration safe?', committee: 'Architecture review' }
    })
    const text = got.messages[0]?.content
    expect(text?.type).toBe('text')
    expect(text?.type === 'text' ? text.text : '').toContain('Is this migration safe?')
    expect(text?.type === 'text' ? text.text : '').toContain('"Architecture review"')
    expect(text?.type === 'text' ? text.text : '').toContain('wait_for_discussion')

    // The whole point of answering it here: a `prompts/list` on every Claude
    // Code session start must not so much as look at the filesystem.
    expect(traffic).toMatchObject({ opens: 0, openIfRunnings: [], listed: [], read: [] })
  })

  it('refuses an unknown prompt and a bad argument set as invalid params', async () => {
    const { client } = await connect(false)

    await expect(client.getPrompt({ name: 'summon' })).rejects.toThrow(/Unknown prompt/)
    await expect(client.getPrompt({ name: 'consult' })).rejects.toThrow(/question/)
    await expect(
      client.getPrompt({ name: 'consult', arguments: { question: 'Well?', chat: 'c', agents: 'Ada' } })
    ).rejects.toThrow(/not both/)
  })

  /* ---------------------------------------------------------------------- */
  /* Resources: forwarded, never launched                                    */
  /* ---------------------------------------------------------------------- */

  it('answers an empty list when Witena is not running, instead of launching it', async () => {
    const { client, traffic } = await connect(false)

    expect(await client.listResources()).toEqual({ resources: [] })
    expect(traffic.openIfRunnings).toEqual(['claude-code'])
    expect(traffic.opens).toBe(0)
  })

  it('forwards the listing, with its cursor, to an app that is already up', async () => {
    const { client, traffic } = await connect(true)

    const listed = await client.listResources({ cursor: 'page-2' })
    expect(listed.resources.map((resource) => resource.uri)).toEqual(
      RESOURCES.resources.map((resource) => resource.uri)
    )
    // Tool calls forward only `name` and `arguments`; a resource listing has
    // its own parameter and it crosses.
    expect(traffic.listed).toEqual([{ cursor: 'page-2' }])
    expect(traffic.closes).toBe(1)
    expect(traffic.opens).toBe(0)
  })

  it('forwards a read by uri and hands back the transcript', async () => {
    const { client, traffic } = await connect(true)
    const uri = 'witena://chat/11111111-1111-4111-8111-111111111111'

    const read = await client.readResource({ uri })
    const content = read.contents[0]
    expect(content !== undefined && 'text' in content ? content.text : '').toContain(
      '**Ada** (round 1)'
    )
    expect(traffic.read).toEqual([{ uri }])
    expect(traffic.closes).toBe(1)
    expect(traffic.opens).toBe(0)
  })

  it('refuses a read when Witena is not running, in a sentence naming the switch', async () => {
    const { client, traffic } = await connect(false)

    // An empty answer would be a lie: the caller named one document. And
    // `resources/read` has no `isError` shape, so this is a JSON-RPC error.
    await expect(
      client.readResource({ uri: 'witena://chat/11111111-1111-4111-8111-111111111111' })
    ).rejects.toThrow(RESOURCE_UNAVAILABLE_TEXT)
    expect(traffic.opens).toBe(0)
  })

  it('offers no resource templates, rather than no method', async () => {
    // Codex asks for this one; an empty list keeps it out of somebody's log.
    const { client } = await connect(false)
    expect(await client.listResourceTemplates()).toEqual({ resourceTemplates: [] })
  })

  /* ---------------------------------------------------------------------- */
  /* Tools are still the one method that may launch                          */
  /* ---------------------------------------------------------------------- */

  it('lists the tools offline and takes the launching path only for a call', async () => {
    const { client, traffic } = await connect(false)

    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES])
    expect(traffic.opens).toBe(0)

    // `open()` throws in this fake, and the shim turns any connector failure
    // into a readable tool error — which is also how the real refusals travel.
    const called = await client.callTool({ name: 'list_chats', arguments: {} })
    expect(called.isError).toBe(true)
    expect(traffic.opens).toBe(1)
  })
})
