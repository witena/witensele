import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  isSignedBuild
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

  it('takes the wrapping decision from WITENA_SIGNED_BUILD when it is not given', () => {
    expect(isSignedBuild({})).toBe(false)
    expect(isSignedBuild({ WITENA_SIGNED_BUILD: '' })).toBe(false)
    expect(isSignedBuild({ WITENA_SIGNED_BUILD: '0' })).toBe(false)
    expect(isSignedBuild({ WITENA_SIGNED_BUILD: 'false' })).toBe(false)
    expect(isSignedBuild({ WITENA_SIGNED_BUILD: '1' })).toBe(true)

    const wrapper = fakeSafeStorage()
    const store = createFileKeySecretStore({
      keyPath: keyPath(),
      wrapper,
      env: { WITENA_SIGNED_BUILD: '1' }
    })
    store.encrypt('sk-from-the-environment')

    expect(readFileSync(keyPath(), 'utf8').startsWith('fkkey1w:')).toBe(true)
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
