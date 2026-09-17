/**
 * The instrument for S5.17's light-theme review, not a test of anything.
 *
 * S5.8 proved the light palette on five mostly empty screens and left the rest
 * in the backlog as "read from their tokens rather than seen". This spec seeds a
 * plausible installation — three agents and an executor, two providers, a chat
 * with a working directory, a document goal and a transcript containing **every
 * part kind the renderer knows how to draw** — then walks every screen in both
 * appearances and writes a full-window screenshot of each into
 * `test-results/theme-review/`.
 *
 * It asserts almost nothing. What it asserts is that each screen it photographs
 * was actually on screen, because a review of forty blank images is worse than
 * no review: the value is entirely in a human opening the folder. The defects
 * that first pass found, and what was done about each, are listed in S5.17's
 * `Done:` paragraph in `docs/STEPS.md`.
 *
 * ## No model runs
 *
 * Every screen here would ordinarily need one — a transcript is what an agent
 * produced — and depending on Ollama would make the review something nobody can
 * run twice in a row. So the installation is built through the backend client
 * (`providers.create`, `agents.create`, `chats.create`), and the transcript is
 * written straight into `witena.db` while the app is closed, with `node:sqlite`.
 * That is a deliberate exception to "the renderer reaches the backend only
 * through `BackendClient`": there is no `messages.append` method and there should
 * not be one — nothing but a run may write a message — so a *review harness*
 * reaches around the app rather than the app growing a seam for it.
 *
 * The one thing that cannot be seeded either way is a pending permission prompt:
 * it is not a row, it is a suspended tool call. It is produced here by sending
 * the real `permission.requested` event down the real IPC channel from the main
 * process, which is exactly what `PermissionGate` does.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createUserDataDir, launchWitena, removeUserDataDir, repoRoot } from './helpers'

/** Where the review lands. Overridable so a reviewer can point a run anywhere. */
const SHOTS_DIR =
  process.env['WITENA_REVIEW_DIR'] ?? join(repoRoot, 'test-results', 'theme-review')

/** The artboard size, so these are comparable with S5.8's shots. */
const WINDOW_SIZE = { width: 1440, height: 900 }

/** The channel `src/preload/index.ts` relays backend events on. */
const IPC_EVENT = 'witena:event'

/** Seeding the transcript needs a longer budget than a click does. */
test.setTimeout(180_000)

let app: ElectronApplication
let window: Page
let userDataDir: string
let workdir: string
let chatId = ''
const agentIds: string[] = []

/** The preload bridge's envelope, restated here: `e2e/` may not import preload. */
type Envelope = { ok: true; value: unknown } | { ok: false; error: { message: string } }

/**
 * Calls a backend method from inside the page.
 *
 * `globalThis.witena`, not `window.witena`: this file's `window` is the
 * Playwright `Page`, and the name would shadow the browser global.
 */
async function invoke<T>(method: string, input?: unknown): Promise<T> {
  const envelope = (await window.evaluate(
    async (call) =>
      await (
        globalThis as unknown as {
          witena: { invoke(method: string, input?: unknown): Promise<unknown> }
        }
      ).witena.invoke(call.method, call.input),
    { method, input }
  )) as Envelope
  if (!envelope.ok) throw new Error(`${method} failed: ${envelope.error.message}`)
  return envelope.value as T
}

