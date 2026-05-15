/// <reference types="vite/client" />

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_URL: string
    /** Backend URL for dev proxy (vite.config), default http://localhost:3001 */
    readonly VITE_PROXY_TARGET: string
    /** Vite dev server port */
    readonly VITE_DEV_PORT: string
    /**
     * When the BE uses JWT only, omit `?userId=` on GET lecturer-review / PATCH grade.
     * Set `true` for production API. Local mock usually needs userId → leave empty or `false`.
     */
    readonly VITE_QUIZ_GRADING_SKIP_USER_QUERY?: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

export {}
