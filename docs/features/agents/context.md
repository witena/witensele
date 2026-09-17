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
- The editor: basic info (name, avatar monogram and an eight-slot palette,
  description, and since S5.2 the **role**), model (provider select, model select
  or free-text id, the **Show thinking** toggle — S5.14's renaming of the
  reasoning one), system prompt, the skills checklist, the
  MCP checklist, and the memory toggle with its panel. Since S5.9 it asks for no
  sampling parameters.
- The `executor` role itself (S5.2): the segmented control, PLAN.md's
  explanation printed under it, and the badge four surfaces draw from
  `isExecutor` — the agent list, the chat's member rows, the member picker and
  every message header.
- Duplicate (under a free name) and a two-click Delete.
- `stores/agents.ts`: the list plus the editor draft, `dirty`, and the validation
  that gates Save.
- `components/agents/agent-display.ts`: the derived strings two screens print
  about an agent, the avatar palette, and (S5.17) the rule that turns whatever an
  agent's record happens to hold — a palette index, a colour from three steps
  ago, or nothing usable — into the two tokens its tile is painted from.
- **The agent templates (S7.5)**: `src/shared/agent-templates.ts` — three
  entries of name, description, system prompt, model hints and a palette index —
  and `agentsStore.createFromTemplate`, the one action that writes an agent
  without opening the editor. The tiles that render them belong to the first-run
  card ([`../chats/context.md`](../chats/context.md)); the records they produce
  are ordinary agents this page then edits like any other.

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
| ~~Avatar colours are literal hex pairs in TypeScript, not CSS variables~~ **Reversed in S5.17: the record holds a palette *index* (`InitialAvatar.palette`) and `index.css` holds the colours** | Keep the hexes; migrate every row to a new pair; keep two lists and branch on the theme in the component | The old reasoning confused the choice with its consequence. The *choice* is data and `3` stores it perfectly; the colour is a rendering decision, and it has to differ between the appearances — slot 3 is a deep violet in dark and a pale one in light, and no single hex can be both. That is why a dark slab with a pale monogram survived onto the light theme's near-white panels for two steps |
| Legacy records are mapped to a slot **at render time**, never rewritten | A database migration; a lazy write-on-read; default an index-less record to neutral | A migration rewrites rows for a cosmetic reason, can half-fail, and makes a downgrade render wrong. `nearestAvatarPalette` is a pure function over eight known values, it cannot fail, and the eight legacy hexes round-trip to the slot the user actually picked. Defaulting to neutral was the cheap option and would have repainted every existing agent grey |
| A record written today **still carries the old hex pair** beside the index | Drop `color` / make it optional | `InitialAvatar.color` is a compatibility shadow now, not what gets painted: an older build, an export or the future server has something to fall back on, and `nearestAvatarPalette` maps it straight back to the index it shadows. Making it optional would have rippled through the main-process fixtures for no gain |
| `InitialAvatar` gained an optional `textColor` | Derive the foreground from the background at render time | The palette pairs come from the artboard and are not computable from the background; making it optional keeps records written before S2.1 rendering on the neutral fallback |
| The model control is a `<select>` when the provider lists models and a text field when it does not | Always free text; always a dropdown | A provider's model list can legitimately be empty (a custom endpoint, an Ollama that was down when it was added), and a dropdown-only form would make such a provider unusable |
| The role is a segmented control with the explanation printed under it, not a tooltip | A select; a tooltip; a checkbox called "can write" | It is the one control on this form that changes what the agent may do to the user's disk. That is not a thing to discover by hovering, and two named roles read better than a negated capability |
| The explanation is **one** sentence-long key per language | Three bullets; a link to the docs | It has to fit under a control in a 50%-width column, and a rule nobody reads is not a safeguard. The full reasoning is in `PLAN.md`; the screen carries the consequence |
| The badge is drawn from `isExecutor` in `agent-display.ts` rather than from `role === 'executor'` in each component | A literal comparison in each of the four places | Four copies is four places to miss when the role set grows, and `hasExecutor` — the picker's rule — belongs next to it |
| The form asks for **no** sampling parameters (S5.9) | Keep Temperature and Max tokens; hide them behind an "advanced" disclosure | Real users do not tune sampling: they pick a model and write a prompt, and current models' provider defaults are what everyone should run with. Two numeric fields with range messages under them were friction with nothing on the other side, and an "advanced" drawer is the same two fields plus a place to hide a bug. `Agent.params` keeps both fields, so an agent saved with a temperature still uses it and no migration is needed |
| The reasoning toggle stays while the other two go | Remove all three | It changes what the model *produces* — a visible reasoning block in the transcript — rather than how it samples, so it is a product choice and not a knob |
| **That toggle now means "show thinking"** (S5.14) | Leave it meaning "ask for reasoning output"; add a second control | It never meant the first thing: nothing read `params.reasoning`, and no provider option was ever set from it. What the first real use complained about was four open models each streaming a chain of thought into one transcript — a question about what is *kept*, not about what is requested — so the field was given the meaning the control's position already implied, and the label says it |
| **Its default comes from the provider, and is written into `params` at creation** (S5.14) | A global setting; off for everyone; on for everyone; compute it at render time only | An `anthropic`, `openai` or `google` model produces reasoning only when the user picked a thinking mode, and then they want to see it; an Ollama or DeepSeek model produces it whether or not anybody asked. Writing the answer at `agents.create` means a stored agent carries a choice rather than a gap, so the toggle never moves under the user afterwards; the editor shows the same computed answer for a draft that has not chosen yet, so the switch at Save is the switch that was on screen |
| The toggle stores an **explicit boolean**, including `false` | Keep storing `undefined` for off, as before S5.14 | With a provider-dependent default, "absent" has to keep meaning "nobody chose". A user who turns thinking off on an Anthropic agent has chosen, and an absent key would silently turn it back on |
| `ensureDefaultAgent` stays | Delete it now that the user can create agents | It is the only thing that makes the *first* chat of a fresh install answerable, and `e2e/chat.spec.ts` depends on that path. It now fires only while the agents table is empty |

## Open questions

- Whether an agent should be copyable *between* providers in one action ("the
  same reviewer, on the other model"), which is what Duplicate is usually reached
  for. Today it copies the provider too and the user changes it afterwards.
- Whether the Show thinking toggle should be hidden for models that do not
  produce reasoning at all. That needs per-model capability data, which no
  provider exposes uniformly — and the toggle is harmless on such a model, since
  there is nothing to hide or show.
- Whether changing an agent's provider should re-apply the Show thinking default.
  Today it does not: once the record holds a boolean, it holds it, and moving a
  Claude agent to Ollama keeps its thinking visible until the user says otherwise.
- Whether `params.temperature` / `params.maxTokens` should eventually leave the
  schema too. S5.9 left them stored and honoured, so agents configured before it
  keep behaving exactly as they did; dropping them means a migration and a
  decision about those records.
- Whether promoting an agent to `executor` should be refused while it is in a
  chat that already has one. Today `agents.update` allows it; see the known gap
  in [`../chats/backend.md`](../chats/backend.md).
- Whether switching an agent back to `participant` should drop the
  `sideEffects` servers already bound to it. Today the ids stay on the record
  and the checklist greys them, which matches how a missing skill is handled.
