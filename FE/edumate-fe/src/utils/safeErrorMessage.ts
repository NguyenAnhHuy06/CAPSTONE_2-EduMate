/**
 * User-facing error copy only — never forward stack traces, SQL, paths, or raw axios text.
 */

export const SAFE_ERROR = {
  generic: 'Đã xảy ra lỗi. Vui lòng thử lại.',
  network: 'Không thể kết nối máy chủ. Vui lòng kiểm tra mạng và thử lại.',
  timeout: 'Yêu cầu quá lâu. Vui lòng thử lại sau.',
  quizGenerate: 'Không thể tạo bài quiz. Vui lòng thử lại sau.',
  quizStart: 'Không thể mở bài quiz. Vui lòng thử lại.',
  attemptRecord: 'Không thể lưu kết quả làm bài. Vui lòng thử lại.',
  upload: 'Tải tài liệu thất bại. Vui lòng thử lại.',
  auth: 'Đăng nhập thất bại. Vui lòng kiểm tra thông tin và thử lại.',
} as const;

const TECHNICAL_PATTERNS: RegExp[] = [
  /at\s+[\w.$/<>]+\s*\(/i,
  /node_modules/i,
  /prisma/i,
  /sequelize/i,
  /\bSQL\b/i,
  /\bER_[A-Z0-9]+\b/i,
  /\bjwt\b/i,
  /jsonwebtoken/i,
  /stack\s*trace/i,
  /syntaxerror/i,
  /typeerror/i,
  /referenceerror/i,
  /\/uploads\//i,
  /\\\\|\/[a-z]:\\/i,
  /\bENOENT\b|\bEACCES\b|\bECONNREFUSED\b|\bECONNABORTED\b/i,
  /request failed with status code/i,
  /\baxios\b/i,
  /unknown column/i,
  /duplicate entry/i,
  /cannot find module/i,
  /getaddrinfo/i,
  /access denied for user/i,
  /<(!DOCTYPE|html|body)\b/i,
];

type AxiosLike = {
  code?: string;
  message?: string;
  response?: { status?: number; data?: unknown };
};

export function isTechnicalErrorMessage(message: string): boolean {
  const m = String(message || '').trim();
  if (!m) return true;
  if (m.length > 300) return true;
  return TECHNICAL_PATTERNS.some((re) => re.test(m));
}

/** Returns a safe user string, or null if the raw text must not be shown. */
export function sanitizeApiUserMessage(raw: string | undefined | null): string | null {
  const m = String(raw || '').trim();
  if (!m || isTechnicalErrorMessage(m)) return null;
  return m;
}

export function isTimeoutError(err: unknown): boolean {
  const ax = err as AxiosLike;
  if (ax?.code === 'ECONNABORTED') return true;
  const m = String(ax?.message || '').toLowerCase();
  return m.includes('timeout');
}

export function isNetworkError(err: unknown): boolean {
  const ax = err as AxiosLike;
  if (!ax?.response && ax?.message) {
    const m = String(ax.message).toLowerCase();
    if (m.includes('network') || m.includes('err_network')) return true;
  }
  return false;
}

export function safeNotificationMessage(
  err: unknown,
  kind: 'quizGenerate' | 'quizStart' | 'attemptRecord' | 'upload' | 'auth' | 'generic'
): string {
  if (isTimeoutError(err)) return SAFE_ERROR.timeout;
  if (isNetworkError(err)) return SAFE_ERROR.network;
  if (kind === 'quizGenerate') return SAFE_ERROR.quizGenerate;
  if (kind === 'quizStart') return SAFE_ERROR.quizStart;
  if (kind === 'attemptRecord') return SAFE_ERROR.attemptRecord;
  if (kind === 'upload') return SAFE_ERROR.upload;
  if (kind === 'auth') return SAFE_ERROR.auth;
  return SAFE_ERROR.generic;
}
