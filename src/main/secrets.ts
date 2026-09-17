/**
 * The secret store seam.
 *
 * Provider API keys are stored as ciphertext in the `providers` table
 * (`docs/features/database/backend.md`), and this interface is what produces it.
 * Nothing outside `src/main/ipc/` may import electron (CLAUDE.md rule #5), so
 * every service takes the interface; `src/main/ipc/secret-store.ts` supplies the
 * `safeStorage` implementation, tests and a future Node server supply their own.
 *
 * **S7.6 changed which implementation the app uses.** `safeStorage` keys its
 * Keychain item off the *application identity*, and an unsigned build has a new
 * identity every time it is packaged — so every stored key became unreadable the
 * moment a rebuilt dmg replaced the previous one. `createFileKeySecretStore`
 * below holds the key in `userData/secrets.key` instead, which survives an
 * update because it belongs to the user's data rather than to the bundle. On a
 * signed build (S7.3 — the `witenaSignedBuild` field electron-builder writes
 * into the packaged manifest) that file is itself wrapped by `safeStorage`,
 * which is the best of both: the Keychain protects the key file, and the
 * identity it is granted to stops changing. `rewrapKeyFile` below is what moves
 * a file written by the unsigned builds that came first.
 *
 * This module is Electron-free by construction — `node:crypto` and `node:fs`
 * only — so the file-key store works unchanged in a Node server.
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { isBackendFailure, keyUnreadable } from './errors'

/**
 * Symmetric, synchronous encryption of a single string.
 *
 * `encrypt` and `decrypt` both return strings so the result can go straight into
 * a `text` column. Implementations must round-trip: `decrypt(encrypt(x)) === x`.
 */
