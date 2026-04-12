/// <reference types="vite/client" />

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_URL: string
    // add more custom VITE_ variables here e.g.
    // readonly VITE_SOME_KEY: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

export {}
