import { contextBridge } from 'electron'
import { APP_NAME } from '@shared/version'

// S0.1 only exposes a placeholder object. S1.3 will attach the typed
// `invoke` / `subscribe` channels used by the renderer's BackendClient.
const witena = {
  appName: APP_NAME
} as const

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('witena', witena)
} else {
  // Fallback for a non-isolated context; not reachable with the current config.
  ;(globalThis as unknown as { witena: typeof witena }).witena = witena
}

export type WitenaApi = typeof witena
