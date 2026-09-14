/**
 * S7.6: move every provider key onto the file-held encryption key, once, at
 * startup.
 *
 * The rows this runs against were written by `safeStorage` (base64 of `v10…`) or
 * by the insecure `plain:` fallback. It reads each one with the store that wrote
 * it and re-encrypts it with `ctx.secrets`, which since S7.6 is the file-key
 * store — so a key pasted into one unsigned build is still readable by the next
 * one, which is the entire point of the step.
 *
 * Two rules it does not bend:
 *
 * - **A ciphertext that could not be read is never overwritten.** The row keeps
 *   exactly what it held. The key inside it is unrecoverable on this machine,
 *   but the user may still restore the Keychain item (from a backup, or by
 *   reinstalling the build that wrote it), and a row we had blanked would be
 *   unrecoverable for good.
 * - **A failure is a fact to report, not an error to throw.** The app must start.
 *   The ids that could not be read are collected in `ctx.unreadableSecrets`, the
 *   `providers.*` handlers report them as `keyState: 'unreadable'`, and the UI
 *   says what to do about it.
 *
 * Electron-free (CLAUDE.md rule #5): the legacy store arrives as an injected
 * `SecretStore`, exactly like every other capability on the context.
 */
import type { AppContext } from '../app-context'
import type { SecretStore } from '../secrets'
import {
  createInsecureSecretStore,
  isFileKeySecret,
  isInsecureSecret,
  isLegacySecret
} from '../secrets'

export interface SecretMigrationResult {
  /** Provider ids whose key was re-encrypted with the file key. */
  migrated: string[]
  /** Provider ids whose stored ciphertext could not be read. */
  unreadable: string[]
  /** Provider ids that already held a `fk1:` value, or no key at all. */
  skipped: number
}

export interface SecretMigrationOptions {
  /**
   * The store that wrote the `safeStorage` rows — the `safeStorage`
   * implementation in the app, `null` on a machine that has no key storage (and
   * therefore cannot possibly read one).
   */
  legacy?: SecretStore | null
}

/**
 * Re-encrypts every legacy provider key with `ctx.secrets`.
 *
 * Safe to call more than once: a row already holding a `fk1:` value is skipped,
 * so the second launch does no writes at all. Returns what it did, which
 * `src/main/index.ts` logs — the one place a user or a bug report can see that
 * the migration ran and what it found.
 */
export function migrateProviderSecrets(
  ctx: AppContext,
  options: SecretMigrationOptions = {}
): SecretMigrationResult {
  const legacy = options.legacy ?? null
  // Built here rather than injected: `plain:` is this repository's own fallback
  // format, decoding it needs no platform support, and a machine that once ran
  // with no Keychain still has those rows.
  const insecure = createInsecureSecretStore()
  const result: SecretMigrationResult = { migrated: [], unreadable: [], skipped: 0 }

  for (const provider of ctx.repos.providers.list(ctx.userId)) {
    const cipher = ctx.repos.providers.getApiKeyCiphertext(provider.id, ctx.userId)
    if (!cipher || isFileKeySecret(cipher) || !isLegacySecret(cipher)) {
      result.skipped += 1
      continue
    }

    const reader = isInsecureSecret(cipher) ? insecure : legacy
    if (!reader) {
      result.unreadable.push(provider.id)
      continue
    }

    let plain: string
    try {
      plain = reader.decrypt(cipher)
    } catch {
      // The Keychain item this value was encrypted against is gone — the failure
      // S7.6 exists to explain. Leave the row alone and remember the id.
      result.unreadable.push(provider.id)
      continue
    }

    // `update` re-encrypts through the repository's injected `encrypt`, which is
    // `ctx.secrets.encrypt`: one path to ciphertext, no second spelling of it.
    ctx.repos.providers.update(provider.id, { apiKey: plain }, ctx.userId)
    result.migrated.push(provider.id)
  }

  for (const id of result.unreadable) ctx.unreadableSecrets.add(id)
  return result
}
