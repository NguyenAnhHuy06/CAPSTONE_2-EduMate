import axios from 'axios'
import {
  SAFE_ERROR,
  isNetworkError,
  isTimeoutError,
  sanitizeApiUserMessage,
} from '@/utils/safeErrorMessage'

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

export function getStoredAuthToken(): string | null {
  const candidates = ['edumate_token', 'accessToken', 'token']
  for (const key of candidates) {
    const value = localStorage.getItem(key)
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
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

  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    if (config.headers) {
      delete (config.headers as Record<string, unknown>)['Content-Type']
      delete (config.headers as Record<string, unknown>)['content-type']
    }
  }

  if (!isPublicAuth) {
    const token = getStoredAuthToken()
    if (token) config.headers.Authorization = `Bearer ${token}`
  }

  return config
})

function showCustomModal(message: string, callback?: () => void) {
  if (typeof document === 'undefined') return
  const overlay = document.createElement('div')
  overlay.style.position = 'fixed'
  overlay.style.inset = '0'
  overlay.style.backgroundColor = 'rgba(0,0,0,0.5)'
  overlay.style.display = 'flex'
  overlay.style.alignItems = 'center'
  overlay.style.justifyContent = 'center'
  overlay.style.zIndex = '99999'

  const modal = document.createElement('div')
  modal.style.backgroundColor = 'white'
  modal.style.padding = '24px'
  modal.style.borderRadius = '12px'
  modal.style.maxWidth = '400px'
  modal.style.width = '100%'
  modal.style.boxShadow =
    '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)'
  modal.style.margin = '0 16px'

  const title = document.createElement('h3')
  title.innerText = 'EduMate Notification'
  title.style.fontSize = '18px'
  title.style.fontWeight = 'bold'
  title.style.marginBottom = '12px'
  title.style.color = '#111827'
  title.style.fontFamily = 'sans-serif'

  const text = document.createElement('p')
  text.innerText = sanitizeApiUserMessage(message) || SAFE_ERROR.generic
  text.style.color = '#4b5563'
  text.style.marginBottom = '24px'
  text.style.fontSize = '14px'
  text.style.fontFamily = 'sans-serif'

  const btn = document.createElement('button')
  btn.innerText = 'OK'
  btn.style.backgroundColor = '#2563eb'
  btn.style.color = 'white'
  btn.style.padding = '10px 16px'
  btn.style.borderRadius = '6px'
  btn.style.fontSize = '14px'
  btn.style.fontWeight = '500'
  btn.style.border = 'none'
  btn.style.cursor = 'pointer'
  btn.style.width = '100%'
  btn.style.fontFamily = 'sans-serif'

  btn.onclick = () => {
    document.body.removeChild(overlay)
    if (callback) callback()
  }

  modal.appendChild(title)
  modal.appendChild(text)
  modal.appendChild(btn)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
}

api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
      showCustomModal(
        'Phiên đăng nhập đã hết hạn hoặc tài khoản bị vô hiệu hóa. Đang chuyển về trang đăng nhập.',
        () => {
          const candidates = ['edumate_token', 'accessToken', 'token']
          candidates.forEach((key) => localStorage.removeItem(key))
          window.location.href = '/login'
        }
      )
    }
    return Promise.reject(err)
  }
)

function extractRawApiMessage(data: unknown): string {
  if (data == null) return ''
  if (typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>
    if (typeof o.message === 'string' && o.message.trim()) return o.message.trim()
    if (typeof o.error === 'string' && o.error.trim()) return o.error.trim()
    return ''
  }
  if (typeof data === 'string') {
    const t = data.trim()
    if (t.startsWith('{')) {
      try {
        const p = JSON.parse(t) as { message?: string; error?: string }
        if (typeof p?.message === 'string' && p.message.trim()) return p.message.trim()
        if (typeof p?.error === 'string' && p.error.trim()) return p.error.trim()
      } catch {
        // ignore
      }
    }
    return t
  }
  return ''
}

/**
 * Safe message for toast/modal — never returns stack traces, SQL, paths, or axios internals.
 */
export function getApiErrorMessage(
  err: unknown,
  fallback: string = SAFE_ERROR.generic
): string {
  const e = err as { response?: { data?: unknown; status?: number }; message?: string }
  const fromBody = sanitizeApiUserMessage(extractRawApiMessage(e?.response?.data))
  if (fromBody) return fromBody

  if (isTimeoutError(err)) return SAFE_ERROR.timeout
  if (isNetworkError(err)) return SAFE_ERROR.network

  const status = e?.response?.status
  if (status === 401) return 'Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.'
  if (status === 403) return 'Bạn không có quyền thực hiện thao tác này.'
  if (status === 404) return 'Không tìm thấy dữ liệu yêu cầu.'
  if (status != null && status >= 500) return SAFE_ERROR.generic

  return fallback
}

export default api
