import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFileKeySecretStore,
  createInsecureSecretStore,
  FILE_KEY_PREFIX,
  isFileKeySecret,
  isInsecureSecret,
  isLegacySecret,
  isSafeStorageSecret,
  isSignedBuild,
  rewrapKeyFile
} from './secrets'
import { fakeSafeStorage } from './testing'

describe('secrets/insecure store', () => {
  it('round-trips a value and marks the ciphertext as insecure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createInsecureSecretStore()

    const cipher = store.encrypt('sk-secret-key')

    expect(cipher).not.toContain('sk-secret-key')
    expect(isInsecureSecret(cipher)).toBe(true)
    expect(store.decrypt(cipher)).toBe('sk-secret-key')

    warn.mockRestore()
  })

  it('round-trips non-ASCII and empty values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createInsecureSecretStore()

    for (const value of ['', 'a'.repeat(4096), 'clé-Ω-🔑']) {
      expect(store.decrypt(store.encrypt(value))).toBe(value)
    }

    warn.mockRestore()
  })

  it('reports that it is not real encryption and warns exactly once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createInsecureSecretStore()

    expect(store.isAvailable()).toBe(false)

    store.encrypt('one')
    store.encrypt('two')
    store.decrypt(store.encrypt('three'))

    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('secrets/file key store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'witena-secrets-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function keyPath(): string {
    return join(dir, 'secrets.key')
  }

  it('round-trips a value and marks it with the versioned prefix', () => {
    const store = createFileKeySecretStore({ keyPath: keyPath(), wrap: false })

    const cipher = store.encrypt('sk-secret-key')

    expect(cipher.startsWith(FILE_KEY_PREFIX)).toBe(true)
    expect(isFileKeySecret(cipher)).toBe(true)
    expect(cipher).not.toContain('sk-secret-key')
    expect(store.decrypt(cipher)).toBe('sk-secret-key')
    expect(store.isAvailable()).toBe(true)
  })

  it('round-trips non-ASCII, empty and long values', () => {
    const store = createFileKeySecretStore({ keyPath: keyPath(), wrap: false })

    for (const value of ['', 'a'.repeat(8192), 'clé-Ω-🔑']) {
      expect(store.decrypt(store.encrypt(value))).toBe(value)
    }
  })

  it('uses a fresh IV per value, so the same key twice is not the same ciphertext', () => {
    const store = createFileKeySecretStore({ keyPath: keyPath(), wrap: false })

    expect(store.encrypt('sk-same')).not.toBe(store.encrypt('sk-same'))
  })

  /** The whole point of S7.6: the key outlives the process that wrote it. */
  it('reads back what a previous instance wrote, from the same key file', () => {
    const first = createFileKeySecretStore({ keyPath: keyPath(), wrap: false })
    const cipher = first.encrypt('sk-survives-a-restart')

    const second = createFileKeySecretStore({ keyPath: keyPath(), wrap: false })

    expect(second.decrypt(cipher)).toBe('sk-survives-a-restart')
  })

  it('creates the key file on first use only, with mode 0600', () => {
    const store = createFileKeySecretStore({ keyPath: keyPath(), wrap: false })

    // Constructing the store must not touch the disk.
    expect(() => statSync(keyPath())).toThrow()

    store.encrypt('sk-first-use')

    expect(statSync(keyPath()).mode & 0o777).toBe(0o600)
  })

  it('detects a tampered value rather than decrypting it to garbage', () => {
    const store = createFileKeySecretStore({ keyPath: keyPath(), wrap: false })
    const cipher = store.encrypt('sk-authentic')

    const raw = Buffer.from(cipher.slice(FILE_KEY_PREFIX.length), 'base64')
    // Flip one bit of the ciphertext body, past the IV and the tag.
    raw[raw.length - 1] ^= 0x01
    const tampered = FILE_KEY_PREFIX + raw.toString('base64')

    expect(() => store.decrypt(tampered)).toThrow(
      expect.objectContaining({ code: 'key_unreadable' })
    )
    expect(() => store.decrypt(FILE_KEY_PREFIX + 'AAAA')).toThrow(
      expect.objectContaining({ code: 'key_unreadable' })
    )
  })

  it('refuses a value written under a different key file', () => {
    const mine = createFileKeySecretStore({ keyPath: keyPath(), wrap: false })
    const theirs = createFileKeySecretStore({ keyPath: join(dir, 'other.key'), wrap: false })
    const cipher = theirs.encrypt('sk-not-mine')

    expect(() => mine.decrypt(cipher)).toThrow(expect.objectContaining({ code: 'key_unreadable' }))
  })

  it('refuses a value that is not its own format', () => {
    const store = createFileKeySecretStore({ keyPath: keyPath(), wrap: false })
    const legacy = fakeSafeStorage().encrypt('sk-old')

    // A `v10…` row belongs to the migration, which reads it with the store that
    // wrote it; handing one to this store is a programming error, not a guess.
    expect(() => store.decrypt(legacy)).toThrow(expect.objectContaining({ code: 'key_unreadable' }))
    expect(() => store.decrypt('plain:c2stb2xk')).toThrow(
      expect.objectContaining({ code: 'key_unreadable' })
    )
  })

  it('stores the key file plain when the build is not signed', () => {
    const wrapper = fakeSafeStorage()
    const store = createFileKeySecretStore({ keyPath: keyPath(), wrapper, wrap: false })
    store.encrypt('sk-unsigned')

    const contents = readFileSync(keyPath(), 'utf8')

    expect(contents.startsWith('fkkey1:')).toBe(true)
    // Nothing the wrapper produced is in the file, so losing its Keychain item
    // cannot take the key with it — which is the bug S7.6 fixes.
    expect(contents).not.toContain('djEw')
  })

  it('wraps the key file with the injected wrapper on a signed build', () => {
    const wrapper = fakeSafeStorage()
    const store = createFileKeySecretStore({ keyPath: keyPath(), wrapper, wrap: true })
    const cipher = store.encrypt('sk-signed')

    const contents = readFileSync(keyPath(), 'utf8')
    expect(contents.startsWith('fkkey1w:')).toBe(true)

    // A second instance with the same wrapper unwraps it and reads the value.
    const again = createFileKeySecretStore({ keyPath: keyPath(), wrapper, wrap: true })
    expect(again.decrypt(cipher)).toBe('sk-signed')
  })

  it('reports a wrapped key file it cannot unwrap instead of guessing', () => {
    const store = createFileKeySecretStore({
      keyPath: keyPath(),
      wrapper: fakeSafeStorage('build-1'),
      wrap: true
    })
    const cipher = store.encrypt('sk-signed')

    // The next build: same file, different identity behind the wrapper.
    const rebuilt = createFileKeySecretStore({
      keyPath: keyPath(),
      wrapper: fakeSafeStorage('build-2'),
      wrap: true
    })
    expect(() => rebuilt.decrypt(cipher)).toThrow(
      expect.objectContaining({ code: 'key_unreadable' })
    )

    // And a build with no key store at all says so rather than reading bytes.
    const bare = createFileKeySecretStore({ keyPath: keyPath(), wrap: true })
    expect(() => bare.decrypt(cipher)).toThrow(expect.objectContaining({ code: 'key_unreadable' }))
  })

  it('refuses a key file that is not one', () => {
    writeFileSync(keyPath(), 'hello', { mode: 0o600 })
    const store = createFileKeySecretStore({ keyPath: keyPath(), wrap: false })

    expect(() => store.encrypt('sk-anything')).toThrow(
      expect.objectContaining({ code: 'key_unreadable' })
    )
  })

  it('does not wrap unless it is told to', () => {
    // The store never discovers whether the build is signed: finding that out
    // means asking electron where the bundle is, which this module may not do
    // (CLAUDE.md rule #5). `src/main/index.ts` reads the flag and passes it.
    const wrapper = fakeSafeStorage()
    createFileKeySecretStore({ keyPath: keyPath(), wrapper }).encrypt('sk-default')

    expect(readFileSync(keyPath(), 'utf8').startsWith('fkkey1:')).toBe(true)
  })
})

