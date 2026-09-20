/**
 * What the command line asked of this launch (S10.3).
 *
 * Two questions, both answered before `whenReady` and both cheap enough to ask
 * again inside `second-instance`:
 *
 * - **`--background`**: start without creating a window. The MCP shim launches
 *   the app this way (`open -g -j -a Witena.app --args --background`) when a
 *   coding agent calls a tool and Witena is not running, so a tool call never
 *   steals the user's focus or their screen. The Dock icon is still there and
 *   clicking it opens the window through the existing `activate` handler.
 * - **`witena://chat/<uuid>`**: the chat a deep link names. macOS normally
 *   delivers this through the `open-url` event rather than in `argv`, but the
 *   argument form is what a `second-instance` hand-off carries, and it costs one
 *   `parseChatUrl` to accept both.
 *
 * Kept apart from `index.ts` because it is the only part of launching that is
 * pure: a function from `argv` to two fields, with no electron import and
 * therefore a unit test instead of an end-to-end run. It is not under
 * `src/main/ipc/`, so CLAUDE.md rule 5 applies to it like any other main-process
 * module — `@shared/mcp-tools` is its only dependency.
 *
 * **The scan starts at `argv[1]` and looks at every remaining entry**, because
 * the two builds hand it different shapes. WP-0a measured a packaged launch's
 * argv as exactly `['<bundle>/Contents/MacOS/Witena', '--background']`, while in
 * development and under the Playwright harness electron is given the app
 * directory (`.`) and whatever switches the harness adds. Matching the literal
 * flag anywhere after the executable is what makes one parser right for both;
 * positional reasoning would only be right for one of them.
 */
import { parseChatUrl } from '@shared/mcp-tools'

/** The flag the shim passes through `open --args`. */
export const BACKGROUND_FLAG = '--background'

/**
 * The URL scheme the packaged app registers.
 *
 * Spelled here rather than imported because `src/shared/mcp-tools.ts` keeps its
 * prefix private; a test pins the two together by checking that `chatUrl` really
 * does speak this scheme, so a change on either side fails rather than drifts.
 */
export const CHAT_URL_SCHEME = 'witena'

export interface LaunchArgs {
  /** Skip the first window: the app starts with a Dock icon and nothing else. */
  background: boolean
  /** The chat id of the first `witena://chat/<uuid>` argument, or `null`. */
  openChatId: string | null
}

/**
 * Reads `--background` and a chat deep link out of a process argument vector.
 *
 * Never throws and never interprets anything else: an argument that is not the
 * flag and not a link the strict `parseChatUrl` accepts is ignored, which is the
 * only safe reading of a vector that contains electron's own switches, the
 * harness's, and — when the operating system hands one over — a string a user
 * clicked on.
 */
export function parseLaunchArgs(argv: readonly string[]): LaunchArgs {
  let background = false
  let openChatId: string | null = null

  for (const arg of argv.slice(1)) {
    if (arg === BACKGROUND_FLAG) {
      background = true
      continue
    }
    // First link wins. A vector with two of them is nothing the app produces,
    // and picking the earlier one at least makes the choice deterministic.
    if (openChatId === null) openChatId = parseChatUrl(arg)
  }

  return { background, openChatId }
}
