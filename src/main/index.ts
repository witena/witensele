// Electron entry point.
// Only this file and `src/main/ipc/` may import electron. All other main process
// business logic must stay Electron-free so it can be lifted into a Node server
// later on (CLAUDE.md rule #5).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { APP_NAME } from '@shared/version'
import { createAppContext, type AppContext } from './app-context'
import { buildHandlers } from './handlers'
import { createElectronSecretStore } from './ipc/secret-store'
import { forwardEvents, registerIpc } from './ipc/register'

const isDev = !app.isPackaged

/** File name of the SQLite database inside the userData directory. */
const DATABASE_FILE = 'witena.db'

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

  // Open external links in the system browser instead of a new Electron window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
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
  const databasePath = join(app.getPath('userData'), DATABASE_FILE)
  context = createAppContext({ databasePath, secrets })
  console.log(`[witena] database: ${databasePath}`)

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
