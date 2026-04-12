/// <reference types="vite/client" />

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_URL: string
    /** Backend URL for dev proxy (vite.config), default http://localhost:3001 */
    readonly VITE_PROXY_TARGET: string
    /** Vite dev server port */
    readonly VITE_DEV_PORT: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

export {}
