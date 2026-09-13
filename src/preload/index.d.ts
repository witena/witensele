export interface WitenaApi {
  readonly appName: string
}

declare global {
  interface Window {
    witena: WitenaApi
  }
}

export {}
