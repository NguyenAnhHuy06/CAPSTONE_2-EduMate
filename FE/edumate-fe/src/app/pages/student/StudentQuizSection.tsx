import { useState, useEffect, useMemo, useRef } from 'react';
import {
    FileText,
    Search,
    Clock,
    CheckCircle,
    Play,
    Eye,
    BarChart3,
    Award,
    X,
    Lightbulb,
    Share2,
    RefreshCw,
    MessageSquare,
} from 'lucide-react';
import { useNotification } from '../NotificationContext';
import api, { getApiBaseUrl, getApiErrorMessage, getStoredAuthToken } from '@/services/api';
import { safeNotificationMessage } from '@/utils/safeErrorMessage';
import { formatDateTimeWithSeconds } from '@/utils/formatDateTime';

/** Same shape as lecturer QuizManagement file highlight — scroll to available quiz card by source file. */
export type StudentQuizFileHighlightRequest = { s3Key: string; nonce: number };

interface StudentQuizSectionProps {
    user: any;
    fileHighlightRequest?: StudentQuizFileHighlightRequest | null;
    onFileHighlightConsumed?: () => void;
}

type QuizTab = 'available' | 'completed' | 'edited' | 'my-practice';

interface QuizAnswer {
    questionId: string;
    selectedAnswer: number;
    selectedText?: string;
}

const LETTERS = ['A', 'B', 'C', 'D'];
const STUDENT_QUIZ_GENERATING_KEY = 'edumate_student_quiz_generating';
const STUDENT_QUIZ_AUTOSTART_KEY = 'edumate_student_quiz_autostart';
const STUDENT_QUIZ_AUTOSTART_EVENT = 'edumate:student-quiz-autostart';
const STUDENT_QUIZ_RESULT_CACHE_KEY = 'edumate_student_quiz_result_cache';
/** quizId → ISO sharedAt — one share per quiz (survives retakes / new attempts). */
const STUDENT_SHARED_QUIZ_IDS_KEY = 'edumate_student_shared_quiz_ids';
const STUDENT_QUIZ_TAKING_EVENT = 'edumate:student-quiz-taking';
type StudentQuizJobStatus = 'idle' | 'running' | 'completed' | 'failed';

type QuizResultCacheItem = {
    attemptId?: number | null;
    quizId: number;
    resultId?: string;
    answersSnapshot: QuizAnswer[];
    questionsSnapshot: any[];
    timeTakenSeconds: number;
    savedAt: number;
    s3Key?: string;
    title?: string;
    passPercentage?: number;
    duration?: number;
    myScore?: number;
};

function formatHourMinute(raw: unknown): string {
    const t = String(raw ?? '').trim();
    if (!t) return '';
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return t;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function mapQuizCommentRows(raw: unknown): { id: string; author: string; createdAt: string; text: string }[] {
    const rows = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as any)?.data)
          ? (raw as any).data
          : Array.isArray((raw as any)?.data?.items)
            ? (raw as any).data.items
            : Array.isArray((raw as any)?.items)
              ? (raw as any).items
              : [];
    return rows.map((c: any, idx: number) => ({
        id: String(c?.commentId ?? c?.id ?? `comment-${idx}`),
        author: String(
            c?.authorLabel ?? c?.author ?? c?.createdByName ?? c?.userName ?? 'User'
        ).trim(),
        createdAt: String(c?.createdAt ?? c?.created_at ?? c?.time ?? '').trim(),
        text: String(c?.text ?? c?.content ?? c?.comment ?? c?.body ?? '').trim(),
    }));
}

function formatDateTimeWithSeconds(raw: unknown): string {
    const t = String(raw ?? '').trim();
    if (!t) return '';
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return t;
    const date = d.toLocaleDateString('en-GB');
    const time = d.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    return `${date} ${time}`;
}

function cacheKeyForUser(baseKey: string, viewerUserId: string | null): string | null {
    if (viewerUserId == null) return null;
    const s = String(viewerUserId).trim();
    if (!s) return null;
    return `${baseKey}:u:${s}`;
}

function readQuizResultCache(viewerUserId: string | null): QuizResultCacheItem[] {
    const key = cacheKeyForUser(STUDENT_QUIZ_RESULT_CACHE_KEY, viewerUserId);
    if (!key) return [];
    try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeQuizResultCache(items: QuizResultCacheItem[], viewerUserId: string | null) {
    const key = cacheKeyForUser(STUDENT_QUIZ_RESULT_CACHE_KEY, viewerUserId);
    if (!key) return;
    try {
        localStorage.setItem(key, JSON.stringify(items.slice(0, 100)));
    } catch {
        // ignore storage failures
    }
}

function resolveStudentQuizId(row?: { quizId?: unknown; id?: unknown } | null): number | null {
    const n = Number((row as any)?.quizId ?? row?.id);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function rowHasSharedFlags(row?: Record<string, unknown> | null): boolean {
    return Boolean(row?.sharedForReview || row?.sharedFromStudent);
}

function readSharedQuizIdMap(viewerUserId: string | null): Map<number, string> {
    const out = new Map<number, string>();
    const key = cacheKeyForUser(STUDENT_SHARED_QUIZ_IDS_KEY, viewerUserId);
    if (!key) return out;
    try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed as Record<string, string>)) {
                const qid = Number(k);
                if (Number.isFinite(qid) && qid > 0 && String(v || '').trim()) {
                    out.set(qid, String(v).trim());
                }
            }
        }
    } catch {
        // ignore
    }
    return out;
}

function markQuizSharedInStorage(quizId: number, sharedAt: string | undefined, viewerUserId: string | null) {
    const qid = Number(quizId);
    if (!Number.isFinite(qid) || qid <= 0) return;
    const storageKey = cacheKeyForUser(STUDENT_SHARED_QUIZ_IDS_KEY, viewerUserId);
    if (!storageKey) return;
    const at = String(sharedAt || '').trim() || new Date().toISOString();
    try {
        const prev = Object.fromEntries(readSharedQuizIdMap(viewerUserId));
        prev[String(qid)] = at;
        localStorage.setItem(storageKey, JSON.stringify(prev));
    } catch {
        // ignore
    }
}

/** Propagate shared flags to every completed row for the same quizId. */
function applySharedFlagsToQuizRows(rows: any[], viewerUserId: string | null): any[] {
    const stored = readSharedQuizIdMap(viewerUserId);
    const sharedByQuiz = new Map<number, string>(stored);

    for (const r of rows) {
        const qid = resolveStudentQuizId(r);
        if (!qid || !rowHasSharedFlags(r)) continue;
        const at = String((r as any)?.sharedAt || '').trim() || sharedByQuiz.get(qid) || new Date().toISOString();
        sharedByQuiz.set(qid, at);
        markQuizSharedInStorage(qid, at, viewerUserId);
    }

    return rows.map((r) => {
        const qid = resolveStudentQuizId(r);
        if (!qid || !sharedByQuiz.has(qid)) return r;
        const sharedAt = sharedByQuiz.get(qid)!;
        return {
            ...r,
            sharedForReview: true,
            sharedFromStudent: true,
            sharedAt: String((r as any)?.sharedAt || '').trim() || sharedAt,
        };
    });
}

function upsertQuizResultCache(entry: QuizResultCacheItem, viewerUserId: string | null) {
    appendQuizResultCache(entry, viewerUserId);
}

/** Keep prior attempts; replace only the same resultId or attemptId. */
function appendQuizResultCache(entry: QuizResultCacheItem, viewerUserId: string | null) {
    const prev = readQuizResultCache(viewerUserId);
    const resultKey = String(entry.resultId || '').trim();
    const aid = Number(entry.attemptId);
    const next = prev.filter((x) => {
        if (resultKey && String(x.resultId || '').trim() === resultKey) return false;
        if (Number.isFinite(aid) && aid > 0 && Number(x.attemptId) === aid) return false;
        return true;
    });
    next.unshift(entry);
    writeQuizResultCache(next, viewerUserId);
}

function stripCompletedAttemptFields(row: Record<string, unknown> | null | undefined) {
    const source = row && typeof row === 'object' ? row : {};
    const {
        attemptId: _attemptId,
        resultId: _resultId,
        answersSnapshot: _answersSnapshot,
        questionsSnapshot: _questionsSnapshot,
        userAnswers: _userAnswers,
        myScore: _myScore,
        completedDate: _completedDate,
        durationSeconds: _durationSeconds,
        timeTakenSeconds: _timeTakenSeconds,
        resultUrl: _resultUrl,
        isRetake: _isRetake,
        ...rest
    } = source as Record<string, unknown>;
    return rest;
}

function mergeCompletedWithCache(apiRows: any[], cacheRows: QuizResultCacheItem[]): any[] {
    const merged = [...apiRows];
    const resultKeys = new Set(merged.map((r) => String((r as any)?.resultId || '').trim()).filter(Boolean));
    const attemptKeys = new Set(
        merged
            .map((r) => Number((r as any)?.attemptId))
            .filter((n) => Number.isFinite(n) && n > 0)
            .map((n) => String(n))
    );

    for (const c of cacheRows) {
        if (!Array.isArray(c.questionsSnapshot) || c.questionsSnapshot.length === 0) continue;
        const resultId =
            String(c.resultId || '').trim() ||
            (c.attemptId != null && c.attemptId !== ''
                ? `${c.quizId}-${c.attemptId}`
                : `${c.quizId}-local-${c.savedAt}`);
        if (resultKeys.has(resultId)) continue;
        if (c.attemptId != null && attemptKeys.has(String(c.attemptId))) continue;

        const template = apiRows.find((r) => Number((r as any)?.quizId ?? r?.id) === Number(c.quizId));
        const qs = normalizeStoredQuestions(c.questionsSnapshot);
        merged.push({
            ...(template || {}),
            id: c.quizId,
            quizId: c.quizId,
            resultId,
            title: c.title || template?.title || 'Quiz',
            subject: template?.subject || 'DOC',
            instructor: template?.instructor || 'Unknown uploader',
            questions:
                qs.length > 0
                    ? qs
                    : Array.from({ length: c.questionsSnapshot.length }).map((_, i) => ({
                          id: `cache-q-${i + 1}`,
                          question: '',
                          options: [],
                          correctAnswer: 0,
                      })),
            duration: Number(c.duration ?? template?.duration ?? 10),
            durationSeconds: Number(c.timeTakenSeconds || 0),
            myScore: Number.isFinite(Number(c.myScore))
                ? Number(c.myScore)
                : Number(template?.myScore || 0),
            attempts: Number(template?.attempts || 1),
            completedDate: new Date(c.savedAt).toISOString(),
            status: 'completed',
            isPublished: Boolean(template?.isPublished),
            sharedForReview: Boolean(template?.sharedForReview),
            sharedAt: template?.sharedAt || null,
            lecturerEdited: Boolean(template?.lecturerEdited),
            lecturerEditedAt: template?.lecturerEditedAt || null,
            attemptId: c.attemptId ?? null,
            answersSnapshot: Array.isArray(c.answersSnapshot) ? c.answersSnapshot : [],
            questionsSnapshot: c.questionsSnapshot,
            s3Key: c.s3Key || template?.s3Key || '',
            passPercentage: Number(c.passPercentage ?? template?.passPercentage ?? 70),
            timeTakenSeconds: Number(c.timeTakenSeconds || 0),
            userAnswers: Array.isArray(c.answersSnapshot)
                ? c.answersSnapshot
                      .map((a: any) => a?.selectedAnswer)
                      .filter((x: any) => Number.isFinite(Number(x)))
                : [],
        });
        resultKeys.add(resultId);
        if (c.attemptId != null) attemptKeys.add(String(c.attemptId));
    }

    return merged.sort((a, b) => {
        const ta = new Date(String((a as any)?.completedDate || 0)).getTime();
        const tb = new Date(String((b as any)?.completedDate || 0)).getTime();
        return tb - ta;
    });
}

function findQuizResultCacheEntry(
    opts: {
        attemptId?: unknown;
        quizId?: unknown;
    },
    viewerUserId: string | null
): QuizResultCacheItem | null {
    const rows = readQuizResultCache(viewerUserId);
    const aid = Number(opts.attemptId);
    if (Number.isFinite(aid) && aid > 0) {
        const byAttempt = rows.find((x) => Number(x.attemptId) === aid);
        if (byAttempt) return byAttempt;
    }
    const qid = Number(opts.quizId);
    if (Number.isFinite(qid) && qid > 0) {
        return rows.find((x) => Number(x.quizId) === qid) ?? null;
    }
    return null;
}

/** Search string (title, course code, instructor, file, date, …). */
function buildQuizSearchHaystack(quiz: Record<string, unknown>): string {
    const parts = [
        quiz?.title,
        quiz?.subject,
        quiz?.subjectCode,
        quiz?.courseCode,
        quiz?.instructor,
        quiz?.fileName,
        quiz?.s3Key,
        quiz?.createdDate,
        quiz?.completedDate,
        quiz?.dueDate,
        quiz?.status,
    ];
    return parts.map((p) => String(p ?? '').toLowerCase()).join(' \n ');
}

function quizMatchesSearchQuery(quiz: Record<string, unknown>, rawQuery: string): boolean {
    const q = String(rawQuery || '').trim().toLowerCase();
    if (!q) return true;
    const hay = buildQuizSearchHaystack(quiz);
    const words = q.split(/\s+/).filter(Boolean);
    return words.every((w) => hay.includes(w));
}

function isQuizMarkedDeleted(raw: any): boolean {
    if (raw == null || typeof raw !== 'object') return false;
    const r = raw as Record<string, unknown>;
    const deletedFlags = [r.isDeleted, r.is_deleted, r.deleted];
    if (deletedFlags.some((v) => v === true || v === 1 || String(v ?? '').toLowerCase() === 'true')) return true;

    const deletedAt = String(r.deletedAt ?? r.deleted_at ?? '').trim();
    if (deletedAt) return true;

    const status = String(r.status ?? r.quizStatus ?? '').trim().toLowerCase();
    if (['deleted', 'removed', 'archived', 'inactive'].includes(status)) return true;

    return false;
}

type NormQuestionType = 'multiple-choice' | 'true-false' | 'short-answer';

/** Raw option strings without assuming question type (for inference when API omits type). */
function collectRawOptionTexts(q: any): string[] {
    const asText = (x: unknown) => String(x ?? '').trim();

    const fromArray = (arr: unknown): string[] => {
        if (!Array.isArray(arr) || arr.length === 0) return [];
        return arr
            .map((x: any) => {
                if (x == null) return '';
                if (typeof x === 'string' || typeof x === 'number') return asText(x);
                if (typeof x === 'object') {
                    return asText(
                        (x as any).text ?? (x as any).label ?? (x as any).value ?? (x as any).content ?? ''
                    );
                }
                return '';
            })
            .filter(Boolean);
    };

    if (Array.isArray(q?.options) && q.options.length > 0) {
        const fromOpt = fromArray(q.options);
        if (fromOpt.length) return fromOpt;
    }

    if (typeof q?.options === 'string' && q.options.trim().startsWith('[')) {
        try {
            const parsed = JSON.parse(q.options) as unknown;
            if (Array.isArray(parsed)) {
                const t = fromArray(parsed);
                if (t.length) return t;
            }
        } catch {
            // ignore
        }
    }

    if (Array.isArray(q?.choices) && q.choices.length > 0) {
        const t = fromArray(q.choices);
        if (t.length) return t;
    }

    const optObj = q?.options;
    if (optObj && typeof optObj === 'object' && !Array.isArray(optObj)) {
        const o = optObj as Record<string, unknown>;
        const order = ['A', 'B', 'C', 'D', 'a', 'b', 'c', 'd'];
        const out: string[] = [];
        for (const k of order) {
            const v = String(o[k] ?? '').trim();
            if (v) out.push(v);
        }
        if (out.length) return out;
    }
    return [q?.option_a, q?.option_b, q?.option_c, q?.option_d, q?.optionA, q?.optionB, q?.optionC, q?.optionD]
        .map((x: any) => String(x ?? '').trim())
        .filter(Boolean);
}

/** Minutes for UI + timer; `Number(x ?? y)` can still be NaN if `x` is NaN — use this instead. */
function finiteQuizMinutes(value: unknown, fallback = 10): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(600, Math.max(1, Math.round(n)));
}

function finitePassPercent(value: unknown, fallback = 70): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(100, Math.round(n)));
}

