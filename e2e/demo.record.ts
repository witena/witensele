/**
 * The recording that produces `docs/assets/demo.gif` — a scripted tour of the
 * built app, driven at human speed and filmed.
 *
 * ## What this file is, and what it is not
 *
 * It is **not a test**. It asserts only enough to know a step landed before the
 * next one starts, because a tour that clicked into an element that was not
 * there yet would film a blank panel. Nothing here guards a behaviour; the specs
 * beside it do that. `playwright.config.ts` therefore ignores the file and
 * `npm run demo` runs it through `playwright.demo.config.ts`.
 *
 * ## Why the pacing is explicit
 *
 * Playwright clicks faster than anyone can read. Every step is followed by a
 * `beat()` of 600–1200 ms and every prompt is typed with `delay: 25`, so the
 * recording shows a person using the app rather than a machine flickering
 * through it. That is the whole reason the file exists instead of a
 * `--video=on` flag on an existing spec.
 *
 * ## Language
 *
 * The first thing the tour does is switch the UI to **English**: the GIF goes in
 * the repository README, and everything committed to this repository is in
 * English (CLAUDE.md rule #1) — including the prompts the tour types, which end
 * up rendered in the picture.
 *
 * ## How it is filmed
 *
 * Not with Playwright's `recordVideo`: under Electron 44 a context launched with
 * it never loads the renderer (the window's URL stays empty), so the tour films
 * itself over the DevTools protocol instead. `Page.startScreencast` delivers a
 * JPEG each time the picture changes, stamped with the compositor's clock; the
 * frames and their timestamps are written out and `scripts/render-demo.mjs`
 * turns them into the MP4 and the GIFs. `mark()` brackets the sections the
 * README shows as separate clips.
 *
 * ## Output
 *
 * | Path | What it is |
 * |---|---|
 * | `test-results/demo/frames/*.jpg` | The raw frames, one per change of the picture |
 * | `test-results/demo/recording.json` | Every frame's timestamp and the `mark()`ed sections; `scripts/render-demo.mjs` reads it |
 * | `test-results/demo/chat.png` | Screenshot: the multi-agent discussion |
 * | `test-results/demo/agents.png` | Screenshot: the agent configuration page |
 * | `test-results/demo/settings.png` | Screenshot: Settings → Providers |
 * | `test-results/demo/demo-poster.png` | Screenshot: the still the README's GIF is posed on |
 *
 * The tour needs a local Ollama holding `qwen2.5:3b` and `llama3.2:3b`. Without
 * them it fails rather than skipping: an empty recording is worse than no
 * recording.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  createChat,
  createUserDataDir,
  launchWitena,
  removeUserDataDir,
  repoRoot
} from './helpers'

/** Where the frames, `recording.json` and the four PNGs land. */
const OUT_DIR = process.env['WITENA_DEMO_DIR'] ?? join(repoRoot, 'test-results', 'demo')

/** The mockup's artboard size; the frames and the screenshots both use it. */
const SIZE = { width: 1440, height: 900 }

const ARCHITECT_MODEL = 'llama3.2:3b'
const REVIEWER_MODEL = 'qwen2.5:3b'

const OLLAMA_BASE_URL = 'http://localhost:11434/v1'

/** The skill shipped in `resources/skills/`, seeded into an empty library. */
const SKILL_NAME = 'architecture-review'

/** Two 3B models, each answering twice: the budget has to cover all of it. */
const REPLY_MS = 120_000

/** The MCP probe's own cap; the section is dropped rather than allowed to stall. */
const MCP_MS = 60_000

/** Typing speed, in milliseconds per character. */
const TYPE_DELAY = 25

let window: Page

/** One filmed frame: its file under `frames/` and the compositor's clock, in seconds. */
interface Frame {
  file: string
  time: number
}

/** A named stretch of the tour, in the same clock as the frames. */
interface Section {
  name: string
  start: number
  end: number
}

const frames: Frame[] = []
const sections: Section[] = []

/** The clock of the newest frame, which is "now" as far as the film is concerned. */
function filmClock(): number {
  return frames.at(-1)?.time ?? 0
}

/** Runs one section of the tour and records where it starts and ends in the film. */
async function mark(name: string, run: () => Promise<void>): Promise<void> {
  const start = filmClock()
  await run()
  sections.push({ name, start, end: filmClock() })
}

/** One human-sized pause between two actions. */
async function beat(ms = 800): Promise<void> {
  await window.waitForTimeout(ms)
}

/** Types into a field the way a person does, one character at a time. */
async function type(testId: string, text: string): Promise<void> {
  await window.getByTestId(testId).click()
  await window.getByTestId(testId).pressSequentially(text, { delay: TYPE_DELAY })
}

