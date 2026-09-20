// Electron entry point.
// Only this file and `src/main/ipc/` may import electron. All other main process
// business logic must stay Electron-free so it can be lifted into a Node server
// later on (CLAUDE.md rule #5).
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { resolveTheme, WINDOW_BACKGROUND } from '@shared/theme'
import { DEFAULT_APP_SETTINGS, type ThemeSetting } from '@shared/types'
import { APP_NAME } from '@shared/version'
import { createAppContext, skillsDir, type AppContext } from './app-context'
import { buildHandlers } from './handlers'
import { createSafeStorageStore } from './ipc/secret-store'
import { forwardEvents, registerIpc } from './ipc/register'
import { createElectronUpdater, UPDATE_FEED_ENV } from './ipc/updater'
import { CHAT_URL_SCHEME, parseLaunchArgs } from './launch-args'
import { migrateProviderSecrets } from './providers/migrate-secrets'
import { createFileKeySecretStore, isSignedBuild, rewrapKeyFile, SECRETS_KEY_FILE } from './secrets'
import { seedSkills } from './skills/loader'

const isDev = !app.isPackaged

/** File name of the SQLite database inside the userData directory. */
const DATABASE_FILE = 'witena.db'

/** The repository folder holding everything shipped beside the code. */
const RESOURCES_DIR = 'resources'

/** Folder of the skills shipped with the application, inside `resources/`. */
const BUNDLED_SKILLS = 'skills'

/**
 * Where the skills bundled with the build live.
 *
 * Two answers, because electron moves them: in development and in the
 * end-to-end harness the app runs from the repository, so they are under
 * `<appPath>/resources/skills`; a packaged build copies the whole `resources`
 * folder into `Witena.app/Contents/Resources/resources` (the `extraResources`
 * entry in `electron-builder.yml`), which is `process.resourcesPath/resources`.
 *
 * The nested `resources/resources` looks redundant and is deliberate: keeping
 * the folder's own name means the packaged tree mirrors the repository, so the
 * relative path below `RESOURCES_DIR` is the same string in both builds and
 * anything added to `resources/` later ships without another config edit.
 *
 * Resolved here rather than in the loader, because this file is the only one
 * allowed to ask electron where anything is.
 */
function bundledSkillsDir(): string {
  const root = app.isPackaged
    ? join(process.resourcesPath, RESOURCES_DIR)
    : join(app.getAppPath(), RESOURCES_DIR)
  return join(root, BUNDLED_SKILLS)
}

/**
 * Where the `ant` shipped with the build lives.
 *
 * Packaged, `electron-builder.yml` copies this architecture's binary into
 * `Contents/Resources/bin`. In development and in the end-to-end harness it is
 * where `scripts/fetch-ant.mjs` left it, `vendor/ant/<arch>`; a checkout that
 * never fetched it has no such folder, which the CLI wrapper's search treats
 * like any other directory without an `ant` in it.
 */
function bundledAntDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin')
    : join(app.getAppPath(), 'vendor', 'ant', process.arch)
}

/**
 * Whether this bundle was signed with a Developer ID (S7.3).
 *
 * The answer is a field in the application's own `package.json`, written there
 * at packaging time by electron-builder's `extraMetadata`
 * (`-c.extraMetadata.witenaSignedBuild=true`, passed by `npm run dist:signed`
 * and by the release workflow when a certificate exists). S7.6 used an
 * environment variable and recorded that as a known gap: a variable exported in
 * the build shell is not in the environment of the app the user double-clicks
 * weeks later, so it was false exactly where it had to be true.
 *
 * `app.getAppPath()` is the asar in a packaged build and the repository root in
 * development and in the end-to-end harness — and the repository's own manifest
 * has no such field, so a checkout is correctly "not signed". Reading it lives
 * here because this file is the only one allowed to ask electron where anything
 * is (CLAUDE.md rule #5); `isSignedBuild` itself takes the parsed object and
 * stays a pure, Electron-free function.
 *
 * Any failure is "not signed". The consequence of guessing wrong in the other
 * direction is a key file wrapped by a Keychain item that is granted to an
 * identity nothing vouches for — which is the bug S7.6 exists to fix.
 */
function signedBuild(): boolean {
  try {
    const manifest = readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')
    return isSignedBuild(JSON.parse(manifest))
  } catch (cause) {
    console.warn(`[witena] could not read the bundle manifest, assuming unsigned: ${String(cause)}`)
    return false
  }
}

