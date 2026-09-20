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

Every string goes through `t()` under `settings.integrations.*` and
`chat.viaClient`; no component reaches past `BackendClient`.

One boundary worth stating, because `src/shared/mcp-tools.ts` is importable from
the renderer and its strings are English: the tool `title` and `description`
fields are **not** UI copy and must never be rendered. Their reader is the
calling model, they are deliberately outside i18n (CLAUDE.md rule 4 is about
what the user sees), and a component that showed one would be showing the user
an untranslated prompt. If Settings → Integrations ever wants to list the tools,
it names them with its own `settings.integrations.*` keys.
