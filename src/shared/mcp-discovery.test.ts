/**
 * The discovery file, which is the only thing standing between the shim and
 * "connect to whatever is on this port and hand it a token".
 *
 * Every rejection below is a real state on a real machine: a half-written file
 * (the app was killed mid-write), a file from a future release, a file whose
 * fields were hand-edited, a file that is JSON but not an object. All of them
 * must come out as `null`, because `null` is the branch the shim already has —
 * launch the app, or tell the calling model Witena is not up — and a thrown
 * error at that point would reach an IDE as a crashed MCP server.
 */
import { describe, expect, it } from 'vitest'
import {
  DISCOVERY_FILE,
  DISCOVERY_VERSION,
  type McpDiscovery,
  parseDiscovery,
  userDataDirFor
} from './mcp-discovery'
import { APP_NAME } from './version'

const VALID: McpDiscovery = {
  version: 1,
  port: 51_234,
  token: 'nt1Qp7T_9d0eXbA4mJk2LrZs8vYcHgUw',
  pid: 4242,
  startedAt: 1_758_300_000_000
}

/**
 * The module's own text, for the import assertion at the bottom. Vite's `?raw`
 * rather than `node:fs`: `src/shared/**` is type-checked by `tsconfig.web.json`
 * as well, and that project has no `node` types.
 */
const SOURCE: string = Object.values(
  import.meta.glob<string>('./mcp-discovery.ts', { query: '?raw', import: 'default', eager: true })
)[0]

/** The file as the host writes it, with one field replaced. */
function withField(field: string, value: unknown): string {
  return JSON.stringify({ ...VALID, [field]: value })
}

describe('DISCOVERY_FILE', () => {
  it('is the name both halves join onto the userData directory', () => {
    expect(DISCOVERY_FILE).toBe('mcp-endpoint.json')
    expect(DISCOVERY_VERSION).toBe(1)
  })
})

describe('parseDiscovery', () => {
  it('accepts what the host writes and keeps every field', () => {
    expect(parseDiscovery(JSON.stringify(VALID))).toEqual(VALID)
  })

  it('ignores fields a later version may add, so an old shim survives an app update', () => {
    const parsed = parseDiscovery(JSON.stringify({ ...VALID, scheme: 'http', extra: [1, 2] }))
    expect(parsed).toEqual(VALID)
  })

  it('refuses a file that is not JSON', () => {
    expect(parseDiscovery('')).toBeNull()
    expect(parseDiscovery('{"version":1,')).toBeNull()
    expect(parseDiscovery('not json at all')).toBeNull()
  })

  it('refuses JSON that is not an object', () => {
    expect(parseDiscovery('null')).toBeNull()
    expect(parseDiscovery('42')).toBeNull()
    expect(parseDiscovery('"mcp-endpoint"')).toBeNull()
    expect(parseDiscovery('[]')).toBeNull()
  })

  it('refuses another version, in either direction', () => {
    expect(parseDiscovery(withField('version', 2))).toBeNull()
    expect(parseDiscovery(withField('version', 0))).toBeNull()
    expect(parseDiscovery(withField('version', '1'))).toBeNull()
  })

  it.each(['version', 'port', 'token', 'pid', 'startedAt'])('refuses a file missing %s', (field) => {
    const partial: Record<string, unknown> = { ...VALID }
    delete partial[field]
    expect(parseDiscovery(JSON.stringify(partial))).toBeNull()
  })

  it('refuses a port that is not a usable TCP port', () => {
    expect(parseDiscovery(withField('port', 0))).toBeNull()
    expect(parseDiscovery(withField('port', -1))).toBeNull()
    expect(parseDiscovery(withField('port', 70_000))).toBeNull()
    expect(parseDiscovery(withField('port', 51_234.5))).toBeNull()
    expect(parseDiscovery(withField('port', '51234'))).toBeNull()
  })

  it('refuses an empty or non-string token, which would be sent as a bearer', () => {
    expect(parseDiscovery(withField('token', ''))).toBeNull()
    expect(parseDiscovery(withField('token', 12_345))).toBeNull()
    expect(parseDiscovery(withField('token', null))).toBeNull()
  })

  it('refuses a pid the liveness check could not use', () => {
    expect(parseDiscovery(withField('pid', 0))).toBeNull()
    expect(parseDiscovery(withField('pid', -1))).toBeNull()
    expect(parseDiscovery(withField('pid', 'self'))).toBeNull()
  })

  it('refuses a startedAt that is not an epoch-millisecond timestamp', () => {
    expect(parseDiscovery(withField('startedAt', 0))).toBeNull()
    expect(parseDiscovery(withField('startedAt', '2026-09-20'))).toBeNull()
  })
})

describe('userDataDirFor', () => {
  it("follows electron's macOS rule when nothing overrides it", () => {
    expect(userDataDirFor({}, '/Users/ada')).toBe(
      `/Users/ada/Library/Application Support/${APP_NAME}`
    )
  })

  it('tolerates a home directory with a trailing slash', () => {
    expect(userDataDirFor({}, '/Users/ada/')).toBe(
      `/Users/ada/Library/Application Support/${APP_NAME}`
    )
  })

  it('honours WITENA_USER_DATA, which is what points a shim at an e2e app', () => {
    expect(userDataDirFor({ WITENA_USER_DATA: '/tmp/witena-e2e-17' }, '/Users/ada')).toBe(
      '/tmp/witena-e2e-17'
    )
  })

  it('treats an empty override as no override rather than as the root directory', () => {
    expect(userDataDirFor({ WITENA_USER_DATA: '' }, '/Users/ada')).toBe(
      `/Users/ada/Library/Application Support/${APP_NAME}`
    )
  })

  it('ignores every other variable in the environment', () => {
    expect(userDataDirFor({ HOME: '/elsewhere', WITENA_DATA_DIR: '/x' }, '/Users/ada')).toBe(
      `/Users/ada/Library/Application Support/${APP_NAME}`
    )
  })
})

describe('what the module is allowed to import', () => {
  it('stays pure, because the shim bundles it and a test may ask about a directory that does not exist', () => {
    expect(SOURCE.length).toBeGreaterThan(0)
    const specifiers = [...SOURCE.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
    expect(specifiers).toEqual(['./version'])
    expect(SOURCE).not.toMatch(/['"]node:/)
    expect(SOURCE).not.toMatch(/['"](?:\.\.\/)*main\//)
    expect(SOURCE).not.toMatch(/@renderer\//)
  })
})
