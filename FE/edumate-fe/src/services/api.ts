import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('edumate_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const requestUrl = String(err?.config?.url || '')
    const isAuthEndpoint =
      requestUrl.includes('/auth/login') ||
      requestUrl.includes('/auth/register') ||
      requestUrl.includes('/auth/verify-otp') ||
      requestUrl.includes('/auth/send-otp')
    if (err.response?.status === 401 && !isAuthEndpoint) {
      localStorage.removeItem('edumate_token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default api