/**
 * Test hook: redirects the whole userData directory, database included.
 *
 * The Playwright harness in `e2e/` sets it to a fresh temporary directory so a
 * test run can never read, write or delete the developer's real database. It must
 * be applied before `whenReady`, because electron resolves `userData` lazily but
 * caches it on first use.
 */
const USER_DATA_ENV = 'WITENA_USER_DATA'

/**
 * Everything the backend needs, built once on ready. This file is the only place
 * allowed to ask electron where things live; the context receives the resolved
 * path and builds the Electron-free layer from it.
 */
let context: AppContext | null = null
let stopForwarding: (() => void) | null = null

function applyUserDataOverride(): void {
  const override = process.env[USER_DATA_ENV]
  if (!override) return
  // setPath requires an existing directory.
  mkdirSync(override, { recursive: true })
  app.setPath('userData', override)
  console.log(`[witena] userData overridden by ${USER_DATA_ENV}: ${override}`)
}

/**
 * True for the only two schemes the app will hand to the system browser.
 *
 * A malformed URL throws out of `new URL`, which is a "no" rather than an error:
 * the caller denies the navigation either way.
 */
function isExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The appearance the next window should open in (S5.8).
 *
 * Read from the settings row rather than assumed, because `backgroundColor` is
 * what the window paints **before the renderer exists**: getting it wrong is a
 * dark flash on a light theme, which is the one frame every launch shows and
 * nobody can style away afterwards. `'system'` is resolved here through
 * `nativeTheme.shouldUseDarkColors` — the main process's answer to the renderer's
 * `matchMedia` — using the same `resolveTheme` both sides share.
 *
 * Falls back to the default setting before the context exists, which only
 * happens if the database could not be opened; a dark first frame is then the
 * least of the problems.
 */
function currentThemeSetting(): ThemeSetting {
  return context?.repos.settings.get().theme ?? DEFAULT_APP_SETTINGS.theme
}

function createWindow(): BrowserWindow {
  const theme = resolveTheme(currentThemeSetting(), nativeTheme.shouldUseDarkColors)
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: APP_NAME,
    backgroundColor: WINDOW_BACKGROUND[theme],
    autoHideMenuBar: true,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // ESM preload scripts require the sandbox to be disabled.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  // Links in a message body carry `target="_blank"`, which in Electron would
  // otherwise open a second BrowserWindow with no chrome and full renderer
  // privileges. Every such request is denied; an http(s) one is handed to the
  // system browser first.
  //
  // The scheme check is the security half: a model can write any URL it likes
  // into a reply, and `shell.openExternal` on a `file:` or a custom scheme hands
  // whatever the OS has registered for it a path chosen by a language model.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return window
}

/**
 * Brings the window forward, creating it if this launch has none (S10.3).
 *
 * The single window is a deliberate simplification: `second-instance`, a deep
 * link and the Dock's `activate` all mean "show me the app", and the app has one
 * thing to show. `restore` before `show` because a minimized window is visible
 * to `getAllWindows` but not to the user.
 */
function showOrCreateWindow(): BrowserWindow {
  const existing = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
  if (!existing) return createWindow()
  if (existing.isMinimized()) existing.restore()
  existing.show()
  existing.focus()
  return existing
}

/**
 * A chat link that arrived before the backend existed (S10.3).
 *
 * macOS delivers `open-url` to a *cold* process as well as to a running one, and
 * for the cold case it can fire before `whenReady` — the handler has to be
 * registered before `ready` to receive it at all. There is no bus to emit on
 * yet, so the id waits here and the ready handler drains it.
 */
let pendingOpenChatId: string | null = null

/**
 * Asks the window to show a chat, from whichever direction the request came.
 *
 * Three subtleties, all of them about timing:
 *
 * - **Before the context exists**, the id is buffered rather than dropped. This
 *   is the cold-launch path, and it is the one that matters most: the app was
 *   not running when the user clicked the link.
 * - **The event is emitted after the window has loaded.** `forwardEvents` sends
 *   to the windows that exist at the moment of the emit, and a window created
 *   one line earlier has no renderer yet — the event would reach nobody. The
 *   renderer starts its subscription before the first render, so
 *   `did-finish-load` is late enough.
 * - **Nothing here checks that the chat exists.** The main process would have to
 *   reach past the handlers to find out, and the window can answer the question
 *   better anyway: it ignores an id it does not know, which is also the right
 *   answer for a chat that was deleted between the link being written and being
 *   clicked.
 */
