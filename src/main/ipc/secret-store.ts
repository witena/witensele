/**
 * The Electron implementation of `SecretStore`.
 *
 * `safeStorage` encrypts against the OS key store (the Keychain on macOS), which
 * is the only electron API the secret path needs. It lives under `src/main/ipc/`
 * because that — with `src/main/index.ts` — is the only place allowed to import
 * electron (CLAUDE.md rule #5); everything else receives the `SecretStore`
 * interface by injection.
 */
import { safeStorage } from 'electron'
import type { SecretStore } from '../secrets'
import { createInsecureSecretStore } from '../secrets'

/**
 * Builds the real store, or the insecure fallback when the platform offers no key
 * storage (a Linux session with no keyring, a CI machine, a locked login
 * keychain). The fallback is loud: it logs on construction and again on first use.
 *
 * The ciphertext is base64 of the `Buffer` `safeStorage` returns, because the
 * `providers.api_key_encrypted` column is `text`.
 */
export function createElectronSecretStore(): SecretStore {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[witena] safeStorage reports no encryption backend; falling back to plain storage')
    return createInsecureSecretStore()
  }

  return {
    isAvailable() {
      return true
    },

    encrypt(plain) {
      return safeStorage.encryptString(plain).toString('base64')
    },

    decrypt(cipher) {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    }
  }
}
