/**
 * The door in front of the MCP endpoint.
 *
 * The endpoint is an HTTP server listening on loopback that can spend the user's
 * provider money and read every chat they have. It is reachable by anything
 * running as the user — and, unless it says otherwise, by any web page the user
 * has open, because a browser will happily send a cross-origin `POST` with a
 * JSON body to `http://127.0.0.1:<port>` and a DNS name can be made to resolve
 * to loopback (DNS rebinding). So four checks run *before* the MCP SDK sees a
 * byte, in this order:
 *
 * | Check | Answer | Why |
 * |---|---|---|
 * | An `Origin` header is present at all | 403 | Only a browser sends one. No legitimate caller of this endpoint is a browser, so its presence is enough to refuse — we never have to decide whether a particular origin is friendly |
 * | `Host` is not `127.0.0.1:<our port>` or `localhost:<our port>` | 403 | The rebinding defence: a page at `evil.test` that resolved to 127.0.0.1 still sends `Host: evil.test` |
 * | No bearer token, or the wrong one | 401 | The token is random per launch and lives only in the `0600` discovery file, so holding it means having read a file only the user can read |
 * | A body over `MAX_BODY_BYTES` | 413 | An unauthenticated `POST` that is buffered before it is authorised is a way to exhaust memory with one connection; the cap is checked while reading, not afterwards |
 *
 * Everything here is a pure function of headers plus the port the request
 * arrived on, which is what lets `guards.test.ts` state each rule as a sentence
 * rather than as a server fixture.
 *
 * It imports `node:crypto`, `node:http` types and `@shared/mcp-tools`, and no
 * electron (CLAUDE.md rule 5).
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { CLIENT_HEADER, MCP_PATH } from '@shared/mcp-tools'

/**
 * The largest request body the endpoint reads, in bytes.
 *
 * The same 8 MiB `src/server/http.ts` allows itself, and for the same reason: a
 * `start_discussion` carrying a diff worth discussing is legitimately large
 * (`MAX_DISCUSSION_INPUT_CHARS` alone is 200 000 characters), but a body with no
 * ceiling is a denial of service on a process that is also the user's window.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * A refusal, in the shape it goes on the wire.
 *
 * `status` is for `curl`, a proxy and the shim — which distinguishes 401 (the
 * token is stale, re-read the discovery file) from everything else — and the
 * JSON-RPC `code` is there because the caller is an MCP client and a JSON-RPC
 * error object is the one body it is already prepared to read. The SDK answers
 * its own transport-level refusals the same way.
 */
export interface GuardRefusal {
  status: number
  code: number
  message: string
}

/** JSON-RPC's "the request itself is not acceptable", which is what every guard means. */
const INVALID_REQUEST = -32600

/** JSON-RPC's parse error, for a body that is not JSON. */
const PARSE_ERROR = -32700