interface Identified {
  id: string
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                     */
/* -------------------------------------------------------------------------- */

/** A working directory with something in it, so the goal's materials validate. */
function createWorkdir(): string {
  const directory = join(userDataDir, 'workspace')
  mkdirSync(join(directory, 'docs'), { recursive: true })
  writeFileSync(join(directory, 'README.md'), '# Sample project\n\nA fixture.\n')
  writeFileSync(join(directory, 'docs', 'notes.md'), '- one\n- two\n')
  return directory
}

/**
 * Providers, agents, a chat and its members — everything that *is* a row the
 * app knows how to write.
 *
 * The three participants take palette slots 2, 4 and 7 and the executor takes 6,
 * so the message list shows four different tiles rather than four copies of the
 * default one. That is the whole point of the avatar half of S5.17, and a review
 * where every agent is slot 1 would show none of it.
 */
async function seedRecords(): Promise<void> {
  const ollama = await invoke<Identified>('providers.create', {
    input: {
      type: 'openai-compatible',
      name: 'Ollama',
      presetId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['qwen2.5:14b', 'llama3.2:3b']
    }
  })
  // A second provider with a key, so the provider list shows both the "ready"
  // and the "no key" states side by side.
  await invoke('providers.create', {
    input: {
      type: 'openai-compatible',
      name: 'DeepSeek',
      presetId: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat'],
      apiKey: 'sk-not-a-real-key-0000000000'
    }
  })

  const people: { name: string; description: string; palette: number; role: string }[] = [
    { name: 'Architect', description: 'Designs the shape of the change', palette: 2, role: 'participant' },
    { name: 'Reviewer', description: 'Looks for what will break', palette: 4, role: 'participant' },
    { name: '设计师', description: 'Speaks for the person using it', palette: 7, role: 'participant' },
    { name: 'Builder', description: 'Makes the change on disk', palette: 6, role: 'executor' }
  ]

  for (const person of people) {
    const agent = await invoke<Identified>('agents.create', {
      input: {
        name: person.name,
        avatar: {
          kind: 'initial',
          text: [...person.name][0]?.toUpperCase() ?? '?',
          palette: person.palette,
          // The compatibility shadow a real record carries; deliberately a
          // *legacy* hex, so the review also shows that a stored colour is not
          // what gets painted any more.
          color: '#3a3a3a'
        },
        description: person.description,
        systemPrompt: 'You are in a group chat.',
        providerId: ollama.id,
        modelId: 'qwen2.5:14b',
        params: {},
        skillNames: [],
        mcpServerIds: [],
        memoryEnabled: person.role === 'participant',
        role: person.role
      }
    })
    agentIds.push(agent.id)
  }

  // A fifth agent with **no** palette index and a legacy hex only: the upgrade
  // case. It should be indistinguishable from the others on screen.
  const legacy = await invoke<Identified>('agents.create', {
    input: {
      name: 'Historian',
      avatar: { kind: 'initial', text: 'H', color: '#2f4a47' },
      description: 'An agent written before the palette existed',
      systemPrompt: 'You are in a group chat.',
      providerId: ollama.id,
      modelId: 'llama3.2:3b',
      params: {},
      skillNames: [],
      mcpServerIds: [],
      memoryEnabled: false,
      role: 'participant'
    }
  })
  agentIds.push(legacy.id)

  const chat = await invoke<Identified>('chats.create', {
    input: {
      title: 'Ship the settings redesign',
      workdir,
      goal: {
        kind: 'document',
        description:
          'Agree on what the settings screen should look like and write the decision down.',
        deliverable: 'docs/decision.md',
        materials: ['README.md', 'docs/notes.md']
      },
      memberAgentIds: agentIds
    }
  })
  chatId = chat.id

  // A second chat, so the chat list has more than one row and a selected row to
  // compare an unselected one against.
  await invoke('chats.create', { input: { title: 'Scratch ideas' } })
}

/**
 * Every part kind the renderer draws, as one transcript.
 *
 * Written with `node:sqlite` while the app is closed. `seq` is the per-chat
 * ordering the repository would have assigned; `messages.list` reads by it, so
 * getting it wrong shows up immediately as a scrambled conversation.
 */
function seedTranscript(): void {
  const database = new DatabaseSync(join(userDataDir, 'witena.db'))
  const insert = database.prepare(
    `insert into messages
       (id, user_id, chat_id, seq, sender_type, sender_id, parts, status, round,
        mentions, in_reply_to, usage, error, created_at, updated_at)
     values (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  const [architect, reviewer, designer, builder, historian] = agentIds as [
    string,
    string,
    string,
    string,
    string
  ]
  const start = Date.now() - 45 * 60 * 1000
  let seq = 0

  const write = (
    senderType: 'user' | 'agent' | 'system',
    senderId: string,
    parts: unknown[],
    options: {
      status?: string
      round?: number
      mentions?: string[]
      inReplyTo?: string[]
      usage?: unknown
      error?: string
    } = {}
  ): void => {
    seq += 1
    const at = start + seq * 60_000
    insert.run(
      `seed-${seq}`,
      chatId,
      seq,
      senderType,
      senderId,
      JSON.stringify(parts),
      options.status ?? 'done',
      options.round ?? 0,
      JSON.stringify(options.mentions ?? []),
      options.inReplyTo ? JSON.stringify(options.inReplyTo) : null,
      options.usage ? JSON.stringify(options.usage) : null,
      options.error ?? null,
      at,
      at
    )
  }

  write('user', 'local', [
    {
      type: 'text',
      text: 'Here is what I want: a settings screen that explains itself. @Architect start us off.'
    }
  ], { mentions: [architect] })

  // Markdown with a table and a fenced block, which is the densest thing the
  // message body ever has to render.
  write(
    'agent',
    architect,
    [
      {
        type: 'text',
        text: [
          'Three sections, in this order:',
          '',
          '| Section | Holds | Why first |',
          '| --- | --- | --- |',
          '| Providers | keys, models | nothing works without one |',
          '| Appearance | theme, language | the first thing anyone changes |',
          '| Developer | probes | last, on purpose |',
          '',
          'The section list is a plain `<nav>`:',
          '',
          '```tsx',
          'export function SectionNav({ current }: { current: Section }) {',
          '  return (',
          '    <nav aria-label="Settings">',
          '      {SECTIONS.map((section) => (',
          '        <button key={section} aria-current={section === current}>',
          '          {t(`settings.sections.${section}`)}',
          '        </button>',
          '      ))}',
          '    </nav>',
          '  )',
          '}',
          '```',
          '',
          'Two rules I would not break: **one column of controls**, and no control',
          'without a hint under it. See [the plan](https://example.invalid/plan).'
        ].join('\n')
      }
    ],
    { round: 1, inReplyTo: ['user'], usage: { inputTokens: 1840, outputTokens: 412, totalTokens: 2252 } }
  )

  // Reasoning: the collapsed block S5.14 made opt-in.
  write(
    'agent',
    reviewer,
    [
      {
        type: 'reasoning',
        text: [
          'The table is fine but the order is a claim, not a fact. Providers first',
          'only matters on a fresh install; after that Appearance is what people',
          'open. I should say that rather than agreeing.'
        ].join(' ')
      },
      {
        type: 'text',
        text: 'Ordering by *first run* optimises for the day nobody comes back to. Put Appearance first after onboarding is dismissed.'
      }
    ],
    { round: 1, usage: { inputTokens: 2100, outputTokens: 96, totalTokens: 2196 } }
  )

  // A PASS: the deliberate abstention, drawn as a status label rather than a body.
  write('agent', designer, [{ type: 'text', text: '[PASS]' }], {
    status: 'passed',
    round: 1
  })

  // A tool call and its result — the ordinary, successful case.
  write(
    'agent',
    builder,
    [
      { type: 'text', text: 'Reading what is there before I touch anything.' },
      {
        type: 'tool-call',
        toolCallId: 'call-read',
        toolName: 'read_file',
        input: { path: 'docs/notes.md' }
      },
      {
        type: 'tool-result',
        toolCallId: 'call-read',
        output: '- one\n- two\n'
      },
      {
        type: 'file-ref',
        path: 'docs/notes.md',
        line: 2
      },
      {
        type: 'file-ref',
        path: 'README.md'
      }
    ],
    { round: 2, usage: { inputTokens: 3010, outputTokens: 188, totalTokens: 3198 } }
  )

  // A tool call that failed, which is the card nobody designs and everybody sees.
  write(
    'agent',
    builder,
    [
      {
        type: 'tool-call',
        toolCallId: 'call-grep',
        toolName: 'search_files',
        serverId: 'srv-1',
        serverName: 'filesystem',
        input: { pattern: 'SectionNav', path: 'src/' }
      },
      {
        type: 'tool-result',
        toolCallId: 'call-grep',
        isError: true,
        output: "ENOENT: no such file or directory, scandir '/workspace/src'"
      }
    ],
    { round: 2 }
  )

  // A diff, the executor's own part kind.
  write(
    'agent',
    builder,
    [
      { type: 'text', text: 'Written. One file, one heading, the table verbatim.' },
      {
        type: 'diff',
        path: 'docs/decision.md',
        patch: [
          '--- /dev/null',
          '+++ b/docs/decision.md',
          '@@ -0,0 +1,9 @@',
          '+# Settings, decided',
          '+',
          '+| Section | Holds |',
          '+| --- | --- |',
          '+| Providers | keys, models |',
          '+| Appearance | theme, language |',
          '+| Developer | probes |',
          '+',
          '+Appearance moves to the top once onboarding is dismissed.'
        ].join('\n')
      }
    ],
    { round: 3, usage: { inputTokens: 4200, outputTokens: 620, totalTokens: 4820 } }
  )

  // A turn that failed: the error status plus its operator-facing detail.
  write('agent', historian, [{ type: 'text', text: '' }], {
    status: 'error',
    round: 3,
    error: 'connect ECONNREFUSED 127.0.0.1:11434'
  })

  // The system notices, drawn as centred dimmed lines.
  write('system', 'system', [
    { type: 'system-notice', key: 'agentSkipped', params: { agent: 'Historian' } }
  ])
  write('system', 'system', [{ type: 'system-notice', key: 'consensus' }])
  write('system', 'system', [
    { type: 'system-notice', key: 'maxRoundsReached', params: { max: 3 } }
  ])

  // The closing message a consensus produces. On `main` today that is an
  // ordinary agent message following the `consensus` notice rather than a part
  // kind of its own; if a later step adds one, it belongs here.
  write(
    'agent',
    architect,
    [
      {
        type: 'text',
        text: [
          '## Conclusion',
          '',
          'Three sections, Appearance first after onboarding. Every control carries a',
          'hint. `docs/decision.md` is written and is the record.',
          '',
          '> Disagreement noted and dropped: Providers-first was the first-run view only.'
        ].join('\n')
      }
    ],
    { round: 3, usage: { inputTokens: 5100, outputTokens: 210, totalTokens: 5310 } }
  )

  database.close()
}

