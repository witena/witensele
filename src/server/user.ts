/**
 * Who a request belongs to.
 *
 * **This is the one seam S8.2 replaces.** Today it answers `LOCAL_USER_ID` for
 * every request and every WebSocket connection, exactly like the desktop build,
 * so nothing about the storage layer or the handlers has to change before
 * accounts exist. When Cognito arrives, this function verifies the JWT on the
 * `Authorization` header (or the connect request's), rejects with `unauthorized`
 * when it is missing or invalid, and returns the token's `sub`.
 *
 * It is a module of its own rather than three lines inside `http.ts` for that
 * reason: a reader looking for "where does the server decide whose data this
 * is" must find exactly one answer, and a later step must be able to change it
 * without touching the transport.
 */
import type { IncomingMessage } from 'node:http'
import { LOCAL_USER_ID, type UserId } from '@shared/types'

/**
 * Resolves the user behind one HTTP request or WebSocket handshake.
 *
 * Takes the request rather than a header string so the S8.2 implementation can
 * read whatever it needs (the `Authorization` header for HTTP, the
 * `Sec-WebSocket-Protocol` header or a query parameter for the handshake) without
 * changing every caller.
 *
 * Asynchronous although the body is not: verifying a JWT means fetching and
 * caching a JWKS, and a synchronous signature here would have to be unpicked the
 * day that lands.
 */
export async function resolveUserId(_request: IncomingMessage): Promise<UserId> {
  return LOCAL_USER_ID
}