/** The path part of a request URL, without query or fragment. */
export function pathOf(url: string | undefined): string {
  const raw = url ?? '/'
  const cut = raw.search(/[?#]/)
  return cut === -1 ? raw : raw.slice(0, cut)
}

/** Whether this request is the endpoint's business at all. */
export function isMcpPath(url: string | undefined): boolean {
  return pathOf(url) === MCP_PATH
}

/**
 * One header value as a single string.
 *
 * `node:http` gives `string[]` for a header sent twice. A caller that sent two
 * `Authorization` headers is not a caller we want to be charitable to, so the
 * repeat is collapsed to `undefined` rather than to its first value.
 */
function single(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value
  return undefined
}

/**
 * Refuses anything carrying an `Origin`.
 *
 * Deliberately not "refuse unknown origins": the set of origins allowed to reach
 * this endpoint is empty, and a check that compares against a list is a check
 * that can be widened by accident.
 */
export function checkOrigin(headers: IncomingHttpHeaders): GuardRefusal | null {
  if (headers.origin === undefined) return null
  return {
    status: 403,
    code: INVALID_REQUEST,
    message:
      'The Witena MCP endpoint refuses requests that carry an Origin header. It is not reachable from a web page.'
  }
}

/**
 * Refuses a `Host` that is not loopback **at the port the request arrived on**.
 *
 * The port matters as much as the name: `Host: 127.0.0.1:1234` arriving on port
 * 5678 is a page that guessed one port and reached another, which is exactly the
 * rebinding case. The port is taken from the socket rather than passed in at
 * construction, because the host (WP-7) listens on `127.0.0.1:0` and learns its
 * port only after `listen` resolves — the socket always knows.
 *
 * `undefined` for `port` is treated as "cannot prove it", and refused.
 */
export function checkHost(
  headers: IncomingHttpHeaders,
  port: number | undefined
): GuardRefusal | null {
  const host = single(headers.host)?.toLowerCase()
  const allowed = port === undefined ? [] : [`127.0.0.1:${port}`, `localhost:${port}`]
  if (host !== undefined && allowed.includes(host)) return null
  return {
    status: 403,
    code: INVALID_REQUEST,
    message: `The Witena MCP endpoint only answers a loopback Host on its own port (${allowed.join(' or ') || 'unknown'}); got ${host ?? 'no Host header'}.`
  }
}

/**
 * Constant-time token comparison.
 *
 * `timingSafeEqual` throws on buffers of different lengths, so the length is
 * compared first — which does leak the token's length, and is worth nothing to
 * an attacker who would still have to guess 32 random bytes. An empty expected
 * token never matches: a build that forgot to generate one must be a closed
 * door, not an open one.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  if (expected.length === 0) return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Refuses a missing, malformed or wrong `Authorization: Bearer <token>`. */
export function checkBearer(headers: IncomingHttpHeaders, token: string): GuardRefusal | null {
  const refusal: GuardRefusal = {
    status: 401,
    code: INVALID_REQUEST,
    message:
      'The Witena MCP endpoint needs the bearer token from its discovery file. Re-read <userData>/mcp-endpoint.json and try again.'
  }
  const header = single(headers.authorization)
  if (header === undefined) return refusal
  const space = header.indexOf(' ')
  if (space === -1) return refusal
  if (header.slice(0, space).toLowerCase() !== 'bearer') return refusal
  return tokenMatches(header.slice(space + 1).trim(), token) ? null : refusal
}

/**
 * Every header check, in the order the table above states them.
 *
 * The body cap is not here because it is enforced while the body is read, not
 * from a header: `content-length` is what the caller *claims*.
 */
export function guardHeaders(
  headers: IncomingHttpHeaders,
  port: number | undefined,
  token: string
): GuardRefusal | null {
  return checkOrigin(headers) ?? checkHost(headers, port) ?? checkBearer(headers, token)
}

/**
 * The name the shim put in `CLIENT_HEADER`, or `undefined` for a direct HTTP
 * client.
 *
 * Untrusted display data, never an identity: nothing is authorised by it, and
 * WP-13 sanitises it again before it can reach a transcript.
 */
export function clientNameFrom(headers: IncomingHttpHeaders): string | undefined {
  const value = single(headers[CLIENT_HEADER])?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** A body that was read, or the refusal that stopped it. */
export type BodyRead = { ok: true; value: unknown } | { ok: false; refusal: GuardRefusal }

/**
 * Reads and parses the request body, refusing anything over `MAX_BODY_BYTES`.
 *
 * The endpoint reads the body itself rather than letting the SDK do it, for the
 * cap — so the parsed value is then handed to `transport.handleRequest` as its
 * `parsedBody`, which is the documented way to pass a body that somebody else
 * has already consumed.
 */
export async function readBody(request: IncomingMessage): Promise<BodyRead> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      // The rest of the body is left unread rather than drained — the point of
      // the cap is not to buffer it — and the socket is *not* destroyed here:
      // `node:http` tears down a connection whose request body was not consumed
      // only once the response has been flushed, which is the ordering that lets
      // the caller actually read its 413 instead of a reset.
      request.pause()
      return {
        ok: false,
        refusal: {
          status: 413,
          code: INVALID_REQUEST,
          message: `Request body exceeds ${MAX_BODY_BYTES} bytes.`
        }
      }
    }
    chunks.push(buffer)
  }

  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (cause) {
    return {
      ok: false,
      refusal: {
        status: 400,
        code: PARSE_ERROR,
        message: `Parse error: ${cause instanceof Error ? cause.message : String(cause)}`
      }
    }
  }
}

/** The body of a refusal: a JSON-RPC error object with a null id. */
export function refusalBody(refusal: GuardRefusal): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    error: { code: refusal.code, message: refusal.message },
    id: null
  })
}

/** Writes one refusal. Never sends a stack, an HTML page or a `WWW-Authenticate` challenge. */
export function sendRefusal(response: ServerResponse, refusal: GuardRefusal): void {
  const body = refusalBody(refusal)
  response.writeHead(refusal.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}