/* -------------------------------------------------------------------------- */
/* Screens                                                                     */
/* -------------------------------------------------------------------------- */

async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  await window.getByTestId('nav-settings').click()
  await window.getByTestId('settings-section-appearance').click()
  await window.getByTestId(`theme-${theme}`).click()
  await expect
    .poll(() =>
      window.evaluate(() =>
        (globalThis as unknown as { document: { documentElement: { getAttribute(n: string): string | null } } })
          .document.documentElement.getAttribute('data-theme')
      )
    )
    .toBe(theme)
}

/**
 * Long enough for a `transition-colors` (150ms) and a layout pass to finish.
 *
 * A screenshot is not a Playwright assertion and has nothing to wait *for*: the
 * only thing that makes a transition finish is time. Every use below is a place
 * the first pass produced a picture of a half-painted screen.
 */
async function settle(): Promise<void> {
  await window.waitForTimeout(350)
}

async function shoot(theme: string, name: string): Promise<void> {
  await window.screenshot({ path: join(SHOTS_DIR, `${theme}-${name}.png`) })
}

/** Opens the seeded chat and waits for its transcript to be on screen. */
async function openSeededChat(): Promise<void> {
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chat-item').filter({ hasText: 'Ship the settings' }).click()
  await expect(window.getByTestId('message-item').first()).toBeVisible()
}