describe('secrets/the signed-build flag', () => {
  it('reads the field electron-builder writes into the packaged manifest', () => {
    // S7.6 read an environment variable, which the launched app never sees.
    // S7.3 replaced it with `extraMetadata`, so the answer travels inside the
    // bundle: `-c.extraMetadata.witenaSignedBuild=true` at packaging time.
    expect(isSignedBuild({ witenaSignedBuild: true })).toBe(true)

    // A command-line value may arrive as a string rather than a boolean
    // depending on how the argument is coerced, and a flag that is quietly
    // false because it was spelled `'true'` is the exact failure this field
    // replaced.
    expect(isSignedBuild({ witenaSignedBuild: 'true' })).toBe(true)
    expect(isSignedBuild({ witenaSignedBuild: '1' })).toBe(true)

    expect(isSignedBuild({ witenaSignedBuild: false })).toBe(false)
    expect(isSignedBuild({ witenaSignedBuild: '' })).toBe(false)
    expect(isSignedBuild({ witenaSignedBuild: '0' })).toBe(false)
    expect(isSignedBuild({ witenaSignedBuild: 'false' })).toBe(false)
  })

  it('answers "not signed" for anything that is not a manifest saying so', () => {
    // A development run and the end-to-end harness both land here: the
    // repository's own package.json has no such field. Wrapping the key file on
    // a build that is not signed is the bug S7.6 fixed, so every uncertain
    // answer has to be this one.
    expect(isSignedBuild({ name: 'witena', version: '0.1.0' })).toBe(false)
    expect(isSignedBuild({})).toBe(false)
    expect(isSignedBuild(null)).toBe(false)
    expect(isSignedBuild(undefined)).toBe(false)
    expect(isSignedBuild('witenaSignedBuild')).toBe(false)
    expect(isSignedBuild({ witenaSignedBuild: 1 })).toBe(false)
  })
})

