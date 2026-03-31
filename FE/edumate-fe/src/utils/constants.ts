export const APP_NAME = 'EduMate'

export const ROLES = {
  STUDENT: 'student',
  LECTURER: 'lecturer',
  ADMIN: 'admin',
}

export const ENDPOINTS = {
  AUTH: { LOGIN: '/auth/login', REGISTER: '/auth/register', VERIFY_OTP: '/auth/verify-otp' },
  DOCUMENTS: { LIST: '/documents', UPLOAD: '/documents/upload', DOWNLOAD: '/documents/download', SEARCH: '/documents/search' },
  AI: { CHAT: '/ai/chat', QUIZ: '/ai/quiz/generate', FLASHCARD: '/ai/flashcard/generate' },
  USER: { PROFILE: '/user/profile', QUIZ_HISTORY: '/user/quiz-history' },
}
