/**
 * The shared contract, in one import.
 *
 * Main, preload and renderer all reach these through the `@shared/*` alias.
 * Nothing in this directory may import electron, node built-ins or renderer code:
 * it is the layer that survives the move from Electron IPC to a real server.
 */
export * from './types'
export * from './events'
export * from './backend'
export * from './mentions'
export * from './presets'
export * from './version'
