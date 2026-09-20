/**
 * The door, stated as sentences.
 *
 * Every guard is a pure function of headers plus the port the request arrived
 * on, so each rule can be asserted without a socket. `server.test.ts` proves the
 * same five refusals again through a real listener and a raw `fetch`; this file
 * is where the *reasons* live — the cases a server fixture would make tedious:
 * a `Host` on the wrong port, a repeated `Authorization`, a token that differs
 * only in length, a body that goes one byte over the cap.
 */
import { PassThrough } from 'node:stream'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { CLIENT_HEADER, MCP_PATH } from '@shared/mcp-tools'
import {
  checkBearer,
  checkHost,
  checkOrigin,
  clientNameFrom,
  guardHeaders,
  isMcpPath,
  MAX_BODY_BYTES,
  pathOf,
  readBody,
  refusalBody,
  tokenMatches
} from './guards'

const TOKEN = 'a-token-of-exactly-this-length'
const PORT = 51234

/**
 * A header that arrived twice.
 *
 * `IncomingHttpHeaders` types `host` and `authorization` as single strings —
 * Node's parser collapses or rejects a repeat for those two — so the cast is
 * how a test can still ask what the guards do with an array. They refuse it,
 * which is the answer that matters: the guards are also read by
 * `CLIENT_HEADER`, where a repeat genuinely reaches them.
 */
function repeated(name: string, values: string[]): IncomingHttpHeaders {
  return { [name]: values } as unknown as IncomingHttpHeaders
}

/** A request body as `readBody` receives it: a readable stream of chunks. */
function bodyStream(chunks: (string | Buffer)[]): IncomingMessage {
  const stream = new PassThrough()
  for (const chunk of chunks) stream.write(chunk)
  stream.end()
  return stream as unknown as IncomingMessage
}

describe('the MCP endpoint path', () => {
  it('claims MCP_PATH and nothing else, query strings included', () => {
    expect(isMcpPath(MCP_PATH)).toBe(true)
    expect(isMcpPath('/mcp?session=1')).toBe(true)
    expect(isMcpPath('/mcp#fragment')).toBe(true)
    expect(pathOf('/mcp?session=1')).toBe('/mcp')

    expect(isMcpPath('/')).toBe(false)
    expect(isMcpPath('/mcp/')).toBe(false)
    expect(isMcpPath('/mcp/call')).toBe(false)
    expect(isMcpPath('/api/chats.list')).toBe(false)
    expect(isMcpPath(undefined)).toBe(false)
  })
})

describe('the Origin guard', () => {
  it('refuses any request that carries an Origin at all', () => {
    // Not "refuses unknown origins": the allowed set is empty, and a check
    // against a list is a check that can be widened by accident.
    for (const origin of ['https://evil.test', 'http://localhost:5173', 'null', '']) {
      const refusal = checkOrigin({ origin })
      expect(refusal?.status).toBe(403)
      expect(refusal?.message).toContain('Origin')
    }
  })

  it('lets a request with no Origin through', () => {
    expect(checkOrigin({})).toBeNull()
  })
})

describe('the Host guard', () => {
  it('accepts loopback on the port the request actually arrived on', () => {
    expect(checkHost({ host: `127.0.0.1:${PORT}` }, PORT)).toBeNull()
    expect(checkHost({ host: `localhost:${PORT}` }, PORT)).toBeNull()
    expect(checkHost({ host: `LOCALHOST:${PORT}` }, PORT)).toBeNull()
  })

  it('refuses a name that is not loopback, which is the rebinding case', () => {
    // A page at evil.test whose DNS resolved to 127.0.0.1 still sends its own
    // name in Host, which is the whole reason this check exists.
    expect(checkHost({ host: `evil.test:${PORT}` }, PORT)?.status).toBe(403)
    expect(checkHost({ host: `witena.local:${PORT}` }, PORT)?.status).toBe(403)
  })

  it('refuses loopback on another port, and a Host with no port at all', () => {
    expect(checkHost({ host: `127.0.0.1:${PORT + 1}` }, PORT)?.status).toBe(403)
    expect(checkHost({ host: '127.0.0.1' }, PORT)?.status).toBe(403)
    expect(checkHost({ host: 'localhost' }, PORT)?.status).toBe(403)
  })

  it('refuses a missing Host, a repeated Host and an unknown port', () => {
    expect(checkHost({}, PORT)?.status).toBe(403)
    expect(checkHost(repeated('host', [`127.0.0.1:${PORT}`, 'evil.test']), PORT)?.status).toBe(403)
    expect(checkHost({ host: `127.0.0.1:${PORT}` }, undefined)?.status).toBe(403)
  })
})