function requestOpenChat(chatId: string): void {
  if (!context) {
    pendingOpenChatId = chatId
    return
  }

  const window = showOrCreateWindow()
  const deliver = (): void => {
    context?.events.emit({ type: 'ui.open-chat', chatId })
  }

  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', deliver)
  else deliver()
}

app.setName(APP_NAME)
applyUserDataOverride()

/** `--background` and a `witena://chat/<id>` argument; see `./launch-args.ts`. */
const launch = parseLaunchArgs(process.argv)

/**
 * One app per `userData` directory (S10.3).
 *
 * Asked immediately after the override, because WP-0a measured that the lock is
 * keyed by `userData`: two instances pointed at different directories both get
 * `true` and run side by side — which is what lets the Playwright specs launch
 * several apps at once — while a second instance on the same directory gets
 * `false`. That second instance **never reaches `ready`**; it parks until
 * something ends it, so `app.quit()` here is the thing that ends it, and nothing
 * below may be assumed to run in that process.
 *
 * It matters now because the app can be started by a machine rather than by a
 * person: the MCP shim launches it when a coding agent calls a tool, and a
 * second copy of Witena over the same SQLite file would mean two `ChatRunner`s
 * on one chat.
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

/**
 * Someone tried to start a second copy: they wanted the one that is running.
 *
 * The argument vector is the second process's, so a `witena://` link passed on a
 * command line arrives here rather than through `open-url`.
 */
app.on('second-instance', (_event, argv) => {
  const { openChatId } = parseLaunchArgs(argv)
  if (openChatId) requestOpenChat(openChatId)
  else showOrCreateWindow()
})

/**
 * The deep link, registered before `ready` because macOS delivers it that early.
 *
 * `preventDefault` is what tells Electron the URL has been dealt with. An
 * unparseable one is still "dealt with" — it is refused silently, because a link
 * the app does not understand is not a dialog the user asked for.
 */
app.on('open-url', (event, url) => {
  event.preventDefault()
  const { openChatId } = parseLaunchArgs(['', url])
  if (openChatId) requestOpenChat(openChatId)
})

