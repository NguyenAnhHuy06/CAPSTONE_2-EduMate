/// <reference types="vite/client" />

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_URL: string
    /** Backend URL for dev proxy (vite.config), default http://localhost:3001 */
    readonly VITE_PROXY_TARGET: string
    /** Vite dev server port */
    readonly VITE_DEV_PORT: string
    /**
     * Khi BE chỉ dùng JWT, không cần `?userId=` trên GET lecturer-review / PATCH grade.
     * Đặt `true` khi nối API production. Mock local thường cần userId → để trống hoặc `false`.
     */
    readonly VITE_QUIZ_GRADING_SKIP_USER_QUERY?: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

export {}