describe('secrets/re-wrapping the key file on a signed build', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'witena-rewrap-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function keyPath(): string {
    return join(dir, 'secrets.key')
  }

  it('moves a plain key file under the wrapper, keeping every stored value readable', () => {
    // The machine has been running unsigned builds: a plain key file and keys
    // encrypted under it.
    const unsigned = createFileKeySecretStore({ keyPath: keyPath(), wrap: false })
    const cipher = unsigned.encrypt('sk-from-the-unsigned-build')
    const before = readFileSync(keyPath(), 'utf8')

    const wrapper = fakeSafeStorage()
    expect(rewrapKeyFile({ keyPath: keyPath(), wrapper, wrap: true })).toBe('wrapped')

    const after = readFileSync(keyPath(), 'utf8')
    expect(after.startsWith('fkkey1w:')).toBe(true)
    // The container changed; the key did not. That is what makes doing this
    // without asking defensible — no provider key is re-encrypted or touched.
    expect(wrapper.decrypt(after.slice('fkkey1w:'.length))).toBe(before.slice('fkkey1:'.length))

    // The point of the whole exercise: the ciphertext written before still reads.
    const signed = createFileKeySecretStore({ keyPath: keyPath(), wrapper, wrap: true })
    expect(signed.decrypt(cipher)).toBe('sk-from-the-unsigned-build')

    expect(statSync(keyPath()).mode & 0o777).toBe(0o600)
  })

  it('leaves an already wrapped file alone, which is every launch after the first', () => {
    const wrapper = fakeSafeStorage()
    createFileKeySecretStore({ keyPath: keyPath(), wrapper, wrap: true }).encrypt('sk-signed')
    const before = readFileSync(keyPath(), 'utf8')

    expect(rewrapKeyFile({ keyPath: keyPath(), wrapper, wrap: true })).toBe('already-wrapped')
    expect(readFileSync(keyPath(), 'utf8')).toBe(before)
  })

  it('keeps the plain file when the wrapper refuses', () => {
    const unsigned = createFileKeySecretStore({ keyPath: keyPath(), wrap: false })
    const cipher = unsigned.encrypt('sk-still-needed')
    const before = readFileSync(keyPath(), 'utf8')

    // A locked keychain, or a user who clicked Deny.
    const denied = {
      isAvailable: () => true,
      encrypt: (): string => {
        throw new Error('User denied access to the keychain')
      },
      decrypt: (): string => {
        throw new Error('User denied access to the keychain')
      }
    }

    expect(rewrapKeyFile({ keyPath: keyPath(), wrapper: denied, wrap: true })).toBe('failed')

    // Untouched, and nothing left behind: a half-written key file would be every
    // API key the user has, gone.
    expect(readFileSync(keyPath(), 'utf8')).toBe(before)
    expect(readdirSync(dir)).toEqual(['secrets.key'])
    expect(
      createFileKeySecretStore({ keyPath: keyPath(), wrap: false }).decrypt(cipher)
    ).toBe('sk-still-needed')
  })

  it('does nothing on an unsigned build, with no file, or with no key store', () => {
    const wrapper = fakeSafeStorage()

    // An unsigned build must never wrap: the Keychain item is granted to an
    // identity that changes with every package, which is the original bug.
    createFileKeySecretStore({ keyPath: keyPath(), wrap: false }).encrypt('sk-a')
    expect(rewrapKeyFile({ keyPath: keyPath(), wrapper, wrap: false })).toBe('unsigned')
    expect(readFileSync(keyPath(), 'utf8').startsWith('fkkey1:')).toBe(true)

    // A first launch has no file yet; the store creates one already wrapped.
    expect(rewrapKeyFile({ keyPath: join(dir, 'absent.key'), wrapper, wrap: true })).toBe('absent')

    // A signed build on a machine with no key storage has nothing to wrap with.
    expect(rewrapKeyFile({ keyPath: keyPath(), wrap: true })).toBe('failed')
  })

  it('refuses to rewrite a file it does not recognise', () => {
    const wrapper = fakeSafeStorage()

    writeFileSync(keyPath(), 'hello', { mode: 0o600 })
    expect(rewrapKeyFile({ keyPath: keyPath(), wrapper, wrap: true })).toBe('failed')
    expect(readFileSync(keyPath(), 'utf8')).toBe('hello')

    // Right marker, wrong number of bytes behind it. Rewriting a key we could
    // not decode would turn "a key we can read" into "a key nobody can".
    const short = join(dir, 'short.key')
    writeFileSync(short, `fkkey1:${Buffer.alloc(16).toString('base64')}`, { mode: 0o600 })
    expect(rewrapKeyFile({ keyPath: short, wrapper, wrap: true })).toBe('failed')
  })
})