void app.whenReady().then(() => {
  // Belt and braces: WP-0a measured that a second instance for the same
  // `userData` never gets here at all, and this costs one comparison to make
  // that a guarantee of this file rather than of a platform note.
  if (!hasSingleInstanceLock) return

  // Only a packaged build may claim the scheme. In development the "app" is the
  // electron binary in `node_modules`, and registering it would point every
  // `witena://` link on the machine at a checkout that moves, gets deleted, or
  // is a different branch by the time the link is clicked. `protocols` in
  // `electron-builder.yml` is the other half: LaunchServices reads the bundle's
  // Info.plist, and this call only claims a scheme the bundle already declares.
  if (app.isPackaged) app.setAsDefaultProtocolClient(CHAT_URL_SCHEME)

  const userDataDir = app.getPath('userData')
  const databasePath = join(userDataDir, DATABASE_FILE)

  // S7.6: provider keys are encrypted with a key held in `userData`, not with a
  // Keychain item the next unsigned rebuild would lose. `safeStorage` is still
  // constructed — it reads the rows written before S7.6, and on a signed build
  // (S7.3) it wraps the key file. This file is the only one allowed to know
  // where either of them lives.
  const legacySecrets = createSafeStorageStore()
  if (!legacySecrets) {
    console.warn('[witena] safeStorage reports no encryption backend on this machine')
  }

  const keyPath = join(userDataDir, SECRETS_KEY_FILE)
  const wrap = signedBuild()

  // S7.3: the first signed build takes a key file the unsigned ones left plain
  // and puts it under the Keychain. Same 32 bytes, different container, so every
  // stored ciphertext stays readable; a refusal keeps the plain file and says so
  // once rather than leaving a key nobody can read. Before the store, because
  // the store reads this file on first use.
  const rewrapped = rewrapKeyFile({
    keyPath,
    wrap,
    ...(legacySecrets ? { wrapper: legacySecrets } : {})
  })
  if (rewrapped === 'wrapped') {
    console.log('[witena] the secrets key file is now wrapped by the Keychain (signed build)')
  } else if (rewrapped === 'failed') {
    console.warn(
      '[witena] the secrets key file could not be wrapped by the Keychain; ' +
        'it stays readable as before and every stored key still works'
    )
  }

  const secrets = createFileKeySecretStore({
    keyPath,
    wrap,
    ...(legacySecrets ? { wrapper: legacySecrets } : {})
  })

  // S7.4: the updater is decided here, where `app.isPackaged` and the signed
  // flag are both readable, and injected as a port. Everything above it — the
  // status, the six-hour schedule, the events — is Electron-free
  // (`src/main/updates/`); this is the only line that knows the library exists.
  const updater = createElectronUpdater({
    packaged: app.isPackaged,
    signed: wrap,
    ...(process.env[UPDATE_FEED_ENV] ? { feedUrl: process.env[UPDATE_FEED_ENV] } : {})
  })

  context = createAppContext({
    databasePath,
    userDataDir,
    secrets,
    updates: updater,
    bundledAntDir: bundledAntDir()
  })
  console.log(`[witena] database: ${databasePath}`)
  if (updater.updater) {
    console.log('[witena] auto-update is on; checking now and every six hours')
  } else {
    console.log(`[witena] auto-update is off: ${updater.reason}`)
  }

  // Once per launch, and a no-op from the second one on: every key still stored
  // in the pre-S7.6 format is read with the store that wrote it and re-encrypted
  // with the file key. A row that cannot be read is left untouched and its id is
  // reported to the UI as `keyState: 'unreadable'`.
  const moved = migrateProviderSecrets(context, { legacy: legacySecrets })
  if (moved.migrated.length > 0) {
    console.log(`[witena] re-encrypted ${moved.migrated.length} provider key(s) with the file key`)
  }
  if (moved.unreadable.length > 0) {
    console.warn(
      `[witena] ${moved.unreadable.length} provider key(s) cannot be decrypted by this build; ` +
        'they were left untouched and have to be pasted again'
    )
  }

  // First launch only: an empty library is filled with the skills shipped with
  // the build, so a new installation has something real to look at under
  // Settings -> Skills. A user who deleted or edited one keeps their decision —
  // see `seedSkills`.
  const seeded = seedSkills(bundledSkillsDir(), skillsDir(context))
  if (seeded.length > 0) console.log(`[witena] seeded skills: ${seeded.join(', ')}`)

  // The transport is up before the first window exists, so a renderer that calls
  // `invoke` in its first effect can never race the registration.
  registerIpc(ipcMain, context, buildHandlers())
  stopForwarding = forwardEvents(context.events, () => BrowserWindow.getAllWindows())

  // The window chrome the renderer cannot paint — the traffic lights of
  // `titleBarStyle: 'hiddenInset'` and the native dialogs — follows the stored
  // setting from the first window on, not only after the user visits Settings.
  // `themeSource` takes `'system'` verbatim, so following the machine keeps
  // working with no listener of our own (see `src/main/ipc/theme.ts`).
  nativeTheme.themeSource = currentThemeSetting()

  // `--background` is the shim's launch (S10.3): the app comes up with its Dock
  // icon, its endpoint and no window, so a tool call from a coding agent never
  // takes over the screen. Clicking the Dock icon opens the window through the
  // `activate` handler below, which is the same path a user who closed the
  // window already takes — there is no second code path and no new UI.
  if (!launch.background) createWindow()

  // After the window, so the `update.available` a launch check can produce
  // reaches a renderer rather than an empty window list. The status is cached
  // either way — Settings → About asks for it on mount — but the notice bar
  // should not have to wait six hours for its first chance.
  context.updates.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // A link that was waiting for the backend, or one that came in on this
  // launch's own argument vector. Last, so the window it may create is built
  // after the transport is registered and the theme is set — and so a launch
  // that is *only* a deep link still gets its window, `--background` or not.
  const requested = pendingOpenChatId ?? launch.openChatId
  pendingOpenChatId = null
  if (requested) requestOpenChat(requested)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Close the database explicitly so WAL is checkpointed before the process exits.
app.on('before-quit', () => {
  stopForwarding?.()
  stopForwarding = null
  context?.close()
  context = null
})
