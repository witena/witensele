// Electron entry point.
// Only this file and `src/main/ipc/` may import electron. All other main process
// business logic must stay Electron-free so it can be lifted into a Node server
// later on (CLAUDE.md rule #5).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { APP_NAME } from '@shared/version'
import { createAppContext, skillsDir, type AppContext } from './app-context'
import { buildHandlers } from './handlers'
import { createElectronSecretStore } from './ipc/secret-store'
import { forwardEvents, registerIpc } from './ipc/register'
import { seedSkills } from './skills/loader'

const isDev = !app.isPackaged

/** File name of the SQLite database inside the userData directory. */
const DATABASE_FILE = 'witena.db'

/** Folder of the skills shipped with the application, inside `resources/`. */
const BUNDLED_SKILLS = 'skills'

/**
 * Where the skills bundled with the build live.
 *
 * Two answers, because electron moves them: in development and in the
 * end-to-end harness the app runs from the repository, so they are under
 * `resources/`; a packaged build copies that folder into
 * `process.resourcesPath`. Resolved here rather than in the loader, because this
 * file is the only one allowed to ask electron where anything is.
 */
function bundledSkillsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, BUNDLED_SKILLS)
    : join(app.getAppPath(), 'resources', BUNDLED_SKILLS)
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

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: APP_NAME,
    backgroundColor: '#171614',
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

app.setName(APP_NAME)
applyUserDataOverride()

void app.whenReady().then(() => {
  const secrets = createElectronSecretStore()
  const userDataDir = app.getPath('userData')
  const databasePath = join(userDataDir, DATABASE_FILE)
  context = createAppContext({ databasePath, userDataDir, secrets })
  console.log(`[witena] database: ${databasePath}`)

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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
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
