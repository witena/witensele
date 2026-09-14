/**
 * The Electron implementation of `SecretStore`.
 *
 * `safeStorage` encrypts against the OS key store (the Keychain on macOS), which
 * is the only electron API the secret path needs. It lives under `src/main/ipc/`
 * because that — with `src/main/index.ts` — is the only place allowed to import
 * electron (CLAUDE.md rule #5); everything else receives the `SecretStore`
 * interface by injection.
 *
 * **Since S7.6 this is no longer the store provider keys are written with.** The
 * Keychain grants its item ("Witena Safe Storage") per application identity, and
 * an unsigned build gets a new identity every time it is packaged — so every key
 * written by the previous dmg became unreadable when the next one replaced it.
 * `createFileKeySecretStore` owns the keys now, and this store has two remaining
 * jobs: it is the **legacy reader** the startup migration decrypts old rows
 * with, and — on a signed build (S7.3) — the **wrapper** around the key file.
 */
import { safeStorage } from 'electron'
import type { SecretStore } from '../secrets'
import { createInsecureSecretStore } from '../secrets'

/**
 * The `safeStorage` store, or `null` when the platform offers no key storage
 * (a Linux session with no keyring, a CI machine, a locked login keychain).
 *
 * `null` rather than a fallback, because both callers have to be able to tell:
 * an absent key store must not be *wrapped* with (there is nothing to wrap
 * with), and a legacy `v10…` row on a machine with no Keychain is unreadable
 * rather than something to guess at.
 *
 * The ciphertext is base64 of the `Buffer` `safeStorage` returns, because the
 * `providers.api_key_encrypted` column is `text`.
 */
export function createSafeStorageStore(): SecretStore | null {
  if (!safeStorage.isEncryptionAvailable()) return null

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

/**
 * The store as it was before S7.6: `safeStorage`, or the loud insecure fallback.
 *
 * Kept because the fallback's warning is still the right answer for a machine
 * with no key storage at all, and because a caller that simply wants "the best
 * store electron can give me" should not have to spell the `??` out. Nothing in
 * the app writes provider keys through it any more.
 */
export function createElectronSecretStore(): SecretStore {
  const store = createSafeStorageStore()
  if (store) return store
  console.warn('[witena] safeStorage reports no encryption backend; falling back to plain storage')
  return createInsecureSecretStore()
}