describe('the bearer guard', () => {
  it('accepts the exact token, with the scheme in any case', () => {
    expect(checkBearer({ authorization: `Bearer ${TOKEN}` }, TOKEN)).toBeNull()
    expect(checkBearer({ authorization: `bearer ${TOKEN}` }, TOKEN)).toBeNull()
    expect(checkBearer({ authorization: `BEARER  ${TOKEN} ` }, TOKEN)).toBeNull()
  })

  it('refuses a missing, malformed or foreign credential with 401', () => {
    for (const authorization of [
      undefined,
      '',
      TOKEN,
      `Basic ${TOKEN}`,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(0, -1)}`,
      'Bearer '
    ]) {
      const headers = authorization === undefined ? {} : { authorization }
      expect(checkBearer(headers, TOKEN)?.status).toBe(401)
    }
  })

  it('refuses a repeated Authorization header rather than picking one', () => {
    expect(
      checkBearer(repeated('authorization', [`Bearer ${TOKEN}`, 'Bearer other']), TOKEN)?.status
    ).toBe(401)
  })

  it('never matches an empty configured token', () => {
    // A build that failed to generate a token must be a closed door, not an
    // open one.
    expect(tokenMatches('', '')).toBe(false)
    expect(checkBearer({ authorization: 'Bearer ' }, '')?.status).toBe(401)
  })

  it('compares in constant time over equal-length buffers only', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true)
    expect(tokenMatches(TOKEN, `${TOKEN}x`)).toBe(false)
    expect(tokenMatches('é', 'e')).toBe(false)
  })
})

describe('the guards in order', () => {
  const ok = {
    host: `127.0.0.1:${PORT}`,
    authorization: `Bearer ${TOKEN}`
  }

  it('lets a well-formed request through', () => {
    expect(guardHeaders(ok, PORT, TOKEN)).toBeNull()
  })

  it('answers Origin before Host and Host before the token', () => {
    // The order is not cosmetic: a browser that also guessed the token must
    // still be told 403, and a bad Host must not be given the chance to learn
    // whether its token was right.
    expect(guardHeaders({ ...ok, origin: 'https://evil.test' }, PORT, TOKEN)?.status).toBe(403)
    expect(
      guardHeaders({ ...ok, origin: 'https://evil.test', authorization: 'Bearer wrong' }, PORT, TOKEN)
        ?.status
    ).toBe(403)
    expect(guardHeaders({ ...ok, host: 'evil.test', authorization: 'nonsense' }, PORT, TOKEN)?.status).toBe(
      403
    )
    expect(guardHeaders({ ...ok, authorization: 'Bearer wrong' }, PORT, TOKEN)?.status).toBe(401)
  })
})

describe('the client header', () => {
  it('reads and trims the name the shim sent', () => {
    expect(clientNameFrom({ [CLIENT_HEADER]: 'claude-code' })).toBe('claude-code')
    expect(clientNameFrom({ [CLIENT_HEADER]: '  codex  ' })).toBe('codex')
  })

  it('is undefined for a direct HTTP client, an empty value or a repeat', () => {
    expect(clientNameFrom({})).toBeUndefined()
    expect(clientNameFrom({ [CLIENT_HEADER]: '   ' })).toBeUndefined()
    expect(clientNameFrom({ [CLIENT_HEADER]: ['a', 'b'] })).toBeUndefined()
  })
})

describe('reading the body', () => {
  it('parses JSON', async () => {
    const read = await readBody(bodyStream(['{"jsonrpc":', '"2.0"}']))
    expect(read).toEqual({ ok: true, value: { jsonrpc: '2.0' } })
  })

  it('refuses anything that is not JSON with a parse error', async () => {
    for (const text of ['', 'not json', '{']) {
      const read = await readBody(bodyStream([text]))
      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(read.refusal.status).toBe(400)
      expect(read.refusal.code).toBe(-32700)
    }
  })

  it('refuses a body one byte over the cap, before it is all in memory', async () => {
    const read = await readBody(bodyStream([Buffer.alloc(MAX_BODY_BYTES + 1, 0x20)]))
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.refusal.status).toBe(413)
    expect(read.refusal.message).toContain(String(MAX_BODY_BYTES))
  })

  it('accepts a body exactly at the cap', async () => {
    const filler = 'x'.repeat(MAX_BODY_BYTES - 2)
    const read = await readBody(bodyStream([`"${filler}"`]))
    expect(read.ok).toBe(true)
  })
})

describe('the refusal body', () => {
  it('is a JSON-RPC error object with a null id', () => {
    // The caller is an MCP client, so the one body it is already prepared to
    // read is a JSON-RPC error — and never a stack or an HTML page.
    expect(JSON.parse(refusalBody({ status: 401, code: -32600, message: 'nope' }))).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'nope' },
      id: null
    })
  })
})
