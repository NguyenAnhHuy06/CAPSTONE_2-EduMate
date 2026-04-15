import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Download,
  MessageSquare,
  Sparkles,
  Send,
  CheckCircle,
  ExternalLink,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { QuizCreator } from '../pages/QuizCreator';
import { FlashcardCreator } from '../pages/FlashcardCreator';
import { FlashcardViewer } from '../pages/student/FlashcardViewer';
import { AIChatPanel } from './AIChatPanel';
import api from '@/services/api';
import { useNotification } from './NotificationContext';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

interface DocumentDetailProps {
  document: any;
  userRole: 'instructor' | 'student';
  user: any;
  onBack: () => void;
  /** Instructor dashboard: run real AI quiz flow (e.g. Quiz Management). */
  onCreateQuizWithAi?: () => void;
  /** Alternative: parent handles navigation to quiz (optional). */
  onOpenQuiz?: (document: any) => void;
}

type DiscussionComment = {
  id: number;
  author: string;
  text: string;
  date: string;
  role: 'instructor' | 'student';
};

function isDirectS3ConsoleUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().includes('amazonaws.com');
  } catch {
    return false;
  }
}

function fileNameFromStorageKey(key: string, fallback: string): string {
  const seg = key.split('/').filter(Boolean).pop();
  return seg && seg.length ? seg : fallback;
}

