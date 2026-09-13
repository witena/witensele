// Electron entry point.
// Only this file (and later `src/main/ipc/`) may import electron. All other main
// process business logic must stay Electron-free so it can be lifted into a Node
// server later on.
import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { APP_NAME } from '@shared/version'
import { openDatabase, type DatabaseHandle } from './db/database'

const isDev = !app.isPackaged

/** File name of the SQLite database inside the userData directory. */
const DATABASE_FILE = 'witena.db'

/**
 * The one database handle for the process. This file is the only place allowed to
 * ask electron where it lives (CLAUDE.md rule #5); everything under `src/main/db/`
 * receives the path or the handle by injection.
 */
let database: DatabaseHandle | null = null

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

void app.whenReady().then(() => {
  app.setName(APP_NAME)

  const databasePath = join(app.getPath('userData'), DATABASE_FILE)
  database = openDatabase(databasePath)
  console.log(`[witena] database: ${databasePath}`)

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
  database?.close()
  database = null
})
