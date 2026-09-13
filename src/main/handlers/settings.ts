/**
 * `settings.*` — application settings, one JSON row per user.
 *
 * The merge rules (defaults underneath a read, `timeouts` merged field by field
 * on a write) live in `src/main/db/repositories/settings.ts`; the handlers only
 * validate the payload and scope the call to `ctx.userId`.
 */
import {
  EDITOR_KINDS,
  THEME_SETTINGS,
  type AppSettingsPatch,
  type EditorKind,
  type EditorSettings,
  type ThemeSetting
} from '@shared/types'
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
 * Accepts only the four documented keys; anything else is a client bug.
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
  const allowed = new Set(['language', 'theme', 'editor', 'timeouts'])
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
}

export const settingsHandlers: HandlerModule = {
  'settings.get': async (ctx) => ctx.repos.settings.get(ctx.userId),

  'settings.update': async (ctx, input) => {
    assertPatch(input?.patch)
    return ctx.repos.settings.update(input.patch, ctx.userId)
  }
}