/**
 * Pushes a real `permission.requested` down the real channel.
 *
 * `PermissionGate` is the only other sender, and it is unreachable without a
 * model that decides to call `write_file`. Sending the event from the main
 * process exercises the identical path — preload relay, `event-bridge`, the
 * store, the card — and leaves the card genuinely pending, because nothing will
 * ever answer it.
 */
async function raisePermissionPrompt(): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const [main] = BrowserWindow.getAllWindows()
      main?.webContents.send(payload.channel, payload.event)
    },
    {
      channel: IPC_EVENT,
      event: {
        type: 'permission.requested',
        requestId: 'review-1',
        chatId,
        agentId: agentIds[3],
        toolName: 'run_command',
        input: { command: 'npm run build', cwd: '.' }
      }
    }
  )
  await expect(window.getByTestId('permission-card')).toBeVisible()
}

/**
 * Closes it again, the only way a card ever closes: `permission.resolved`.
 *
 * Nothing is suspended behind this one, so nobody is waiting for the answer —
 * but leaving it open would put a permission card in every screenshot taken
 * after it, which is how the first pass ended up with one in the transcript
 * shot of the appearance that never raised it.
 */
async function resolvePermissionPrompt(): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const [main] = BrowserWindow.getAllWindows()
      main?.webContents.send(payload.channel, payload.event)
    },
    {
      channel: IPC_EVENT,
      event: {
        type: 'permission.resolved',
        requestId: 'review-1',
        chatId,
        decision: 'aborted'
      }
    }
  )
  await expect(window.getByTestId('permission-card')).toHaveCount(0)
}

