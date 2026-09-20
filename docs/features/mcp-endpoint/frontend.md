# mcp-endpoint — Frontend

> Nothing in the renderer yet. WP-1, the first package to land, is two modules in
> `src/shared/` with no UI of their own — the feature reaches the window in
> WP-8, WP-12 and WP-13.

Planned surface, by work package (`tasks.md`):

| Surface | Package |
|---|---|
| Settings → Integrations: the endpoint switch, status, Claude Code and Codex cards, the generic snippet | WP-12 |
| The "via {{client}}" chip on a message sent through the endpoint | WP-13 |
| Selecting a chat on the `ui.open-chat` event (`witena://chat/<id>`) | WP-8 |
| "Create a Claude Code agent for each committee" | WP-14 |

## HTTP endpoint and guards (WP-4)

Still nothing in the renderer, and the table above is unchanged. One thing WP-12
will want when it writes the status line: the endpoint's refusals are **English
JSON-RPC error objects written for the calling model**, exactly like the tool
descriptions — a 401 says to re-read the discovery file, a 403 says the endpoint
is not reachable from a web page. They are read by the shim and by an IDE, never
by the Witena window, so they are outside i18n by the same rule that puts the
tool descriptions outside it (CLAUDE.md rule 4 is about what the *user* sees).
If Settings → Integrations ever surfaces "the last call was refused", it says so
with its own `settings.integrations.*` key rather than showing the sentence.

Every string goes through `t()` under `settings.integrations.*` and
`chat.viaClient`; no component reaches past `BackendClient`.

## Discussion watcher (WP-2)

No renderer surface, and deliberately none: `src/main/mcp-endpoint/discussion.ts`
watches the same `EventBus` the window already watches, and adds no event, no
store field and no component. A discussion started through the endpoint shows up
in the window as an ordinary chat — the message list, the member panel and the
presence dots are the ones `chats` and `presence` already own, and the only thing
that will ever mark it as *not* typed by the user is WP-13's "via {{client}}"
chip.

The progress lines the watcher produces ("Round 2 — Ada, Lin", "Ada has spoken")
are **not** UI copy and never reach the renderer: they are written in English for
the calling model's progress notifications, for the same reason the tool
descriptions are (below).

## Tools (WP-3)

Still nothing in the renderer, and the table above is unchanged. Two things the
window will meet indirectly:

- **A discussion started through the endpoint is an ordinary chat.**
  `start_discussion` creates it with `chats.create` and writes to it with
  `chat.send`, so the left column, the message list and the member panel show it
  the moment it exists, with no new event and no store field. The only thing that
  will ever mark it as not typed by the user is WP-13's "via {{client}}" chip.
- **A chat the endpoint created is titled from the question's first line**, cut
  at 60 characters, which is what the user sees in the sidebar until they rename
  it. That title is *content*, like every other chat title, and so is outside
  i18n — the same rule that keeps `DEFAULT_CHAT_TITLE` a plain string.

The hints and the markdown `get_discussion` renders are, like the tool
descriptions and the watcher's progress lines, written in English for the calling
model and never drawn in the window.

One boundary worth stating, because `src/shared/mcp-tools.ts` is importable from
the renderer and its strings are English: the tool `title` and `description`
fields are **not** UI copy and must never be rendered. Their reader is the
calling model, they are deliberately outside i18n (CLAUDE.md rule 4 is about
what the user sees), and a component that showed one would be showing the user
an untranslated prompt. If Settings → Integrations ever wants to list the tools,
it names them with its own `settings.integrations.*` keys.