function displayCourseName(courseCode: string | undefined, courseName: string | undefined): string {
  const code = String(courseCode || '').trim();
  const raw = String(courseName || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (code && (lower === code.toLowerCase() || lower === `course ${code}`.toLowerCase())) return '';
  return raw;
}

function triggerBrowserDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function DocumentDetail({
  document,
  userRole,
  user,
  onBack,
  onCreateQuizWithAi,
  onOpenQuiz,
}: DocumentDetailProps) {
  const { showNotification } = useNotification();
  const [showQuizCreator, setShowQuizCreator] = useState(false);
  const [showFlashcardCreator, setShowFlashcardCreator] = useState(false);
  const [showAIChat, setShowAIChat] = useState(false);
  const [descriptionLoading, setDescriptionLoading] = useState(false);
  const [displayDescription, setDisplayDescription] = useState('');
  const [comments, setComments] = useState<DiscussionComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsPosting, setCommentsPosting] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [downloadLoading, setDownloadLoading] = useState(false);

  const [docStatus, setDocStatus] = useState(document?.status || 'pending');
  const [isVerifying, setIsVerifying] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewRetry, setPreviewRetry] = useState(0);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfTotalPages, setPdfTotalPages] = useState(0);
  const [pdfRendering, setPdfRendering] = useState(false);
  const [pdfRenderError, setPdfRenderError] = useState('');
  const pdfCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const fileName = String(document?.s3Key || document?.storedFileName || document?.originalFileName || '');
  const fileExt = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() || '' : '';
  const isPdfPreview = fileExt === 'pdf';
  const isWordPreview = ['doc', 'docx', 'docm', 'dotx', 'dotm'].includes(fileExt);
  const canInlinePreview = isPdfPreview || isWordPreview;
  const trustedBadgeVisible =
    !!document.isLecturerUpload ||
    !!document.highCredibility ||
    (document.authorRole === 'instructor' && document.highCredibility !== false);

  const documentRefKey = useCallback(() => {
    const documentId = document?.documentId ?? document?.id;
    const s3Key = String(document?.s3Key || '').trim();
    const numericId =
      documentId != null && documentId !== '' && Number.isFinite(Number(documentId))
        ? Number(documentId)
        : null;
    return { documentId: numericId, s3Key };
  }, [document?.documentId, document?.id, document?.s3Key]);

  function commentQueryParams() {
    const { documentId, s3Key } = documentRefKey();
    if (documentId != null) return { documentId };
    if (s3Key) return { s3Key };
    return {};
  }

  function commentPostBody() {
    const { documentId, s3Key } = documentRefKey();
    if (documentId != null) return { documentId };
    if (s3Key) return { s3Key };
    return {};
  }

  const loadComments = useCallback(async () => {
    const { documentId, s3Key } = documentRefKey();
    if (documentId == null && !s3Key) {
      setComments([]);
      setCommentsLoading(false);
      return;
    }
    setCommentsLoading(true);
    try {
      const res: any = await api.get('/documents/comments', {
        params: commentQueryParams(),
      });
      const raw = Array.isArray(res?.data) ? res.data : [];
      const mapped: DiscussionComment[] = raw.map((c: any, idx: number) => ({
        id: Number(c?.id ?? idx),
        author: String(c?.author || 'User').trim(),
        text: String(c?.text || '').trim(),
        date: String(c?.date || '').trim(),
        role: c?.role === 'instructor' ? 'instructor' : 'student',
      }));
      setComments(mapped);
    } catch {
      setComments([]);
      showNotification({
        type: 'error',
        title: 'Discussion',
        message: 'Could not load comments. Please try again later.',
      });
    } finally {
      setCommentsLoading(false);
    }
  }, [documentRefKey, showNotification]);

  useEffect(() => {
    void loadComments();
  }, [loadComments]);

  useEffect(() => {
    const fromList = String(document?.uploadDescription || '').trim();
    if (fromList) {
      setDisplayDescription(fromList);
      return;
    }

    const documentId = document?.documentId ?? document?.id;
    const s3Key = String(document?.s3Key || '').trim();
    let cancelled = false;

    const loadDescription = async () => {
      if (!documentId && !s3Key) {
        setDisplayDescription('');
        return;
      }
      setDescriptionLoading(true);
      try {
        const did = document?.documentId ?? document?.id;
        const sk = String(document?.s3Key || '').trim();
        const num =
          did != null && did !== '' && Number.isFinite(Number(did)) ? Number(did) : null;
        const previewParams =
          num != null ? { documentId: num } : sk ? { s3Key: sk } : {};

        const res: any = await api.get('/documents/preview', {
          params: previewParams,
        });
        if (cancelled) return;
        const d = String(res?.data?.description || '').trim();
        setDisplayDescription(d);
      } catch {
        if (!cancelled) setDisplayDescription('');
      } finally {
        if (!cancelled) setDescriptionLoading(false);
      }
    };

    void loadDescription();
    return () => {
      cancelled = true;
    };
  }, [document?.documentId, document?.id, document?.s3Key, document?.uploadDescription]);

  useEffect(() => {
    let cancelled = false;

    const loadPreviewUrl = async () => {
      if (!canInlinePreview) {
        setPreviewUrl('');
        setPreviewError('');
        return;
      }
      const did = document?.documentId ?? document?.id;
      const sk = String(document?.s3Key || '').trim();
      const num =
        did != null && did !== '' && Number.isFinite(Number(did)) ? Number(did) : null;
      const params =
        num != null ? { documentId: num } : sk ? { s3Key: sk } : {};
      if (!Object.keys(params).length) {
        setPreviewUrl('');
        setPreviewError('Preview is not available for this file.');
        return;
      }

      setPreviewLoading(true);
      setPreviewError('');
      try {
        const res: any = await api.get('/documents/preview', { params });
        if (cancelled) return;
        const data = res?.data || {};
        const urlCandidates = [
          data?.url,
          data?.previewUrl,
          data?.previewFileUrl,
          data?.viewerUrl,
          data?.fileUrl,
          data?.sourceFileUrl,
        ];
        const url = String(urlCandidates.find((v) => typeof v === 'string' && String(v).trim()) || '').trim();
        if (!url) {
          setPreviewUrl('');
          setPreviewError('Could not load preview. Try downloading the file.');
          return;
        }
        setPreviewUrl(url);
      } catch {
        if (!cancelled) {
          setPreviewUrl('');
          setPreviewError('Could not load preview right now.');
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    };

    void loadPreviewUrl();
    return () => {
      cancelled = true;
    };
  }, [canInlinePreview, document?.documentId, document?.id, document?.s3Key, previewRetry]);

  useEffect(() => {
    let cancelled = false;

    const loadPdfDocument = async () => {
      if (!isPdfPreview || !previewUrl || previewLoading || !!previewError) {
        setPdfDoc(null);
        setPdfTotalPages(0);
        setPdfPage(1);
        return;
      }
      try {
        const task = pdfjsLib.getDocument(previewUrl);
        const doc = await task.promise;
        if (cancelled) return;
        setPdfDoc(doc);
        setPdfTotalPages(doc.numPages || 0);
        setPdfPage(1);
        setPdfRenderError('');
      } catch {
        if (!cancelled) {
          setPdfDoc(null);
          setPdfTotalPages(0);
          setPdfRenderError('Could not render this PDF in browser preview.');
        }
      }
    };

    void loadPdfDocument();
    return () => {
      cancelled = true;
    };
  }, [isPdfPreview, previewUrl, previewLoading, previewError]);

  useEffect(() => {
    let cancelled = false;

    const renderPdfPage = async () => {
      if (!isPdfPreview || !pdfDoc || !pdfCanvasRef.current) return;
      setPdfRendering(true);
      setPdfRenderError('');
      try {
        const page = await pdfDoc.getPage(pdfPage);
        if (cancelled || !pdfCanvasRef.current) return;
        const viewport = page.getViewport({ scale: 1.25 });
        const canvas = pdfCanvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context not available');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch {
        if (!cancelled) {
          setPdfRenderError('Could not render this PDF page.');
        }
      } finally {
        if (!cancelled) setPdfRendering(false);
      }
    };

    void renderPdfPage();
    return () => {
      cancelled = true;
    };
  }, [isPdfPreview, pdfDoc, pdfPage]);

  const handleOpenQuizFlow = () => {
    if (onCreateQuizWithAi) {
      onCreateQuizWithAi();
      return;
    }
    if (onOpenQuiz) {
      onOpenQuiz(document);
      return;
    }
    setShowQuizCreator(true);
  };

  const handleDownload = async () => {
    const token = localStorage.getItem('edumate_token');
    if (!token) {
      showNotification({
        type: 'warning',
        title: 'Sign in required',
        message: 'Please sign in to download this file.',
      });
      return;
    }

    let s3Key = String(document?.s3Key || '').trim();
    const rawDocId = document?.documentId ?? document?.id;
    const numId =
      rawDocId != null &&
      String(rawDocId).trim() !== '' &&
      Number.isFinite(Number(rawDocId))
        ? Number(rawDocId)
        : null;
    if (!s3Key && typeof rawDocId === 'string' && rawDocId.includes('/') && !rawDocId.startsWith('http')) {
      s3Key = rawDocId.trim();
    }

    const publicUrl = String(document?.fileUrl || '').trim();

    if (numId == null && !s3Key) {
      if (publicUrl && !isDirectS3ConsoleUrl(publicUrl)) {
        window.open(publicUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      showNotification({
        type: 'warning',
        title: 'Download',
        message: publicUrl
          ? 'This file is stored privately. Use a signed download from the server (ensure the document is linked in the library).'
          : 'No file link is available for this document yet.',
      });
      return;
    }

    setDownloadLoading(true);
    try {
      const params = numId != null ? { documentId: numId } : { s3Key };
      const suggestedName = fileNameFromStorageKey(
        s3Key,
        numId != null ? `document-${numId}` : 'document'
      );
      const blob = (await api.get('/documents/download-file', {
        params,
        responseType: 'blob',
        timeout: 180_000,
      })) as unknown as Blob;
      if (!(blob instanceof Blob) || blob.size === 0) {
        showNotification({
          type: 'error',
          title: 'Download',
          message: 'Empty or invalid file response. Please try again.',
        });
        return;
      }
      triggerBrowserDownload(blob, suggestedName);
    } catch {
      showNotification({
        type: 'error',
        title: 'Download',
        message: 'Could not download. Check your connection or try again later.',
      });
    } finally {
      setDownloadLoading(false);
    }
  };

  const handleAddComment = async () => {
    const text = newComment.trim();
    if (!text) return;
    const token = localStorage.getItem('edumate_token');
    if (!token) {
      showNotification({
        type: 'warning',
        title: 'Sign in required',
        message: 'Please sign in to post a comment.',
      });
      return;
    }
    const { documentId, s3Key } = documentRefKey();
    if (documentId == null && !s3Key) {
      showNotification({
        type: 'warning',
        title: 'Discussion',
        message: 'This document cannot be commented on yet.',
      });
      return;
    }
    setCommentsPosting(true);
    try {
      await api.post('/documents/comments', {
        text,
        ...commentPostBody(),
      });
      setNewComment('');
      await loadComments();
    } catch (err: any) {
      const msg = err?.response?.data?.message;
      showNotification({
        type: 'error',
        title: 'Could not post',
        message: typeof msg === 'string' && msg.trim() ? msg : 'Please try again.',
      });
    } finally {
      setCommentsPosting(false);
    }
  };

  const handleVerify = async () => {
    if (!document.documentId) {
      showNotification({
        type: 'warning',
        title: 'Verify',
        message: 'No document ID available for verification.',
      });
      return;
    }
    setIsVerifying(true);
    try {
      const res: any = await api.patch(`/documents/${document.documentId}/verify`);
      if (res?.success) {
        setDocStatus('verified');
        showNotification({
          type: 'success',
          title: 'Verified',
          message: 'Document verified successfully.',
        });
      } else {
        showNotification({
          type: 'error',
          title: 'Verify',
          message: String(res?.message || 'Could not verify.'),
        });
      }
    } catch (e: any) {
      showNotification({
        type: 'error',
        title: 'Verify',
        message: String(e?.message || 'Could not verify.'),
      });
    } finally {
      setIsVerifying(false);
    }
  };

  const handleReject = async () => {
    if (!document.documentId) {
      showNotification({
        type: 'warning',
        title: 'Reject',
        message: 'No document ID available.',
      });
      return;
    }
    setIsVerifying(true);
    try {
      const res: any = await api.patch(`/documents/${document.documentId}/reject`);
      if (res?.success) {
        setDocStatus('rejected');
        showNotification({ type: 'info', title: 'Rejected', message: 'Document rejected.' });
      } else {
        showNotification({
          type: 'error',
          title: 'Reject',
          message: String(res?.message || 'Could not reject.'),
        });
      }
    } catch (e: any) {
      showNotification({
        type: 'error',
        title: 'Reject',
        message: String(e?.message || 'Could not reject.'),
      });
    } finally {
      setIsVerifying(false);
    }
  };

  if (showQuizCreator) {
    return (
      <QuizCreator
        document={document}
        userRole={userRole}
        onBack={() => setShowQuizCreator(false)}
      />
    );
  }

  if (showFlashcardCreator) {
    if (userRole === 'student') {
      return (
        <FlashcardViewer document={document} onBack={() => setShowFlashcardCreator(false)} />
      );
    }
    return (
      <FlashcardCreator document={document} onBack={() => setShowFlashcardCreator(false)} />
    );
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-blue-600 hover:text-blue-700 mb-6"
      >
        <ArrowLeft size={20} />
        Back to Documents
      </button>

      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <h2>{document.title}</h2>
              {trustedBadgeVisible && (
                <span
                  className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-800 px-2 py-1 rounded text-xs font-medium"
                  title="Uploaded by course staff — marked as reliable"
                >
                  <CheckCircle size={14} aria-hidden />
                  Verified
                </span>
              )}
              {docStatus && !(docStatus === 'verified' && trustedBadgeVisible) && (
                <span
                  className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold ${
                    docStatus === 'verified'
                      ? 'bg-green-100 text-green-700'
                      : docStatus === 'rejected'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-yellow-100 text-yellow-700'
                  }`}
                >
                  {docStatus === 'verified'
                    ? 'Verified'
                    : docStatus === 'rejected'
                      ? 'Rejected'
                      : 'Pending verification'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-gray-600 mb-3 flex-wrap">
              <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded">
                {document.type === 'general'
                  ? 'General'
                  : document.type === 'general-major'
                    ? 'General Major'
                    : 'Specialized'}
              </span>
              {document.courseCode ? <span>{document.courseCode}</span> : null}
              {displayCourseName(document.courseCode, document.courseName) ? (
                <>
                  {document.courseCode ? <span className="text-gray-300">·</span> : null}
                  <span>{displayCourseName(document.courseCode, document.courseName)}</span>
                </>
              ) : null}
            </div>
            <p className="text-gray-700 mb-3">{document.description}</p>
            <div className="flex items-center gap-4 text-gray-500">
              <span>
                Uploaded by {document.author} ({document.authorRole})
              </span>
              <span>•</span>
              <span>{document.uploadDate}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 pt-4 border-t border-gray-100 items-center justify-between">
          <div className="flex flex-wrap gap-3">
            {(() => {
              const raw = document?.documentId ?? document?.id;
              const numericId =
                raw != null && String(raw).trim() !== '' && Number.isFinite(Number(raw))
                  ? Number(raw)
                  : null;
              const s3KeyStr = String(document?.s3Key || '').trim();
              const idAsKey =
                typeof raw === 'string' && raw.includes('/') && !raw.startsWith('http')
                  ? raw.trim()
                  : '';
              const publicUrl = String(document?.fileUrl || '').trim();
              const hasPresignable = numericId != null || !!s3KeyStr || !!idAsKey;
              const hasPublicCdn = !!publicUrl && !isDirectS3ConsoleUrl(publicUrl);
              const hasFile = hasPresignable || hasPublicCdn;
              if (!hasFile) {
                return (
                  <button
                    type="button"
                    disabled
                    className="flex items-center gap-2 px-4 py-2 bg-gray-200 text-gray-500 rounded-lg cursor-not-allowed"
                  >
                    <Download size={18} />
                    Download unavailable
                  </button>
                );
              }
              return (
                <button
                  type="button"
                  onClick={() => void handleDownload()}
                  disabled={downloadLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-70 disabled:cursor-wait"
                >
                  <Download size={18} />
                  {downloadLoading ? 'Preparing…' : 'Download'}
                </button>
              );
            })()}
            <button
              type="button"
              onClick={handleOpenQuizFlow}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors"
            >
              <Sparkles size={18} />
              Create Quiz with AI
            </button>
            <button
              type="button"
              onClick={() => setShowAIChat((v) => !v)}
              title="Chat about this document"
              className={`flex items-center gap-2 px-4 py-2 border rounded-lg transition-colors ${
                showAIChat
                  ? 'bg-blue-50 border-blue-600 text-blue-600'
                  : 'bg-white border-blue-600 text-blue-600 hover:bg-blue-50'
              }`}
            >
              <MessageSquare size={18} />
              {showAIChat ? 'Close Chat' : 'Chat with AI'}
            </button>
            {userRole === 'student' && (
              <button
                type="button"
                onClick={() => setShowFlashcardCreator(true)}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors"
              >
                <Sparkles size={18} />
                Create Flashcards with AI
              </button>
            )}
          </div>

          {userRole === 'instructor' && docStatus === 'pending' && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleVerify()}
                disabled={isVerifying}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                <CheckCircle size={16} />
                {isVerifying ? 'Processing…' : 'Verify'}
              </button>
              <button
                type="button"
                onClick={() => void handleReject()}
                disabled={isVerifying}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-red-200 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3>Document preview</h3>
          {previewUrl ? (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
            >
              <ExternalLink size={14} />
              Open in new tab
            </a>
          ) : null}
        </div>

        {!canInlinePreview ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
            <p className="text-gray-700">Preview is not supported for this file type.</p>
            <p className="text-gray-500 text-sm mt-1">Use Download to view the file.</p>
          </div>
        ) : previewLoading ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50 h-[560px] flex items-center justify-center">
            <div className="flex items-center gap-2 text-gray-600">
              <Loader2 size={18} className="animate-spin" />
              <span>Loading preview…</span>
            </div>
          </div>
        ) : previewError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-6">
            <div className="flex items-start gap-2 text-red-700">
              <AlertCircle size={18} className="mt-0.5" />
              <div>
                <p className="font-medium">Preview unavailable</p>
                <p className="text-sm mt-1">{previewError}</p>
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setPreviewRetry((x) => x + 1)}
                className="px-3 py-1.5 text-sm bg-white border border-red-300 text-red-700 rounded hover:bg-red-100"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => void handleDownload()}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Download instead
              </button>
            </div>
          </div>
        ) : previewUrl ? (
          <div className="rounded-lg border border-gray-200 overflow-hidden bg-gray-50 h-[560px]">
            {isWordPreview ? (
              <iframe
                src={previewUrl || undefined}
                title={`${document?.title || 'Document'} preview`}
                className="w-full h-full border-0"
                loading="lazy"
              />
            ) : (
              <div className="h-full flex flex-col">
                <div className="px-3 py-2 border-b border-gray-200 bg-white flex items-center justify-between text-sm">
                  <span className="text-gray-700">
                    PDF page {pdfTotalPages ? `${pdfPage} / ${pdfTotalPages}` : '—'}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPdfPage((p) => Math.max(1, p - 1))}
                      disabled={pdfRendering || pdfPage <= 1}
                      className="px-2 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50"
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      onClick={() => setPdfPage((p) => Math.min(pdfTotalPages || 1, p + 1))}
                      disabled={pdfRendering || pdfPage >= (pdfTotalPages || 1)}
                      className="px-2 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-auto p-3 flex items-start justify-center">
                  {pdfRenderError ? (
                    <div className="text-red-700 text-sm">{pdfRenderError}</div>
                  ) : (
                    <canvas ref={pdfCanvasRef} className="max-w-full h-auto bg-white shadow-sm" />
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-6">
            <div className="flex items-start gap-2 text-amber-800">
              <AlertCircle size={18} className="mt-0.5" />
              <div>
                <p className="font-medium">Preview is not ready</p>
                <p className="text-sm mt-1">
                  The server did not return a valid preview URL yet. Please retry or download the file.
                </p>
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setPreviewRetry((x) => x + 1)}
                className="px-3 py-1.5 text-sm bg-white border border-amber-300 text-amber-800 rounded hover:bg-amber-100"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => void handleDownload()}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Download instead
              </button>
            </div>
          </div>
        )}
      </div>

      {showAIChat && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 h-[730px] min-h-[400px]">
          <AIChatPanel
            documentId={document.documentId}
            s3Key={document.s3Key}
            onClose={() => setShowAIChat(false)}
          />
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <h3 className="mb-4">Description</h3>
        <div className="bg-gray-50 p-6 rounded-lg border border-gray-200 min-h-[120px]">
          {descriptionLoading ? (
            <p className="text-gray-600">Loading description…</p>
          ) : displayDescription ? (
            <p className="text-gray-700 whitespace-pre-wrap">{displayDescription}</p>
          ) : (
            <p className="text-gray-600">No description was provided for this document.</p>
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="mb-4 flex items-center gap-2">
          <MessageSquare size={24} />
          Discussion ({comments.length})
        </h3>

        {commentsLoading ? (
          <p className="text-gray-600 text-sm mb-6">Loading comments…</p>
        ) : comments.length === 0 ? (
          <p className="text-gray-600 text-sm mb-6">No comments yet. Start the discussion.</p>
        ) : null}

        <div className="space-y-4 mb-6">
          {comments.map((comment) => (
            <div key={comment.id} className="border-b border-gray-100 pb-4 last:border-0">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <p className="text-gray-900 font-medium">{comment.author}</p>
                <span
                  className={`px-2 py-1 rounded text-xs ${
                    comment.role === 'instructor'
                      ? 'bg-purple-100 text-purple-700'
                      : 'bg-blue-100 text-blue-700'
                  }`}
                >
                  {comment.role}
                </span>
                <span className="text-gray-500">•</span>
                <span className="text-gray-500">{comment.date || '—'}</span>
              </div>
              <p className="text-gray-700 whitespace-pre-wrap">{comment.text}</p>
            </div>
          ))}
        </div>

        <div>
          <label className="block text-gray-700 font-medium mb-2" htmlFor="doc-comment-input">
            Add a comment
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <textarea
              id="doc-comment-input"
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void handleAddComment();
                }
              }}
              placeholder="Share your thoughts..."
              rows={3}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 resize-y min-h-[44px]"
            />
            <button
              type="button"
              onClick={() => void handleAddComment()}
              disabled={commentsPosting || !newComment.trim()}
              className="sm:self-start px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send size={18} />
              {commentsPosting ? 'Posting…' : 'Post'}
            </button>
          </div>
          <p className="text-gray-400 text-xs mt-2">Tip: Ctrl+Enter to post</p>
        </div>
      </div>
    </div>
  );
}
