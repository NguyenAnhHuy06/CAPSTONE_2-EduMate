/**
 * User-facing error copy only — never forward API bodies, axios messages, or stack text.
 */
export const SAFE_ERROR = {
  generic: 'Something went wrong. Please try again later.',
  network: 'Could not reach the server. Check your connection and try again.',
  timeout: 'The request took too long. Please try again in a moment.',
  quizGenerate: 'The quiz could not be generated. Please try again later.',
  attemptRecord: 'Could not record your attempt. Please try again.',
} as const;

type AxiosLike = {
  code?: string;
  message?: string;
  response?: { status?: number };
};

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

/** Map technical failures to a short, safe string for notifications. */
export function safeNotificationMessage(
  err: unknown,
  kind: 'quizGenerate' | 'attemptRecord' | 'generic'
): string {
  if (isTimeoutError(err)) return SAFE_ERROR.timeout;
  if (isNetworkError(err)) return SAFE_ERROR.network;
  if (kind === 'quizGenerate') return SAFE_ERROR.quizGenerate;
  if (kind === 'attemptRecord') return SAFE_ERROR.attemptRecord;
  return SAFE_ERROR.generic;
}
