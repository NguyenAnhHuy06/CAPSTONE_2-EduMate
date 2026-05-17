export const EDUMATE_COMMENT_NAVIGATE_KEY = 'edumate_comment_navigate';

export type CommentNavigateTarget = {
  documentId?: number | null;
  s3Key?: string | null;
  commentId?: number | null;
};

export type DocumentCommentAction = {
  kind: 'document_comment';
  documentId?: number | null;
  commentId?: number | null;
  s3Key?: string | null;
};

export function parseDocumentCommentAction(raw: unknown): DocumentCommentAction | null {
  if (!raw) return null;
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o.kind !== 'document_comment') return null;
  return {
    kind: 'document_comment',
    documentId:
      o.documentId != null && Number.isFinite(Number(o.documentId))
        ? Number(o.documentId)
        : null,
    commentId:
      o.commentId != null && Number.isFinite(Number(o.commentId))
        ? Number(o.commentId)
        : null,
    s3Key: o.s3Key != null ? String(o.s3Key).trim() || null : null,
  };
}

export function storeCommentNavigateTarget(target: CommentNavigateTarget) {
  localStorage.setItem(EDUMATE_COMMENT_NAVIGATE_KEY, JSON.stringify(target));
  window.dispatchEvent(new Event('edumate:comment-navigate'));
}

export function readCommentNavigateTarget(): CommentNavigateTarget | null {
  try {
    const raw = localStorage.getItem(EDUMATE_COMMENT_NAVIGATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CommentNavigateTarget;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearCommentNavigateTarget() {
  localStorage.removeItem(EDUMATE_COMMENT_NAVIGATE_KEY);
}