/**
 * Every screen worth photographing, in one appearance.
 *
 * It starts by reloading the renderer. The first pass left a provider editor
 * open and a permission card pending, and the second pass then photographed
 * *that* — a screen the theme had nothing to do with. Reloading is cheaper and
 * more honest than teaching the walk to close everything it opened.
 */
async function walkEveryScreen(theme: string): Promise<void> {
  await window.reload()
  await expect(window.getByTestId('nav-chats')).toBeVisible()

  await openSeededChat()

  // The top of the transcript: the markdown table and the fenced code block,
  // which is the densest thing a message body ever has to render.
  await window.getByTestId('message-list').hover()
  await window.mouse.wheel(0, -6000)
  await settle()
  await shoot(theme, 'chat-transcript-start')

  // The reasoning block, opened, and the abstention under it — the one row the
  // app deliberately draws at reduced opacity, which is exactly the thing a
  // light theme is most likely to lose.
  const reasoning = window.getByTestId('message-reasoning-toggle').first()
  await reasoning.click()
  await window.locator('[data-status="passed"]').first().scrollIntoViewIfNeeded()
  await settle()
  await shoot(theme, 'chat-reasoning-and-passed')

  // The tool cards and the diff, expanded: collapsed they are one line each, and
  // their bodies are where the mono type and the +/- colours live.
  for (const toggle of await window.getByTestId('tool-card-toggle').all()) {
    await toggle.click().catch(() => {})
  }
  await window.getByTestId('diff-block-toggle').first().click()
  await window.getByTestId('diff-block').first().scrollIntoViewIfNeeded()
  await settle()
  await shoot(theme, 'chat-tools-and-diff-open')

  // The bottom: the failed turn, the notices and the closing message.
  await window.mouse.wheel(0, 6000)
  await settle()
  await shoot(theme, 'chat-transcript-end')

  await raisePermissionPrompt()
  await shoot(theme, 'chat-permission')
  await resolvePermissionPrompt()

  await window.getByTestId('composer-input').fill('@')
  await settle()
  await shoot(theme, 'chat-mention-popover')
  await window.getByTestId('composer-input').fill('')

  await window.getByTestId('nav-agents').click()
  await expect(window.getByTestId('page-agents')).toBeVisible()
  await shoot(theme, 'agents-list')

  await window.getByTestId('agent-item').first().click()
  await expect(window.getByTestId('agent-name')).toBeVisible()
  await shoot(theme, 'agents-editor')

  // The agent whose record has no palette index — the upgrade case, which has
  // to be indistinguishable from the four that do.
  await window.getByTestId('agent-item').filter({ hasText: 'Historian' }).click()
  await expect(window.getByTestId('agent-name')).toBeVisible()
  await shoot(theme, 'agents-editor-legacy-avatar')

  const sections = [
    'providers',
    'mcp',
    'skills',
    'timeouts',
    'appearance',
    'data',
    'about',
    'developer'
  ]
  await window.getByTestId('nav-settings').click()
  for (const section of sections) {
    await window.getByTestId(`settings-section-${section}`).click()
    await expect(window.getByTestId('settings-section-title')).toBeVisible()
    // `transition-colors` on the section list is 150ms, and the first pass
    // caught several shots mid-transition: the header said one section and the
    // highlight was still on the previous one, which reads as a bug in a review.
    await settle()
    await shoot(theme, `settings-${section}`)
  }

  // Providers: the editor, the preset grid (eight monogram tiles in one place)
  // and the sign-in panel, which is the only section with a third state.
  await window.getByTestId('settings-section-providers').click()
  await window.getByTestId('provider-card').first().click()
  await expect(window.getByTestId('provider-editor')).toBeVisible()
  await shoot(theme, 'settings-provider-editor')

  await window.getByTestId('settings-section-providers').click()
  await window.getByTestId('providers-add').click()
  await expect(window.getByTestId('preset-anthropic')).toBeVisible()
  await shoot(theme, 'settings-provider-presets')

  await window.getByTestId('preset-anthropic').click()
  await window.getByTestId('provider-auth-oauth').click()
  await expect(window.getByTestId('provider-sign-in')).toBeVisible()
  await shoot(theme, 'settings-provider-sign-in')

  // MCP: the connector gallery is what "Add server" opens (S5.1).
  await window.getByTestId('settings-section-mcp').click()
  await window.getByTestId('mcp-add').click()
  await expect(window.getByTestId('mcp-preset-everything')).toBeVisible()
  await shoot(theme, 'settings-mcp-gallery')

  await window.getByTestId('settings-section-appearance').click()
  await expect(window.getByTestId('settings-section-title')).toBeVisible()
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

test.beforeAll(async () => {
  rmSync(SHOTS_DIR, { recursive: true, force: true })
  mkdirSync(SHOTS_DIR, { recursive: true })

  userDataDir = createUserDataDir()
  workdir = createWorkdir()
  ;({ app, window } = await launchWitena(userDataDir))
  await app.evaluate(({ BrowserWindow }, size) => {
    const [main] = BrowserWindow.getAllWindows()
    main?.setContentSize(size.width, size.height)
  }, WINDOW_SIZE)

  // English, so the shots read for any reviewer whatever the machine's locale.
  await window.getByTestId('nav-settings').click()
  await window.getByTestId('lang-en').click()

  await seedRecords()

  // The transcript goes in with the app closed: SQLite is happy with a second
  // writer, but the renderer would not know the rows had appeared.
  await app.close()
  seedTranscript()
  ;({ app, window } = await launchWitena(userDataDir))
  await app.evaluate(({ BrowserWindow }, size) => {
    const [main] = BrowserWindow.getAllWindows()
    main?.setContentSize(size.width, size.height)
  }, WINDOW_SIZE)
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('the onboarding card, in both appearances', async () => {
  // It only exists on an installation that has dismissed nothing and has no
  // chats, so it gets its own pass on a second, empty `userData` directory.
  const freshDir = createUserDataDir()
  const fresh = await launchWitena(freshDir)
  try {
    await fresh.app.evaluate(({ BrowserWindow }, size) => {
      const windows = BrowserWindow.getAllWindows()
      windows[windows.length - 1]?.setContentSize(size.width, size.height)
    }, WINDOW_SIZE)
    await fresh.window.getByTestId('nav-settings').click()
    await fresh.window.getByTestId('lang-en').click()

    for (const theme of ['dark', 'light'] as const) {
      await fresh.window.getByTestId('nav-settings').click()
      await fresh.window.getByTestId('settings-section-appearance').click()
      await fresh.window.getByTestId(`theme-${theme}`).click()
      await fresh.window.getByTestId('nav-chats').click()
      await expect(fresh.window.getByTestId('onboarding')).toBeVisible()
      await fresh.window.screenshot({ path: join(SHOTS_DIR, `${theme}-onboarding.png`) })
    }
  } finally {
    await fresh.app.close()
    removeUserDataDir(freshDir)
  }
})

for (const theme of ['dark', 'light'] as const) {
  test(`every screen with content on it, ${theme}`, async () => {
    await setTheme(theme)
    await walkEveryScreen(theme)

    // The only assertion this file makes about a picture: that the screen it
    // photographed was the one it meant to.
    await expect(window.getByTestId('settings-section-title')).toBeVisible()
  })
}
