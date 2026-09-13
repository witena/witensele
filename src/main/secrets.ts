/**
 * The secret store seam.
 *
 * Provider API keys are stored as ciphertext in the `providers` table
 * (`docs/features/database/backend.md`). Producing that ciphertext is Electron's
 * job — `safeStorage` is backed by the macOS Keychain — but nothing outside
 * `src/main/ipc/` may import electron (CLAUDE.md rule #5), so every service takes
 * this interface instead. `src/main/ipc/secret-store.ts` supplies the real
 * `safeStorage` implementation; tests and a future Node server supply their own.
 */

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
