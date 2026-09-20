/**
 * `settings.*` — application settings, one JSON row per user.
 *
 * The merge rules (defaults underneath a read, `timeouts` merged field by field
 * on a write) live in `src/main/db/repositories/settings.ts`; the handlers
 * validate the payload, scope the call to `ctx.userId` — and, for the one
 * setting that is also a running thing, make the process match the row.
 *
 * That one setting is `mcpEndpoint` (S10.3): storing `enabled` and waiting for a
 * restart would mean a switch that appears to do nothing, so `settings.update`
 * starts or stops `ctx.mcpEndpoint` after the write. It is the only side effect
 * in this file, and it is deliberately the last thing that happens.
 */
import {
  EDITOR_KINDS,
  THEME_SETTINGS,
  type AppSettingsPatch,
  type EditorKind,
  type EditorSettings,
  type McpEndpointSettings,
  type ThemeSetting
} from '@shared/types'
import type { AppContext } from '../app-context'
import { validation } from '../errors'
import type { HandlerModule } from './types'

/**
 * The `editor` half of the patch (S5.7), checked field by field.
 *
 * Both fields are validated for the same reason `theme` is: they are read back
 * by code that cannot fail safely. An unknown `kind` would fall through every
 * branch of `planOpenInEditor` and leave a chip that does nothing, and a blank
 * `command` would spawn an empty shell line — a click that silently succeeds and
 * opens nothing. Neither is reachable from the UI, so both are client bugs, and
 * a refusal is the only answer that says so.
 */
function assertEditorPatch(editor: unknown): asserts editor is Partial<EditorSettings> {
  if (typeof editor !== 'object' || editor === null || Array.isArray(editor)) {
    throw validation('settings.update: editor must be an object')
  }
  const allowed = new Set(['kind', 'command'])
  const unknownKeys = Object.keys(editor).filter((key) => !allowed.has(key))
  if (unknownKeys.length > 0) {
    throw validation(`settings.update: editor received unknown keys: ${unknownKeys.join(', ')}`)
  }

  const { kind, command } = editor as Partial<EditorSettings>
  if (kind !== undefined && !EDITOR_KINDS.includes(kind as EditorKind)) {
    throw validation(
      `settings.update received an unknown editor kind: ${String(kind)} (expected ${EDITOR_KINDS.join(', ')})`
    )
  }
  if (command !== undefined && (typeof command !== 'string' || command.trim().length === 0)) {
    throw validation('settings.update: editor.command must be a non-empty string')
  }
}

/**
 * The `mcpEndpoint` half of the patch (S10.3), checked like `theme` and `editor`.
 *
 * Worth the lines for the same reason the other two are, and a little more: this
 * one is read back as a boolean by code that **opens a local port**. A stored
 * `'no'` is truthy, and the difference between the endpoint being closed and
 * being open to whatever is on the machine is not a difference to leave to a
 * client's spelling.
 */
function assertMcpEndpointPatch(
  endpoint: unknown
): asserts endpoint is Partial<McpEndpointSettings> {
  if (typeof endpoint !== 'object' || endpoint === null || Array.isArray(endpoint)) {
    throw validation('settings.update: mcpEndpoint must be an object')
  }
  const unknownKeys = Object.keys(endpoint).filter((key) => key !== 'enabled')
  if (unknownKeys.length > 0) {
    throw validation(
      `settings.update: mcpEndpoint received unknown keys: ${unknownKeys.join(', ')}`
    )
  }
  const { enabled } = endpoint as Partial<McpEndpointSettings>
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw validation(
      `settings.update: mcpEndpoint.enabled must be a boolean, received ${typeof enabled}`
    )
  }
}

/**
 * Accepts only the documented keys; anything else is a client bug.
 *
 * `theme` is the first value whose *content* is checked as well (S5.8), and
 * `editor` the second (S5.7). Both are worth the lines because they are the
 * settings read back by code that cannot fail safely: a stored `'sepia'` would
 * reach `resolveTheme`, resolve to light, and leave a user staring at a theme
 * nothing in the UI can explain. The language is not checked the same way because
 * `resolveLanguage` falls back to English for anything it does not know, which is
 * a visible, recoverable state rather than a silent one.
 */
function assertPatch(patch: unknown): asserts patch is AppSettingsPatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw validation('settings.update requires a patch object')
  }
  const allowed = new Set([
    'language',
    'theme',
    'editor',
    'mcpEndpoint',
    'timeouts',
    'onboardingDismissed'
  ])
  const unknownKeys = Object.keys(patch).filter((key) => !allowed.has(key))
  if (unknownKeys.length > 0) {
    throw validation(`settings.update received unknown keys: ${unknownKeys.join(', ')}`)
  }
  const theme = (patch as AppSettingsPatch).theme
  if (theme !== undefined && !THEME_SETTINGS.includes(theme as ThemeSetting)) {
    throw validation(
      `settings.update received an unknown theme: ${String(theme)} (expected ${THEME_SETTINGS.join(', ')})`
    )
  }
  const editor = (patch as AppSettingsPatch).editor
  if (editor !== undefined) assertEditorPatch(editor)

  const mcpEndpoint = (patch as AppSettingsPatch).mcpEndpoint
  if (mcpEndpoint !== undefined) assertMcpEndpointPatch(mcpEndpoint)

  // S7.5's Skip flag. Checked like the two above because it is read back as a
  // boolean by code with no other branch: a stored `'no'` is truthy and would
  // hide the first-run card on a machine that has nothing set up.
  const dismissed = (patch as AppSettingsPatch).onboardingDismissed
  if (dismissed !== undefined && typeof dismissed !== 'boolean') {
    throw validation(
      `settings.update: onboardingDismissed must be a boolean, received ${typeof dismissed}`
    )
  }
}

/**
 * Makes the MCP endpoint's switch true of the process, not only of the row
 * (S10.3).
 *
 * Called **after** the row is written, so the stored setting is what the host is
 * being asked to match rather than the other way round, and only when the patch
 * carried `mcpEndpoint` — a user changing the theme must not restart a listening
 * socket.
 *
 * `ctx.mcpEndpoint` is `null` on the Node host and in every test, where the
 * setting is stored and nothing listens. That is the whole of "a context without
 * the option ignores the toggle".
 *
 * **A failure never fails the write.** The user's intent is the row; whether a
 * socket came up is a fact about this launch, and WP-11's `integrations.status`
 * reports it from `host.state` rather than from the setting. Rejecting here
 * would leave the row saying one thing and the UI — which reverts a switch on a
 * rejected update — saying another, which is the one outcome that helps nobody.
 */
async function applyEndpointSetting(ctx: AppContext, enabled: boolean): Promise<void> {
  const host = ctx.mcpEndpoint
  if (!host) return
  try {
    if (enabled) await host.start()
    else await host.stop()
  } catch (cause) {
    console.warn(
      `[witena] the MCP endpoint could not be ${enabled ? 'started' : 'stopped'}: ${String(cause)}`
    )
  }
}

export const settingsHandlers: HandlerModule = {
  'settings.get': async (ctx) => ctx.repos.settings.get(ctx.userId),

  'settings.update': async (ctx, input) => {
    assertPatch(input?.patch)
    const next = ctx.repos.settings.update(input.patch, ctx.userId)
    if (input.patch.mcpEndpoint !== undefined) {
      await applyEndpointSetting(ctx, next.mcpEndpoint.enabled)
    }
    return next
  }
}