/** Loads a model's weights, so the tour does not film a cold start. */
async function warmUp(model: string): Promise<void> {
  try {
    await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1
      }),
      signal: AbortSignal.timeout(180_000)
    })
  } catch {
    // A failed warm-up only costs the recording a slow first reply.
  }
}

const agentMessages = (): ReturnType<Page['locator']> =>
  window.locator('[data-testid="message-item"][data-sender="agent"]')
const streaming = (): ReturnType<Page['locator']> =>
  window.locator('[data-testid="message-item"][data-status="streaming"]')

/** Sends the composer's contents and waits for the whole run to finish. */
async function sendAndWait(text: string): Promise<void> {
  await type('composer-input', text)
  await beat(900)
  await window.getByTestId('composer-input').press('Enter')
  await expect(window.getByTestId('composer-send')).toBeVisible({
    timeout: REPLY_MS
  })
  await expect(streaming()).toHaveCount(0, { timeout: REPLY_MS })
  await beat(1_200)
}

test('records the product tour', async () => {
  test.setTimeout(900_000)

  await warmUp(ARCHITECT_MODEL)
  await warmUp(REVIEWER_MODEL)

  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  const userDataDir = createUserDataDir()

  const launched = await launchWitena(userDataDir)
  const app = launched.app
  window = launched.window
  await app.evaluate(({ BrowserWindow }, size) => {
    const [main] = BrowserWindow.getAllWindows()
    main?.setContentSize(size.width, size.height)
  }, SIZE)

  const framesDir = join(OUT_DIR, 'frames')
  mkdirSync(framesDir, { recursive: true })
  const cdp = await window.context().newCDPSession(window)
  cdp.on('Page.screencastFrame', (frame) => {
    const file = `${String(frames.length).padStart(5, '0')}.jpg`
    writeFileSync(join(framesDir, file), Buffer.from(frame.data, 'base64'))
    frames.push({ file, time: frame.metadata.timestamp ?? filmClock() })
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 92,
    everyNthFrame: 2
  })

  const shot = async (name: string): Promise<void> => {
    await window.screenshot({ path: join(OUT_DIR, `${name}.png`) })
  }

  try {
    // ---------------------------------------------------------------- language
    // English first: everything in the picture ends up in the README.
    await beat(1_500)
    await window.getByTestId('nav-settings').click()
    await beat()
    await window.getByTestId('lang-en').click()
    await beat(1_000)

    // --------------------------------------------------------------- providers
    await mark('providers', async () => {
      await window.getByTestId('settings-section-providers').click()
      await beat()
      await window.getByTestId('providers-add').click()
      await beat(1_000)
      await window.getByTestId('preset-ollama').click()
      await beat(1_000)

      for (const model of [REVIEWER_MODEL, ARCHITECT_MODEL]) {
        await window.getByTestId('provider-add-model').click()
        await type('provider-add-model-input', model)
        await window.getByTestId('provider-add-model-input').press('Enter')
        await beat(700)
      }

      await window.getByTestId('provider-test').click()
      await expect(window.getByTestId('provider-test-result')).toHaveAttribute('data-ok', 'true', {
        timeout: REPLY_MS
      })
      await beat(1_500)
      await shot('settings')
      await window.getByTestId('provider-save').click()
      await expect(window.getByTestId('provider-card')).toHaveCount(1)
      await beat(1_200)
    })

    // ------------------------------------------------------------------ agents
    await mark('agents', async () => {
      await window.getByTestId('nav-agents').click()
      await beat(900)

      await window.getByTestId('agents-new').click()
      await beat(700)
      await type('agent-name', 'Architect')
      await window.getByTestId('agent-provider').selectOption({ index: 1 })
      await window.getByTestId('agent-model').selectOption(ARCHITECT_MODEL)
      await beat(600)
      await type('agent-system-prompt', 'You propose a design and name its trade-offs. Be concise.')
      await beat(900)
      await window.getByTestId('agent-save').click()
      await expect(window.getByTestId('agent-item')).toHaveCount(1)
      await beat(1_000)

      await window.getByTestId('agents-new').click()
      await beat(700)
      await type('agent-name', 'Reviewer')
      await window.getByTestId('agent-provider').selectOption({ index: 1 })
      await window.getByTestId('agent-model').selectOption(REVIEWER_MODEL)
      await beat(600)
      await type(
        'agent-system-prompt',
        'You challenge proposals and point out risks. Be concise. Mention @Architect when you want a reply.'
      )
      await beat(900)

      // Memory on, and the shipped skill ticked: the two capability blocks the
      // agent form exists for.
      // `Toggle` is a `role="switch"` button, not a checkbox, so it is clicked
      // rather than checked; the wrapper span is what carries the test id.
      await window.getByTestId('agent-memory-toggle').getByRole('switch').click()
      await beat(800)
      const skillRow = window.locator(
        `[data-testid="agent-skill-item"][data-skill="${SKILL_NAME}"]`
      )
      await skillRow.getByTestId('agent-skill-checkbox').check()
      await beat(1_000)
      await shot('agents')
      await window.getByTestId('agent-save').click()
      await expect(window.getByTestId('agent-item')).toHaveCount(2)
      await beat(1_200)
    })

    // ------------------------------------------------------------------- chats
    await mark('discussion', async () => {
      await window.getByTestId('nav-chats').click()
      await beat(800)
      // Two clicks since S9.3 — open the New chat dialog, press Create with
      // nothing chosen — which is the same empty chat the "+" used to make.
      await createChat(window)
      await beat(900)

      for (const name of ['Architect', 'Reviewer']) {
        const before = await window.getByTestId('member-row').count()
        await window.getByTestId('member-add').click()
        await beat(700)
        await window
          .getByTestId('member-picker')
          .getByTestId('member-candidate')
          .filter({ hasText: name })
          .click()
        await expect(window.getByTestId('member-row')).toHaveCount(before + 1)
        await beat(700)
      }

      // Round-robin and sequential are already the defaults; only the round limit
      // is touched, so the tour shows the control without re-stating a default.
      await window.getByTestId('chat-max-rounds').selectOption('2')
      await beat(1_000)

      await sendAndWait(
        'We need to store chat history for a desktop app. SQLite or a JSON file? Give a short opinion.'
      )
      await expect(agentMessages()).not.toHaveCount(0)
      await shot('chat')
      await beat(1_200)
    })

    // ---------------------------------------------------------------- parallel
    await mark('parallel', async () => {
      // Same members, same question shape, different speaking mode: both stream at
      // once, which is the thing the dots are there to show.
      await window.getByTestId('chat-speaking-parallel').click()
      await beat(1_000)
      await sendAndWait(
        'One sentence each: what is the main risk of the option you did not choose?'
      )
      // The poster is taken here rather than after round 1: the README's still
      // should show the thing the product is for — several models disagreeing in
      // one transcript — and that is only true once both have answered twice.
      await shot('demo-poster')
    })

    // ------------------------------------------------------------- MCP servers
    await mark('mcp', async () => {
      // Capped: a first run downloads the package over the network, and a tour
      // that filmed a spinner for a minute would be cut out anyway.
      await window.getByTestId('nav-settings').click()
      await beat(800)
      await window.getByTestId('settings-section-mcp').click()
      await beat(800)
      await window.getByTestId('mcp-add').click()
      await beat(700)
      await type('mcp-name-input', 'everything')
      await beat(500)
      await type('mcp-command-input', 'npx')
      await beat(500)
      // `fill`, not `pressSequentially`: it reads as a paste, which is what anyone
      // actually does with an npx command. (It was once also a workaround — the
      // arguments box used to erase a typed Enter on the next render; that is
      // fixed, and `e2e/mcp.spec.ts` now types the newline for real.)
      await window.getByTestId('mcp-args-input').fill('-y\n@modelcontextprotocol/server-everything')
      await beat(900)
      await window.getByTestId('mcp-test').click()
      try {
        await expect(window.getByTestId('mcp-test-result')).toHaveAttribute('data-ok', 'true', {
          timeout: MCP_MS
        })
        // The result lands under the form's fold; a tour that did not scroll to
        // it would film the button spinning and then cut away.
        await window.getByTestId('mcp-test-result').scrollIntoViewIfNeeded()
        await beat(2_000)
      } catch {
        // Left unsaved and unfilmed further: the tour moves on rather than stall.
      }
    })

    // --------------------------------------------------------- actions: summary
    await mark('summary', async () => {
      await window.getByTestId('nav-chats').click()
      await beat(1_000)
      const before = await agentMessages().count()
      await window.getByTestId('action-summarize').click()
      await beat(900)
      await window
        .getByTestId('action-member-picker')
        .getByTestId('action-member')
        .filter({ hasText: 'Architect' })
        .click()
      // The run has to be seen starting before it can be seen finishing: the send
      // button is still showing in the instant after the click.
      await expect(agentMessages()).not.toHaveCount(before, { timeout: REPLY_MS })
      await expect(window.getByTestId('composer-send')).toBeVisible({
        timeout: REPLY_MS
      })
      await expect(streaming()).toHaveCount(0, { timeout: REPLY_MS })
      await beat(2_500)
    })

    await cdp.send('Page.stopScreencast')
  } finally {
    await app.close()
  }

  writeFileSync(join(OUT_DIR, 'recording.json'), JSON.stringify({ frames, sections }, null, 2))
  console.log(`[demo] ${frames.length} frames: ${join(OUT_DIR, 'recording.json')}`)
  removeUserDataDir(userDataDir)
})
