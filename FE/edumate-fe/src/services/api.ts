import axios from 'axios'

/**
 * Axios paths are like `/documents/comments` (no `/api` prefix).
 * Base must be exactly one `/api` — avoid `VITE_API_URL=http://host:3001/api` + `/api` in code → 404.
 */
export function getApiBaseUrl(): string {
  const v = import.meta.env.VITE_API_URL
  if (v == null || String(v).trim() === '') return '/api'
  let s = String(v).trim().replace(/\/+$/, '')
  if (!s) return '/api'
  if (s === '/api') return '/api'
  if (s.endsWith('/api')) return s
  if (/^https?:\/\//i.test(s)) return `${s}/api`
  return s.startsWith('/') ? (s === '' ? '/api' : `${s}/api`) : `/${s}/api`
}

const api = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 120000,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config) => {
  const url = String(config.url || '')
  const isPublicAuth =
    url.includes('/auth/login') ||
    url.includes('/auth/register') ||
    url.includes('/auth/verify-otp') ||
    url.includes('/auth/send-otp')

  if (!isPublicAuth) {
    const token = localStorage.getItem('edumate_token')
    if (token) config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (res) => res.data,
  (err) => Promise.reject(err)
)

/**
 * Read backend `message` from a failed axios call (4xx/5xx). Use in catch blocks so UI matches server errors.
 */
export function getApiErrorMessage(err: unknown): string {
  const e = err as {
    response?: { data?: unknown; status?: number }
    message?: string
  }
  const data = e?.response?.data

  if (data != null && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>
    if (typeof o.message === 'string' && o.message.trim()) return o.message.trim()
    if (typeof o.error === 'string' && o.error.trim()) return o.error.trim()
  }

  if (typeof data === 'string') {
    const t = data.trim()
    if (t.startsWith('{')) {
      try {
        const p = JSON.parse(t) as { message?: string }
        if (typeof p?.message === 'string' && p.message.trim()) return p.message.trim()
      } catch {
        // ignore
      }
    }
    if (t.length > 0) return t.length > 800 ? `${t.slice(0, 800)}…` : t
  }

  const st = e?.response?.status
  const net = String(e?.message || '').trim()
  if (net && !/^request failed with status code \d+$/i.test(net)) return net
  if (st != null) return `Request failed (HTTP ${st}).`
  return 'Request failed.'
}

export default api