function looksLikeMediaRef(s: string): boolean {
    const t = String(s ?? '').trim();
    if (t.length < 3 || t === 'null' || t === 'undefined') return false;
    if (/^https?:\/\//i.test(t)) return true;
    if (t.startsWith('//') && t.length > 4) return true;
    if (t.startsWith('/api/') || t.startsWith('/uploads/')) return true;
    if (t.startsWith('question-media/')) return true;
    if (t.includes('/questions/media/')) return true;
    if (/^api\//i.test(t)) return true;
    return false;
}

function deepFindMediaString(input: unknown, seen = new WeakSet<object>(), depth = 0): string {
    if (depth > 6 || input == null) return '';
    if (typeof input === 'string') {
        return looksLikeMediaRef(input) ? input.trim() : '';
    }
    if (typeof input !== 'object') return '';
    if (seen.has(input as object)) return '';
    seen.add(input as object);
    if (Array.isArray(input)) {
        for (const el of input) {
            const g = deepFindMediaString(el, seen, depth + 1);
            if (g) return g;
        }
        return '';
    }
    const o = input as Record<string, unknown>;
    for (const k of Object.keys(o)) {
        const lk = k.toLowerCase();
        const v = o[k];
        if (
            lk.includes('media') ||
            lk.includes('image') ||
            lk.includes('attachment') ||
            (lk.includes('file') && (lk.includes('url') || lk.includes('path') || lk.includes('key'))) ||
            lk === 's3key' ||
            lk === 's3_key' ||
            lk === 'fileurl' ||
            lk === 'file_url' ||
            lk === 'storagekey' ||
            lk === 'storage_key'
        ) {
            const g = deepFindMediaString(v, seen, depth + 1);
            if (g) return g;
        }
    }
    return '';
}

function resolveMediaUrl(q: any): string {
    const candidates = [
        q?.mediaUrl,
        q?.media_url,
        q?.MediaUrl,
        q?.MEDIA_URL,
        q?.imageUrl,
        q?.image_url,
        q?.questionImage,
        q?.question_image,
        q?.attachmentUrl,
        q?.attachment_url,
        q?.media,
        q?.picture,
        q?.photo,
        q?.image,
        q?.fileUrl,
        q?.file_url,
        q?.filePath,
        q?.file_path,
        q?.storageKey,
        q?.storage_key,
        q?.s3Key,
        q?.s3_key,
    ];
    for (const c of candidates) {
        const s = String(c ?? '').trim();
        if (s) return s;
    }
    const deep = deepFindMediaString(q);
    return deep ? String(deep).trim() : '';
}

/**
 * Direct links like https://bucket.s3.region.amazonaws.com/key work in <img> for public objects,
 * but our auth-retry uses fetch() + Authorization — that triggers a CORS preflight on S3 and fails.
 * Always route virtual-hosted S3 object URLs through the API proxy (same-origin, server-side GetObject).
 */
function proxifyVirtualHostedS3Url(raw: string): string | null {
    const s = String(raw ?? '').trim();
    if (!/^https?:\/\//i.test(s) || /\/questions\/media\/file/i.test(s)) return null;
    try {
        const u = new URL(s);
        const host = u.hostname.toLowerCase();
        const pathStyle = /^s3([.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(host);
        const vhost =
            !pathStyle &&
            host.includes('.s3.') &&
            host.endsWith('.amazonaws.com') &&
            !host.startsWith('s3.');
        if (vhost) {
            const key = u.pathname.replace(/^\/+/, '').split('?')[0];
            if (!key) return null;
            const base = getApiBaseUrl().replace(/\/$/, '');
            return `${base}/questions/media/file?s3Key=${encodeURIComponent(key)}`;
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Browser needs an absolute or same-origin path; bare S3 keys must use the media proxy like lecturer UI.
 * Full URLs saved with another host:port (e.g. API on 3001) break on Vite (5173) — use same-origin /api/... so the dev proxy can reach the backend.
 */
function toDisplayableMediaUrl(raw: string): string {
    let s = String(raw ?? '').trim();
    if (!s) return '';
    if (s.startsWith('data:') || s.startsWith('blob:')) return s;
    if (s.startsWith('//')) {
        if (typeof window !== 'undefined' && window.location?.protocol) {
            return `${window.location.protocol}${s}`;
        }
        return `https:${s}`;
    }
    if (!/^https?:\/\//i.test(s) && /^api\//i.test(s)) {
        s = `/${s}`;
    }
    if (/^https?:\/\//i.test(s)) {
        const proxied = proxifyVirtualHostedS3Url(s);
        if (proxied) return proxied;
        try {
            const u = new URL(s);
            const path = u.pathname.replace(/\/+$/, '');
            if (path.endsWith('/questions/media/file')) {
                return `${u.pathname}${u.search}`;
            }
        } catch {
            // ignore
        }
        return s;
    }
    if (s.startsWith('/')) return s;
    const base = getApiBaseUrl().replace(/\/$/, '');
    return `${base}/questions/media/file?s3Key=${encodeURIComponent(s)}`;
}

function parseYoutubeVideoId(url: unknown): string {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    try {
        const u = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        if (host === 'youtu.be') {
            const id = u.pathname.replace(/^\/+/, '').split('/')[0]?.trim() || '';
            return /^[a-zA-Z0-9_-]{6,}$/.test(id) ? id : '';
        }
        if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
            const v = String(u.searchParams.get('v') || '').trim();
            if (/^[a-zA-Z0-9_-]{6,}$/.test(v)) return v;
            const parts = u.pathname.split('/').filter(Boolean);
            if (parts.length >= 2 && (parts[0] === 'shorts' || parts[0] === 'embed')) {
                const id = parts[1];
                return /^[a-zA-Z0-9_-]{6,}$/.test(id) ? id : '';
            }
            if (parts.length >= 2 && parts[0] === 'live') {
                const id = String(parts[1] || '').split('?')[0].trim();
                return /^[a-zA-Z0-9_-]{6,}$/.test(id) ? id : '';
            }
        }
    } catch {
        // ignore
    }
    return '';
}

/**
 * Student quiz: show YouTube title (oEmbed) + embed with native controls (volume lives in the player UI).
 * YouTube still injects some overlays (share/watch-later) — not removable via iframe parameters.
 */
function YoutubeStudentEmbed({ videoId, mediaUrl }: { videoId: string; mediaUrl: string }) {
    const [title, setTitle] = useState('');
    useEffect(() => {
        let cancelled = false;
        const pageUrl = /^https?:\/\//i.test(String(mediaUrl || '').trim())
            ? String(mediaUrl).trim()
            : `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
        const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(pageUrl)}&format=json`;
        void fetch(oembed)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                if (cancelled || !data || typeof data.title !== 'string') return;
                const t = data.title.trim();
                if (t) setTitle(t);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [videoId, mediaUrl]);

    const embedUrl = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=0&playsinline=1&rel=0&modestbranding=1&controls=1&iv_load_policy=3`;

    return (
        <div className="w-full overflow-hidden rounded border border-gray-200 bg-black">
            <div className="border-b border-gray-800 bg-gray-950 px-3 py-2 text-sm font-medium leading-snug text-white">
                <span className="line-clamp-2">{title || 'YouTube video'}</span>
            </div>
            <div className="bg-black">
                <iframe
                    title={title || 'YouTube video'}
                    src={embedUrl}
                    className="aspect-video min-h-[280px] w-full"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                />
            </div>
        </div>
    );
}

/** Some backends require Authorization for media; <img> cannot send headers — retry with fetch + blob. */
function QuizQuestionMediaImg({ src }: { src: string }) {
    const [displaySrc, setDisplaySrc] = useState(src);
    const [failed, setFailed] = useState(false);
    const [authTried, setAuthTried] = useState(false);
    const blobUrlRef = useRef<string | null>(null);

    useEffect(() => {
        setDisplaySrc(src);
        setFailed(false);
        setAuthTried(false);
        if (blobUrlRef.current?.startsWith('blob:')) {
            URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = null;
        }
    }, [src]);

    const tryLoadWithAuth = async () => {
        try {
            const token = getStoredAuthToken();
            const path = src.startsWith('http')
                ? src
                : `${typeof window !== 'undefined' ? window.location.origin : ''}${src.startsWith('/') ? '' : '/'}${src}`;
            // Never fetch YouTube links from the browser (CORS). Use embed/thumbnail instead.
            const youtubeId = parseYoutubeVideoId(path);
            if (youtubeId) throw new Error('youtube');
            // Bearer on cross-origin S3 triggers CORS preflight; S3 does not answer it — never attach here for aws hosts.
            const isAwsHost = /^https?:\/\//i.test(path) && /amazonaws\.com/i.test(path);
            const isOurApiMedia =
                path.includes('/questions/media/file') ||
                path.startsWith('/api/') ||
                (typeof window !== 'undefined' &&
                    path.startsWith('http') &&
                    (() => {
                        try {
                            return new URL(path).origin === window.location.origin;
                        } catch {
                            return false;
                        }
                    })());
            const headers: Record<string, string> = {};
            if (token && !isAwsHost && isOurApiMedia) {
                headers.Authorization = `Bearer ${token}`;
            }
            const res = await fetch(path, { headers });
            if (!res.ok) throw new Error(String(res.status));
            const blob = await res.blob();
            if (!blob.size) throw new Error('empty');
            const u = URL.createObjectURL(blob);
            if (blobUrlRef.current?.startsWith('blob:')) URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = u;
            setDisplaySrc(u);
        } catch {
            setFailed(true);
        }
    };

    if (!String(src || '').trim()) return null;
    if (failed) {
        return (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Could not load question media. If this quiz should include an image, ask your instructor to re-upload the
                attachment or check the server media configuration.
            </div>
        );
    }

    const youtubeId = parseYoutubeVideoId(src);
    if (youtubeId) {
        return <YoutubeStudentEmbed videoId={youtubeId} mediaUrl={String(src).trim()} />;
    }

    return (
        <img
            src={displaySrc}
            alt="Question media"
            className="max-h-56 w-auto rounded border border-gray-200"
            onError={() => {
                if (!authTried) {
                    setAuthTried(true);
                    void tryLoadWithAuth();
                } else {
                    setFailed(true);
                }
            }}
        />
    );
}

/** Positive integer quiz id for POST /quiz/attempts (reject document placeholders like "doc-1"). */
function coercePositiveQuizId(raw: unknown): number | null {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
    const s = String(raw).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** Unwrap GET /quizzes/:id — backends nest payload differently. */
function unwrapQuizDetailPayload(res: any): {
    quiz_id?: number;
    title?: string;
    questions: any[];
    duration_minutes?: number;
    pass_percentage?: number;
} {
    if (!res || typeof res !== 'object') return { questions: [] };
    const payload =
        res?.data != null && typeof res.data === 'object' && !Array.isArray(res.data)
            ? res.data
            : res;
    const nestedQuiz = payload?.quiz != null && typeof payload.quiz === 'object' ? payload.quiz : null;
    let questionsRaw: unknown =
        payload?.questions ??
        payload?.questionList ??
        payload?.QuestionList ??
        payload?.quiz_questions ??
        payload?.quizQuestions ??
        payload?.Items ??
        payload?.items ??
        nestedQuiz?.questions ??
        res?.questions;
    if (typeof questionsRaw === 'string') {
        try {
            questionsRaw = JSON.parse(questionsRaw);
        } catch {
            questionsRaw = [];
        }
    }
    let questions: any[] = [];
    if (Array.isArray(questionsRaw)) {
        questions = questionsRaw;
    } else if (questionsRaw && typeof questionsRaw === 'object') {
        const vals = Object.values(questionsRaw as object);
        if (vals.length && vals.every((v) => v != null && typeof v === 'object')) {
            questions = vals as any[];
        }
    }
    const durationRaw =
        payload?.duration_minutes ??
        payload?.durationMinutes ??
        payload?.time_limit_minutes ??
        payload?.timeLimitMinutes ??
        payload?.duration ??
        nestedQuiz?.duration_minutes ??
        nestedQuiz?.duration;
    const durationN = Number(durationRaw);
    const passRaw = payload?.pass_percentage ?? payload?.passPercentage ?? nestedQuiz?.pass_percentage;
    const passN = Number(passRaw);
    return {
        quiz_id:
            coercePositiveQuizId(payload?.quiz_id ?? payload?.quizId ?? payload?.id ?? nestedQuiz?.id) ??
            undefined,
        title: String(payload?.title ?? nestedQuiz?.title ?? payload?.quiz_title ?? '').trim() || undefined,
        questions,
        duration_minutes: Number.isFinite(durationN) && durationN > 0 ? durationN : undefined,
        pass_percentage: Number.isFinite(passN) && passN > 0 ? passN : undefined,
    };
}

/**
 * Explanation text for results/review only (not shown during active quiz).
 * Supports `question.explanation`, `question_explanation`, or `quizResult.explanationsByQuestionId`.
 */
function pickQuestionExplanation(q: any, idx: number, quizResult: Record<string, unknown> | null): string {
    const qr = quizResult as Record<string, unknown> | null | undefined;
    const qid = String(q?.id ?? q?.question_id ?? q?.questionId ?? `q-${idx + 1}`);
    const mapObj = qr?.explanationsByQuestionId ?? qr?.explanations;
    if (mapObj && typeof mapObj === 'object' && !Array.isArray(mapObj)) {
        const o = mapObj as Record<string, unknown>;
        const fromMap = o[qid] ?? o[String(idx + 1)];
        if (fromMap != null && String(fromMap).trim()) return String(fromMap).trim();
    }
    const direct = q?.explanation ?? q?.Explanation ?? q?.question_explanation;
    if (direct != null && String(direct).trim()) return String(direct).trim();
    return '';
}

/** Prefer embedded quiz snapshots from GET /quiz/result (includes explanation). */
function embeddedQuestionsFromReview(reviewData: any, reviewPayload: any): any[] | null {
    const raw =
        reviewData?.questions ||
        reviewData?.quiz?.questions ||
        reviewPayload?.questions ||
        reviewPayload?.quiz?.questions;
    if (Array.isArray(raw) && raw.length) return raw;
    return null;
}

/** Align raw API / DB rows with what normalizeStoredQuestions expects (same idea as lecturer mapping). */
function coerceQuizQuestionRow(q: any): any {
    if (!q || typeof q !== 'object') return q;
    const out: any = { ...q };

    if (!out.question && out.question_text != null) out.question = out.question_text;
    if (!out.questionText && out.question_text != null) out.questionText = out.question_text;

    const typed =
        out.questionType ??
        out.type ??
        out.question_type ??
        out.QuestionType ??
        out.questionTypeCode;
    if (typed != null && out.type == null) out.type = typed;
    if (typed != null && out.questionType == null) out.questionType = typed;

    if (out.options_json != null && (out.options == null || (Array.isArray(out.options) && out.options.length === 0))) {
        try {
            const parsed =
                typeof out.options_json === 'string' ? JSON.parse(out.options_json) : out.options_json;
            if (Array.isArray(parsed) && parsed.length) out.options = parsed;
        } catch {
            // ignore
        }
    }

    if (typeof out.options === 'string') {
        const t = out.options.trim();
        if (t.startsWith('[') || t.startsWith('{')) {
            try {
                const parsed = JSON.parse(t);
                if (Array.isArray(parsed)) out.options = parsed;
                else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    out.options = parsed;
                }
            } catch {
                // ignore
            }
        }
    }

    const optObj = out.options;
    if (optObj && typeof optObj === 'object' && !Array.isArray(optObj)) {
        const numericKeys = Object.keys(optObj)
            .filter((k) => /^\d+$/.test(k))
            .sort((a, b) => Number(a) - Number(b));
        if (numericKeys.length >= 2 && !LETTERS.some((L) => String((optObj as any)[L] ?? '').trim())) {
            const arr = numericKeys.map((k) => String((optObj as any)[k] ?? '').trim()).filter(Boolean);
            if (arr.length) out.options = arr;
        }
    }

    const mu = String(out.media_url ?? out.mediaUrl ?? out.MediaUrl ?? '').trim();
    if (mu && !String(out.mediaUrl ?? '').trim()) out.mediaUrl = mu;

    const fp = String(out.file_path ?? out.filePath ?? out.storage_key ?? out.storageKey ?? '').trim();
    if (fp && !String(out.mediaUrl ?? out.media_url ?? '').trim()) {
        out.media_url = fp;
        out.mediaUrl = fp;
    }

    if (out.explanation == null && out.question_explanation != null) {
        out.explanation = out.question_explanation;
    }

    return out;
}

function looksLikeTrueFalsePair(a: string, b: string): boolean {
    const norm = (s: string) =>
        s
            .toLowerCase()
            .normalize('NFD')
            .replace(/\p{M}/gu, '');
    const x = norm(a);
    const y = norm(b);
    const hasTrue = (s: string) =>
        /\btrue\b|\byes\b|\bcorrect\b|\bđúng\b|\bdung\b/.test(s) || s === 't' || s === 'y';
    const hasFalse = (s: string) =>
        /\bfalse\b|\bno\b|\bincorrect\b|\bsai\b/.test(s) || s === 'f' || s === 'n';
    return (hasTrue(x) && hasFalse(y)) || (hasTrue(y) && hasFalse(x));
}

function normalizeQuestionType(raw: unknown): NormQuestionType {
    if (raw == null || raw === '') return 'multiple-choice';
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        const n = Math.floor(Number(raw));
        if (n === 1) return 'true-false';
        if (n === 2 || n === 3) return 'short-answer';
        return 'multiple-choice';
    }
    let t = String(raw).trim().toLowerCase().replace(/_/g, '-');
    t = t.replace(/\s+/g, '-');
    while (t.includes('--')) t = t.replace('--', '-');

    const sa = new Set([
        'short-answer',
        'shortanswer',
        'sa',
        'essay',
        'open-ended',
        'openended',
        'text',
        'free-text',
        'freetext',
        'written',
        'fill-in',
        'fillin',
        'open-response',
        'long-answer',
        'short',
    ]);
    if (sa.has(t)) return 'short-answer';

    const tf = new Set([
        'true-false',
        'truefalse',
        'boolean',
        'tf',
        't-f',
        'yes-no',
        'yesno',
        'binary',
    ]);
    if (tf.has(t)) return 'true-false';

    if (
        t === 'multiple-choice' ||
        t === 'multiplechoice' ||
        t === 'mcq' ||
        t === 'choice' ||
        t === 'm-c'
    ) {
        return 'multiple-choice';
    }

    return 'multiple-choice';
}

/**
 * Resolve type from explicit fields, then infer True/False from two-option shape.
 * Do **not** infer short-answer from missing options — that broke MCQ/TF when options live in non-standard keys or load later.
 */
function resolveQuestionType(q: any): NormQuestionType {
    const raw =
        q?.questionType ??
        q?.type ??
        q?.question_type ??
        q?.QuestionType ??
        q?.questionTypeCode ??
        q?.kind ??
        q?.category;
    let t = normalizeQuestionType(raw);
    if (t !== 'multiple-choice') return t;

    const texts = collectRawOptionTexts(q);
    if (texts.length === 2 && looksLikeTrueFalsePair(texts[0], texts[1])) {
        return 'true-false';
    }
    return 'multiple-choice';
}

/**
 * Build ordered option labels from API: array, options.{A-D}, option_a…option_d, etc.
 */
function buildQuestionOptionsList(q: any, type: NormQuestionType): string[] {
    if (type === 'short-answer') return [];

    const optsRef = q?.options;
    const letterVals = (o: Record<string, unknown>) =>
        LETTERS.map((k) => String(o?.[k] ?? o?.[k.toLowerCase()] ?? '').trim()).filter(Boolean);

    if (Array.isArray(optsRef) && optsRef.length > 0) {
        const cleaned = optsRef.map((x: any) => String(x ?? '').trim()).filter(Boolean);
        if (type === 'true-false') {
            if (cleaned.length >= 2) return cleaned.slice(0, 2);
            if (cleaned.length === 1) return [cleaned[0], cleaned[0].toLowerCase() === 'true' ? 'False' : 'True'];
        }
        if (cleaned.length) return cleaned;
    }

    const o =
        optsRef && typeof optsRef === 'object' && !Array.isArray(optsRef)
            ? (optsRef as Record<string, unknown>)
            : {};
    const fromObj = letterVals(o);

    const a = String(q?.option_a ?? q?.optionA ?? o?.A ?? o?.a ?? '').trim();
    const b = String(q?.option_b ?? q?.optionB ?? o?.B ?? o?.b ?? '').trim();
    const c = String(q?.option_c ?? q?.optionC ?? o?.C ?? o?.c ?? '').trim();
    const d = String(q?.option_d ?? q?.optionD ?? o?.D ?? o?.d ?? '').trim();

    if (type === 'true-false') {
        if (a && b) return [a, b];
        if (fromObj.length >= 2) return fromObj.slice(0, 2);
        if (fromObj.length === 1) {
            const one = fromObj[0];
            return [one, one.toLowerCase() === 'true' ? 'False' : 'True'];
        }
        return ['True', 'False'];
    }

    const fromTop = [a, b, c, d].filter(Boolean);
    if (fromTop.length) return fromTop;
    if (fromObj.length) return fromObj;
    return ['Option A', 'Option B', 'Option C', 'Option D'];
}

/** Align with backend `normalizeShortAnswerText` for auto-grading short answers. */
function normalizeShortAnswerTextClient(s: unknown): string {
    return String(s ?? '')
        .normalize('NFKC')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function parseCorrectAnswerIndex(q: any, type: NormQuestionType, options: string[]): number {
    if (type === 'short-answer') return -1;
    const correctRaw = q?.correct_answer ?? q?.correctAnswer ?? q?.answer;
    if (typeof correctRaw === 'number' && Number.isFinite(correctRaw) && correctRaw >= 0) {
        const n = Math.floor(correctRaw);
        if (options.length === 0) return 0;
        return Math.min(n, options.length - 1);
    }
    const s = String(correctRaw ?? 'A').trim();
    if (type === 'true-false') {
        const u = s.toUpperCase();
        if (u === 'A' || s === '0') return 0;
        if (u === 'B' || s === '1') return 1;
        const sl = s.toLowerCase();
        if (sl === 'true' || sl === 't') {
            const i = options.findIndex((x) => x.toLowerCase() === 'true');
            return i >= 0 ? i : 0;
        }
        if (sl === 'false' || sl === 'f') {
            const i = options.findIndex((x) => x.toLowerCase() === 'false');
            return i >= 0 ? i : 1;
        }
    }
    const letterIdx = LETTERS.indexOf(s.toUpperCase().slice(0, 1));
    if (letterIdx >= 0 && letterIdx < options.length) return letterIdx;
    return options.length > 0 ? 0 : 0;
}

function normalizeQuestions(quizItems: any[] = []) {
    return quizItems.map((q: any, idx: number) => {
        const row = coerceQuizQuestionRow(q);
        const type = resolveQuestionType(row);
        const normalizedOptions = buildQuestionOptionsList(row, type);
        const correctAnswer = parseCorrectAnswerIndex(row, type, normalizedOptions);
        const correctText =
            type === 'short-answer'
                ? String(row?.correct_answer ?? row?.correctAnswer ?? '').trim()
                : '';
        const expl =
            row?.explanation != null && String(row.explanation).trim()
                ? String(row.explanation).trim()
                : row?.question_explanation != null && String(row.question_explanation).trim()
                  ? String(row.question_explanation).trim()
                  : '';
        return {
            id: String(row?.id || `q-${idx + 1}`),
            question: row?.question || row?.question_text || `Question ${idx + 1}`,
            questionType: type,
            mediaUrl: toDisplayableMediaUrl(resolveMediaUrl(row)),
            options: normalizedOptions,
            correctAnswer,
            correctText,
            ...(expl ? { explanation: expl } : {}),
        };
    });
}

/** Matches backend: 1–25 questions; prefers estimatedQuestions from /documents/for-quiz. */
function numQuestionsForGenerate(quiz: { estimatedQuestions?: unknown }): number {
    const raw = Number(quiz?.estimatedQuestions);
    if (Number.isFinite(raw) && raw > 0) {
        return Math.min(25, Math.max(1, Math.floor(raw)));
    }
    return 10;
}

function normalizeStoredQuestions(rows: any[] = []) {
    return rows.map((q: any, idx: number) => {
        const row = coerceQuizQuestionRow(q);
        const type = resolveQuestionType(row);
        const normalizedOptions = buildQuestionOptionsList(row, type);
        const correctAnswer = parseCorrectAnswerIndex(row, type, normalizedOptions);
        const correctText =
            type === 'short-answer'
                ? String(row?.correct_answer ?? row?.correctAnswer ?? '').trim()
                : '';
        const expl =
            row?.explanation != null && String(row.explanation).trim()
                ? String(row.explanation).trim()
                : row?.question_explanation != null && String(row.question_explanation).trim()
                  ? String(row.question_explanation).trim()
                  : '';
        return {
            id: String(row?.question_id || row?.id || `stored-q-${idx + 1}`),
            question: row?.question_text || row?.question || `Question ${idx + 1}`,
            questionType: type,
            mediaUrl: toDisplayableMediaUrl(resolveMediaUrl(row)),
            options: normalizedOptions,
            correctAnswer,
            correctText,
            ...(expl ? { explanation: expl } : {}),
        };
    });
}

/**
 * Normalize answers from backend into { questionId, selectedAnswer } format.
 * Backend may return various shapes — handle all known variants.
 */
function normalizeReviewAnswers(raw: any[]): QuizAnswer[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((a: any) => {
        // questionId: try all known field names
        const questionId = String(
            a?.questionId ?? a?.question_id ?? a?.questionID ?? ''
        );
        // selectedAnswer: may be index (number) or letter (A/B/C/D)
        let selectedAnswer: number;
        let selectedText = '';
        const raw_sel = a?.selectedAnswer ?? a?.selected_answer ?? a?.selected_option ?? a?.userAnswer ?? a?.user_answer;
        if (typeof raw_sel === 'number') {
            selectedAnswer = raw_sel;
        } else if (typeof raw_sel === 'string' && LETTERS.includes(raw_sel.toUpperCase())) {
            selectedAnswer = LETTERS.indexOf(raw_sel.toUpperCase());
        } else {
            selectedAnswer = -1; // unanswered
            if (typeof raw_sel === 'string' && raw_sel.trim()) {
                // Some backends return the chosen option text instead of A/B/C/D or index.
                selectedText = raw_sel.trim();
            }
        }
        return { questionId, selectedAnswer, selectedText };
    }).filter((a) => a.questionId !== '');
}

function formatTimeTakenLabel(totalSecondsRaw: number): string {
    const totalSeconds = Math.max(0, Math.floor(Number(totalSecondsRaw) || 0));
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}m ${secs}s`;
}

export function StudentQuizSection({
    user,
    fileHighlightRequest = null,
    onFileHighlightConsumed,
}: StudentQuizSectionProps) {
    const { showNotification, showConfirm } = useNotification();
    const [activeTab, setActiveTab] = useState<QuizTab>('available');
    const [searchQuery, setSearchQuery] = useState('');
    const [filterSubject, setFilterSubject] = useState('all');
    const [selectedQuiz, setSelectedQuiz] = useState<any>(null);
    const [showQuizTaking, setShowQuizTaking] = useState(false);
    const [showResults, setShowResults] = useState(false);
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [answers, setAnswers] = useState<QuizAnswer[]>([]);
    const [timeRemaining, setTimeRemaining] = useState(0);
    const [quizStartedAtMs, setQuizStartedAtMs] = useState<number | null>(null);
    const [quizResult, setQuizResult] = useState<any>(null);
    const [timerId, setTimerId] = useState<NodeJS.Timeout | null>(null);
    const [isGeneratingQuiz, setIsGeneratingQuiz] = useState(false);

    const [availableQuizzes, setAvailableQuizzes] = useState<any[]>([]);
    const [completedQuizzes, setCompletedQuizzes] = useState<any[]>([]);
    const [editedQuizzes, setEditedQuizzes] = useState<any[]>([]);
    const [practiceQuizzes, setPracticeQuizzes] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [resultComments, setResultComments] = useState<any[]>([]);
    const [resultCommentsLoading, setResultCommentsLoading] = useState(false);
    const [sharingQuiz, setSharingQuiz] = useState(false);
    const [highlightedS3Key, setHighlightedS3Key] = useState('');
    const availableCardRefs = useRef<Record<string, HTMLDivElement | null>>({});

    const viewerIdStr = useMemo((): string | null => {
        const v = user?.user_id ?? user?.id ?? user?.userId;
        if (v == null || v === '') return null;
        const s = String(v).trim();
        return s || null;
    }, [user]);

    const loadResultComments = async (quizRow?: any) => {
        const qid = coercePositiveQuizId(
            (quizRow as any)?.quizId ?? quizRow?.id ?? selectedQuiz?.quizId ?? selectedQuiz?.id
        );
        if (qid == null) {
            setResultComments([]);
            return;
        }
        setResultCommentsLoading(true);
        try {
            const commentsRes: any = await api.get(`/quizzes/${qid}/comments`);
            setResultComments(mapQuizCommentRows(commentsRes));
        } catch {
            setResultComments([]);
        } finally {
            setResultCommentsLoading(false);
        }
    };

    useEffect(() => {
        if (!showResults || !selectedQuiz) return;
        void loadResultComments(selectedQuiz);
    }, [showResults, selectedQuiz?.id, (selectedQuiz as any)?.quizId]);

    useEffect(() => {
        const raw = fileHighlightRequest?.s3Key?.trim();
        const nonce = fileHighlightRequest?.nonce;
        if (!raw || nonce == null) return;
        setActiveTab('available');
        setSearchQuery('');
        setFilterSubject('all');
        setHighlightedS3Key(raw);
        onFileHighlightConsumed?.();
        const t = window.setTimeout(() => setHighlightedS3Key(''), 8000);
        return () => window.clearTimeout(t);
    }, [fileHighlightRequest?.nonce, fileHighlightRequest?.s3Key, onFileHighlightConsumed]);

    useEffect(() => {
        if (!highlightedS3Key || loading) return;
        const el = availableCardRefs.current[highlightedS3Key];
        if (el) {
            requestAnimationFrame(() => {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        }
    }, [highlightedS3Key, loading, availableQuizzes]);

    useEffect(() => {
        window.dispatchEvent(
            new CustomEvent(STUDENT_QUIZ_TAKING_EVENT, {
                detail: { active: Boolean(showQuizTaking) },
            })
        );
    }, [showQuizTaking]);

    const setQuizGeneratingStatus = (
        status: StudentQuizJobStatus,
        extra?: { jobId?: string; title?: string; error?: string; quizId?: number | null }
    ) => {
        setIsGeneratingQuiz(status === 'running');
        const prevRaw = localStorage.getItem(STUDENT_QUIZ_GENERATING_KEY);
        let prev: any = null;
        try {
            prev = prevRaw ? JSON.parse(prevRaw) : null;
        } catch {
            prev = null;
        }
        const jobId = extra?.jobId || prev?.jobId || `job-${Date.now()}`;
        try {
            localStorage.setItem(
                STUDENT_QUIZ_GENERATING_KEY,
                JSON.stringify({
                    running: status === 'running',
                    status,
                    jobId,
                    title: extra?.title ?? prev?.title ?? '',
                    error: extra?.error ?? '',
                    startedAt: prev?.startedAt ?? Date.now(),
                    updatedAt: Date.now(),
                })
            );
        } catch {
            // ignore storage failures
        }
        window.dispatchEvent(new Event('edumate:student-quiz-generating'));
    };

    const loadConnectedData = async (opts?: { quiet?: boolean }) => {
        if (!opts?.quiet) setLoading(true);
        try {
            const uid = user?.user_id ?? user?.id ?? user?.userId;
            if (viewerIdStr) {
                try {
                    localStorage.removeItem(STUDENT_QUIZ_RESULT_CACHE_KEY);
                    localStorage.removeItem(STUDENT_SHARED_QUIZ_IDS_KEY);
                } catch {
                    /* ignore */
                }
            }
            const [docsRes, historyRes, publishedRes] = await Promise.allSettled([
                // Ask backend to include moderation-verified materials (some APIs omit them by default).
                api.get('/documents/for-quiz', {
                    params: { audience: 'student', includeVerified: true },
                }),
                api.get('/quizzes/history', {
                    params: {
                        limit: 200,
                        ...(uid != null && uid !== '' ? { userId: uid } : {}),
                    },
                }),
                api.get('/quizzes/published'),
            ]);
            const docsData: any = docsRes.status === 'fulfilled' ? docsRes.value : null;
            const historyData: any = historyRes.status === 'fulfilled' ? historyRes.value : null;
            const publishedData: any = publishedRes.status === 'fulfilled' ? publishedRes.value : null;

            const rowsRaw = Array.isArray(historyData?.data) ? historyData.data : [];
            const historyScoped = Boolean(historyData?.scopedToAttemptUser);
            const cacheRows = readQuizResultCache(viewerIdStr);
            const uidStr = uid != null ? String(uid) : '';
            const rows = rowsRaw.filter((h: any) => {
                if (isQuizMarkedDeleted(h)) return false;
                if (!uidStr) return true;
                if (historyScoped) {
                    const ao = h?.attemptUserId ?? h?.attempt_user_id;
                    if (ao == null || ao === '') return false;
                    return String(ao) === uidStr;
                }
                const owner = h?.userId ?? h?.user_id ?? h?.ownerId ?? h?.studentId;
                if (owner == null || owner === '') return true;
                return String(owner) === uidStr;
            });
            const attemptsByTitle = new Map<string, number>();
            rows.forEach((h: any) => {
                const k = String(h?.title || '').trim().toLowerCase();
                if (!k) return;
                attemptsByTitle.set(k, Number(h?.attemptsCount || 0));
            });

            const docs = Array.isArray(docsData?.data) ? docsData.data : [];
            const mappedAvailable = docs.map((d: any, idx: number) => {
                const modStatus = String(d?.status ?? d?.verificationStatus ?? '')
                    .trim()
                    .toLowerCase();
                const highCred =
                    Boolean(d?.highCredibility) ||
                    modStatus === 'verified' ||
                    String(d?.uploaderRole ?? '')
                        .toLowerCase()
                        .includes('lectur');
                return {
                id: d?.documentId || d?.id || `doc-${idx + 1}`,
                title: d?.title || d?.fileName || `Document ${idx + 1}`,
                subject: d?.courseCode || d?.subjectCode || 'DOC',
                s3Key: d?.s3Key || '',
                instructor:
                    String(d?.uploaderName || d?.uploader_name || d?.uploadedByName || '').trim() ||
                    'Unknown uploader',
                questions: [],
                chunkCount: Number(d?.chunkCount || 0),
                estimatedQuestions: Number(d?.estimatedQuestions || 0) || 5,
                duration: 10,
                myAttempts: Number(
                    d?.attemptsCount ??
                        attemptsByTitle.get(String(d?.title || d?.fileName || '').trim().toLowerCase()) ??
                        0
                ),
                status: 'available',
                documentVerificationStatus: modStatus,
                highCredibility: highCred,
            };
            });
            setAvailableQuizzes(mappedAvailable);

            const mappedCompleted = rows.map((h: any) => {
                const hidAttempt = h?.attemptId ?? h?.lastAttemptId ?? null;
                const hidQuiz = h?.quizId || h?.quiz_id || h?.id;
                const cacheMatch =
                    findQuizResultCacheEntry({ attemptId: hidAttempt, quizId: hidQuiz }, viewerIdStr) ??
                    (hidAttempt != null && hidAttempt !== ''
                        ? cacheRows.find((c) => Number(c.attemptId) === Number(hidAttempt))
                        : null);

                const answersSnapshot = Array.isArray(cacheMatch?.answersSnapshot) ? cacheMatch.answersSnapshot : [];
                const questionsSnapshot = Array.isArray(cacheMatch?.questionsSnapshot) ? cacheMatch.questionsSnapshot : [];
                const cacheTime = Number(cacheMatch?.timeTakenSeconds || 0);

                return {
                    id: hidQuiz,
                    quizId: hidQuiz,
                    resultId: `${hidQuiz}-${hidAttempt ?? 'latest'}`,
                    title: h?.title || 'Quiz',
                    subject: h?.courseCode || h?.subjectCode || 'DOC',
                    instructor: h?.creatorName || 'AI Generated',
                    questions: Array.from({ length: Number(h?.questionCount || h?.total_questions || 5) }).map((_, i) => ({
                        id: `h-q-${i}`,
                        question: '',
                        options: [],
                        correctAnswer: 0,
                    })),
                    duration: 10,
                    durationSeconds: Math.max(0, Number(h?.timeTakenSeconds || h?.time_taken_seconds || 0)),
                    myScore: Number(h?.scorePercent ?? h?.score ?? 0),
                    attempts: Number(h?.attemptsCount || 1),
                    completedDate: h?.lastAttemptAt || h?.createdAt || h?.created_at || '',
                    status: 'completed',
                    isPublished: Boolean(h?.isPublished),
                    sharedForReview: Boolean(h?.sharedForReview ?? h?.sharedFromStudent),
                    sharedAt: h?.sharedAt || h?.shared_at || null,
                    lecturerEdited: Boolean(h?.lecturerEdited),
                    lecturerEditedAt: h?.lecturerEditedAt || null,
                    attemptId: hidAttempt,
                    answersSnapshot,
                    questionsSnapshot,
                    s3Key: cacheMatch?.s3Key || h?.s3Key || h?.sourceKey || '',
                    passPercentage: Number(cacheMatch?.passPercentage ?? h?.passPercentage ?? 70),
                    duration: Number(cacheMatch?.duration ?? 10),
                    timeTakenSeconds: Number(cacheTime || h?.timeTakenSeconds || h?.time_taken_seconds || 0),
                    userAnswers:
                        answersSnapshot.length > 0
                            ? answersSnapshot
                                  .map((a: any) => a?.selectedAnswer)
                                  .filter((x: any) => Number.isFinite(Number(x)))
                            : [],
                };
            });
            setCompletedQuizzes(applySharedFlagsToQuizRows(mergeCompletedWithCache(mappedCompleted, cacheRows), viewerIdStr));
            const editedRows = rows.filter(
                (h: any) =>
                    Boolean(h?.sharedForReview) ||
                    Boolean(h?.sharedFromStudent) ||
                    Boolean(h?.lecturerEdited)
            );
            const mappedEdited = editedRows.map((h: any) => {
                const hidQuiz = Number(h?.quizId || h?.id || 0);
                const fromCompleted = mappedCompleted.find((c: any) => Number(c?.quizId ?? c?.id) === hidQuiz);
                return {
                    ...(fromCompleted || {}),
                    id: hidQuiz || fromCompleted?.id,
                    quizId: hidQuiz || fromCompleted?.quizId,
                    title: h?.title || fromCompleted?.title || 'Quiz',
                    subject: h?.courseCode || fromCompleted?.subject || 'DOC',
                    instructor: fromCompleted?.instructor || 'Lecturer',
                    questions:
                        fromCompleted?.questions ||
                        Array.from({ length: Number(h?.questionCount || 5) }).map((_: any, i: number) => ({
                            id: `edited-q-${i + 1}`,
                            question: '',
                            options: [],
                            correctAnswer: 0,
                        })),
                    duration: Number(fromCompleted?.duration || 10),
                    attempts: Number(h?.attemptsCount ?? fromCompleted?.attempts ?? 0),
                    completedDate: fromCompleted?.completedDate || h?.createdAt || '',
                    status: 'completed',
                    sharedForReview: Boolean(h?.sharedForReview ?? h?.sharedFromStudent ?? true),
                    sharedAt: h?.sharedAt || h?.shared_at || fromCompleted?.sharedAt || null,
                    lecturerEdited: Boolean(h?.lecturerEdited ?? true),
                    lecturerEditedAt: h?.lecturerEditedAt || null,
                    myScore: Number(fromCompleted?.myScore ?? 0),
                    attemptId: fromCompleted?.attemptId ?? null,
                    answersSnapshot: Array.isArray(fromCompleted?.answersSnapshot) ? fromCompleted.answersSnapshot : [],
                    questionsSnapshot: Array.isArray(fromCompleted?.questionsSnapshot) ? fromCompleted.questionsSnapshot : [],
                    timeTakenSeconds: Number(fromCompleted?.timeTakenSeconds || 0),
                    userAnswers: Array.isArray(fromCompleted?.userAnswers) ? fromCompleted.userAnswers : [],
                };
            });
            const editedFromApi = mappedEdited.filter((q: any) => Number.isFinite(Number(q?.quizId || q?.id)));
            if (editedFromApi.length > 0) {
                setEditedQuizzes(editedFromApi);
            } else {
                // Fallback: use history rows tagged by shared-review or lecturer-edited flags.
                setEditedQuizzes(
                    mappedCompleted.filter(
                        (q: any) => Boolean(q?.sharedForReview) || Boolean(q?.sharedFromStudent)
                    )
                );
            }

            const pubRows = Array.isArray(publishedData?.data) ? publishedData.data : [];
            const mappedPublished = pubRows.filter((h: any) => !isQuizMarkedDeleted(h)).map((h: any) => ({
                id: h?.quizId || h?.id,
                title: h?.title || 'Published Quiz',
                subject: h?.courseCode || 'DOC',
                instructor: h?.creatorName || 'Lecturer',
                questions: [],
                estimatedQuestions: Number(h?.questionCount || 0) || 5,
                duration: 10,
                attempts: Number(h?.attemptsCount ?? 0),
                createdDate: h?.publishedAt || h?.createdAt || '',
                status: 'published',
                isPublished: true,
            }));
            setPracticeQuizzes(mappedPublished);
        } catch {
            setAvailableQuizzes([]);
            setCompletedQuizzes([]);
            setEditedQuizzes([]);
            setPracticeQuizzes([]);
        } finally {
            if (!opts?.quiet) setLoading(false);
        }
    };

    const historyUserKey = user?.user_id ?? user?.id ?? user?.userId;

    useEffect(() => {
        loadConnectedData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [historyUserKey]);

    useEffect(() => {
        let cancelled = false;
        const runAutoStart = async () => {
            try {
                const raw = localStorage.getItem(STUDENT_QUIZ_AUTOSTART_KEY);
                if (!raw) return;
                const payload = JSON.parse(raw);
                const quizId = Number(payload?.quizId);
                if (!Number.isFinite(quizId) || quizId <= 0) {
                    localStorage.removeItem(STUDENT_QUIZ_AUTOSTART_KEY);
                    return;
                }
                const detailRes = await api.get(`/quizzes/${quizId}`);
                if (cancelled) return;
                const detail = unwrapQuizDetailPayload(detailRes);
                const questions = normalizeStoredQuestions(detail.questions || []);
                if (!questions.length) return;
                const generatedQuiz = {
                    id: detail.quiz_id || quizId,
                    title: detail.title || payload?.title || 'Quiz',
                    questions,
                    duration: finiteQuizMinutes(
                        detail.duration_minutes ?? payload?.duration ?? 10,
                        10
                    ),
                    passPercentage: finitePassPercent(payload?.passPercentage ?? 70, 70),
                    isPublished: false,
                };
                void recordAttemptStart(generatedQuiz.id);
                if (cancelled) return;
                localStorage.removeItem(STUDENT_QUIZ_AUTOSTART_KEY);
                setSelectedQuiz(generatedQuiz);
                setCurrentQuestionIndex(0);
                setAnswers([]);
                setTimeRemaining((generatedQuiz.duration || 10) * 60);
                setQuizStartedAtMs(Date.now());
                setShowQuizTaking(true);
                const timer = setInterval(() => {
                    setTimeRemaining((prev) => {
                        if (prev <= 1) {
                            clearInterval(timer);
                            handleSubmitQuiz(true);
                            return 0;
                        }
                        return prev - 1;
                    });
                }, 1000);
                setTimerId(timer);
            } catch (err: any) {
                const status = Number(err?.response?.status || 0);
                // If quiz id is stale/non-existent, clear autostart key to avoid repeated 404.
                if (status === 404) {
                    localStorage.removeItem(STUDENT_QUIZ_AUTOSTART_KEY);
                }
            }
        };
        void runAutoStart();
        const onAutostart = () => void runAutoStart();
        window.addEventListener(STUDENT_QUIZ_AUTOSTART_EVENT, onAutostart);
        return () => {
            cancelled = true;
            window.removeEventListener(STUDENT_QUIZ_AUTOSTART_EVENT, onAutostart);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const currentTabQuizzes = useMemo(() => {
        if (activeTab === 'available') return availableQuizzes;
        if (activeTab === 'completed') return completedQuizzes;
        if (activeTab === 'edited') return editedQuizzes;
        return practiceQuizzes;
    }, [activeTab, availableQuizzes, completedQuizzes, editedQuizzes, practiceQuizzes]);

    const subjectOptions = useMemo(() => {
        const set = new Set<string>();
        [...availableQuizzes, ...completedQuizzes, ...editedQuizzes, ...practiceQuizzes].forEach((q) => {
            const s = String(q?.subject ?? '').trim();
            if (s) set.add(s);
        });
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }, [availableQuizzes, completedQuizzes, editedQuizzes, practiceQuizzes]);

    useEffect(() => {
        if (filterSubject !== 'all' && !subjectOptions.includes(filterSubject)) {
            setFilterSubject('all');
        }
    }, [filterSubject, subjectOptions]);

    const filteredQuizzes = () => {
        return currentTabQuizzes.filter((quiz) => {
            const matchesSearch = quizMatchesSearchQuery(quiz as Record<string, unknown>, searchQuery);
            const subj = String(quiz?.subject ?? '');
            const matchesSubject = filterSubject === 'all' || subj === filterSubject;
            return matchesSearch && matchesSubject;
        });
    };

    const hasActiveFilters = Boolean(searchQuery.trim()) || filterSubject !== 'all';

    const safeQuizQuestions = Array.isArray(selectedQuiz?.questions) ? selectedQuiz.questions : [];

    const openQuizTakingSession = (quiz: any) => {
        if (!quiz) return;
        if (timerId) {
            clearInterval(timerId);
            setTimerId(null);
        }
        setShowResults(false);
        const resolvedId = coercePositiveQuizId(quiz?.quizId ?? quiz?.id);
        const normalizedQuiz =
            resolvedId != null ? { ...quiz, id: resolvedId, quizId: resolvedId } : quiz;
        setSelectedQuiz(normalizedQuiz);
        setCurrentQuestionIndex(0);
        setAnswers([]);
        setTimeRemaining((finiteQuizMinutes(quiz?.duration, 10) || 10) * 60);
        setQuizStartedAtMs(Date.now());
        setShowQuizTaking(true);
        const timer = setInterval(() => {
            setTimeRemaining((prev) => {
                if (prev <= 1) {
                    clearInterval(timer);
                    handleSubmitQuiz(true);
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
        setTimerId(timer);
    };

    const regenerateQuizQuestions = async (opts: {
        s3Key: string;
        title?: string;
        numQuestions?: number;
    }): Promise<{ quizId: number; questions: any[] } | null> => {
        const createdBy = Number(user?.user_id ?? user?.id ?? user?.userId);
        if (!Number.isFinite(createdBy) || createdBy <= 0) return null;
        const token = getStoredAuthToken();
        const base = getApiBaseUrl().replace(/\/$/, '');
        const resp = await fetch(`${base}/quiz/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
                s3Key: opts.s3Key,
                persist: true,
                quizTitle: opts.title,
                numQuestions: opts.numQuestions ?? 5,
                language: 'English',
                createdBy,
            }),
        });
        let res: any = null;
        try {
            res = await resp.json();
        } catch {
            res = null;
        }
        if (!resp.ok || (res && res.success === false)) return null;
        const quizData = res?.data || res || {};
        const questions = normalizeQuestions(quizData?.quiz || res?.quiz || []);
        const quizId = Number(quizData?.quizId ?? res?.quizId);
        if (!questions.length || !Number.isFinite(quizId) || quizId <= 0) return null;
        return { quizId, questions };
    };

    const resolveQuestionsForQuizRow = async (quizRow: any): Promise<{
        questions: any[];
        detail: ReturnType<typeof unwrapQuizDetailPayload> | null;
        cache: QuizResultCacheItem | null;
        regeneratedQuizId?: number;
    }> => {
        const quizId = Number(quizRow?.quizId ?? quizRow?.id);
        const cache = findQuizResultCacheEntry(
            {
                attemptId: (quizRow as any)?.attemptId,
                quizId: Number.isFinite(quizId) ? quizId : undefined,
            },
            viewerIdStr
        );
        const snapshotRaw =
            (Array.isArray((quizRow as any)?.questionsSnapshot) && (quizRow as any).questionsSnapshot.length
                ? (quizRow as any).questionsSnapshot
                : null) ??
            (Array.isArray(cache?.questionsSnapshot) && cache.questionsSnapshot.length
                ? cache.questionsSnapshot
                : null);
        if (snapshotRaw) {
            const fromSnap = normalizeStoredQuestions(snapshotRaw);
            if (fromSnap.length) return { questions: fromSnap, detail: null, cache };
        }

        let detail: ReturnType<typeof unwrapQuizDetailPayload> | null = null;
        if (Number.isFinite(quizId) && quizId > 0) {
            try {
                const detailRes = await api.get(`/quizzes/${quizId}`);
                detail = unwrapQuizDetailPayload(detailRes);
                const fromApi = normalizeStoredQuestions(detail.questions || []);
                if (fromApi.length) return { questions: fromApi, detail, cache };
            } catch {
                detail = null;
            }
        }

        const placeholderQs = normalizeStoredQuestions(
            (Array.isArray(quizRow?.questions) ? quizRow.questions : []) as any[]
        ).filter((q) => String(q?.question || '').trim().length > 0);
        if (placeholderQs.length) return { questions: placeholderQs, detail, cache };

        const s3Key = String(quizRow?.s3Key || cache?.s3Key || '').trim();
        if (s3Key) {
            const regen = await regenerateQuizQuestions({
                s3Key,
                title: String(quizRow?.title || cache?.title || 'Quiz'),
                numQuestions: numQuestionsForGenerate(quizRow),
            });
            if (regen) {
                return {
                    questions: regen.questions,
                    detail: null,
                    cache,
                    regeneratedQuizId: regen.quizId,
                };
            }
        }

        return { questions: [], detail, cache };
    };

    const isPublishedLecturerQuiz = (quizRow?: any) => {
        const row = quizRow || selectedQuiz;
        if (!row) return false;
        if (String((row as any)?.s3Key || '').trim()) return false;
        if (Boolean((row as any)?.isPublished)) return true;
        const res = quizResult;
        if (res && (res as any).isPractice === false && !String((row as any)?.s3Key || '').trim()) {
            return true;
        }
        return false;
    };

    const isQuizAlreadyShared = (quizRow?: any) => {
        const qid = resolveStudentQuizId(quizRow || selectedQuiz);
        if (!qid) return rowHasSharedFlags(quizRow) || rowHasSharedFlags(selectedQuiz);
        if (readSharedQuizIdMap(viewerIdStr).has(qid)) return true;
        if (rowHasSharedFlags(quizRow)) return true;
        return completedQuizzes.some(
            (q) => resolveStudentQuizId(q) === qid && rowHasSharedFlags(q)
        );
    };

    const markQuizSharedForStudent = (quizId: number, sharedAt: string) => {
        const qid = Number(quizId);
        if (!Number.isFinite(qid) || qid <= 0) return;
        const at = String(sharedAt || '').trim() || new Date().toISOString();
        markQuizSharedInStorage(qid, at, viewerIdStr);
        const withFlags = (row: any) => ({
            ...row,
            sharedForReview: true,
            sharedFromStudent: true,
            sharedAt: String(row?.sharedAt || '').trim() || at,
        });
        setCompletedQuizzes((prev) =>
            prev.map((q) => (resolveStudentQuizId(q) === qid ? withFlags(q) : q))
        );
        setSelectedQuiz((prev) =>
            prev && resolveStudentQuizId(prev) === qid ? withFlags(prev) : prev
        );
    };

    const canShareQuizWithLecturer = (quizRow?: any) => {
        const row = quizRow || selectedQuiz;
        if (!row) return false;
        if (isQuizAlreadyShared(row)) return false;
        if (isPublishedLecturerQuiz(row)) return false;
        return true;
    };

    const syncAttemptBeforeShare = async (quizRow: any): Promise<number | null> => {
        const existing = Number((quizRow as any)?.attemptId);
        if (Number.isFinite(existing) && existing > 0) return existing;

        const quizId = coercePositiveQuizId((quizRow as any)?.quizId ?? quizRow?.id);
        if (quizId == null) return null;

        const answersSource: QuizAnswer[] = Array.isArray(quizResult?.answers)
            ? quizResult.answers
            : Array.isArray((quizRow as any)?.answersSnapshot)
              ? normalizeReviewAnswers((quizRow as any).answersSnapshot)
              : [];
        if (!answersSource.length) return null;

        const textTrim = (s: string) => String(s || '').trim();
        const answersForSubmit = answersSource.map((a) => ({
            questionId: a.questionId,
            ...(Number.isFinite(Number(a.selectedAnswer)) && Number(a.selectedAnswer) >= 0
                ? { selectedAnswer: a.selectedAnswer }
                : {}),
            ...(textTrim(a.selectedText || '')
                ? {
                      userAnswer: textTrim(a.selectedText || ''),
                      shortAnswer: textTrim(a.selectedText || ''),
                      user_answer: textTrim(a.selectedText || ''),
                  }
                : {}),
        }));

        try {
            const attemptRes: any = await api.post('/quiz/attempts', {
                quizId,
                quiz_id: quizId,
                userId: user?.user_id ?? user?.id ?? user?.userId,
                user_id: user?.user_id ?? user?.id ?? user?.userId,
                score: (() => {
                    const s = Number(quizResult?.score ?? (quizRow as any)?.myScore ?? 0);
                    return Number.isFinite(s) && s >= 0 ? s : 0;
                })(),
                answers: answersForSubmit,
                timeTaken: Number(
                    quizResult?.timeTaken ??
                        (quizRow as any)?.timeTakenSeconds ??
                        (quizRow as any)?.durationSeconds ??
                        0
                ),
                phase: 'complete',
            });
            const payload = attemptRes?.data ?? attemptRes;
            const responseData =
                payload?.data && typeof payload.data === 'object' ? payload.data : payload;
            const createdAttemptId =
                responseData?.attemptId ?? payload?.attemptId ?? attemptRes?.attemptId ?? null;
            const n = Number(createdAttemptId);
            return Number.isFinite(n) && n > 0 ? n : null;
        } catch (err) {
            console.warn('[syncAttemptBeforeShare] failed:', err);
            return null;
        }
    };

    const shareQuizWithLecturer = async (quizRow?: any) => {
        const row = quizRow || selectedQuiz;
        const quizId = coercePositiveQuizId((row as any)?.quizId ?? row?.id);
        const resultKey = String((row as any)?.resultId || '').trim();

        if (isQuizAlreadyShared(row)) {
            showNotification({
                type: 'info',
                title: 'Share Quiz',
                message: 'This quiz was already shared with your lecturer.',
            });
            return;
        }
        if (isPublishedLecturerQuiz(row)) {
            showNotification({
                type: 'info',
                title: 'Share Quiz',
                message:
                    'Published lecturer quizzes cannot be shared. Complete a quiz from your own document (Available tab) to share with your lecturer.',
            });
            return;
        }

        if (quizId == null) {
            showNotification({
                type: 'warning',
                title: 'Share Quiz',
                message: 'Quiz identifier is missing.',
            });
            return;
        }

        const confirmed = await showConfirm({
            title: 'Share with lecturer',
            message:
                'Send this quiz attempt to your lecturer for review? They can view your answers and leave comments.',
            confirmText: 'Share',
            cancelText: 'Cancel',
            type: 'info',
        });
        if (!confirmed) return;

        setSharingQuiz(true);
        try {
            const syncedAttemptId = await syncAttemptBeforeShare(row);
            if (syncedAttemptId != null) {
                setSelectedQuiz((prev) =>
                    prev ? { ...prev, attemptId: syncedAttemptId } : prev
                );
                setCompletedQuizzes((prev) =>
                    prev.map((q) => {
                        const sameResult =
                            resultKey && String((q as any)?.resultId || '').trim() === resultKey;
                        const sameQuizNoResult =
                            !resultKey && Number((q as any)?.quizId ?? q?.id) === quizId;
                        if (!sameResult && !sameQuizNoResult) return q;
                        return { ...q, attemptId: syncedAttemptId };
                    })
                );
            }

            const res: any = await api.post(`/quizzes/${quizId}/share`, {});
            if (res?.success === false) {
                showNotification({
                    type: 'warning',
                    title: 'Share Quiz',
                    message: String(res?.message || 'Could not share quiz.'),
                });
                return;
            }

            const sharedAt = new Date().toISOString();
            showNotification({
                type: 'success',
                title: 'Quiz shared',
                message: String(res?.message || 'Your quiz was shared with your lecturer successfully.'),
            });
            markQuizSharedForStudent(quizId, sharedAt);
            void loadResultComments(row);
            void loadConnectedData({ quiet: true });
        } catch (err: unknown) {
            const status = Number((err as any)?.response?.status || 0);
            const apiMsg = getApiErrorMessage(err);
            if (status === 409) {
                showNotification({
                    type: 'info',
                    title: 'Already shared',
                    message: apiMsg || 'This quiz was already shared with your lecturer.',
                });
                markQuizSharedForStudent(quizId, new Date().toISOString());
                void loadResultComments(row);
            } else if (status === 403) {
                showNotification({
                    type: 'warning',
                    title: 'Share not allowed',
                    message:
                        apiMsg ||
                        'Access denied. Sign in as a student with a verified account, or complete the quiz before sharing.',
                });
            } else {
                showNotification({
                    type: 'warning',
                    title: 'Share failed',
                    message:
                        apiMsg ||
                        'Could not share quiz. Finish the quiz first so your attempt is saved, then try again.',
                });
            }
        } finally {
            setSharingQuiz(false);
        }
    };

    const retakeQuiz = async (quizRow: any) => {
        if (isGeneratingQuiz) return;

        try {
            const { questions, detail, cache, regeneratedQuizId } = await resolveQuestionsForQuizRow(quizRow);
            if (!questions.length) {
                showNotification({
                    type: 'warning',
                    title: 'Retake Quiz',
                    message: 'This quiz has no questions available to retake.',
                });
                return;
            }

        const quizId = coercePositiveQuizId(
            regeneratedQuizId ?? detail?.quiz_id ?? quizRow?.quizId ?? quizRow?.id ?? cache?.quizId
        );
        if (quizId == null) {
            showNotification({
                type: 'warning',
                title: 'Retake Quiz',
                message: 'Could not resolve a valid quiz id for this quiz.',
            });
            return;
        }

        const quizToTake = {
                ...stripCompletedAttemptFields(quizRow),
                id: quizId,
                quizId,
                title: detail?.title || quizRow?.title || cache?.title || selectedQuiz?.title || 'Quiz',
                questions,
                s3Key: String(quizRow?.s3Key || cache?.s3Key || '').trim() || undefined,
                passPercentage: finitePassPercent(
                    detail?.pass_percentage ??
                        (detail as any)?.passPercentage ??
                        (quizRow as any)?.passPercentage ??
                        cache?.passPercentage ??
                        70,
                    70
                ),
                duration: finiteQuizMinutes(
                    detail?.duration_minutes ??
                        (detail as any)?.duration ??
                        (quizRow as any)?.duration ??
                        cache?.duration ??
                        10,
                    10
                ),
                isRetake: true,
            };

            void recordAttemptStart(quizToTake.id);
            openQuizTakingSession(quizToTake);
        } catch (err: unknown) {
            console.error('[retakeQuiz] failed:', err);
            showNotification({
                type: 'warning',
                title: 'Retake Quiz',
                message: safeNotificationMessage(err, 'quizStart'),
            });
        }
    };

    const recordAttemptStart = async (quizId: string | number | undefined) => {
        const id = coercePositiveQuizId(quizId);
        if (id == null) return;

        try {
            console.log('[recordAttemptStart] payload =', {
                quizId: id,
                userId: user?.user_id ?? user?.id ?? user?.userId,
                phase: 'start',
            });

            await api.post('/quiz/attempts', {
                quizId: id,
                quiz_id: id,
                userId: user?.user_id ?? user?.id ?? user?.userId,
                user_id: user?.user_id ?? user?.id ?? user?.userId,
                phase: 'start',
            });
            // Refresh list in background; do not block opening the quiz modal.
            void loadConnectedData({ quiet: true });
        } catch (err: unknown) {
            console.warn('[recordAttemptStart] failed (quiz can still open):', err, getApiErrorMessage(err));
        }
    };

    const startQuiz = async (quiz: any) => {
        if (isGeneratingQuiz) return;
        try {
            if (!quiz?.s3Key && quiz?.id) {
                const detailRes = await api.get(`/quizzes/${quiz.id}`);
                const detail = unwrapQuizDetailPayload(detailRes);
                const questions = normalizeStoredQuestions(detail.questions || []);
                if (!questions.length) {
                    showNotification({
                        type: 'warning',
                        title: 'Take Quiz',
                        message: 'This quiz has no published questions yet.',
                    });
                    return;
                }
                const resolvedId = coercePositiveQuizId(detail.quiz_id ?? quiz.id);
                if (resolvedId == null) {
                    showNotification({
                        type: 'warning',
                        title: 'Take Quiz',
                        message: 'Could not resolve a valid quiz id for this quiz.',
                    });
                    return;
                }
                const generatedQuiz = {
                    ...quiz,
                    id: resolvedId,
                    quizId: resolvedId,
                    title: detail.title || quiz.title,
                    questions,
                    passPercentage: finitePassPercent(
                        detail.pass_percentage ??
                            (detail as any)?.passPercentage ??
                            quiz.passPercentage ??
                            70,
                        70
                    ),
                    duration: finiteQuizMinutes(
                        detail.duration_minutes ?? (detail as any)?.duration ?? quiz.duration ?? 10,
                        10
                    ),
                };
                void recordAttemptStart(generatedQuiz.id);
                openQuizTakingSession(generatedQuiz);
                return;
            }

            if (!quiz?.s3Key) {
                showNotification({
                    type: 'warning',
                    title: 'Generate Quiz',
                    message: 'Document reference (s3Key) is missing.',
                });
                return;
            }
            const newJobId = `quiz-gen-${Date.now()}`;
            setQuizGeneratingStatus('running', {
                jobId: newJobId,
                title: String(quiz?.title || 'AI Quiz'),
            });
            setShowQuizTaking(false);
            setShowResults(false);
            const createdBy = Number(user?.user_id ?? user?.id ?? user?.userId);
            if (!Number.isFinite(createdBy) || createdBy <= 0) {
                setQuizGeneratingStatus('failed', {
                    jobId: newJobId,
                    title: String(quiz?.title || 'AI Quiz'),
                    error: 'Your account is missing required information. Please sign in again.',
                });
                showNotification({
                    type: 'warning',
                    title: 'Generate Quiz',
                    message: 'Your account is missing required information. Please sign in again.',
                });
                return;
            }
            const payload = {
                s3Key: quiz?.s3Key,
                persist: true,
                quizTitle: quiz?.title,
                numQuestions: numQuestionsForGenerate(quiz),
                language: 'English',
                createdBy,
            };
            const token = getStoredAuthToken();
            const base = getApiBaseUrl().replace(/\/$/, '');
            const resp = await fetch(`${base}/quiz/generate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify(payload),
            });
            let res: any = null;
            try {
                res = await resp.json();
            } catch {
                res = null;
            }
            if (!resp.ok) {
                const errorLike = { response: { status: resp.status, data: res } };
                throw errorLike;
            }
            if (res && (res as any).success === false) {
                setQuizGeneratingStatus('failed', {
                    jobId: newJobId,
                    title: String(quiz?.title || 'AI Quiz'),
                    error: safeNotificationMessage(null, 'quizGenerate'),
                });
                showNotification({
                    type: 'warning',
                    title: 'Generate Quiz',
                    message: safeNotificationMessage(null, 'quizGenerate'),
                });
                return;
            }
            const quizData = (res as any)?.data || (res as any) || {};

            const questions = normalizeQuestions(quizData?.quiz || (res as any)?.quiz || []);
            if (!questions.length) {
                showNotification({
                    type: 'warning',
                    title: 'Generate Quiz',
                    message: 'No question returned from AI for this document.',
                });
                setQuizGeneratingStatus('failed', {
                    jobId: newJobId,
                    title: String(quiz?.title || 'AI Quiz'),
                    error: 'No question returned from AI for this document.',
                });
                return;
            }
            const persistedQuizId = quizData?.quizId ?? (res as any)?.quizId;

            if (!persistedQuizId) {
                showNotification({
                    type: 'warning',
                    title: 'Generate Quiz',
                    message: 'Quiz was generated but backend did not return a persisted quizId.',
                });
                setQuizGeneratingStatus('failed', {
                    jobId: newJobId,
                    title: String(quiz?.title || 'AI Quiz'),
                    error: 'Quiz was generated but backend did not return a persisted quizId.',
                });
                return;
            }

            const resolvedPersistId = coercePositiveQuizId(persistedQuizId);
            if (resolvedPersistId == null) {
                showNotification({
                    type: 'warning',
                    title: 'Generate Quiz',
                    message: 'Backend returned an invalid quiz id after generation.',
                });
                setQuizGeneratingStatus('failed', {
                    jobId: newJobId,
                    title: String(quiz?.title || 'AI Quiz'),
                    error: 'Invalid quiz id from server.',
                });
                return;
            }

            const finalQuestions = questions;

            const generatedQuiz = {
                ...quiz,
                id: resolvedPersistId,
                quizId: resolvedPersistId,
                questions: finalQuestions,
                passPercentage: Number(quiz.passPercentage ?? 70),
            };

            void recordAttemptStart(generatedQuiz.id);
            setSelectedQuiz(generatedQuiz);
            setCurrentQuestionIndex(0);
            setAnswers([]);
            setTimeRemaining((generatedQuiz.duration || 10) * 60);
            setQuizStartedAtMs(Date.now());
            setShowQuizTaking(true);
            setQuizGeneratingStatus('completed', {
                jobId: newJobId,
                title: String(quiz?.title || 'AI Quiz'),
                quizId: resolvedPersistId,
            });
            try {
                localStorage.setItem(
                    STUDENT_QUIZ_AUTOSTART_KEY,
                    JSON.stringify({
                        quizId: resolvedPersistId,
                        title: String(quiz?.title || 'AI Quiz'),
                        passPercentage: Number(quiz.passPercentage ?? 70),
                        duration: Number(generatedQuiz.duration || 10),
                        updatedAt: Date.now(),
                    })
                );
                window.dispatchEvent(new Event(STUDENT_QUIZ_AUTOSTART_EVENT));
            } catch {
                // ignore storage failures
            }

            const timer = setInterval(() => {
                setTimeRemaining((prev) => {
                    if (prev <= 1) {
                        clearInterval(timer);
                        handleSubmitQuiz(true);
                        return 0;
                    }
                    return prev - 1;
                });
            }, 1000);
            setTimerId(timer);
        } catch (err: unknown) {
            const status = Number((err as any)?.response?.status);
            setQuizGeneratingStatus('failed', {
                title: String(quiz?.title || 'AI Quiz'),
                error:
                    status === 429
                        ? 'Too many requests. Please wait a moment and try again.'
                        : safeNotificationMessage(err, 'quizGenerate'),
            });
            showNotification({
                type: 'warning',
                title: 'Generate Quiz',
                message:
                    status === 429
                        ? 'Too many requests. Please wait a moment and try again.'
                        : safeNotificationMessage(err, 'quizGenerate'),
            });
        }
    };

    // Cleanup timer on unmount
    useEffect(() => {
        return () => {
            if (timerId) {
                clearInterval(timerId);
            }
        };
    }, [timerId]);

    const handleAnswerSelect = (questionId: string, answerIndex: number) => {
        setAnswers((prev) => {
            const existing = prev.find((a) => a.questionId === questionId);
            if (existing) {
                return prev.map((a) =>
                    a.questionId === questionId ? { ...a, selectedAnswer: answerIndex, selectedText: '' } : a
                );
            }
            return [...prev, { questionId, selectedAnswer: answerIndex, selectedText: '' }];
        });
    };

    const handleShortAnswerChange = (questionId: string, text: string) => {
        setAnswers((prev) => {
            const existing = prev.find((a) => a.questionId === questionId);
            if (existing) {
                return prev.map((a) =>
                    a.questionId === questionId ? { ...a, selectedAnswer: -1, selectedText: text } : a
                );
            }
            return [...prev, { questionId, selectedAnswer: -1, selectedText: text }];
        });
    };

    const handleSubmitQuiz = async (autoSubmit = false) => {
        if (!selectedQuiz || !safeQuizQuestions.length) {
            showNotification({
                type: 'warning',
                title: 'Submit Quiz',
                message: 'Quiz data is not ready yet.',
            });
            return;
        }
        if (!autoSubmit) {
            const confirmed = await showConfirm({
                title: 'Submit Quiz',
                message: 'Are you sure you want to submit your quiz? You cannot change your answers after submission.',
                confirmText: 'Submit',
                cancelText: 'Continue Quiz',
                type: 'warning',
            });
            if (!confirmed) return;
        }

        if (timerId) {
            clearInterval(timerId);
            setTimerId(null);
        }

        // Use current answers state (correct for active quiz taking)
        let correctCount = 0;
        const questions = safeQuizQuestions;
        questions.forEach((q: any) => {
            const qt = String(q?.questionType || '').toLowerCase();
            const userAnswer = answers.find((a) => String(a.questionId) === String(q.id));
            if (qt === 'short-answer') {
                const expected = String(q?.correctText ?? '').trim();
                const got = String(userAnswer?.selectedText || '').trim();
                if (
                    got &&
                    normalizeShortAnswerTextClient(got) === normalizeShortAnswerTextClient(expected)
                ) {
                    correctCount++;
                }
                return;
            }
            if (userAnswer && userAnswer.selectedAnswer === q.correctAnswer) {
                correctCount++;
            }
        });

        const score = Math.round((correctCount / questions.length) * 100);
        const isPractice = !Boolean(selectedQuiz?.isPublished);
        const passThreshold = isPractice
            ? null
            : Math.max(
                1,
                Math.min(100, Number(selectedQuiz?.passPercentage ?? selectedQuiz?.pass_percentage ?? 70))
            );
        const passed = isPractice ? null : score >= Number(passThreshold);

        const durationMinutes = Number(selectedQuiz.duration) || 10;
        const plannedSeconds = Math.max(0, Math.floor(durationMinutes * 60));
        const elapsedByTimer = Math.max(0, plannedSeconds - Math.max(0, Number(timeRemaining) || 0));
        const elapsedByClock = quizStartedAtMs ? Math.max(0, Math.floor((Date.now() - quizStartedAtMs) / 1000)) : 0;
        const resolvedTimeTaken = elapsedByClock > 0 ? elapsedByClock : elapsedByTimer;

        const resultId = `${selectedQuiz.id}-${Date.now()}`;
        const result = {
            quizId: selectedQuiz.id,
            resultId,
            score,
            correctAnswers: correctCount,
            totalQuestions: questions.length,
            timeTaken: resolvedTimeTaken,
            answers: answers,
            completedDate: new Date().toISOString(),
            isPractice,
            passThreshold,
            passed,
        };
        appendQuizResultCache(
            {
            attemptId: null,
            quizId: Number(selectedQuiz.id),
            resultId,
            answersSnapshot: answers,
            questionsSnapshot: safeQuizQuestions,
            timeTakenSeconds: Number(result.timeTaken || 0),
            savedAt: Date.now(),
            s3Key: String(selectedQuiz?.s3Key || '').trim() || undefined,
            title: String(selectedQuiz?.title || '').trim() || undefined,
            passPercentage: Number(selectedQuiz?.passPercentage ?? 70),
            duration: Number(selectedQuiz?.duration ?? 10),
            myScore: score,
            },
            viewerIdStr
        );

        setQuizResult(result);
        setShowQuizTaking(false);

        const submitQuizId = resolveStudentQuizId(selectedQuiz);
        const priorSharedAt =
            submitQuizId != null ? readSharedQuizIdMap(viewerIdStr).get(submitQuizId) : undefined;
        const alreadySharedQuiz =
            Boolean(priorSharedAt) ||
            (submitQuizId != null &&
                completedQuizzes.some(
                    (q) => resolveStudentQuizId(q) === submitQuizId && rowHasSharedFlags(q)
                ));

        const completedRow = {
            ...selectedQuiz,
            isPublished: false,
            isRetake: undefined,
            attemptId: null,
            myScore: score,
            attempts: Number((selectedQuiz as any)?.attempts ?? selectedQuiz.myAttempts ?? 0) + 1,
            completedDate: result.completedDate,
            status: 'completed',
            resultId: result.resultId,
            durationSeconds: Number(result.timeTaken || 0),
            timeTakenSeconds: Number(result.timeTaken || 0),
            userAnswers: answers.map((a) => a.selectedAnswer),
            answersSnapshot: answers,
            questionsSnapshot: safeQuizQuestions,
            ...(alreadySharedQuiz
                ? {
                      sharedForReview: true,
                      sharedFromStudent: true,
                      sharedAt: priorSharedAt || new Date().toISOString(),
                  }
                : {}),
        };

        if (activeTab === 'available' || activeTab === 'completed' || Boolean((selectedQuiz as any)?.isRetake)) {
            setCompletedQuizzes((prev) => [completedRow, ...prev]);
        } else if (activeTab === 'my-practice') {
            setPracticeQuizzes((prev) =>
                prev.map((q) =>
                    q.id === selectedQuiz.id ? { ...q, myScore: score } : q
                )
            );
        }

        showNotification({
            type: 'success',
            title: 'Quiz Submitted!',
            message: isPractice
                ? `You scored ${score}%. ${correctCount} out of ${questions.length} correct.`
                : `You scored ${score}%. ${correctCount} out of ${questions.length} correct. ${passed ? 'Pass — you met the required score.' : `Not passed — need at least ${passThreshold}%.`}`,
            duration: 6000,
        });

        setShowResults(true);
        setQuizStartedAtMs(null);

        try {
            const scorePercent = score;
            const textTrim = (s: string) => String(s || '').trim();
            const answersForSubmit = answers.map((a) => ({
                questionId: a.questionId,
                ...(Number.isFinite(Number(a.selectedAnswer)) && Number(a.selectedAnswer) >= 0
                    ? { selectedAnswer: a.selectedAnswer }
                    : {}),
                ...(textTrim(a.selectedText || '')
                    ? {
                          userAnswer: textTrim(a.selectedText || ''),
                          shortAnswer: textTrim(a.selectedText || ''),
                          user_answer: textTrim(a.selectedText || ''),
                      }
                    : {}),
            }));
            const scorePayload = Number(scorePercent);
            const safeScore = Number.isFinite(scorePayload) && scorePayload >= 0 ? scorePayload : 0;
            const quizIdNum = coercePositiveQuizId((selectedQuiz as any)?.quizId ?? selectedQuiz?.id);
            if (quizIdNum == null) {
                console.warn('[handleSubmitQuiz] skip attempt save: invalid quiz id', selectedQuiz?.id);
                showNotification({
                    type: 'warning',
                    title: 'Quiz result not saved',
                    message:
                        'Could not save your attempt because the quiz id is invalid. Try starting the quiz again from Available quizzes.',
                });
                await loadConnectedData({ quiet: true });
                return;
            }
            const uidForAttempt = user?.user_id ?? user?.id ?? user?.userId;
            const attemptRes: any = await api.post('/quiz/attempts', {
                quizId: quizIdNum,
                quiz_id: quizIdNum,
                userId: uidForAttempt,
                user_id: uidForAttempt,
                score: safeScore,
                answers: answersForSubmit,
                timeTaken: result.timeTaken,
                phase: 'complete',
            });
            const payload = attemptRes?.data ?? attemptRes;
            const responseData =
                payload?.data && typeof payload.data === 'object' ? payload.data : payload;
            const serverGraded = responseData?.result ?? payload?.result;
            if (serverGraded && typeof serverGraded.score === 'number') {
                const srvScore = Number(serverGraded.score);
                const srvCorrect = Number(serverGraded.correct_count ?? result.correctAnswers);
                const srvTotal = Number(serverGraded.total_questions ?? result.totalQuestions);
                const passedSrv =
                    !result.isPractice && srvScore >= Number(result.passThreshold ?? passThreshold ?? 70);
                const expMap =
                    serverGraded.explanationsByQuestionId ?? serverGraded.explanations;
                setQuizResult((prev) => {
                    if (!prev) return prev;
                    const next: Record<string, unknown> = {
                        ...prev,
                        score: srvScore,
                        correctAnswers: srvCorrect,
                        totalQuestions: srvTotal,
                        passed: result.isPractice ? prev.passed : passedSrv,
                    };
                    if (
                        expMap &&
                        typeof expMap === 'object' &&
                        !Array.isArray(expMap) &&
                        Object.keys(expMap as object).length
                    ) {
                        next.explanationsByQuestionId = expMap as Record<string, string>;
                    }
                    return next;
                });
            }
            const createdAttemptId =
                responseData?.attemptId ??
                payload?.attemptId ??
                attemptRes?.attemptId ??
                null;
            if (createdAttemptId != null) {
                const serverResultId = `${quizIdNum}-${createdAttemptId}`;
                appendQuizResultCache(
                    {
                    attemptId: Number(createdAttemptId),
                    quizId: quizIdNum,
                    resultId: serverResultId,
                    answersSnapshot: answers,
                    questionsSnapshot: safeQuizQuestions,
                    timeTakenSeconds: Number(result.timeTaken || 0),
                    savedAt: Date.now(),
                    s3Key: String(selectedQuiz?.s3Key || '').trim() || undefined,
                    title: String(selectedQuiz?.title || '').trim() || undefined,
                    passPercentage: Number(selectedQuiz?.passPercentage ?? 70),
                    duration: Number(selectedQuiz?.duration ?? 10),
                    myScore: Number((quizResult as any)?.score ?? result.score),
                    },
                    viewerIdStr
                );
                const nowIso = new Date().toISOString();
                const scorePct = Number((quizResult as any)?.score ?? result.score);
                setCompletedQuizzes((prev) =>
                    prev.map((q) => {
                        if (String((q as any)?.resultId || '') !== String(result.resultId)) return q;
                        return {
                            ...q,
                            attemptId: createdAttemptId,
                            resultId: serverResultId,
                            ...(Number.isFinite(scorePct) ? { myScore: Math.round(scorePct) } : {}),
                            completedDate: (q as any)?.completedDate ?? nowIso,
                            answersSnapshot: answers,
                            questionsSnapshot: safeQuizQuestions,
                        };
                    })
                );
                setQuizResult((prev) =>
                    prev ? { ...prev, resultId: serverResultId } : prev
                );
            }
            await loadConnectedData({ quiet: true });
        } catch (err) {
            console.error('[handleSubmitQuiz] save attempt failed:', err, getApiErrorMessage(err));
        showNotification({
            type: 'warning',
            title: 'Quiz result not saved',
            message: safeNotificationMessage(err, 'attemptRecord'),
        });
        }
    };

    const renderAvailableQuizzes = () => (
        <div className="space-y-4">
            {filteredQuizzes().map((quiz) => {
                const sk = String(quiz?.s3Key || '').trim();
                const isHl = Boolean(sk && highlightedS3Key && sk === highlightedS3Key);
                const showVerified =
                    Boolean((quiz as any).highCredibility) ||
                    String((quiz as any).documentVerificationStatus || '').toLowerCase() === 'verified';
                return (
                <div
                    key={quiz.id}
                    ref={(el) => {
                        if (sk) availableCardRefs.current[sk] = el;
                    }}
                    className={`bg-white rounded-lg border p-6 hover:shadow-md transition-shadow ${
                        isHl
                            ? 'border-blue-600 ring-4 ring-blue-300/70 shadow-md bg-blue-50/80'
                            : 'border-gray-200'
                    }`}
                >
                    <div className="flex items-start justify-between mb-4">
                        <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                                <h3 className="text-gray-900">{quiz.title}</h3>
                                {showVerified && (
                                    <span
                                        className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-800 px-2 py-1 rounded text-xs font-medium"
                                        title="Moderation approved or staff-uploaded material"
                                    >
                                        <CheckCircle size={14} aria-hidden />
                                        Verified
                                    </span>
                                )}
                            </div>
                            <p className="text-gray-600 mb-1">Document Type: {quiz.subject}</p>
                            {'instructor' in quiz && (
                                <p className="text-gray-500 text-sm">Instructor: {quiz.instructor}</p>
                            )}
                        </div>
                        <button
                            onClick={() => startQuiz(quiz)}
                            className="flex items-center gap-2 px-6 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                        >
                            <Play size={20} />
                            Take Quiz
                        </button>
                    </div>
                    <div className="grid grid-cols-2 gap-4 pt-4 border-t border-gray-200 text-sm">
                        <div>
                            <p className="text-gray-500 mb-1">Questions</p>
                            <p className="text-gray-900">
                                {Array.isArray(quiz.questions) && quiz.questions.length
                                    ? quiz.questions.length
                                    : (Number(quiz.estimatedQuestions || 0) || 5)}
                            </p>
                        </div>
                        <div>
                            <p className="text-gray-500 mb-1">Attempts</p>
                            <p className="text-gray-900">{Number(quiz.myAttempts || 0)}</p>
                        </div>
                    </div>
                </div>
            );
            })}
        </div>
    );

    const renderCompletedQuizzes = () => (
        <div className="space-y-4">
            {filteredQuizzes().map((quiz) => (
                <div key={String((quiz as any)?.resultId || quiz.id)} className="bg-white rounded-lg border border-gray-200 p-6">
                    <div className="flex items-start justify-between mb-4">
                        <div className="flex-1">
                            <div className="flex items-center gap-3 mb-2">
                                <h3 className="text-gray-900">{quiz.title}</h3>
                                {'myScore' in quiz && quiz.myScore !== undefined && (
                                    <span
                                        className={`px-3 py-1 rounded-full text-sm ${quiz.myScore >= 80
                                            ? 'bg-green-100 text-green-700'
                                            : quiz.myScore >= 60
                                                ? 'bg-yellow-100 text-yellow-700'
                                                : 'bg-red-100 text-red-700'
                                            }`}
                                    >
                                        Score: {quiz.myScore}%
                                    </span>
                                )}
                                {Boolean((quiz as any)?.sharedForReview || (quiz as any)?.sharedFromStudent) && (
                                    <span className="px-3 py-1 rounded-full text-sm bg-indigo-100 text-indigo-700">
                                        Shared Quiz
                                    </span>
                                )}
                            </div>
                            <p className="text-gray-600 mb-1">Document Type: {quiz.subject}</p>
                            {'instructor' in quiz ? (
                                <p className="text-gray-500 text-sm">Instructor: {quiz.instructor}</p>
                            ) : (
                                <p className="text-gray-500 text-sm">Instructor: N/A</p>
                            )}
                            {'completedDate' in quiz ? (
                                <p className="text-gray-500 text-sm">
                                    Completed: {formatDateTimeWithSeconds(quiz.completedDate) || '—'}
                                </p>
                            ) : (
                                <p className="text-gray-500 text-sm">Completed: N/A</p>
                            )}
                            {Boolean((quiz as any)?.sharedAt) && (
                                <p className="text-gray-500 text-sm">
                                    Shared at: {String((quiz as any).sharedAt)}
                                </p>
                            )}
                        </div>
                        <div className="flex flex-col items-end gap-2">
                            <button
                                onClick={() => retakeQuiz(quiz)}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                            >
                                <Play size={20} />
                                Retake
                            </button>
                            <button
                                onClick={async () => {
                                const score = 'myScore' in quiz ? Number(quiz.myScore || 0) : 0;
                                let fullQuiz = quiz;
                                const uid = user?.user_id ?? user?.id ?? user?.userId;
                                const attemptId = (quiz as any)?.attemptId;
                                const quizId = (quiz as any)?.quizId ?? quiz?.id;
                                const resultUrl = String((quiz as any)?.resultUrl || '').trim();
                                let loadedComments: any[] = [];
                                let reviewPayload: any = null;
                                let reviewData: any = null;
                                let hasReviewQuestions = false;
                                const rowCache = findQuizResultCacheEntry(
                                    {
                                        attemptId,
                                        quizId,
                                    },
                                    viewerIdStr
                                );
                                const snapshotQuestionsRaw = Array.isArray((quiz as any)?.questionsSnapshot)
                                    ? (quiz as any).questionsSnapshot
                                    : Array.isArray(rowCache?.questionsSnapshot)
                                      ? rowCache.questionsSnapshot
                                      : [];
                                const snapshotQuestions = normalizeStoredQuestions(snapshotQuestionsRaw);
                                const snapshotAnswersRaw = Array.isArray((quiz as any)?.answersSnapshot)
                                    ? (quiz as any).answersSnapshot
                                    : Array.isArray(rowCache?.answersSnapshot)
                                      ? rowCache.answersSnapshot
                                      : [];
                                if (snapshotQuestions.length) {
                                    fullQuiz = {
                                        ...quiz,
                                        id: quizId,
                                        title: quiz.title,
                                        questions: snapshotQuestions,
                                    };
                                    hasReviewQuestions = true;
                                }

                                const openResultsFromSnapshots = () => {
                                    const normalizedAnswersResolved = normalizeReviewAnswers(snapshotAnswersRaw);
                                    const fallbackUserAnswers = Array.isArray((quiz as any)?.userAnswers)
                                        ? (quiz as any).userAnswers
                                        : [];
                                    const answersForUi =
                                        normalizedAnswersResolved.length > 0
                                            ? normalizedAnswersResolved
                                            : fallbackUserAnswers
                                                  .map((sel: any, i: number) => ({
                                                      questionId: String(
                                                          snapshotQuestions[i]?.id ?? `q-${i + 1}`
                                                      ),
                                                      selectedAnswer: Number.isFinite(Number(sel))
                                                          ? Number(sel)
                                                          : -1,
                                                      selectedText:
                                                          typeof sel === 'string' ? String(sel) : '',
                                                  }))
                                                  .filter(
                                                      (a: any) =>
                                                          a.selectedAnswer >= 0 ||
                                                          String(a.selectedText || '').trim().length > 0
                                                  );
                                    const quizQuestionsLen = snapshotQuestions.length;
                                    const fallbackTimeTaken = Number(
                                        (quiz as any)?.timeTakenSeconds ??
                                            (quiz as any)?.durationSeconds ??
                                            rowCache?.timeTakenSeconds ??
                                            0
                                    );
                                    setSelectedQuiz(fullQuiz);
                                    setAnswers(answersForUi);
                                    setResultComments([]);
                                    setQuizResult({
                                        score,
                                        correctAnswers: Math.round((score / 100) * quizQuestionsLen),
                                        totalQuestions: quizQuestionsLen,
                                        timeTaken: Math.max(0, fallbackTimeTaken),
                                        answers: answersForUi,
                                        isPractice: !Boolean(fullQuiz?.isPublished),
                                        passThreshold: Boolean(fullQuiz?.isPublished)
                                            ? Math.max(
                                                  1,
                                                  Math.min(
                                                      100,
                                                      Number(
                                                          (fullQuiz as any)?.passPercentage ??
                                                              (fullQuiz as any)?.pass_percentage ??
                                                              70
                                                      )
                                                  )
                                              )
                                            : null,
                                        passed: Boolean(fullQuiz?.isPublished)
                                            ? score >=
                                              Math.max(
                                                  1,
                                                  Math.min(
                                                      100,
                                                      Number(
                                                          (fullQuiz as any)?.passPercentage ??
                                                              (fullQuiz as any)?.pass_percentage ??
                                                              70
                                                      )
                                                  )
                                              )
                                            : null,
                                    });
                                    setShowResults(true);
                                };

                                if (snapshotQuestions.length > 0) {
                                    openResultsFromSnapshots();
                                    return;
                                }

                                // Step 1: prefer row-specific resultUrl when provided by backend.
                                if (resultUrl) {
                                    try {
                                        let reviewRes: any;
                                        try {
                                            reviewRes = await api.get(resultUrl, {
                                                params: uid != null && uid !== '' ? { userId: uid } : undefined,
                                            });
                                        } catch (err: any) {
                                            if (Number(err?.response?.status || 0) === 403) {
                                                reviewRes = await api.get(resultUrl);
                                            } else {
                                                throw err;
                                            }
                                        }
                                        reviewPayload = reviewRes?.data || null;
                                        reviewData = reviewPayload?.data || reviewPayload || null;
                                    } catch {
                                        // keep fallback path running
                                    }
                                }

                                // Step 2: try attempt review (has per-question answers)
                                if ((!reviewData || !Array.isArray(reviewData?.answers)) && attemptId != null && uid != null && uid !== '') {
                                    try {
                                        let reviewRes: any;
                                        try {
                                            reviewRes = await api.get(`/quiz/result/${attemptId}`, {
                                                params: { userId: uid },
                                            });
                                        } catch (err: any) {
                                            if (Number(err?.response?.status || 0) === 403) {
                                                reviewRes = await api.get(`/quiz/result/${attemptId}`);
                                            } else {
                                                throw err;
                                            }
                                        }
                                        reviewPayload = reviewRes?.data || null;
                                        reviewData = reviewPayload?.data || reviewPayload || null;
                                        const embedded = embeddedQuestionsFromReview(reviewData, reviewPayload);
                                        if (embedded?.length) {
                                            const nq = normalizeStoredQuestions(embedded);
                                            if (nq.length) {
                                                hasReviewQuestions = true;
                                                fullQuiz = {
                                                    ...quiz,
                                                    id: quizId,
                                                    title: String(
                                                        reviewData?.title || reviewPayload?.title || quiz.title || ''
                                                    ),
                                                    questions: nq,
                                                };
                                            }
                                        } else {
                                            const reviewQuestions = (
                                                Array.isArray(reviewData?.answers) ? reviewData.answers : []
                                            ).map((a: any, i: number) => {
                                                const qt = normalizeQuestionType(
                                                    a?.question_type ?? a?.questionType ?? a?.type
                                                );
                                                const opts = buildQuestionOptionsList(a, qt);
                                                const expl =
                                                    a?.explanation != null && String(a.explanation).trim()
                                                        ? String(a.explanation).trim()
                                                        : a?.question_explanation != null &&
                                                            String(a.question_explanation).trim()
                                                          ? String(a.question_explanation).trim()
                                                          : undefined;
                                                return {
                                                    id: String(a?.questionId ?? a?.id ?? `attempt-q-${i + 1}`),
                                                    question:
                                                        a?.question_text || a?.question || `Question ${i + 1}`,
                                                    questionType: qt,
                                                    options: opts,
                                                    correctAnswer: parseCorrectAnswerIndex(a, qt, opts),
                                                    ...(expl ? { explanation: expl } : {}),
                                                };
                                            });
                                            if (reviewQuestions.length) {
                                                hasReviewQuestions = true;
                                                fullQuiz = {
                                                    ...quiz,
                                                    id: quizId,
                                                    title: quiz.title,
                                                    questions: reviewQuestions,
                                                };
                                            }
                                        }
                                    } catch {
                                        // keep fallback path running
                                    }
                                }

                                // Step 1b: fallback to latest completed attempt by quiz+user
                                // ONLY when this row has no stable identifier (attemptId/resultUrl).
                                if (
                                    (!reviewData || !Array.isArray(reviewData?.answers) || reviewData.answers.length === 0) &&
                                    quizId != null &&
                                    uid != null &&
                                    uid !== '' &&
                                    (attemptId == null || attemptId === '') &&
                                    !resultUrl
                                ) {
                                    try {
                                        let latestRes: any;
                                        try {
                                            latestRes = await api.get(`/quiz/result/latest/${quizId}`, {
                                                params: { userId: uid },
                                            });
                                        } catch (err: any) {
                                            if (Number(err?.response?.status || 0) === 403) {
                                                latestRes = await api.get(`/quiz/result/latest/${quizId}`);
                                            } else {
                                                throw err;
                                            }
                                        }
                                        const latestPayload = latestRes?.data || null;
                                        const latestData = latestPayload?.data || latestPayload || null;
                                        if (latestData && Array.isArray(latestData?.answers) && latestData.answers.length > 0) {
                                            reviewPayload = latestPayload;
                                            reviewData = latestData;
                                        }
                                    } catch {
                                        // continue fallback
                                    }
                                }

                                // Step 2: some backends return questions separately in result payload
                                if (!hasReviewQuestions) {
                                    const resultQuestions = normalizeStoredQuestions(
                                        reviewData?.questions ||
                                        reviewData?.quiz?.questions ||
                                        reviewPayload?.questions ||
                                        reviewPayload?.quiz?.questions ||
                                        []
                                    );
                                    if (resultQuestions.length) {
                                        hasReviewQuestions = true;
                                        fullQuiz = {
                                            ...quiz,
                                            id: quizId,
                                            title: reviewData?.title || reviewPayload?.title || quiz.title,
                                            questions: resultQuestions,
                                        };
                                    }
                                }

                                // Step 3: fallback fetch quiz detail regardless of review errors
                                if (!hasReviewQuestions && quizId != null) {
                                    try {
                                        let detailRes: any;
                                        try {
                                            detailRes = await api.get(`/quizzes/${quizId}`, {
                                                params: { userId: uid },
                                            });
                                        } catch (err: any) {
                                            if (Number(err?.response?.status || 0) === 403) {
                                                detailRes = await api.get(`/quizzes/${quizId}`);
                                            } else {
                                                throw err;
                                            }
                                        }
                                        const detail = unwrapQuizDetailPayload(detailRes);
                                        const qs = normalizeStoredQuestions(detail.questions || []);
                                        if (qs.length) {
                                            fullQuiz = {
                                                ...quiz,
                                                title: detail.title || quiz.title,
                                                questions: qs,
                                            };
                                        }
                                    } catch {
                                        // fallback to summarized history data
                                    }
                                }

                                {
                                    const emb = embeddedQuestionsFromReview(reviewData, reviewPayload);
                                    if (Array.isArray(emb) && emb.length > 0) {
                                        const nq = normalizeStoredQuestions(emb);
                                        if (nq.length > 0) {
                                            hasReviewQuestions = true;
                                            fullQuiz = {
                                                ...fullQuiz,
                                                id: (quizId ?? (fullQuiz as any)?.id) as any,
                                                title: String(
                                                    reviewData?.title ||
                                                        reviewPayload?.title ||
                                                        (fullQuiz as any)?.title ||
                                                        quiz.title ||
                                                        ''
                                                ),
                                                questions: nq,
                                            };
                                        }
                                    }
                                }

                                // Normalize answers from backend into QuizAnswer[]
                                const normalizedAnswers = normalizeReviewAnswers(
                                    Array.isArray(reviewData?.answers)
                                        ? reviewData.answers
                                        : Array.isArray(reviewPayload?.answers)
                                            ? reviewPayload.answers
                                            : []
                                );
                                const fallbackUserAnswers = Array.isArray((quiz as any)?.userAnswers)
                                    ? (quiz as any).userAnswers
                                    : [];
                                const fallbackDetailedAnswers = Array.isArray((quiz as any)?.answersSnapshot)
                                    ? (quiz as any).answersSnapshot
                                    : [];
                                const fallbackStateAnswers =
                                    Number((quizResult as any)?.quizId) === Number(quizId) &&
                                    Array.isArray((quizResult as any)?.answers)
                                        ? (quizResult as any).answers
                                        : [];
                                const normalizedAnswersResolved =
                                    normalizedAnswers.length > 0
                                        ? normalizedAnswers
                                        : fallbackDetailedAnswers.length > 0
                                            ? normalizeReviewAnswers(fallbackDetailedAnswers)
                                            : fallbackStateAnswers.length > 0
                                                ? normalizeReviewAnswers(fallbackStateAnswers)
                                            : fallbackUserAnswers
                                                .map((sel: any, i: number) => ({
                                                    questionId: String((fullQuiz as any)?.questions?.[i]?.id ?? `q-${i + 1}`),
                                                    selectedAnswer: Number.isFinite(Number(sel)) ? Number(sel) : -1,
                                                    selectedText: typeof sel === 'string' ? String(sel) : '',
                                                }))
                                                .filter((a: any) => a.selectedAnswer >= 0 || String(a.selectedText || '').trim().length > 0);

                                if (
                                    normalizedAnswersResolved.length === 0 &&
                                    (!Array.isArray((fullQuiz as any)?.questions) ||
                                        (fullQuiz as any).questions.filter((q: any) =>
                                            String(q?.question || '').trim()
                                        ).length === 0) &&
                                    snapshotAnswersRaw.length === 0 &&
                                    (attemptId == null || attemptId === '') &&
                                    !resultUrl
                                ) {
                                    showNotification({
                                        type: 'warning',
                                        title: 'View Results',
                                        message: 'Result details are not available yet. Please try again in a moment.',
                                    });
                                    return;
                                }

                                const quizQuestionsLen = Array.isArray(fullQuiz.questions) ? fullQuiz.questions.length : 0;
                                const scorePct = Number(reviewData?.score ?? reviewPayload?.score);
                                const correctFromApi = Number(reviewData?.correct_count ?? reviewPayload?.correct_count);
                                const totalFromApi = Number(reviewData?.total_questions ?? reviewPayload?.total_questions);
                                const timeTakenFromApi = Number(reviewData?.time_taken_seconds ?? reviewPayload?.time_taken_seconds);
                                const hasApiScore = Number.isFinite(scorePct);
                                const hasApiCorrect = Number.isFinite(correctFromApi);
                                const hasApiTotal = Number.isFinite(totalFromApi);
                                const hasApiTimeTaken = Number.isFinite(timeTakenFromApi);
                                const fallbackTimeTaken = Number(
                                    (quiz as any)?.timeTakenSeconds ??
                                    (quiz as any)?.durationSeconds ??
                                    0
                                );
                                const reviewExplanationMap =
                                    reviewData?.explanationsByQuestionId ??
                                    reviewData?.explanations ??
                                    reviewPayload?.explanationsByQuestionId ??
                                    reviewPayload?.explanations;
                                if (quizId != null) {
                                    try {
                                        const commentsRes: any = await api.get(`/quizzes/${quizId}/comments`);
                                        loadedComments = mapQuizCommentRows(commentsRes);
                                    } catch {
                                        loadedComments = [];
                                    }
                                }

                                setSelectedQuiz(fullQuiz);
                                setAnswers(normalizedAnswersResolved);
                                setResultComments(loadedComments);
                                setQuizResult({
                                    ...(reviewExplanationMap &&
                                    typeof reviewExplanationMap === 'object' &&
                                    !Array.isArray(reviewExplanationMap) &&
                                    Object.keys(reviewExplanationMap).length
                                        ? { explanationsByQuestionId: reviewExplanationMap as Record<string, string> }
                                        : {}),
                                    score: hasApiScore ? scorePct : score,
                                    correctAnswers: hasApiCorrect
                                        ? correctFromApi
                                        : Math.round((score / 100) * quizQuestionsLen),
                                    totalQuestions: hasApiTotal ? totalFromApi : quizQuestionsLen,
                                    timeTaken: hasApiTimeTaken
                                        ? timeTakenFromApi
                                        : Math.max(0, fallbackTimeTaken),
                                    answers: normalizedAnswersResolved,
                                    isPractice: !Boolean(fullQuiz?.isPublished),
                                    passThreshold: Boolean(fullQuiz?.isPublished)
                                        ? Math.max(
                                            1,
                                            Math.min(100, Number((fullQuiz as any)?.passPercentage ?? (fullQuiz as any)?.pass_percentage ?? 70))
                                        )
                                        : null,
                                    passed: Boolean(fullQuiz?.isPublished)
                                        ? (hasApiScore ? scorePct : score) >= Math.max(
                                            1,
                                            Math.min(100, Number((fullQuiz as any)?.passPercentage ?? (fullQuiz as any)?.pass_percentage ?? 70))
                                        )
                                        : null,
                                });
                                setShowResults(true);
                                }}
                                className="flex items-center gap-2 px-4 py-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            >
                                <Eye size={20} />
                                View Results
                            </button>
                        </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4 pt-4 border-t border-gray-200 text-sm">
                        <div>
                            <p className="text-gray-500 mb-1">Questions</p>
                            <p className="text-gray-900">
                                {Array.isArray((quiz as any)?.questionsSnapshot) &&
                                (quiz as any).questionsSnapshot.length > 0
                                    ? (quiz as any).questionsSnapshot.length
                                    : Array.isArray(quiz.questions) && quiz.questions.length > 0
                                      ? quiz.questions.length
                                      : Number((quiz as any)?.estimatedQuestions || 0) || 5}
                            </p>
                        </div>
                        <div>
                            <p className="text-gray-500 mb-1">Duration</p>
                            <p className="text-gray-900">{quiz.duration} minutes</p>
                        </div>
                        <div>
                            <p className="text-gray-500 mb-1">Attempts Used</p>
                            {'attempts' in quiz ? (
                                <p className="text-gray-900">{quiz.attempts}</p>
                            ) : (
                                <p className="text-gray-400">N/A</p>
                            )}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );

    const renderPracticeQuizzes = () => (
        <div>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
                <p className="text-blue-800 text-sm">
                    Quizzes shared by your instructor — pick one and tap <strong>Take Quiz</strong> to begin.
                </p>
            </div>
            <div className="space-y-4">
                {filteredQuizzes().map((quiz) => (
                    <div key={quiz.id} className="bg-white rounded-lg border border-gray-200 p-6">
                        <div className="flex items-start justify-between mb-4">
                            <div className="flex-1">
                                <h3 className="text-gray-900 mb-2">{quiz.title}</h3>
                                <p className="text-gray-600 mb-1">Document Type: {quiz.subject}</p>
                                {'createdDate' in quiz && (
                                    <p className="text-gray-500 text-sm">
                                        Created: {formatDateTimeWithSeconds((quiz as any).createdDate)}
                                    </p>
                                )}
                                {'myScore' in quiz && quiz.myScore !== undefined && (
                                    <p className="text-gray-600 mt-2">
                                        Latest Score: <span className="text-green-600">{quiz.myScore}%</span>
                                    </p>
                                )}
                            </div>
                            <button
                                onClick={() => startQuiz(quiz)}
                                className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                            >
                                <Play size={20} />
                                Take Quiz
                            </button>
                        </div>
                        <div className="grid grid-cols-3 gap-4 pt-4 border-t border-gray-200 text-sm">
                            <div>
                                <p className="text-gray-500 mb-1">Questions</p>
                                <p className="text-gray-900">
                                    {Array.isArray(quiz.questions) && quiz.questions.length
                                        ? quiz.questions.length
                                        : (Number(quiz.estimatedQuestions || 0) || 5)}
                                </p>
                            </div>
                            <div>
                                <p className="text-gray-500 mb-1">Duration</p>
                                <p className="text-gray-900">{quiz.duration} minutes</p>
                            </div>
                            <div>
                                <p className="text-gray-500 mb-1">Attempts</p>
                                <p className="text-gray-900">{Number(quiz.attempts || 0)}</p>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );

    const renderQuizTaking = () => {
        if (!selectedQuiz || !showQuizTaking) return null;
        if (!safeQuizQuestions.length) return null;

        const safeIndex = Math.min(Math.max(0, currentQuestionIndex), safeQuizQuestions.length - 1);
        const currentQuestion = safeQuizQuestions[safeIndex];
        if (!currentQuestion) return null;
        const currentAnswer = answers.find((a) => String(a.questionId) === String(currentQuestion.id));
        const questionMediaUrl = toDisplayableMediaUrl(
            String((currentQuestion as any)?.mediaUrl || '').trim() || resolveMediaUrl(currentQuestion)
        );
        const progress = ((safeIndex + 1) / safeQuizQuestions.length) * 100;
        const minutes = Math.floor(timeRemaining / 60);
        const seconds = timeRemaining % 60;

        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
                    <div className="p-6 border-b border-gray-200">
                        <div className="flex items-start justify-between mb-4">
                            <div>
                                <h2 className="mb-2">{selectedQuiz.title}</h2>
                                <p className="text-gray-600">
                                    {safeQuizQuestions.length} Questions •{' '}
                                    {finiteQuizMinutes(selectedQuiz?.duration, 10)} minutes
                                </p>
                            </div>
                            <div className="flex items-center gap-4">
                                <div className={`flex items-center gap-2 ${timeRemaining < 300 ? 'text-red-600' : 'text-orange-600'}`}>
                                    <Clock size={20} />
                                    <span className="text-xl">{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}</span>
                                </div>
                                <button
                                    aria-label="Close"
                                    onClick={async () => {
                                        const confirmed = await showConfirm({
                                            title: 'Exit Quiz',
                                            message: 'Are you sure you want to exit? Your progress will be lost and this will count as an attempt.',
                                            confirmText: 'Exit',
                                            cancelText: 'Stay',
                                            type: 'warning',
                                        });
                                        if (confirmed) {
                                            if (timerId) {
                                                clearInterval(timerId);
                                                setTimerId(null);
                                            }
                                            setShowQuizTaking(false);
                                            setSelectedQuiz(null);
                                            showNotification({
                                                type: 'info',
                                                message: 'Quiz exited. Your progress was not saved.',
                                            });
                                        }
                                    }}
                                    className="text-gray-500 hover:text-gray-700"
                                >
                                    <X size={24} />
                                </button>
                            </div>
                        </div>
                        <div className="w-full bg-gray-200 rounded-full h-2">
                            <div className="bg-blue-600 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
                        </div>
                        <p className="text-sm text-gray-600 mt-2">Question {safeIndex + 1} of {safeQuizQuestions.length}</p>
                    </div>

                    <div className="p-6">
                        <div className="mb-6">
                            <p className="text-gray-900 mb-4"><strong>Question {safeIndex + 1}:</strong> {currentQuestion.question}</p>
                            {String(questionMediaUrl || '').trim() && (
                                <div className="mb-4">
                                    <QuizQuestionMediaImg src={String(questionMediaUrl)} />
                                </div>
                            )}
                            {(() => {
                                const qt = resolveQuestionType({
                                    questionType: currentQuestion?.questionType,
                                    type: (currentQuestion as any)?.type,
                                    question_type: (currentQuestion as any)?.question_type,
                                    options: currentQuestion?.options,
                                    option_a: (currentQuestion as any)?.option_a,
                                    option_b: (currentQuestion as any)?.option_b,
                                    option_c: (currentQuestion as any)?.option_c,
                                    option_d: (currentQuestion as any)?.option_d,
                                });
                                const tfLabels =
                                    Array.isArray(currentQuestion.options) && currentQuestion.options.length >= 2
                                        ? currentQuestion.options.slice(0, 2)
                                        : ['True', 'False'];
                                if (qt === 'short-answer') {
                                    return (
                                        <textarea
                                            value={String(currentAnswer?.selectedText || '')}
                                            onChange={(e) =>
                                                handleShortAnswerChange(String(currentQuestion.id), e.target.value)
                                            }
                                            placeholder="Type your answer..."
                                            rows={4}
                                            className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        />
                                    );
                                }
                                if (qt === 'true-false') {
                                    return (
                                        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
                                            {tfLabels.map((label: string, idx: number) => (
                                                <button
                                                    key={idx}
                                                    type="button"
                                                    onClick={() => handleAnswerSelect(String(currentQuestion.id), idx)}
                                                    className={`flex-1 py-4 px-6 rounded-xl border-2 text-base font-semibold transition-colors ${
                                                        currentAnswer?.selectedAnswer === idx
                                                            ? 'border-blue-600 bg-blue-600 text-white shadow-md'
                                                            : 'border-gray-300 bg-white text-gray-900 hover:border-blue-400 hover:bg-blue-50'
                                                    }`}
                                                >
                                                    {label}
                                                </button>
                                            ))}
                                        </div>
                                    );
                                }
                                return (
                                    <div className="space-y-3">
                                        {(currentQuestion.options || []).map((option: string, idx: number) => (
                                            <label
                                                key={idx}
                                                className={`flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                                                    currentAnswer?.selectedAnswer === idx
                                                        ? 'border-blue-500 bg-blue-50'
                                                        : 'border-gray-300 hover:bg-blue-50 hover:border-blue-300'
                                                }`}
                                            >
                                                <input
                                                    type="radio"
                                                    name={`question-${currentQuestion.id}`}
                                                    checked={currentAnswer?.selectedAnswer === idx}
                                                    onChange={() => handleAnswerSelect(String(currentQuestion.id), idx)}
                                                    className="w-4 h-4 text-blue-600"
                                                />
                                                <span className="text-gray-900">{option}</span>
                                            </label>
                                        ))}
                                    </div>
                                );
                            })()}
                        </div>
                    </div>

                    <div className="p-6 border-t border-gray-200 flex items-center justify-between">
                        <button
                            onClick={() => setCurrentQuestionIndex(Math.max(0, currentQuestionIndex - 1))}
                            disabled={safeIndex === 0}
                            className="px-6 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Previous
                        </button>
                        <div className="flex items-center gap-3">
                            {safeIndex === safeQuizQuestions.length - 1 ? (
                                <button
                                    onClick={() => handleSubmitQuiz()}
                                    className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                                >
                                    Submit Quiz
                                </button>
                            ) : (
                                <button
                                    onClick={() => setCurrentQuestionIndex(Math.min(safeQuizQuestions.length - 1, safeIndex + 1))}
                                    className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                >
                                    Next
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const renderGeneratingModal = () => {
        return null;
    };

    const renderQuizResults = () => {
        if (!showResults || !selectedQuiz || !quizResult) return null;
        const isAiGeneratedQuiz = String((selectedQuiz as any)?.instructor || '').trim().toLowerCase() === 'ai generated';

        // Use answers from quizResult (set at submit or view-results time),
        // fall back to answers state (active quiz session).
        const displayAnswers: QuizAnswer[] =
            Array.isArray(quizResult.answers) && quizResult.answers.length > 0
                ? quizResult.answers
                : answers;

        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden">
                    <div className="p-6 border-b border-gray-200 shrink-0">
                        <div className="flex items-start justify-between">
                            <div>
                                <h2 className="mb-2">Quiz Results</h2>
                                <p className="text-gray-600">{selectedQuiz.title}</p>
                            </div>
                            <button
                                aria-label="Close"
                                onClick={() => {
                                    setShowResults(false);
                                    setSelectedQuiz(null);
                                    setQuizResult(null);
                                    setAnswers([]);
                                    setResultComments([]);
                                }}
                                className="text-gray-500 hover:text-gray-700"
                            >
                                <X size={24} />
                            </button>
                        </div>
                    </div>

                    <div className="p-6 overflow-y-auto flex-1 min-h-0">
                        {/* Score Summary */}
                        <div className="flex flex-wrap items-center justify-end gap-2 mb-4">
                            <button
                                type="button"
                                onClick={() => retakeQuiz(selectedQuiz)}
                                className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                            >
                                Retake quiz
                            </button>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
                            <div className="bg-blue-50 rounded-lg p-4 text-center">
                                <div className="text-blue-600 mb-2">
                                    <Award size={32} className="mx-auto" />
                                </div>
                                <p className="text-gray-600 text-sm mb-1">Your Score</p>
                                <p className="text-2xl text-blue-600">{quizResult.score}%</p>
                            </div>
                            {!(quizResult as any).isPractice && !isAiGeneratedQuiz && (
                                <div
                                    className={`rounded-lg p-4 text-center ${(quizResult as any).passed ? 'bg-green-50' : 'bg-amber-50'}`}
                                >
                                    <p className="text-gray-600 text-sm mb-1">Result</p>
                                    <p
                                        className={`text-2xl font-semibold ${(quizResult as any).passed ? 'text-green-700' : 'text-amber-800'}`}
                                    >
                                        {(quizResult as any).passed ? 'Pass' : 'Not passed'}
                                    </p>
                                    <p className="text-xs text-gray-500 mt-1">
                                        Required: {(quizResult as any).passThreshold ?? 70}%
                                    </p>
                                </div>
                            )}
                            <div className="bg-green-50 rounded-lg p-4 text-center">
                                <div className="text-green-600 mb-2">
                                    <CheckCircle size={32} className="mx-auto" />
                                </div>
                                <p className="text-gray-600 text-sm mb-1">Correct</p>
                                <p className="text-2xl text-green-600">{quizResult.correctAnswers}</p>
                            </div>
                            <div className="bg-gray-50 rounded-lg p-4 text-center">
                                <div className="text-gray-600 mb-2">
                                    <FileText size={32} className="mx-auto" />
                                </div>
                                <p className="text-gray-600 text-sm mb-1">Total Questions</p>
                                <p className="text-2xl text-gray-900">{quizResult.totalQuestions}</p>
                            </div>
                            <div className="bg-purple-50 rounded-lg p-4 text-center">
                                <div className="text-purple-600 mb-2">
                                    <Clock size={32} className="mx-auto" />
                                </div>
                                <p className="text-gray-600 text-sm mb-1">Time Taken</p>
                                <p className="text-2xl text-purple-600">{formatTimeTakenLabel(quizResult.timeTaken)}</p>
                            </div>
                        </div>

                        {/* Question Review */}
                        <div>
                            <h3 className="mb-4">Answer Review</h3>
                            <div className="space-y-4">
                                {selectedQuiz.questions.map((q: any, idx: number) => {
                                    const userAnswer = displayAnswers.find(
                                        (a) => String(a.questionId) === String(q.id)
                                    ) || displayAnswers[idx];
                                    const qType = normalizeQuestionType(q?.questionType ?? q?.type ?? q?.question_type);
                                    const safeOptions = buildQuestionOptionsList(q, qType);
                                    const hasSelectedIndex = Boolean(userAnswer && userAnswer.selectedAnswer >= 0);
                                    const hasSelectedText = Boolean(String((userAnswer as any)?.selectedText || '').trim());
                                    const answered = hasSelectedIndex || hasSelectedText;
                                    const isShort = qType === 'short-answer';
                                    const isCorrectMcTf =
                                        !isShort &&
                                        hasSelectedIndex &&
                                        userAnswer!.selectedAnswer === q.correctAnswer;
                                    const resultQuestionMediaUrl = toDisplayableMediaUrl(
                                        String(q?.mediaUrl || '').trim() || resolveMediaUrl(q)
                                    );

                                    return (
                                        <div
                                            key={q.id}
                                            className={`rounded-lg border-2 p-4 ${
                                                isShort
                                                    ? 'border-blue-200 bg-blue-50'
                                                    : isCorrectMcTf
                                                      ? 'border-green-200 bg-green-50'
                                                      : 'border-red-200 bg-red-50'
                                            }`}
                                        >
                                            <div className="flex items-start gap-3 mb-3">
                                                <span
                                                    className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-white ${
                                                        isShort
                                                            ? 'bg-blue-500'
                                                            : isCorrectMcTf
                                                              ? 'bg-green-500'
                                                              : 'bg-red-500'
                                                    }`}
                                                >
                                                    {isShort ? '…' : isCorrectMcTf ? '✓' : '✗'}
                                                </span>
                                                <div className="flex-1">
                                                    <p className="text-gray-900 mb-1">
                                                        <strong>Question {idx + 1}</strong>
                                                        <span className="ml-2 text-xs font-normal uppercase text-gray-500">
                                                            {qType.replace(/-/g, ' ')}
                                                        </span>
                                                    </p>
                                                    <p className="text-gray-900 mb-3">
                                                        {String(q?.question || '').trim() || `Question ${idx + 1}`}
                                                    </p>
                                                    {String(resultQuestionMediaUrl || '').trim() ? (
                                                        <div className="mb-3">
                                                            <QuizQuestionMediaImg src={String(resultQuestionMediaUrl)} />
                                                        </div>
                                                    ) : null}
                                                    <div className="space-y-2">
                                                        <div>
                                                            <p className="text-sm text-gray-600">Your Answer:</p>
                                                            <p
                                                                className={
                                                                    isShort
                                                                        ? 'text-blue-900'
                                                                        : isCorrectMcTf
                                                                          ? 'text-green-700'
                                                                          : 'text-red-700'
                                                                }
                                                            >
                                                                {answered
                                                                    ? hasSelectedIndex
                                                                        ? safeOptions[userAnswer!.selectedAnswer] ??
                                                                          'Unknown option'
                                                                        : String(
                                                                              (userAnswer as any)?.selectedText ||
                                                                                  'Not answered'
                                                                          )
                                                                    : 'Not answered'}
                                                            </p>
                                                        </div>
                                                        {!isShort && !isCorrectMcTf && (
                                                            <div>
                                                                <p className="text-sm text-gray-600">Correct Answer:</p>
                                                                <p className="text-green-700">
                                                                    {safeOptions[q.correctAnswer] ?? 'Unknown option'}
                                                                </p>
                                                            </div>
                                                        )}
                                                        {isShort && (
                                                            <p className="text-xs text-gray-600">
                                                                Short answers may be reviewed by your instructor.
                                                            </p>
                                                        )}
                                                        {(() => {
                                                            const expl = pickQuestionExplanation(
                                                                q,
                                                                idx,
                                                                quizResult as unknown as Record<string, unknown> | null
                                                            );
                                                            if (!expl) return null;
                                                            return (
                                                                <details className="mt-4 overflow-hidden rounded-r-lg border border-slate-200/90 border-l-[3px] border-l-indigo-500 bg-gradient-to-br from-slate-50/90 to-white shadow-sm ring-1 ring-slate-900/[0.06] [&[open]_summary_.expl-chevron]:rotate-90">
                                                                    <summary className="cursor-pointer list-none px-4 py-3.5 transition-colors hover:bg-slate-50/80 [&::-webkit-details-marker]:hidden">
                                                                        <div className="flex items-start gap-3">
                                                                            <span
                                                                                className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 ring-1 ring-indigo-600/10"
                                                                                aria-hidden
                                                                            >
                                                                                <Lightbulb className="h-4 w-4" strokeWidth={2} />
                                                                            </span>
                                                                            <div className="min-w-0 flex-1 pt-1">
                                                                                <span className="text-sm font-semibold tracking-tight text-slate-900">
                                                                                    Explanation
                                                                                </span>
                                                                            </div>
                                                                            <span
                                                                                className="expl-chevron mt-1.5 inline-block shrink-0 text-slate-400 transition-transform duration-200"
                                                                                aria-hidden
                                                                            >
                                                                                ▶
                                                                            </span>
                                                                        </div>
                                                                    </summary>
                                                                    <div className="border-t border-slate-100 bg-white/70 px-4 py-3.5 pl-[4.25rem]">
                                                                        <p className="text-sm leading-relaxed text-slate-700 whitespace-pre-wrap">
                                                                            {expl}
                                                                        </p>
                                                                    </div>
                                                                </details>
                                                            );
                                                        })()}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                        <div className="mt-8 border-t border-gray-200 pt-6">
                            <div className="flex items-center justify-between gap-3 mb-4">
                                <h3 className="flex items-center gap-2 m-0">
                                    <MessageSquare size={20} className="text-blue-600" />
                                    {isQuizAlreadyShared(selectedQuiz)
                                        ? 'Comments with lecturer'
                                        : 'Comments'}
                                </h3>
                                <button
                                    type="button"
                                    onClick={() => void loadResultComments(selectedQuiz)}
                                    disabled={resultCommentsLoading}
                                    className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 disabled:opacity-50"
                                >
                                    <RefreshCw
                                        size={14}
                                        className={resultCommentsLoading ? 'animate-spin' : ''}
                                    />
                                    Refresh
                                </button>
                            </div>
                            {isQuizAlreadyShared(selectedQuiz) &&
                            resultComments.length === 0 &&
                            !resultCommentsLoading ? (
                                <p className="text-sm text-gray-500 mb-3">
                                    Your quiz was shared. Your lecturer can leave comments here — check back later or tap Refresh.
                                </p>
                            ) : null}
                            {resultCommentsLoading ? (
                                <p className="text-sm text-gray-500">Loading comments…</p>
                            ) : resultComments.length === 0 ? (
                                <p className="text-sm text-gray-500">No comments yet.</p>
                            ) : (
                                <div className="space-y-3">
                                    {resultComments.map((c) => (
                                        <div
                                            key={String(c.id)}
                                            className="rounded-lg border border-gray-200 bg-gray-50 p-3"
                                        >
                                            <p className="text-xs text-gray-500">
                                                {c.author} • {formatHourMinute(c.createdAt)}
                                            </p>
                                            <p className="text-sm text-gray-800 mt-1 whitespace-pre-wrap">
                                                {c.text}
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="p-6 border-t border-gray-200 flex items-center gap-3 shrink-0 bg-white relative z-10">
                        {!isQuizAlreadyShared(selectedQuiz) && (
                            <button
                                type="button"
                                disabled={sharingQuiz}
                                onClick={() => void shareQuizWithLecturer(selectedQuiz)}
                                className="flex-1 flex items-center justify-center gap-2 bg-white border border-blue-600 text-blue-600 py-3 rounded-lg hover:bg-blue-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                            >
                                <Share2 size={18} aria-hidden />
                                {sharingQuiz ? 'Sharing…' : 'Share'}
                            </button>
                        )}
                        {isQuizAlreadyShared(selectedQuiz) && (
                            <button
                                type="button"
                                disabled
                                className="flex-1 flex items-center justify-center gap-2 border border-gray-300 bg-gray-50 text-gray-500 py-3 rounded-lg cursor-not-allowed"
                            >
                                <Share2 size={18} aria-hidden />
                                Already shared
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => {
                                setShowResults(false);
                                setSelectedQuiz(null);
                                setQuizResult(null);
                                setAnswers([]);
                                setResultComments([]);
                            }}
                            className="flex-1 bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition-colors"
                        >
                            Close
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div>
            <h2 className="mb-6">Quizzes</h2>
            {loading && (
                <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 text-gray-600">
                    Preparing quiz data...
                </div>
            )}
            {!loading && currentTabQuizzes.length === 0 && (
                <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 text-gray-600">
                    {activeTab === 'edited'
                        ? 'No shared quizzes from lecturer yet.'
                        : 'No quizzes available right now.'}
                </div>
            )}
            {!loading &&
                currentTabQuizzes.length > 0 &&
                filteredQuizzes().length === 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 text-amber-900 flex flex-wrap items-center justify-between gap-3">
                        <span>No quizzes match your search or subject filter.</span>
                        <button
                            type="button"
                            onClick={() => {
                                setSearchQuery('');
                                setFilterSubject('all');
                            }}
                            className="px-3 py-1.5 text-sm bg-white border border-amber-300 rounded-lg hover:bg-amber-100"
                        >
                            Clear search & filter
                        </button>
                    </div>
                )}

            {/* Sub-navigation */}
            <div className="bg-white rounded-lg border border-gray-200 p-2 mb-6">
                <div className="flex flex-wrap gap-2">
                    <button
                        onClick={() => setActiveTab('available')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'available'
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-600 hover:bg-gray-100'
                            }`}
                    >
                        <FileText size={18} />
                        Available Quizzes
                    </button>
                    <button
                        onClick={() => setActiveTab('completed')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'completed'
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-600 hover:bg-gray-100'
                            }`}
                    >
                        <CheckCircle size={18} />
                        Completed
                    </button>
                    <button
                        onClick={() => setActiveTab('my-practice')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'my-practice'
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-600 hover:bg-gray-100'
                            }`}
                    >
                        <BarChart3 size={18} />
                        Published Quizzes
                    </button>
                </div>
            </div>

            {/* Search & subject filter */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
                <p className="text-sm text-gray-500 mb-3">
                    Search by title, course code, instructor, or file name. Use multiple words to narrow results.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={20} />
                        <input
                            type="search"
                            placeholder="Search quizzes..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            autoComplete="off"
                            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                    </div>
                    <div className="flex gap-2 items-center">
                        <select
                            aria-label="Filter by subject"
                            value={filterSubject}
                            onChange={(e) => setFilterSubject(e.target.value)}
                            className="flex-1 min-w-0 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                        >
                            <option value="all">All subjects</option>
                            {subjectOptions.map((s) => (
                                <option key={s} value={s}>
                                    {s}
                                </option>
                            ))}
                        </select>
                        {hasActiveFilters && (
                            <button
                                type="button"
                                onClick={() => {
                                    setSearchQuery('');
                                    setFilterSubject('all');
                                }}
                                className="shrink-0 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                            >
                                Reset
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Content */}
            {activeTab === 'available' && renderAvailableQuizzes()}
            {activeTab === 'completed' && renderCompletedQuizzes()}
            {activeTab === 'edited' && renderCompletedQuizzes()}
            {activeTab === 'my-practice' && renderPracticeQuizzes()}

            {/* Modals */}
            {renderGeneratingModal()}
            {renderQuizTaking()}
            {renderQuizResults()}
        </div>
    );
}