export interface SecretStore {
  /** False when the platform has no real key storage and the fallback is in use. */
  isAvailable(): boolean
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

/** Marks a value produced by the insecure fallback so it is never mistaken for real ciphertext. */
const INSECURE_PREFIX = 'plain:'

/**
 * Development and test fallback: base64 behind a `plain:` marker.
 *
 * This is **not encryption**. Anyone with the database file can read the keys
 * back. It exists so the app still runs where `safeStorage` is unavailable
 * (a headless CI box, a Linux session with no keyring, unit tests), and it logs
 * once so that situation is never silent.
 */
export function createInsecureSecretStore(): SecretStore {
  let warned = false

  function warnOnce(): void {
    if (warned) return
    warned = true
    console.warn(
      '[witena] secrets are stored WITHOUT encryption: OS key storage is unavailable. ' +
        'Do not use this build with production API keys.'
    )
  }

  return {
    isAvailable() {
      return false
    },

    encrypt(plain) {
      warnOnce()
      return INSECURE_PREFIX + Buffer.from(plain, 'utf8').toString('base64')
    },

    decrypt(cipher) {
      warnOnce()
      const body = cipher.startsWith(INSECURE_PREFIX) ? cipher.slice(INSECURE_PREFIX.length) : cipher
      return Buffer.from(body, 'base64').toString('utf8')
    }
  }
}

/** True for a value produced by `createInsecureSecretStore`. */
export function isInsecureSecret(cipher: string): boolean {
  return cipher.startsWith(INSECURE_PREFIX)
}

/* -------------------------------------------------------------------------- */
/* S7.6: the file-held key                                                     */
/* -------------------------------------------------------------------------- */

/** Versioned marker on every value `FileKeySecretStore` produces. */
export const FILE_KEY_PREFIX = 'fk1:'

/** File name of the key inside the data directory. */
export const SECRETS_KEY_FILE = 'secrets.key'

/**
 * The `package.json` field that records a signed build (S7.3).
 *
 * S7.6 read an environment variable here, which was wrong and was recorded as
 * wrong: a variable exported while the dmg is being built does not exist in the
 * process the *user* launches three days later, so the flag it was supposed to
 * carry was always false where it mattered. electron-builder's `extraMetadata`
 * writes this field into the `package.json` inside the bundle instead
 * (`-c.extraMetadata.witenaSignedBuild=true`, passed by `npm run dist:signed`
 * and by the release workflow when the certificate exists), so the answer
 * travels with the application and is read back from it at startup.
 */
export const SIGNED_BUILD_FIELD = 'witenaSignedBuild'

/** AES-256-GCM sizes, in bytes. The IV is 12 because GCM is defined for 96 bits. */
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** Owner read/write only. The whole point of the file is that nobody else reads it. */
const KEY_FILE_MODE = 0o600

/**
 * How the key file itself is stored, written into the file so a build can always
 * tell which it is holding.
 *
 * Without the marker, a build whose signed-ness differs from the one that wrote
 * the file would hand 32 bytes of `safeStorage` ciphertext to AES as a key, or
 * the reverse — and both failures look exactly like "your keys are gone", which
 * is the failure this whole step exists to remove.
 */
const KEY_FILE_PLAIN = 'fkkey1:'
const KEY_FILE_WRAPPED = 'fkkey1w:'

/** True for a value produced by `createFileKeySecretStore`. */
export function isFileKeySecret(cipher: string): boolean {
  return cipher.startsWith(FILE_KEY_PREFIX)
}

/**
 * True for base64 of Electron `safeStorage` output.
 *
 * Chromium's `OSCrypt` stamps a version prefix on every value: `v10` on macOS
 * and on Linux with a real keyring, `v11` on Linux's fallback. Base64 encodes
 * three bytes to four characters with no padding in between, so those prefixes
 * survive as the literal `djEw` / `djEx` — which is what the user's own database
 * holds and what the migration looks for.
 */
export function isSafeStorageSecret(cipher: string): boolean {
  return cipher.startsWith('djEw') || cipher.startsWith('djEx')
}

/**
 * True for a ciphertext written before S7.6: `safeStorage` output or the
 * `plain:` fallback. Those are the rows the startup migration re-encrypts.
 */
export function isLegacySecret(cipher: string): boolean {
  return isSafeStorageSecret(cipher) || isInsecureSecret(cipher)
}

export interface FileKeySecretStoreOptions {
  /** Absolute path of the key file, normally `<userData>/secrets.key`. */
  keyPath: string
  /**
   * The store the key file is wrapped with when `wrap` is true — in the app,
   * the `safeStorage` implementation from `src/main/ipc/secret-store.ts`.
   *
   * Injected rather than imported, because this module may not import electron.
   */
  wrapper?: SecretStore | undefined
  /**
   * Whether to wrap the key file. Off unless the caller says otherwise, and the
   * only caller that says so is `src/main/index.ts` on a signed build.
   *
   * Passed in rather than discovered, because discovering it means asking
   * electron where the bundle is, and this module may not (CLAUDE.md rule #5).
   * Wrapping is off by default on purpose: `safeStorage` can only protect the
   * key file if the identity it grants the Keychain item to is stable, and an
   * unsigned build's is not — wrapping there would reintroduce the exact bug
   * S7.6 fixes.
   */
  wrap?: boolean
}

/**
 * Whether the running build was signed, according to its own manifest.
 *
 * Takes the parsed `package.json` rather than reading one, so it stays a pure
 * function over data: the caller that knows where the bundle is
 * (`src/main/index.ts`, the only file allowed to ask electron) hands the object
 * over, and a test hands over a literal.
 *
 * `true` and `'true'` both count, because a value set on the command line
 * (`-c.extraMetadata.witenaSignedBuild=true`) may arrive as either depending on
 * how electron-builder's argument parser coerces it, and a flag that is
 * silently false because it was a string is the failure mode this whole field
 * exists to remove. `''`, `'0'` and `'false'` are false, matching what the
 * environment variable used to accept.
 */
export function isSignedBuild(manifest: unknown): boolean {
  if (typeof manifest !== 'object' || manifest === null) return false
  const value = (manifest as Record<string, unknown>)[SIGNED_BUILD_FIELD]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length > 0 && value !== '0' && value !== 'false'
  return false
}

/**
 * Real encryption with a key held in a file beside the database (S7.6).
 *
 * AES-256-GCM with a fresh 12-byte IV per value, so two identical keys do not
 * produce identical ciphertext and any edit to a stored value is detected by the
 * tag rather than decrypting to garbage. The stored form is
 * `fk1:` + base64(iv ‖ tag ‖ ciphertext) — one string, because
 * `providers.api_key_encrypted` is a `text` column.
 *
 * The key is read (or created) lazily on first use: constructing the store must
 * not write to disk, so a context built for a read-only purpose leaves no file
 * behind, and a `userData` directory that does not exist yet is created by the
 * first save rather than by startup.
 *
 * **The trade this makes is deliberate and documented** in
 * `docs/features/providers/context.md`: on an unsigned build, anyone who can
 * read the user's files can read `secrets.key` and therefore the stored API
 * keys. That is already true of the Keychain item of an unsigned app — one
 * "Always Allow" prompt away — and unlike the Keychain item, the file survives
 * the next rebuild, which is the property the user actually needs.
 */
export function createFileKeySecretStore(options: FileKeySecretStoreOptions): SecretStore {
  const { keyPath, wrapper } = options
  const wrap = options.wrap ?? false
  let key: Buffer | null = null

  function unwrap(contents: string): Buffer {
    if (contents.startsWith(KEY_FILE_WRAPPED)) {
      if (!wrapper) {
        throw keyUnreadable(`${keyPath} is wrapped but this build has no key store to unwrap it`)
      }
      return Buffer.from(wrapper.decrypt(contents.slice(KEY_FILE_WRAPPED.length)), 'base64')
    }
    if (contents.startsWith(KEY_FILE_PLAIN)) {
      return Buffer.from(contents.slice(KEY_FILE_PLAIN.length), 'base64')
    }
    throw keyUnreadable(`${keyPath} is not a Witena key file`)
  }

  function write(material: Buffer): void {
    const body = material.toString('base64')
    const contents =
      wrap && wrapper ? KEY_FILE_WRAPPED + wrapper.encrypt(body) : KEY_FILE_PLAIN + body
    mkdirSync(dirname(keyPath), { recursive: true })
    // `wx` rather than `w`: two processes starting at once must not each write a
    // key, because the loser's would silently replace the winner's and every
    // value encrypted in between would become unreadable. An `EEXIST` here means
    // somebody else won, and the file they wrote is read below.
    writeFileSync(keyPath, contents, { mode: KEY_FILE_MODE, flag: 'wx' })
    // `mode` is masked by the process umask; this is not.
    chmodSync(keyPath, KEY_FILE_MODE)
  }

  /**
   * The key file's contents, or `null` when there is no file yet.
   *
   * Every failure to make sense of an existing file becomes `key_unreadable`,
   * including one thrown by the wrapper: a signed build whose Keychain item is
   * gone is the same situation as a value encrypted with a key we do not have,
   * and the caller must not have to tell two spellings of it apart.
   */
  function read(): Buffer | null {
    let contents: string
    try {
      contents = readFileSync(keyPath, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw cause
    }
    try {
      return unwrap(contents)
    } catch (cause) {
      if (isBackendFailure(cause)) throw cause
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw keyUnreadable(`${keyPath} could not be unwrapped: ${detail}`)
    }
  }

  function load(): Buffer {
    if (key) return key
    let material = read()
    if (!material) {
      const created = randomBytes(KEY_BYTES)
      try {
        write(created)
        material = created
      } catch (raced) {
        if ((raced as NodeJS.ErrnoException).code !== 'EEXIST') throw raced
        material = read()
        if (!material) throw keyUnreadable(`${keyPath} disappeared while it was being created`)
      }
    }
    if (material.length !== KEY_BYTES) {
      throw keyUnreadable(`${keyPath} does not hold a ${KEY_BYTES}-byte key`)
    }
    key = material
    return key
  }

  return {
    isAvailable() {
      // This *is* real encryption, unlike `createInsecureSecretStore`. Whether
      // the key file is additionally wrapped is a separate question, and the one
      // caller of this method only wants to know whether the value is protected.
      return true
    },

    encrypt(plain) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', load(), iv)
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return FILE_KEY_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
    },

    decrypt(cipher) {
      if (!isFileKeySecret(cipher)) {
        // A `v10…` or `plain:` value reaching this store was written by an
        // earlier build and belongs to `migrateProviderSecrets`, which is the
        // only thing allowed to read one. Saying so is more useful than an
        // "unsupported state or unable to authenticate data" from OpenSSL.
        throw keyUnreadable('This value was not encrypted with the file key')
      }
      const raw = Buffer.from(cipher.slice(FILE_KEY_PREFIX.length), 'base64')
      // Equal is legal: an empty string encrypts to an IV and a tag and nothing
      // else, and `''` is a value the caller may legitimately have stored.
      if (raw.length < IV_BYTES + TAG_BYTES) throw keyUnreadable('Truncated ciphertext')
      try {
        const decipher = createDecipheriv('aes-256-gcm', load(), raw.subarray(0, IV_BYTES))
        decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
        return Buffer.concat([
          decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
          decipher.final()
        ]).toString('utf8')
      } catch (cause) {
        // The tag failed, or the key is not the one this value was written with.
        // Both mean the same thing to every caller: the plaintext is not
        // recoverable here, and the user has to paste the key again.
        throw keyUnreadable(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* S7.3: moving an existing key file under the Keychain                        */
/* -------------------------------------------------------------------------- */

/** What `rewrapKeyFile` did, for the caller's log line and for the tests. */
export type RewrapOutcome =
  /** Not a signed build: the plain file is the correct form and was left alone. */
  | 'unsigned'
  /** No key file yet — the store will create one, already wrapped. */
  | 'absent'
  /** Already `fkkey1w:`; nothing to do, which is every launch after the first. */
  | 'already-wrapped'
  /** Was `fkkey1:`, is now `fkkey1w:`, same 32 bytes. */
  | 'wrapped'
  /** The wrapper refused, or the file is not one of ours. The plain file stands. */
  | 'failed'

export interface RewrapKeyFileOptions {
  /** Absolute path of the key file, normally `<userData>/secrets.key`. */
  keyPath: string
  /** The `safeStorage` store, or nothing when the platform has no key storage. */
  wrapper?: SecretStore | undefined
  /** Whether this is a signed build. False makes the whole call a no-op. */
  wrap: boolean
}

/**
 * Re-wrap a plain key file the first time a signed build runs (S7.3).
 *
 * S7.6 left this undone and said so: wrapping was only ever applied to a file
 * this build *created*, so a machine that had been running unsigned dmgs kept a
 * plain `secrets.key` forever and never gained the protection signing paid for.
 * The missing half is exactly this — one rewrite, at startup, of a file that is
 * already the user's.
 *
 * **It rewrites the container, never the contents.** The same 32 bytes go back
 * in, only under `fkkey1w:` instead of `fkkey1:`, so every `fk1:` ciphertext in
 * the database stays readable and no provider key is touched. That is what makes
 * doing it silently defensible where re-encrypting the keys themselves would not
 * be.
 *
 * **It is atomic.** A temp file in the same directory, `fsync`, then `rename` —
 * because the interruption this has to survive is the one that would be
 * catastrophic: a half-written key file is every API key the user has, gone. The
 * `rename` is the only moment anything observable changes, and POSIX makes it
 * indivisible within a filesystem.
 *
 * **It fails soft.** `safeStorage` can refuse — a locked keychain, a user who
 * clicked Deny — and the honest answer there is to keep the plain file, which
 * still works, and say so once. Never to leave the user with a file nothing can
 * read.
 *
 * Electron-free: the wrapper is injected, exactly as it is for the store.
 */
export function rewrapKeyFile(options: RewrapKeyFileOptions): RewrapOutcome {
  const { keyPath, wrapper, wrap } = options
  if (!wrap) return 'unsigned'
  if (!wrapper) return 'failed'

  let contents: string
  try {
    contents = readFileSync(keyPath, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    return 'failed'
  }

  if (contents.startsWith(KEY_FILE_WRAPPED)) return 'already-wrapped'
  // Anything that is not one of our two markers is not ours to rewrite. The
  // store will refuse it in a moment with a message that names the file; this
  // is not the place to guess at what it might be.
  if (!contents.startsWith(KEY_FILE_PLAIN)) return 'failed'

  const body = contents.slice(KEY_FILE_PLAIN.length)
  // Round-trip the base64 rather than trusting it: rewriting a file whose bytes
  // we could not decode would turn "a key we can read" into "a key nobody can".
  if (Buffer.from(body, 'base64').length !== KEY_BYTES) return 'failed'

  let wrapped: string
  try {
    wrapped = KEY_FILE_WRAPPED + wrapper.encrypt(body)
  } catch {
    return 'failed'
  }

  const tempPath = `${keyPath}.${randomBytes(6).toString('hex')}.tmp`
  try {
    // `wx` so a concurrent launch cannot be writing the same temp file, and
    // `0o600` so the intermediate is never more readable than the destination.
    const handle = openSync(tempPath, 'wx', KEY_FILE_MODE)
    try {
      writeSync(handle, wrapped)
      // Without this the rename can land before the bytes do, and a power cut in
      // between leaves a correctly named, empty key file.
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    chmodSync(tempPath, KEY_FILE_MODE)
    renameSync(tempPath, keyPath)
    return 'wrapped'
  } catch {
    rmSync(tempPath, { force: true })
    return 'failed'
  }
}
