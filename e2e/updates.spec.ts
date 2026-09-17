/**
 * The S7.4 acceptance surface: Settings → About's Updates block, and the seam
 * that lets the updater be pointed somewhere other than GitHub.
 *
 * Two runs, because they need different builds of the same app:
 *
 * 1. **An ordinary launch** is a checkout — `app.isPackaged` is false — so the
 *    updater is absent and the block has to say so rather than offer a button
 *    that would do nothing. This is the "updater stubbed absent" case S7.4 asks
 *    for, and it needs no stub: a checkout *is* the absent case.
 * 2. **A launch with `WITENA_UPDATE_FEED`** pointed at a local static feed. This
 *    is the only part of the real path that can be exercised without a
 *    Developer ID: the gate is lifted, `electron-updater` is constructed, and it
 *    fetches `latest-mac.yml` over HTTP from a server this spec is holding — so
 *    the request arriving is proof the whole chain is wired, from
 *    `src/main/index.ts` through `src/main/ipc/updater.ts` to the library. What
 *    it cannot exercise is the swap: macOS replaces an app bundle only when the
 *    new signature matches the old one, and this run has neither.
 *
 * Assertions are on `data-state` and on disabled-ness rather than on sentences,
 * so the spec does not depend on which language the machine resolves to.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createUserDataDir, launchWitena, removeUserDataDir } from './helpers'

/** A version no build of Witena will ever have, so the feed always offers one. */
const OFFERED_VERSION = '99.0.0'

interface Feed {
  url: string
  /** Every path the updater asked for, in order. */
  paths: string[]
  /** Answers the pending `latest-mac.yml` request, and every later one. */
  release: () => void
  close: () => Promise<void>
}

/**
 * A generic `electron-updater` feed, served from memory.
 *
 * Two things about it are deliberate. It **holds** the `latest-mac.yml` request
 * until the test says so, because the launch check starts before the renderer
 * has mounted and a race between the two would make the assertion below a coin
 * toss; and the zip it names is answered with **404**, because what can be
 * proven without a Developer ID ends at the download — macOS replaces an app
 * bundle only when the new signature matches the running one, so producing a
 * real 150 MB zip would buy one more failed step rather than a passing one.
 */
function startFeed(): Promise<Feed> {
  const paths: string[] = []
  const yml = [
    `version: ${OFFERED_VERSION}`,
    'files:',
    `  - url: Witena-${OFFERED_VERSION}-arm64-mac.zip`,
    '    sha512: ' + 'A'.repeat(88),
    '    size: 1024',
    `path: Witena-${OFFERED_VERSION}-arm64-mac.zip`,
    'sha512: ' + 'A'.repeat(88),
    `releaseDate: '2026-09-17T00:00:00.000Z'`,
    ''
  ].join('\n')

  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })

  const server: Server = createServer((request, response) => {
    const path = request.url ?? ''
    paths.push(path)
    // The updater appends `?noCache=…`, so the query string has to be ignored.
    if (path.split('?')[0]?.endsWith('latest-mac.yml')) {
      void held.then(() => {
        response.writeHead(200, { 'content-type': 'text/yaml' })
        response.end(yml)
      })
      return
    }
    response.writeHead(404)
    response.end()
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}/`,
        paths,
        release: () => {
          release()
        },
        close: () =>
          new Promise<void>((done) => {
            release()
            server.close(() => done())
          })
      })
    })
  })
}

async function openAbout(window: Page): Promise<void> {
  await window.getByTestId('nav-settings').click()
  await window.getByTestId('settings-section-about').click()
  await expect(window.getByTestId('about-update-state')).toBeVisible()
}

test.describe('a build that cannot update itself', () => {
  let app: ElectronApplication
  let window: Page
  let userDataDir: string

  test.beforeAll(async () => {
    userDataDir = createUserDataDir()
    ;({ app, window } = await launchWitena(userDataDir))
  })

  test.afterAll(async () => {
    await app?.close()
    if (userDataDir) removeUserDataDir(userDataDir)
  })

  test('Settings → About says why, and does not offer a check', async () => {
    await openAbout(window)

    const state = window.getByTestId('about-update-state')
    await expect(state).toHaveAttribute('data-state', 'unsupported')
    // A checkout, not an unsigned bundle — the honest half of the pair.
    const sentence = (await state.textContent()) ?? ''
    expect(sentence.length).toBeGreaterThan(10)
    // A raw key on screen is the failure `lib/updates.ts` exists to prevent.
    expect(sentence.startsWith('settings.')).toBe(false)

    await expect(window.getByTestId('about-update-check')).toBeDisabled()
    await expect(window.getByTestId('about-update-restart')).toHaveCount(0)
  })

  test('the notice bar stays away while there is nothing to install', async () => {
    await expect(window.getByTestId('update-bar')).toHaveCount(0)
  })
})

test.describe('WITENA_UPDATE_FEED', () => {
  let app: ElectronApplication
  let window: Page
  let userDataDir: string
  let feed: Awaited<ReturnType<typeof startFeed>>

  test.beforeAll(async () => {
    feed = await startFeed()
    userDataDir = createUserDataDir()
    ;({ app, window } = await launchWitena(userDataDir, { WITENA_UPDATE_FEED: feed.url }))
  })

  test.afterAll(async () => {
    await app?.close()
    if (userDataDir) removeUserDataDir(userDataDir)
    await feed?.close()
  })

  test('reads the feed and tells the window which version it found', async () => {
    // The launch check runs on its own; the request arriving is what proves the
    // library is wired rather than merely constructed.
    await expect
      .poll(() => feed.paths.filter((path) => path.includes('latest-mac.yml')).length, {
        timeout: 20_000
      })
      .toBeGreaterThan(0)

    // The gate is lifted: a checkout would be saying "unsupported" here.
    await openAbout(window)
    const state = window.getByTestId('about-update-state')
    await expect(state).not.toHaveAttribute('data-state', 'unsupported')

    // Only now is the feed answered, so the `update.available` it produces
    // cannot have arrived before this screen existed.
    feed.release()

    await expect(state).toHaveAttribute('data-state', 'available')
    // The version travelled feed -> electron-updater -> UpdateService ->
    // `update.available` -> the store -> this sentence.
    await expect(state).toContainText(OFFERED_VERSION)

    // The download that follows is a 404 from the same server, and the backend
    // records it as `error`. The screen keeps what it was told, because there is
    // no error event and nothing has asked again — and nothing was ever
    // downloaded, so no bar appears.
    await expect(window.getByTestId('update-bar')).toHaveCount(0)
    await expect(window.getByTestId('about-update-restart')).toHaveCount(0)
  })
})