describe('secrets/ciphertext discrimination', () => {
  it('tells the three stored formats apart', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fileKey = createFileKeySecretStore({
      keyPath: join(mkdtempSync(join(tmpdir(), 'witena-prefix-')), 'secrets.key'),
      wrap: false
    }).encrypt('sk-new')
    const safeStorage = fakeSafeStorage().encrypt('sk-old')
    const insecure = createInsecureSecretStore().encrypt('sk-plain')

    expect(isFileKeySecret(fileKey)).toBe(true)
    expect(isLegacySecret(fileKey)).toBe(false)

    // The real thing: base64 of `v10…`, which is what the user's rows hold.
    expect(safeStorage.startsWith('djEw')).toBe(true)
    expect(isSafeStorageSecret(safeStorage)).toBe(true)
    expect(isLegacySecret(safeStorage)).toBe(true)
    expect(isFileKeySecret(safeStorage)).toBe(false)

    expect(isInsecureSecret(insecure)).toBe(true)
    expect(isLegacySecret(insecure)).toBe(true)
    expect(isSafeStorageSecret(insecure)).toBe(false)

    // Linux's keyring-less fallback stamps `v11`, which is `djEx` in base64.
    expect(isSafeStorageSecret(Buffer.from('v11abc', 'utf8').toString('base64'))).toBe(true)

    warn.mockRestore()
  })
})
