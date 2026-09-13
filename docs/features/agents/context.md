# agents — Context

## Problem

A Witena chat is interesting because the members in it are *different*: different
models, different instructions, different jobs. Until S2.1 there was exactly one
agent in the product — the bootstrap `Assistant` that `chats.create` wrote so the
first conversation was possible at all. This feature is the screen and the
handlers that let the user own that list: create an agent, give it a name, a
face, a provider, a model, parameters and a system prompt, duplicate it, delete
it, and find it all again after a restart.

The name matters more than it looks. S2.3 resolves `@name` against this table, so
the name is an **identifier the models will type**, not a label.

## Scope

- `agents.get / create / update / delete` on top of the existing repository, with
  the validation that keeps an unusable record out of the database.
- The Agents page: the 264px list (avatar, name, `modelId · provider`, count in
  the header, "+" opens a draft) and the configuration editor beside it.
- The editor: basic info (name, avatar monogram and an eight-colour palette,
  description, and since S5.2 the **role**), model (provider select, model select
  or free-text id, temperature, max tokens, reasoning toggle), system prompt, the
  skills checklist, the MCP checklist, and the memory toggle with its panel.
- The `executor` role itself (S5.2): the segmented control, PLAN.md's
  explanation printed under it, and the badge four surfaces draw from
  `isExecutor` — the agent list, the chat's member rows, the member picker and
  every message header.
- Duplicate (under a free name) and a two-click Delete.
- `stores/agents.ts`: the list plus the editor draft, `dirty`, and the validation
  that gates Save.
- `components/agents/agent-display.ts`: the derived strings two screens print
  about an agent, and the avatar palette.

## Out of scope

| Not here | Owned by |
|---|---|
| Which agents are in which chat, and in what order | [`chats`](../chats/context.md) (S2.2) |
| What an agent does during its turn | [`agent-turn`](../agent-turn/context.md) |
| The skills library itself: scanning, importing, reading a skill | [`skills`](../skills/context.md) (S3.1+S3.2 `[x]`). The agent form's **checklist** is here; the library and the `read_skill` tools are there |
| Registering and probing MCP servers | `mcp` (S3.1 `[x]`). The agent form's **checklist** is here; the registry, the connections and the side-effects rule are there |
| The memory files, the tools and the prompt section | [`memory`](../memory/context.md) (S3.3 `[x]`). The **toggle and the panel** are here; the store, the tools and the format are there |
| Which chat an executor may join, and the chat's working directory | [`chats`](../chats/context.md) (S5.2). The role lives here; the "one executor per chat" rule and the folder live there, because both are properties of a chat |
| The executor's file, shell and git tools, and the permission prompt before each change | S5.4 and S5.5 (`docs/features/executor/`) |
| Searching or grouping the agent list | Not planned for the MVP |

As of S3.3 the editor's right column is complete: all three blocks — Skills, MCP
servers and Memory — are real controls bound to stored fields. Each of them is
only the *binding*; the capability behind it belongs to its own feature, which is
why a skill is chosen here and scanned there.

## Dependencies

| Feature | What this one needs from it |
|---|---|
| [`database`](../database/context.md) | `AgentRepository`, and the `ON DELETE CASCADE` on `chat_members.agent_id` that makes deletion remove memberships |
| [`backend-client`](../backend-client/context.md) | `BackendClient`, the `BackendApi` contract, the typed event union |
| [`providers`](../providers/context.md) | The provider list the model dropdown is fed from; a provider id must exist before an agent can point at it |
| [`ui-shell`](../ui-shell/context.md) | `Column`, `Avatar`, `Field`, `Input`, `Select`, `TextArea`, `Toggle`, `EmptyState`, `SectionTitle` and the tokens |
| [`i18n`](../i18n/context.md) | Every string under `agents.*`, including `agents.validation.*` |

Depending on it in return: `chats` puts these agents into chats and prints their
name, avatar and model on every message and member row; `orchestration` (S2.3)
resolves `@name` against the names created here.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| A name may contain spaces, but never `@`, and is unique case-insensitively | Forbid whitespace so `@name` parses by splitting on it | "Architect copy" has to be a legal duplicate, and a Chinese name has no spaces to split on anyway. S2.3 resolves the **longest matching member name** instead of tokenising, which also handles `@Data Analyst`. `@` inside a name would make any mention unparseable, so it is refused |
| The editor works on a draft and saves as a whole | Save each field as it changes | A half-typed name is not a name, the provider change rewrites the model field, and agents are read by every chat they are in — an autosaved intermediate state would reach a running conversation |
| Validation is computed in the store **and** enforced in the handler | Only one of the two | The handler is the authority (a future HTTP client is not this UI). The store's copy is what lets Save be disabled with the reason under the field instead of a rejection after the click |
| Deleting an agent stops the runs of every chat it was in | Let the cascade fire and hope | A turn streaming for that agent would keep writing into a chat whose membership changed under it. Stopping first makes the outcome the same every time |
| `agents.update` / `delete` emit `chat.updated` per affected chat | A new `agent.updated` event | The renderer already has one path for "this chat changed"; a second event type would need its own reducer in every store that cares. The chat rows are what actually re-render |
| Avatar colours are literal hex pairs in TypeScript, not CSS variables | Tokens in `index.css` | An avatar is *data*: the pair is copied into `agents.avatar` and stored in SQLite, where `var(--color-…)` resolves to nothing |
| `InitialAvatar` gained an optional `textColor` | Derive the foreground from the background at render time | The palette pairs come from the artboard and are not computable from the background; making it optional keeps records written before S2.1 rendering on the neutral fallback |
| The model control is a `<select>` when the provider lists models and a text field when it does not | Always free text; always a dropdown | A provider's model list can legitimately be empty (a custom endpoint, an Ollama that was down when it was added), and a dropdown-only form would make such a provider unusable |
| The role is a segmented control with the explanation printed under it, not a tooltip | A select; a tooltip; a checkbox called "can write" | It is the one control on this form that changes what the agent may do to the user's disk. That is not a thing to discover by hovering, and two named roles read better than a negated capability |
| The explanation is **one** sentence-long key per language | Three bullets; a link to the docs | It has to fit under a control in a 50%-width column, and a rule nobody reads is not a safeguard. The full reasoning is in `PLAN.md`; the screen carries the consequence |
| The badge is drawn from `isExecutor` in `agent-display.ts` rather than from `role === 'executor'` in each component | A literal comparison in each of the four places | Four copies is four places to miss when the role set grows, and `hasExecutor` — the picker's rule — belongs next to it |
| `ensureDefaultAgent` stays | Delete it now that the user can create agents | It is the only thing that makes the *first* chat of a fresh install answerable, and `e2e/chat.spec.ts` depends on that path. It now fires only while the agents table is empty |

## Open questions

- Whether an agent should be copyable *between* providers in one action ("the
  same reviewer, on the other model"), which is what Duplicate is usually reached
  for. Today it copies the provider too and the user changes it afterwards.
- Whether the reasoning toggle should be hidden for models that do not support
  it. That needs per-model capability data, which no provider exposes uniformly.
- Whether promoting an agent to `executor` should be refused while it is in a
  chat that already has one. Today `agents.update` allows it; see the known gap
  in [`../chats/backend.md`](../chats/backend.md).
- Whether switching an agent back to `participant` should drop the
  `sideEffects` servers already bound to it. Today the ids stay on the record
  and the checklist greys them, which matches how a missing skill is handled.
