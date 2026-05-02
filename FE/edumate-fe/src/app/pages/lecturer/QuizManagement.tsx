import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
    FileText,
    Edit3,
    CheckCircle,
    BarChart3,
    Database,
    Plus,
    Search,
    Clock,
    Users,
    Eye,
    Trash2,
    TrendingUp,
    X,
    Save,
    ArrowLeft,
    ClipboardCheck,
    Lightbulb,
} from 'lucide-react';
import api, { getApiBaseUrl, getApiErrorMessage, getStoredAuthToken } from '@/services/api';
import {
    fetchLecturerReviewForGrading,
    formatStudentAnswerForLecturerDisplay,
    patchQuizAttemptGrade,
} from '@/services/quizGradingApi';
import { useNotification } from '../NotificationContext';
import { formatDateTimeWithSeconds } from '@/utils/formatDateTime';
const LETTERS = ['A', 'B', 'C', 'D'];

const LECTURER_QUIZ_GENERATING_KEY = 'edumate_lecturer_quiz_generating';
const LECTURER_QUIZ_AUTOSTART_KEY = 'edumate_lecturer_quiz_autostart';
const LECTURER_QUIZ_AUTOSTART_EVENT = 'edumate:lecturer-quiz-autostart';
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|avi|mkv)(\?.*)?$/i;

function formatHourMinute(raw: unknown): string {
    const t = String(raw ?? '').trim();
    if (!t) return '';
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return t;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Shared-by-student quizzes: use API display name; avoid placeholder `creatorName` so we do not fall through to `User #id`. */
function resolveSharedStudentDisplayName(quiz: {
    sharedByName?: string;
    creatorName?: string;
    sharedByUserCode?: string;
    sharedByUserId?: number;
    sharedByEmail?: string;
    studentName?: string;
    userName?: string;
    fullName?: string;
    name?: string;
    email?: string;
}): string {
    const generic = new Set(['student', 'lecturer', 'n/a', '—', '-', 'unknown', 'unknown student']);
    const looksLikeId = (v: string): boolean => {
        const t = String(v || '').trim();
        if (!t) return false;
        if (/^user\s*#?\s*\d+$/i.test(t)) return true;
        if (/^u[-_\s]?\d+$/i.test(t)) return true;
        return false;
    };
    const candidates = [
        quiz.sharedByName,
        quiz.studentName,
        quiz.fullName,
        quiz.userName,
        quiz.name,
        quiz.creatorName,
    ];
    for (const c of candidates) {
        const t = String(c ?? '').trim();
        if (t && !generic.has(t.toLowerCase()) && !looksLikeId(t)) return t;
    }
    const cn = String(quiz.creatorName ?? '').trim();
    if (cn && !generic.has(cn.toLowerCase()) && !looksLikeId(cn)) return cn;
    const emailRaw = String(quiz.sharedByEmail ?? quiz.email ?? '').trim();
    if (emailRaw && emailRaw.includes('@')) {
        const local = emailRaw.split('@')[0].trim();
        if (local && !looksLikeId(local)) return local;
    }
    const uid = Number(quiz.sharedByUserId ?? 0);
    if (Number.isFinite(uid) && uid > 0) return `User #${uid}`;
    return 'Unknown student';
}

function formatSharedAtLabel(raw: unknown): string {
    const formatted = formatDateTimeWithSeconds(raw);
    if (formatted) return formatted;
    const t = String(raw ?? '').trim();
    return t || '—';
}

function isImageUrl(url: unknown): boolean {
    const u = String(url ?? '').trim();
    if (!u) return false;
    return IMAGE_EXT_RE.test(u);
}

function isVideoUrl(url: unknown): boolean {
    const u = String(url ?? '').trim();
    if (!u) return false;
    return VIDEO_EXT_RE.test(u);
}

function normalizeMediaPreviewUrl(url: unknown): string {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    if (/\/questions\/media\/file/i.test(raw)) {
        try {
            const u = new URL(raw, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
            if (u.pathname.endsWith('/questions/media/file')) {
                return u.pathname.startsWith('/') ? `${u.pathname}${u.search}` : `/${u.pathname}${u.search}`;
            }
        } catch {
            // fall through
        }
        if (raw.startsWith('/')) return raw;
    }
    try {
        const parsed = new URL(raw);
        const host = parsed.hostname.toLowerCase();
        const pathStyle = /^s3([.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(host);
        const vhost =
            !pathStyle &&
            host.includes('.s3.') &&
            host.endsWith('.amazonaws.com') &&
            !host.startsWith('s3.');
        if (vhost) {
            const key = parsed.pathname.replace(/^\/+/, '').split('?')[0];
            if (key) {
                return `${getApiBaseUrl().replace(/\/$/, '')}/questions/media/file?s3Key=${encodeURIComponent(key)}`;
            }
        }
        const isAws = host.includes('.amazonaws.com');
        const keyLegacy = parsed.pathname.replace(/^\/+/, '').split('?')[0];
        if (isAws && keyLegacy && pathStyle) {
            const parts = keyLegacy.split('/');
            const objectKey = parts.length > 1 ? parts.slice(1).join('/') : keyLegacy;
            if (objectKey) {
                return `${getApiBaseUrl().replace(/\/$/, '')}/questions/media/file?s3Key=${encodeURIComponent(objectKey)}`;
            }
        }
    } catch {
        // relative / bare key
    }
    if (!/^https?:\/\//i.test(raw) && /^api\//i.test(raw)) {
        return `/${raw}`;
    }
    if (raw.startsWith('/')) return raw;
    if (raw.length > 0 && !raw.includes('://')) {
        return `${getApiBaseUrl().replace(/\/$/, '')}/questions/media/file?s3Key=${encodeURIComponent(raw)}`;
    }
    return raw;
}

function isLikelyImageMedia(url: unknown): boolean {
    const raw = String(url ?? '').trim();
    if (!raw) return false;
    if (isImageUrl(raw)) return true;
    try {
        const p = new URL(raw).pathname.toLowerCase();
        return p.includes('/image/') || p.includes('/images/');
    } catch {
        return false;
    }
}

function isLikelyVideoMedia(url: unknown): boolean {
    const raw = String(url ?? '').trim();
    if (!raw) return false;
    if (isVideoUrl(raw)) return true;
    try {
        const p = new URL(raw).pathname.toLowerCase();
        return p.includes('/video/') || p.includes('/videos/');
    } catch {
        return false;
    }
}

function parseYoutubeVideoId(url: unknown): string {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    try {
        const u = new URL(raw);
        const host = u.hostname.toLowerCase();
        if (host === 'youtu.be') {
            const id = u.pathname.replace(/^\/+/, '').split('/')[0] || '';
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
        }
        return '';
    } catch {
        return '';
    }
}

function resolveCorrectAnswerIndex(options: string[], rawCorrect: unknown): number {
    const normalizedOptions = (Array.isArray(options) ? options : []).map((x) => String(x ?? ''));
    if (!normalizedOptions.length) return 0;

    const raw = String(rawCorrect ?? '').trim();
    if (!raw) return 0;

    const upper = raw.toUpperCase();
    const firstChar = upper.slice(0, 1);
    const letterIdx = LETTERS.indexOf(firstChar);
    if (letterIdx >= 0 && letterIdx < normalizedOptions.length) return letterIdx;

    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
        // Accept both 0-based and 1-based inputs.
        if (numeric >= 0 && numeric < normalizedOptions.length) return numeric;
        if (numeric >= 1 && numeric <= normalizedOptions.length) return numeric - 1;
    }

    const byExactText = normalizedOptions.findIndex((opt) => String(opt).trim() === raw);
    if (byExactText >= 0) return byExactText;

    const byInsensitiveText = normalizedOptions.findIndex(
        (opt) => String(opt).trim().toLowerCase() === raw.toLowerCase()
    );
    if (byInsensitiveText >= 0) return byInsensitiveText;

    return 0;
}

/** Display label for upload `documents.category` (Document Type), not course code. */
function formatDocumentTypeLabel(raw: string | undefined | null): string {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    const k = s.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (k === 'general') return 'General';
    if (k === 'general major') return 'General Major';
    if (k === 'specialized') return 'Specialized';
    return s;
}

/** Same bucket names as upload form / `documents.category` (for list filtering). */
function normalizeMaterialCategoryKey(
    raw: string | undefined | null
): 'general' | 'general-major' | 'specialized' | 'uncategorized' {
    const c = String(raw ?? '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '-');
    if (!c) return 'uncategorized';
    if (c === 'general-major' || c === 'general major') return 'general-major';
    if (c === 'specialized' || c === 'specialised') return 'specialized';
    if (c === 'general') return 'general';
    return 'uncategorized';
}

type QbCategoryFilter = 'all' | 'general' | 'general-major' | 'specialized' | 'uncategorized';


interface Quiz {
    id: number;
    title: string;
    /** Course code (matches DB `courses.course_code` / upload Course Code). */
    subject: string;
    /** Upload document type (`documents.category`), for display next to course code. */
    documentTypeLabel: string;
    /** Raw `documents.category` (general / general-major / …) for question bank filtering. */
    documentCategory?: string;
    documentId?: number;
    s3Key?: string;
    status: 'draft' | 'published';
    questions: any[];
    duration: number;
    passPercentage: number;
    attemptsAllowed: string;
    participants: number;
    averageScore: number;
    createdDate: string;
    publishedDate?: string;
    startDate?: string;
    endDate?: string;
    sharedForReview?: boolean;
    sharedAt?: string;
    /** Display name of the student who shared (from API / mock). */
    sharedByName?: string;
    creatorName?: string;
    sharedByUserId?: number;
    sharedByUserCode?: string;
    sharedByEmail?: string;
}

interface Question {
    id: number;
    question: string;
    type: 'multiple-choice' | 'true-false' | 'short-answer';
    topic: string;
    difficulty: 'easy' | 'medium' | 'hard';
    /** Material category (upload document type), aligned with course materials. */
    category?: string;
    options?: string[];
    correctAnswer?: string;
    /** Optional rationale shown to students after they submit (not during the quiz). */
    explanation?: string;
    mediaUrl?: string;
    /** Present when loaded from GET /questions/bank */
    quizId?: number;
    /** Set for rows from GET /questions/bank only; used to tell real bank items from quiz-only rows merged into state. */
    quizTitle?: string;
}

/** Real question-bank rows use positive numeric ids from DB. */
function isPersistedQuestionBankId(id: unknown): boolean {
    const num = Number(id);
    return Number.isFinite(num) && num > 0;
}

/**
 * Quiz snapshot rows (GET /quizzes/:id, AI sync) use **negative** client ids so they never collide with
 * question_bank `item_id` when `loadQuestionBankFromApi({ merge: true })` unions lists.
 */
function quizSnapshotQuestionId(questionIdFromDb: unknown, idx: number, fallbackBase: number): number {
    const raw = Number(questionIdFromDb);
    if (Number.isFinite(raw) && raw > 0) return -Math.abs(raw);
    return -(fallbackBase + idx);
}

/** Rows from GET /quizzes/:id — supports DB columns (`option_a`…) and mock AI shape (`options: { A,B,C,D }`). */
function mapQuizDetailRowsToQuestions(rows: any[], subject: string, linkQuizId: number): Question[] {
    if (!Array.isArray(rows) || !rows.length) return [];
    const base = Date.now();
    return rows.map((q: any, idx: number) => {
        const rawType = String(q?.type || q?.question_type || q?.questionType || 'multiple-choice')
            .trim()
            .toLowerCase();
        const type: 'multiple-choice' | 'true-false' | 'short-answer' =
            rawType === 'short-answer'
                ? 'short-answer'
                : rawType === 'true-false'
                    ? 'true-false'
                    : 'multiple-choice';
        const optObj = q?.options;
        let opts = [q.option_a, q.option_b, q.option_c, q.option_d].map((x: any) => String(x ?? ''));
        if (Array.isArray(optObj)) {
            opts = optObj.map((x: any) => String(x ?? ''));
        }
        if (optObj && typeof optObj === 'object' && !Array.isArray(optObj)) {
            opts = LETTERS.map((L) => String(optObj[L] ?? ''));
        }
        opts = opts.map((x) => String(x || '').trim()).filter(Boolean);
        if (type === 'true-false') {
            opts = [String(opts[0] ?? 'True'), String(opts[1] ?? 'False')];
        }
        if (type === 'short-answer') {
            opts = [];
        }
        const ci = resolveCorrectAnswerIndex(opts, q?.correct_answer ?? q?.correctAnswer);
        const id = quizSnapshotQuestionId(q.question_id, idx, base);
        return {
            id,
            question: String(q.question_text ?? q.question ?? ''),
            type,
            topic: subject || 'General',
            difficulty: 'medium' as const,
            options: opts,
            correctAnswer:
                type === 'short-answer'
                    ? String(q?.correct_answer ?? q?.correctAnswer ?? '')
                    : opts[ci] || opts[0] || '',
            quizId: linkQuizId,
            mediaUrl: String(q?.mediaUrl ?? q?.media_url ?? '').trim() || undefined,
            explanation:
                q?.explanation != null && String(q.explanation).trim()
                    ? String(q.explanation).trim()
                    : q?.question_explanation != null && String(q.question_explanation).trim()
                      ? String(q.question_explanation).trim()
                      : undefined,
        };
    });
}

interface AnalyticsQuestion {
    questionId: number;
    question: string;
    attempts: number;
    correctRatePercent: number;
}

interface AnalyticsPerformanceRow {
    quizId: number;
    title: string;
    participants: number;
    attempts: number;
    averageScorePercent: number;
    passRatePercent: number;
    difficulty: string;
    isPublished: boolean;
}

interface AnalyticsState {
    summary: {
        totalQuizzes: number;
        totalParticipants: number;
        averageScorePercent: number;
        completionRatePercent: number;
    };
    performance: AnalyticsPerformanceRow[];
    challengingQuestions: AnalyticsQuestion[];
}

/** When set from Document detail quiz flow, triggers the same flow as “Generate & Edit with AI”. */
export type InitialAiDocumentPayload = {
    s3Key: string;
    documentId?: number;
    title?: string;
    courseCode?: string;
    /** Set by dashboard so Strict Mode / remounts do not run generation twice for one click. */
    nonce?: number;
};

/** Parent (Documents → Open in Quizzes) requests scrolling to and highlighting a quiz card by s3Key in the Quizzes list. */
export type FileHighlightRequest = { s3Key: string; nonce: number };

interface QuizManagementProps {
    user: any;
    initialAiDocument?: InitialAiDocumentPayload | null;
    onInitialAiDocumentConsumed?: () => void;
    /** Open this quiz in the editor (from `/quiz/:id` or `/lecturer/quiz/:id`). */
    focusQuizId?: number | null;
    fileHighlightRequest?: FileHighlightRequest | null;
    onFileHighlightConsumed?: () => void;
}

type QuizTab =
    | 'all'
    | 'draft'
    | 'published'
    | 'shared'
    | 'analytics'
    | 'grading'
    | 'question-bank'
    | 'create'
    | 'edit';
type ModalType = 'delete-quiz' | 'delete-question' | 'view-quiz' | 'add-question' | 'edit-question' | 'select-questions' | null;

export function QuizManagement({
    user,
    initialAiDocument,
    onInitialAiDocumentConsumed,
    focusQuizId = null,
    fileHighlightRequest = null,
    onFileHighlightConsumed,
}: QuizManagementProps) {
    const navigate = useNavigate();
    const location = useLocation();
    const { showNotification } = useNotification();
    const initialParams = (() => {
        if (typeof window === 'undefined') return new URLSearchParams();
        return new URLSearchParams(window.location.search);
    })();
    const validTabs: QuizTab[] = [
        'all',
        'draft',
        'published',
        'shared',
        'analytics',
        'grading',
        'question-bank',
        'create',
        'edit',
    ];
    const urlTab = String(initialParams.get('tab') || '').trim() as QuizTab;
    const [activeTab, setActiveTab] = useState<QuizTab>(() => {
        /** From Documents → “Open in Quizzes”: always land on the quiz list and highlight by s3Key, not URL ?tab=edit. */
        if (String(fileHighlightRequest?.s3Key || '').trim()) return 'all';
        if (initialAiDocument?.s3Key?.trim()) return 'edit';
        return validTabs.includes(urlTab) ? urlTab : 'all';
    });
    const [searchQuery, setSearchQuery] = useState(String(initialParams.get('q') || '').trim());
    const [filterSubject, setFilterSubject] = useState(String(initialParams.get('subject') || 'all').trim() || 'all');
    const [filterStatus, setFilterStatus] = useState(String(initialParams.get('status') || 'all').trim() || 'all');
    const [sortBy, setSortBy] = useState(String(initialParams.get('sort') || 'newest').trim() || 'newest');
    const [page, setPage] = useState(Math.max(1, Number(initialParams.get('page') || 1) || 1));
    const [selectedId, setSelectedId] = useState<number | null>(() => {
        const raw = Number(initialParams.get('selectedId') || 0);
        return Number.isFinite(raw) && raw > 0 ? raw : null;
    });
    const [modalType, setModalType] = useState<ModalType>(null);
    const [selectedItem, setSelectedItem] = useState<any>(null);

    // Question Bank Filters
    const [qbFilterType, setQbFilterType] = useState('all');
    const [qbFilterCategory, setQbFilterCategory] = useState<QbCategoryFilter>('all');
    const [qbFilterDifficulty, setQbFilterDifficulty] = useState('all');

    // Quiz State Management
    const [quizzes, setQuizzes] = useState<Quiz[]>([]);

    // Question Bank State — loaded from GET /questions/bank (see loadQuestionBankFromApi)
    const [questionBank, setQuestionBank] = useState<Question[]>([]);

    // Quiz Form State
    const [quizForm, setQuizForm] = useState(() => {
        const ai = initialAiDocument;
        if (ai?.s3Key?.trim()) {
            return {
                title: String(ai.title || ''),
                subject: String(ai.courseCode || 'DOC'),
                duration: '10',
                passPercentage: '70',
                attemptsAllowed: '1',
                startDate: '',
                endDate: '',
                selectedQuestions: [] as number[],
            };
        }
        return {
            title: '',
            subject: '',
            duration: '',
            passPercentage: '70',
            attemptsAllowed: '1',
            startDate: '',
            endDate: '',
            selectedQuestions: [] as number[],
        };
    });
    const [scheduleDisplay, setScheduleDisplay] = useState({
        startDate: '',
        endDate: '',
    });

    // Question Form State
    const [questionForm, setQuestionForm] = useState({
        question: '',
        type: 'multiple-choice' as 'multiple-choice' | 'true-false' | 'short-answer',
        topic: '',
        /** Upload material category (general / general-major / specialized). */
        category: '' as '' | 'general' | 'general-major' | 'specialized',
        difficulty: 'medium' as 'easy' | 'medium' | 'hard',
        options: ['', '', '', ''],
        correctAnswer: '',
        mediaUrl: '',
        explanation: '',
    });

    // Edit mode
    const [editingQuizId, setEditingQuizId] = useState<number | null>(null);
    const [sharedEditMode, setSharedEditMode] = useState(false);
    const [editingQuestionId, setEditingQuestionId] = useState<number | null>(null);
    const [aiGeneratingQuizId, setAiGeneratingQuizId] = useState<number | null>(null);
    const [savingQuiz, setSavingQuiz] = useState(false);
    const [loadingCloudData, setLoadingCloudData] = useState(false);
    const [loadingQuestionBank, setLoadingQuestionBank] = useState(false);
    const [loadingAnalytics, setLoadingAnalytics] = useState(false);
    const [viewQuizLoading, setViewQuizLoading] = useState(false);
    const [highlightedS3Key, setHighlightedS3Key] = useState('');
    const [sharedComments, setSharedComments] = useState<any[]>([]);
    const [sharedCommentText, setSharedCommentText] = useState('');
    const [commentsLoading, setCommentsLoading] = useState(false);
    const [savingComment, setSavingComment] = useState(false);
    const [sharedAttemptId, setSharedAttemptId] = useState<number | null>(null);
    const [manualGrades, setManualGrades] = useState<Record<string, { score: string; feedback: string }>>({});
    const [savingManualGradeKey, setSavingManualGradeKey] = useState<string>('');
    /** Analytics → view student attempts & manual grading (non–Published tab flow). */
    const [studentAttemptsOpen, setStudentAttemptsOpen] = useState(false);
    const [studentAttemptsQuizId, setStudentAttemptsQuizId] = useState<number | null>(null);
    const [studentAttemptsTitle, setStudentAttemptsTitle] = useState('');
    const [studentAttemptsStep, setStudentAttemptsStep] = useState<'list' | 'detail'>('list');
    const [studentAttemptsList, setStudentAttemptsList] = useState<any[]>([]);
    const [loadingStudentAttempts, setLoadingStudentAttempts] = useState(false);
    const [studentAttemptDetailId, setStudentAttemptDetailId] = useState<number | null>(null);
    const [loadingStudentAttemptDetail, setLoadingStudentAttemptDetail] = useState(false);
    const [studentAttemptDetail, setStudentAttemptDetail] = useState<any>(null);
    const [attemptDetailGrades, setAttemptDetailGrades] = useState<Record<string, { score: string; feedback: string }>>(
        {}
    );
    const [savingAttemptDetailGradeKey, setSavingAttemptDetailGradeKey] = useState<string>('');
    const [deletingQuiz, setDeletingQuiz] = useState(false);
    const [uploadingQuestionMedia, setUploadingQuestionMedia] = useState(false);
    const questionMediaInputRef = useRef<HTMLInputElement | null>(null);
    const [questionMediaPreviewUrl, setQuestionMediaPreviewUrl] = useState('');
    const [questionMediaPreviewFailed, setQuestionMediaPreviewFailed] = useState(false);
    const quizCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const viewQuizFetchSeq = useRef(0);
    const autostartRunningRef = useRef(false);
    const focusOpenHandledRef = useRef<number | null>(null);
    const quizzesRef = useRef<Quiz[]>([]);
    const restoreScrollYRef = useRef<number | null>(null);
    const [analytics, setAnalytics] = useState<AnalyticsState>({
        summary: {
            totalQuizzes: 0,
            totalParticipants: 0,
            averageScorePercent: 0,
            completionRatePercent: 0,
        },
        performance: [],
        challengingQuestions: [],
    });

    /** Grading tab: load by attemptId, mark Correct/Incorrect, save via PATCH /quiz/attempts/:id/grade */
    const [gradingAttemptInput, setGradingAttemptInput] = useState(() =>
        String(initialParams.get('attemptId') || '').trim()
    );
    const [gradingDetail, setGradingDetail] = useState<any>(null);
    const [gradingMarks, setGradingMarks] = useState<Record<string, boolean>>({});
    const [loadingGrading, setLoadingGrading] = useState(false);
    const [savingGrading, setSavingGrading] = useState(false);
    /** Dedupe auto-load from URL vs manual «Load submission» / Analytics. */
    const lastAutoLoadedGradingAttemptRef = useRef<number | null>(null);

    const setLecturerQuizGeneratingStatus = (
        status: 'running' | 'completed' | 'failed',
        extra?: {
            title?: string;
            error?: string;
            quizId?: number | null;
            autoOpen?: boolean;
            navigateTo?: string;
            navigateReplace?: boolean;
        }
    ) => {
        try {
            const prevRaw = localStorage.getItem(LECTURER_QUIZ_GENERATING_KEY);
            const prev = prevRaw ? JSON.parse(prevRaw) : {};
            localStorage.setItem(
                LECTURER_QUIZ_GENERATING_KEY,
                JSON.stringify({
                    ...(prev || {}),
                    running: status === 'running',
                    status,
                    title: extra?.title ?? prev?.title ?? 'AI Quiz',
                    error: extra?.error ?? '',
                    quizId: extra?.quizId ?? prev?.quizId ?? null,
                    autoOpen: extra?.autoOpen ?? prev?.autoOpen ?? false,
                    navigateTo: extra?.navigateTo ?? prev?.navigateTo ?? '',
                    navigateReplace: extra?.navigateReplace ?? prev?.navigateReplace ?? true,
                    startedAt: prev?.startedAt ?? Date.now(),
                    updatedAt: Date.now(),
                })
            );
            window.dispatchEvent(new Event('edumate:lecturer-quiz-generating'));
        } catch {
            // ignore storage failures
        }
    };

    // Filtered data
    const filteredQuizzes = quizzes.filter((quiz) => {
        const matchesSearch =
            quiz.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            quiz.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
            quiz.documentTypeLabel.toLowerCase().includes(searchQuery.toLowerCase()) ||
            String(quiz.creatorName || '').toLowerCase().includes(searchQuery.toLowerCase());
        const matchesSubject = filterSubject === 'all' || quiz.subject === filterSubject;
        const matchesStatus = filterStatus === 'all' || quiz.status === filterStatus;

        // Draft tab shows persisted drafts only (valid DB quiz id).
        if (activeTab === 'draft') return quiz.status === 'draft' && quiz.id > 0 && matchesSearch && matchesSubject;
        if (activeTab === 'published') {
            return (
                quiz.status === 'published' &&
                !Boolean(quiz.sharedForReview) &&
                matchesSearch &&
                matchesSubject
            );
        }
        if (activeTab === 'shared') return Boolean(quiz.sharedForReview) && quiz.id > 0 && matchesSearch && matchesSubject;

        return matchesSearch && matchesSubject && matchesStatus;
    });

    const persistedBankQuestions = questionBank.filter((q) => isPersistedQuestionBankId(q?.id));
    const filteredQuestions = persistedBankQuestions.filter((question) => {
        if (!question) return false;
        const matchesType = qbFilterType === 'all' || question.type === qbFilterType;
        const catKey = normalizeMaterialCategoryKey(question.category);
        const matchesCategory =
            qbFilterCategory === 'all' ||
            (qbFilterCategory === 'uncategorized' ? catKey === 'uncategorized' : catKey === qbFilterCategory);
        const matchesDifficulty = qbFilterDifficulty === 'all' || question.difficulty === qbFilterDifficulty;
        return matchesType && matchesCategory && matchesDifficulty;
    });

    // Reset category filter when no rows match (e.g. after reload).
    useEffect(() => {
        if (qbFilterCategory === 'all' || persistedBankQuestions.length === 0) return;
        const anyMatch = persistedBankQuestions.some((q) => {
            const catKey = normalizeMaterialCategoryKey(q?.category);
            if (qbFilterCategory === 'uncategorized') return catKey === 'uncategorized';
            return catKey === qbFilterCategory;
        });
        if (!anyMatch) setQbFilterCategory('all');
    }, [persistedBankQuestions, qbFilterCategory]);

    const lecturerUserId = user?.user_id ?? user?.id ?? user?.userId;
    const lecturerDisplayName = String(
        user?.full_name ?? user?.fullName ?? user?.name ?? user?.email ?? user?.user_code ?? 'Lecturer'
    ).trim();

    const preserveScrollForNextRender = () => {
        if (typeof window === 'undefined') return;
        restoreScrollYRef.current = window.scrollY;
    };

    const loadLecturerQuizzes = async () => {
        if (lecturerUserId == null || lecturerUserId === '') return;
        setLoadingCloudData(true);
        setLoadingAnalytics(true);
        try {
            const [historyRes, sharedHistoryRes, publishedRes, docsRes, analyticsRes]: any[] = await Promise.all([
                api.get('/quizzes/history', {
                    params: { userId: lecturerUserId, limit: 500, ownerOnly: true },
                }),
                api.get('/quizzes/history', {
                    params: { limit: 500 },
                }),
                api.get('/quizzes/published', {
                    params: { userId: lecturerUserId, ownerOnly: true },
                }),
                api.get('/documents/for-quiz'),
                api.get('/quizzes/analytics', {
                    params: { userId: lecturerUserId, topQuestions: 5 },
                }),
            ]);
            const historyRowsRaw = Array.isArray(historyRes?.data) ? historyRes.data : [];
            const sharedHistoryRowsRaw = Array.isArray(sharedHistoryRes?.data) ? sharedHistoryRes.data : [];
            const publishedRowsRaw = Array.isArray(publishedRes?.data) ? publishedRes.data : [];
            // Draft/Shared source: history API (exclude published rows)
            const rows = historyRowsRaw.filter((q: any) => !Boolean(q?.isPublished ?? q?.publishedAt));
            const sharedRows = sharedHistoryRowsRaw.filter((q: any) => Boolean(q?.sharedForReview ?? q?.sharedFromStudent));
            const docs = Array.isArray(docsRes?.data) ? docsRes.data : [];
            const analyticsPayload = analyticsRes?.data || analyticsRes || {};
            setAnalytics({
                summary: {
                    totalQuizzes: Number(analyticsPayload?.summary?.totalQuizzes || 0),
                    totalParticipants: Number(analyticsPayload?.summary?.totalParticipants || 0),
                    averageScorePercent: Number(analyticsPayload?.summary?.averageScorePercent || 0),
                    completionRatePercent: Number(analyticsPayload?.summary?.completionRatePercent || 0),
                },
                performance: Array.isArray(analyticsPayload?.performance) ? analyticsPayload.performance : [],
                challengingQuestions: Array.isArray(analyticsPayload?.challengingQuestions)
                    ? analyticsPayload.challengingQuestions
                    : [],
            });
            const s3ByNormalizedTitle = new Map<string, string>();
            docs.forEach((d: any) => {
                const k = String(d?.title || d?.fileName || '').trim().toLowerCase();
                const v = String(d?.s3Key || '').trim();
                if (k && v && !s3ByNormalizedTitle.has(k)) s3ByNormalizedTitle.set(k, v);
            });
            const mappedHistory: Quiz[] = rows.map((q: any) => ({
                id: Number(q?.quizId || q?.id || 0),
                title: String(q?.title || 'Quiz'),
                subject: String(q?.courseCode || 'DOC'),
                documentTypeLabel: formatDocumentTypeLabel(q?.documentCategory),
                documentCategory:
                    q?.documentCategory != null && String(q.documentCategory).trim() !== ''
                        ? String(q.documentCategory).trim()
                        : '',
                documentId: Number(q?.documentId || 0) || undefined,
                s3Key:
                    String(q?.s3Key || q?.sourceKey || '').trim() ||
                    s3ByNormalizedTitle.get(String(q?.title || '').trim().toLowerCase()) ||
                    '',
                status: q?.isPublished || q?.publishedAt ? 'published' : 'draft',
                questions: Array.from({ length: Number(q?.questionCount || 0) }),
                duration: 10,
                passPercentage: 70,
                attemptsAllowed: '1',
                participants: Number(q?.attemptsCount || 0),
                averageScore: Number(q?.scorePercent || 0),
                createdDate: String(q?.createdAt || ''),
                publishedDate: q?.isPublished ? String(q?.publishedAt || q?.createdAt || '').slice(0, 10) : undefined,
                sharedForReview: Boolean(q?.sharedForReview ?? q?.sharedFromStudent),
                sharedAt: q?.sharedAt
                    ? String(q.sharedAt).slice(0, 10)
                    : (q?.createdAt ? String(q.createdAt).slice(0, 10) : undefined),
                creatorName:
                    (q?.creatorName != null && String(q.creatorName).trim() !== ''
                        ? String(q.creatorName)
                        : q?.studentName != null && String(q.studentName).trim() !== ''
                            ? String(q.studentName)
                            : q?.student_name != null && String(q.student_name).trim() !== ''
                                ? String(q.student_name)
                                : q?.fullName != null && String(q.fullName).trim() !== ''
                                    ? String(q.fullName)
                                    : q?.full_name != null && String(q.full_name).trim() !== ''
                                        ? String(q.full_name)
                                        : q?.userName != null && String(q.userName).trim() !== ''
                                            ? String(q.userName)
                                            : q?.user_name != null && String(q.user_name).trim() !== ''
                                                ? String(q.user_name)
                        : q?.sharedByName != null && String(q.sharedByName).trim() !== ''
                            ? String(q.sharedByName)
                            : q?.shared_by_name != null && String(q.shared_by_name).trim() !== ''
                                ? String(q.shared_by_name)
                                : q?.createdByName != null && String(q.createdByName).trim() !== ''
                                    ? String(q.createdByName)
                                    : q?.created_by_name != null && String(q.created_by_name).trim() !== ''
                                        ? String(q.created_by_name)
                                        : undefined),
                sharedByUserId: Number(
                    q?.sharedByUserId ??
                    q?.shared_by_user_id ??
                    q?.createdBy ??
                    q?.created_by ??
                    0
                ) || undefined,
                sharedByUserCode:
                    q?.sharedByUserCode != null && String(q.sharedByUserCode).trim() !== ''
                        ? String(q.sharedByUserCode).trim()
                        : q?.shared_by_user_code != null && String(q.shared_by_user_code).trim() !== ''
                            ? String(q.shared_by_user_code).trim()
                            : undefined,
                sharedByEmail:
                    q?.sharedByEmail != null && String(q.sharedByEmail).trim() !== ''
                        ? String(q.sharedByEmail).trim()
                        : q?.shared_by_email != null && String(q.shared_by_email).trim() !== ''
                            ? String(q.shared_by_email).trim()
                            : q?.studentEmail != null && String(q.studentEmail).trim() !== ''
                                ? String(q.studentEmail).trim()
                                : q?.student_email != null && String(q.student_email).trim() !== ''
                                    ? String(q.student_email).trim()
                                    : q?.email != null && String(q.email).trim() !== ''
                                        ? String(q.email).trim()
                                        : undefined,
            })).filter((q: any) => Number.isFinite(q.id) && q.id > 0);

            const mappedShared: Quiz[] = sharedRows.map((q: any) => ({
                id: Number(q?.quizId || q?.id || 0),
                title: String(q?.title || 'Quiz'),
                subject: String(q?.courseCode || 'DOC'),
                documentTypeLabel: formatDocumentTypeLabel(q?.documentCategory),
                documentCategory:
                    q?.documentCategory != null && String(q.documentCategory).trim() !== ''
                        ? String(q.documentCategory).trim()
                        : '',
                documentId: Number(q?.documentId || 0) || undefined,
                s3Key: String(q?.s3Key || q?.sourceKey || '').trim(),
                status: q?.isPublished || q?.publishedAt ? 'published' : 'draft',
                questions: Array.from({ length: Number(q?.questionCount || 0) }),
                duration: 10,
                passPercentage: 70,
                attemptsAllowed: '1',
                participants: Number(q?.attemptsCount || 0),
                averageScore: Number(q?.scorePercent || 0),
                createdDate: String(q?.createdAt || ''),
                sharedForReview: true,
                sharedAt: String(q?.sharedAt || q?.createdAt || ''),
                creatorName:
                    q?.sharedByName != null && String(q.sharedByName).trim() !== ''
                        ? String(q.sharedByName).trim()
                        : q?.studentName != null && String(q.studentName).trim() !== ''
                            ? String(q.studentName).trim()
                            : q?.student_name != null && String(q.student_name).trim() !== ''
                                ? String(q.student_name).trim()
                                : q?.fullName != null && String(q.fullName).trim() !== ''
                                    ? String(q.fullName).trim()
                                    : q?.full_name != null && String(q.full_name).trim() !== ''
                                        ? String(q.full_name).trim()
                                        : q?.userName != null && String(q.userName).trim() !== ''
                                            ? String(q.userName).trim()
                                            : q?.user_name != null && String(q.user_name).trim() !== ''
                                                ? String(q.user_name).trim()
                        : q?.shared_by_name != null && String(q.shared_by_name).trim() !== ''
                            ? String(q.shared_by_name).trim()
                            : q?.creatorName != null && String(q.creatorName).trim() !== ''
                                ? String(q.creatorName).trim()
                                : 'Student',
                sharedByUserId: Number(q?.sharedByUserId ?? q?.shared_by_user_id ?? 0) || undefined,
                sharedByUserCode:
                    q?.sharedByUserCode != null && String(q.sharedByUserCode).trim() !== ''
                        ? String(q.sharedByUserCode).trim()
                        : q?.shared_by_user_code != null && String(q.shared_by_user_code).trim() !== ''
                            ? String(q.shared_by_user_code).trim()
                            : undefined,
                sharedByName:
                    q?.sharedByName != null && String(q.sharedByName).trim() !== ''
                        ? String(q.sharedByName).trim()
                        : q?.shared_by_name != null && String(q.shared_by_name).trim() !== ''
                            ? String(q.shared_by_name).trim()
                            : q?.studentName != null && String(q.studentName).trim() !== ''
                                ? String(q.studentName).trim()
                                : q?.student_name != null && String(q.student_name).trim() !== ''
                                    ? String(q.student_name).trim()
                            : undefined,
                sharedByEmail:
                    q?.sharedByEmail != null && String(q.sharedByEmail).trim() !== ''
                        ? String(q.sharedByEmail).trim()
                        : q?.shared_by_email != null && String(q.shared_by_email).trim() !== ''
                            ? String(q.shared_by_email).trim()
                            : q?.studentEmail != null && String(q.studentEmail).trim() !== ''
                                ? String(q.studentEmail).trim()
                                : q?.student_email != null && String(q.student_email).trim() !== ''
                                    ? String(q.student_email).trim()
                                    : q?.email != null && String(q.email).trim() !== ''
                                        ? String(q.email).trim()
                                        : undefined,
            })).filter((q: any) => Number.isFinite(q.id) && q.id > 0);

            // Published source: published API only
            const mappedPublished: Quiz[] = publishedRowsRaw.map((q: any) => ({
                id: Number(q?.quizId || q?.id || 0),
                title: String(q?.title || 'Quiz'),
                subject: String(q?.courseCode || 'DOC'),
                documentTypeLabel: formatDocumentTypeLabel(q?.documentCategory),
                documentCategory:
                    q?.documentCategory != null && String(q.documentCategory).trim() !== ''
                        ? String(q.documentCategory).trim()
                        : '',
                documentId: Number(q?.documentId || 0) || undefined,
                s3Key: String(q?.s3Key || q?.sourceKey || '').trim(),
                status: 'published',
                questions: Array.from({ length: Number(q?.questionCount || 0) }),
                duration: 10,
                passPercentage: 70,
                attemptsAllowed: '1',
                participants: Number(q?.attemptsCount || 0),
                averageScore: Number(q?.scorePercent || 0),
                createdDate: String(q?.createdAt || ''),
                publishedDate: String(q?.publishedAt || q?.createdAt || ''),
                creatorName:
                    q?.creatorName != null && String(q.creatorName).trim() !== ''
                        ? (String(q.creatorName).trim().toLowerCase() === 'lecturer'
                            ? lecturerDisplayName
                            : String(q.creatorName).trim())
                        : q?.publishedByName != null && String(q.publishedByName).trim() !== ''
                            ? String(q.publishedByName).trim()
                            : q?.createdByName != null && String(q.createdByName).trim() !== ''
                                ? String(q.createdByName).trim()
                                : q?.publishedByUserCode != null && String(q.publishedByUserCode).trim() !== ''
                                    ? String(q.publishedByUserCode).trim()
                                    : lecturerDisplayName,
                sharedForReview: false,
            })).filter((q: any) => Number.isFinite(q.id) && q.id > 0);

            const existingTitles = new Set(
                mappedHistory.map((q) => String(q.title || '').trim().toLowerCase()).filter(Boolean)
            );
            const mappedFromDocs: Quiz[] = docs
                .filter((d: any) => {
                    const t = String(d?.title || d?.fileName || '').trim().toLowerCase();
                    return !!t && !existingTitles.has(t);
                })
                .map((d: any, idx: number) => {
                    const estimatedQuestions = Math.max(0, Number(d?.estimatedQuestions || 0));
                    const title = String(d?.title || d?.fileName || `Document ${idx + 1}`);
                    const baseDocId = Number(d?.documentId || d?.id || 0);
                    // Ensure unique negative IDs for cloud-only rows to avoid React key collisions.
                    const uniqueCloudId = -1 * ((Math.max(1, baseDocId + 100000) * 1000) + idx);
                    return {
                        id: uniqueCloudId,
                        title,
                        subject: String(d?.courseCode || d?.subjectCode || 'DOC'),
                        documentTypeLabel: formatDocumentTypeLabel(d?.category),
                        documentCategory: String(d?.category ?? '').trim(),
                        documentId: Number(d?.documentId || d?.id || 0) || undefined,
                        s3Key: String(d?.s3Key || ''),
                        status: 'draft',
                        questions: Array.from({ length: estimatedQuestions }),
                        duration: 10,
                        passPercentage: 70,
                        attemptsAllowed: '1',
                        participants: Number(d?.attemptsCount || 0),
                        averageScore: 0,
                        createdDate: String(d?.createdAt || d?.uploadedAt || ''),
                    };
                });

            const merged = [...mappedHistory, ...mappedPublished, ...mappedShared, ...mappedFromDocs];
            const byId = new Map<number, Quiz>();
            merged.forEach((q) => {
                if (q && Number.isFinite(Number(q.id))) byId.set(Number(q.id), q);
            });
            setQuizzes(Array.from(byId.values()));
        } catch {
            setQuizzes([]);
            setAnalytics({
                summary: {
                    totalQuizzes: 0,
                    totalParticipants: 0,
                    averageScorePercent: 0,
                    completionRatePercent: 0,
                },
                performance: [],
                challengingQuestions: [],
            });
        } finally {
            setLoadingCloudData(false);
            setLoadingAnalytics(false);
        }
    };

    const loadQuizComments = async (quizId: number) => {
        if (!Number.isFinite(quizId) || quizId <= 0) return;
        setCommentsLoading(true);
        try {
            const res: any = await api.get(`/quizzes/${quizId}/comments`);
            const rawRows = Array.isArray(res?.data)
                ? res.data
                : Array.isArray(res?.data?.items)
                    ? res.data.items
                    : Array.isArray(res?.items)
                        ? res.items
                        : [];
            const rows = rawRows.map((c: any, idx: number) => ({
                id: c?.id ?? `comment-${idx}`,
                author: c?.author ?? c?.createdByName ?? c?.userName ?? 'Lecturer',
                createdAt: c?.createdAt ?? c?.created_at ?? c?.time ?? '',
                text: c?.text ?? c?.comment ?? c?.content ?? c?.body ?? '',
            }));
            setSharedComments(rows);
        } catch {
            setSharedComments([]);
        } finally {
            setCommentsLoading(false);
        }
    };

    const handlePostQuizComment = async () => {
        const text = String(sharedCommentText || '').trim();
        const quizId = Number(selectedItem?.id || 0);
        if (!text || !Number.isFinite(quizId) || quizId <= 0) return;
        setSavingComment(true);
        try {
            await api.post(`/quizzes/${quizId}/comments`, { text, userId: lecturerUserId });
            setSharedCommentText('');
            await loadQuizComments(quizId);
            showNotification({
                type: 'success',
                title: 'Comment posted',
                message: 'Your comment has been added.',
            });
        } catch {
            showNotification({
                type: 'warning',
                title: 'Comment',
                message: 'Unable to post comment right now.',
            });
        } finally {
            setSavingComment(false);
        }
    };

    const handleSaveManualGrade = async (questionId: string) => {
        const attemptId = Number(sharedAttemptId || 0);
        const qid = String(questionId || '').trim();
        if (!Number.isFinite(attemptId) || attemptId <= 0 || !qid) return;
        const scoreRaw = String(manualGrades[qid]?.score || '').trim();
        const feedback = String(manualGrades[qid]?.feedback || '').trim();
        const score = Number(scoreRaw || 0);
        if (!Number.isFinite(score) || score < 0) {
            showNotification({
                type: 'warning',
                title: 'Manual grading',
                message: 'Please enter a valid score (>= 0).',
            });
            return;
        }
        setSavingManualGradeKey(qid);
        try {
            const res: any = await api.post(`/quiz/attempts/${attemptId}/manual-grading`, {
                grades: [{ questionId: qid, score, feedback }],
            });
            const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res?.data?.data) ? res.data.data : [];
            if (rows.length) {
                const next: Record<string, { score: string; feedback: string }> = {};
                rows.forEach((g: any) => {
                    const k = String(g?.questionId || '').trim();
                    if (!k) return;
                    next[k] = { score: String(g?.score ?? ''), feedback: String(g?.feedback ?? '') };
                });
                setManualGrades((prev) => ({ ...prev, ...next }));
            }
            showNotification({
                type: 'success',
                title: 'Manual grading',
                message: 'Score and feedback saved.',
            });
        } catch {
            showNotification({
                type: 'error',
                title: 'Manual grading',
                message: 'Unable to save score right now.',
            });
        } finally {
            setSavingManualGradeKey('');
        }
    };

    const isShortAnswerAttemptQ = (q: any) => {
        const t = String(q?.type ?? q?.question_type ?? q?.questionType ?? '')
            .toLowerCase()
            .replace(/_/g, '-');
        return t === 'short-answer' || t === 'shortanswer' || t === 'essay';
    };

    const questionKeyForAttemptRow = (q: any, idx: number) =>
        String(q?.id ?? q?.question_id ?? q?.questionId ?? `q-${idx + 1}`);

    const openStudentAttemptsModal = async (quizId: number, title: string) => {
        if (lecturerUserId == null || lecturerUserId === '') {
            showNotification({
                type: 'warning',
                title: 'Student attempts',
                message: 'Missing lecturer account.',
            });
            return;
        }
        setStudentAttemptsQuizId(quizId);
        setStudentAttemptsTitle(title);
        setStudentAttemptsStep('list');
        setStudentAttemptDetail(null);
        setStudentAttemptDetailId(null);
        setAttemptDetailGrades({});
        setStudentAttemptsOpen(true);
        setLoadingStudentAttempts(true);
        try {
            const res: any = await api.get(`/quizzes/${quizId}/attempts`, { params: { userId: lecturerUserId } });
            const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
            setStudentAttemptsList(rows);
        } catch (err: unknown) {
            const status = (err as { response?: { status?: number } })?.response?.status;
            const hint =
                status === 404
                    ? 'Quiz không có trên API đang chạy (khởi động lại `npm run dev:api` / quiz chỉ nằm ở FE cũ).'
                    : getApiErrorMessage(err) || 'Could not load attempts for this quiz.';
            showNotification({
                type: 'error',
                title: 'Student attempts',
                message: hint,
            });
            setStudentAttemptsList([]);
        } finally {
            setLoadingStudentAttempts(false);
        }
    };

    const closeStudentAttemptsModal = () => {
        setStudentAttemptsOpen(false);
        setStudentAttemptsQuizId(null);
        setStudentAttemptsTitle('');
        setStudentAttemptsStep('list');
        setStudentAttemptsList([]);
        setStudentAttemptDetail(null);
        setStudentAttemptDetailId(null);
        setAttemptDetailGrades({});
    };

    const openStudentAttemptDetail = async (attemptId: number) => {
        if (lecturerUserId == null || lecturerUserId === '') return;
        setStudentAttemptDetailId(attemptId);
        setStudentAttemptsStep('detail');
        setLoadingStudentAttemptDetail(true);
        try {
            const payload = await fetchLecturerReviewForGrading(attemptId, lecturerUserId);
            setStudentAttemptDetail(payload);
            const gradesArr = Array.isArray(payload?.manualGrades) ? payload.manualGrades : [];
            const next: Record<string, { score: string; feedback: string }> = {};
            gradesArr.forEach((g: any) => {
                const k = String(g?.questionId || '').trim();
                if (k) next[k] = { score: String(g?.score ?? ''), feedback: String(g?.feedback ?? '') };
            });
            setAttemptDetailGrades(next);
        } catch {
            showNotification({
                type: 'error',
                title: 'Attempt detail',
                message: 'Could not load this attempt.',
            });
            setStudentAttemptsStep('list');
        } finally {
            setLoadingStudentAttemptDetail(false);
        }
    };

    const handleSaveAttemptDetailGrade = async (questionId: string) => {
        const attemptId = Number(studentAttemptDetailId || 0);
        const qid = String(questionId || '').trim();
        if (!Number.isFinite(attemptId) || attemptId <= 0 || !qid) return;
        const scoreRaw = String(attemptDetailGrades[qid]?.score || '').trim();
        const feedback = String(attemptDetailGrades[qid]?.feedback || '').trim();
        const score = Number(scoreRaw || 0);
        if (!Number.isFinite(score) || score < 0) {
            showNotification({
                type: 'warning',
                title: 'Manual grading',
                message: 'Please enter a valid score (>= 0).',
            });
            return;
        }
        setSavingAttemptDetailGradeKey(qid);
        try {
            const res: any = await api.post(`/quiz/attempts/${attemptId}/manual-grading`, {
                grades: [{ questionId: qid, score, feedback }],
            });
            const rows = Array.isArray(res?.data) ? res.data : [];
            if (rows.length) {
                const merged = { ...attemptDetailGrades };
                rows.forEach((g: any) => {
                    const k = String(g?.questionId || '').trim();
                    if (k) merged[k] = { score: String(g?.score ?? ''), feedback: String(g?.feedback ?? '') };
                });
                setAttemptDetailGrades(merged);
            }
            showNotification({
                type: 'success',
                title: 'Manual grading',
                message: 'Score and feedback saved.',
            });
        } catch {
            showNotification({
                type: 'error',
                title: 'Manual grading',
                message: 'Unable to save score right now.',
            });
        } finally {
            setSavingAttemptDetailGradeKey('');
        }
    };

    const loadGradingReview = useCallback(
        async (attemptIdNum: number) => {
            if (lecturerUserId == null || lecturerUserId === '') {
                showNotification({
                    type: 'warning',
                    title: 'Grading',
                    message: 'Lecturer account is not available. Please sign in again.',
                });
                return;
            }
            setLoadingGrading(true);
            try {
                const payload = await fetchLecturerReviewForGrading(attemptIdNum, lecturerUserId);
                lastAutoLoadedGradingAttemptRef.current = attemptIdNum;
                setGradingDetail(payload);
                const questions = Array.isArray(payload?.questions) ? payload.questions : [];
                const answersArr = Array.isArray(payload?.attempt?.answers) ? payload.attempt.answers : [];
                const qMarks =
                    payload?.questionMarks != null &&
                    typeof payload.questionMarks === 'object' &&
                    !Array.isArray(payload.questionMarks)
                        ? (payload.questionMarks as Record<string, unknown>)
                        : {};
                const next: Record<string, boolean> = {};
                questions.forEach((q: any, idx: number) => {
                    const k = questionKeyForAttemptRow(q, idx);
                    if (Object.prototype.hasOwnProperty.call(qMarks, k)) {
                        next[k] = Boolean(qMarks[k]);
                        return;
                    }
                    const ans = answersArr.find(
                        (a: any) => String(a?.questionId ?? a?.question_id ?? '') === k
                    );
                    const ic = ans?.is_correct ?? ans?.isCorrect;
                    next[k] = ic === true || ic === 1 || ic === '1' || ic === 'true';
                });
                setGradingMarks(next);
            } catch {
                setGradingDetail(null);
                setGradingMarks({});
                showNotification({
                    type: 'error',
                    title: 'Grading',
                    message: 'Could not load this submission. Check the attempt ID and try again.',
                });
            } finally {
                setLoadingGrading(false);
            }
        },
        [lecturerUserId, showNotification]
    );

    const saveGradingMarks = async () => {
        const attemptId = Number(String(gradingAttemptInput || '').trim());
        if (!Number.isFinite(attemptId) || attemptId <= 0) {
            showNotification({
                type: 'warning',
                title: 'Grading',
                message: 'Enter a valid numeric attempt ID.',
            });
            return;
        }
        if (lecturerUserId == null || lecturerUserId === '') return;
        const items = Object.entries(gradingMarks).map(([questionId, markedCorrect]) => ({
            questionId,
            markedCorrect,
        }));
        if (!items.length) {
            showNotification({
                type: 'warning',
                title: 'Grading',
                message: 'Load a submission before saving.',
            });
            return;
        }
        setSavingGrading(true);
        try {
            await patchQuizAttemptGrade(attemptId, items, lecturerUserId);
            showNotification({
                type: 'success',
                title: 'Grading',
                message: 'Marks saved successfully.',
            });
            await loadGradingReview(attemptId);
        } catch {
            showNotification({
                type: 'error',
                title: 'Grading',
                message: 'Could not save grades. Please try again.',
            });
        } finally {
            setSavingGrading(false);
        }
    };

    const openGradingTabForAttempt = (attemptId: number) => {
        lastAutoLoadedGradingAttemptRef.current = attemptId;
        setGradingAttemptInput(String(attemptId));
        setActiveTab('grading');
        closeStudentAttemptsModal();
        void loadGradingReview(attemptId);
    };

    useEffect(() => {
        if (activeTab !== 'grading') {
            lastAutoLoadedGradingAttemptRef.current = null;
            return;
        }
        const params = new URLSearchParams(location.search);
        const id = Number(String(params.get('attemptId') || '').trim());
        if (!Number.isFinite(id) || id <= 0) return;
        if (lastAutoLoadedGradingAttemptRef.current === id) return;
        lastAutoLoadedGradingAttemptRef.current = id;
        setGradingAttemptInput(String(id));
        void loadGradingReview(id);
    }, [activeTab, location.search, loadGradingReview]);

    const mapApiRowToQuestion = (row: any, i: number): Question => {
        const t = String(row?.type || 'multiple-choice');
        const type = (['multiple-choice', 'true-false', 'short-answer'].includes(t)
            ? t
            : 'multiple-choice') as Question['type'];
        const d = String(row?.difficulty || 'medium');
        const difficulty = (['easy', 'medium', 'hard'].includes(d) ? d : 'medium') as Question['difficulty'];
        const options = Array.isArray(row?.options) ? row.options.map((x: any) => String(x)) : undefined;
        const rawCorrect = row?.correctAnswer != null ? String(row.correctAnswer).trim() : '';
        let normalizedCorrect = rawCorrect;
        if (rawCorrect) {
            const upper = rawCorrect.toUpperCase();
            const letterIdx = LETTERS.indexOf(upper);
            if (letterIdx >= 0 && options?.[letterIdx]) {
                // API may store A/B/C/D; list UI compares against option text.
                normalizedCorrect = String(options[letterIdx]);
            }
        }
        const catRaw = row?.category != null ? String(row.category).trim() : '';
        // Some backends return both:
        // - item_id: primary key in question_bank (the one PATCH/DELETE needs)
        // - id: joined question id from quiz/question table
        // Always prefer item_id for stable edit/delete behavior.
        const rawId = row?.item_id ?? row?.id;
        const numId = Number(rawId);
        // Bank endpoint rows should carry a DB id; fallback stays negative so it never looks persisted.
        const stableId = Number.isFinite(numId) && numId > 0 ? numId : -(Date.now() + i);
        return {
            id: stableId,
            question: String(row?.question ?? ''),
            type,
            topic: String(row?.topic || 'General'),
            difficulty,
            category: catRaw || undefined,
            options,
            correctAnswer: normalizedCorrect || undefined,
            mediaUrl:
                row?.mediaUrl != null
                    ? String(row.mediaUrl)
                    : row?.media_url != null
                      ? String(row.media_url)
                      : undefined,
            quizId: row?.quizId != null && Number.isFinite(Number(row.quizId)) ? Number(row.quizId) : undefined,
            quizTitle: row?.quizTitle != null ? String(row.quizTitle) : undefined,
            explanation:
                row?.explanation != null && String(row.explanation).trim()
                    ? String(row.explanation).trim()
                    : row?.question_explanation != null && String(row.question_explanation).trim()
                      ? String(row.question_explanation).trim()
                      : undefined,
        };
    };

    const loadQuestionBankFromApi = async (opts?: { merge?: boolean }): Promise<Question[]> => {
        if (lecturerUserId == null || lecturerUserId === '') return [];
        const merge = opts?.merge === true;
        setLoadingQuestionBank(true);
        try {
            const res: any = await api.get('/questions/bank', {
                params: { userId: lecturerUserId },
            });
            const rows = Array.isArray(res?.data) ? res.data : [];
            const mapped = rows.map((row: any, i: number) => mapApiRowToQuestion(row, i));
            if (merge) {
                setQuestionBank((prev) => {
                    const byId = new Map<number, Question>();
                    // Keep only local quiz-snapshot rows (negative ids).
                    // Positive ids must follow server truth from /questions/bank.
                    prev.forEach((q) => {
                        if (!q || !Number.isFinite(q.id)) return;
                        if (Number(q.id) < 0) byId.set(q.id, q);
                    });
                    mapped.forEach((q: Question) => {
                        if (q && Number.isFinite(q.id)) byId.set(q.id, q);
                    });
                    return Array.from(byId.values());
                });
            } else {
                setQuestionBank(mapped);
            }
            return mapped;
        } catch {
            if (!merge) setQuestionBank([]);
            return [];
        } finally {
            setLoadingQuestionBank(false);
        }
    };

    const mergeQuestionsIntoBank = (incoming: Question[]) => {
        if (!incoming.length) return;
        setQuestionBank((prev) => {
            const byId = new Map<number, Question>();
            prev.forEach((q) => {
                if (q && Number.isFinite(q.id)) byId.set(q.id, q);
            });
            incoming.forEach((q) => {
                if (q && Number.isFinite(q.id)) byId.set(q.id, q);
            });
            return Array.from(byId.values());
        });
    };

    const formatDateTimeForDisplay = (raw: string): string => {
        const t = String(raw || '').trim();
        if (!t) return '';
        const d = new Date(t);
        if (Number.isNaN(d.getTime())) return '';
        const p = (n: number) => String(n).padStart(2, '0');
        return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    const parseDisplayDateTimeToIso = (raw: string): string | null => {
        const t = String(raw || '').trim();
        if (!t) return '';
        // Accept ISO-like input as fallback.
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) return t.slice(0, 16);
        const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
        if (!m) return null;
        const dd = Number(m[1]);
        const mm = Number(m[2]);
        const yyyy = Number(m[3]);
        const hh = Number(m[4] ?? '0');
        const mi = Number(m[5] ?? '0');
        if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh < 0 || hh > 23 || mi < 0 || mi > 59) return null;
        const d = new Date(yyyy, mm - 1, dd, hh, mi, 0, 0);
        if (
            d.getFullYear() !== yyyy ||
            d.getMonth() !== mm - 1 ||
            d.getDate() !== dd ||
            d.getHours() !== hh ||
            d.getMinutes() !== mi
        ) {
            return null;
        }
        const p = (n: number) => String(n).padStart(2, '0');
        return `${yyyy}-${p(mm)}-${p(dd)}T${p(hh)}:${p(mi)}`;
    };

    const validateQuizFormMeta = (): string | null => {
        if (!quizForm.title?.trim()) {
            return 'Quiz title is required.';
        }
        if (!quizForm.subject?.trim()) {
            return 'Course code is required.';
        }
        const pass = Number(quizForm.passPercentage);
        if (!Number.isFinite(pass) || pass < 1 || pass > 100) {
            return 'Pass percentage must be between 1 and 100. Students need at least this percentage of points to pass.';
        }
        const dur = Number(quizForm.duration);
        if (!Number.isFinite(dur) || dur < 1) {
            return 'Duration must be at least 1 minute.';
        }
        let attemptsNum = Number(quizForm.attemptsAllowed);
        if (quizForm.attemptsAllowed === 'unlimited') attemptsNum = 999;
        if (!Number.isFinite(attemptsNum) || attemptsNum < 1 || attemptsNum > 999) {
            return 'Attempts allowed must be a number from 1 to 999.';
        }
        const nowMs = Date.now();
        const skewMs = 60_000;
        if (quizForm.startDate?.trim()) {
            const t = new Date(quizForm.startDate).getTime();
            if (Number.isFinite(t) && t < nowMs - skewMs) {
                return 'Start date & time cannot be in the past.';
            }
        }
        if (quizForm.endDate?.trim()) {
            const te = new Date(quizForm.endDate).getTime();
            if (Number.isFinite(te) && te < nowMs - skewMs) {
                return 'End date & time cannot be in the past.';
            }
            if (quizForm.startDate?.trim()) {
                const ts = new Date(quizForm.startDate).getTime();
                if (Number.isFinite(ts) && Number.isFinite(te) && te < ts) {
                    return 'End date & time must be on or after the start.';
                }
            }
        }
        return null;
    };

    useEffect(() => {
        // Merge so quiz-snapshot rows (negative ids from GET /quizzes/:id / AI) are not wiped when
        // this fetch completes after handleEditQuiz merges questions into the bank.
        loadQuestionBankFromApi({ merge: true });
        // Deep link to a quiz: open editor from GET /quizzes/:id first; skip the heavy "cloud" catalog
        // on initial mount so we do not block the edit screen on history + documents + analytics.
        if (focusQuizId != null && focusQuizId > 0) return;
        loadLecturerQuizzes();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lecturerUserId, focusQuizId]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);
        params.set('tab', activeTab);
        if (searchQuery.trim()) params.set('q', searchQuery.trim());
        else params.delete('q');
        if (filterSubject !== 'all') params.set('subject', filterSubject);
        else params.delete('subject');
        if (filterStatus !== 'all') params.set('status', filterStatus);
        else params.delete('status');
        if (sortBy && sortBy !== 'newest') params.set('sort', sortBy);
        else params.delete('sort');
        if (page > 1) params.set('page', String(page));
        else params.delete('page');
        if (selectedId && selectedId > 0) params.set('selectedId', String(selectedId));
        else params.delete('selectedId');
        if (activeTab === 'grading' && gradingAttemptInput.trim()) {
            params.set('attemptId', gradingAttemptInput.trim());
        } else {
            params.delete('attemptId');
        }
        const next = `${window.location.pathname}?${params.toString()}${window.location.hash || ''}`;
        window.history.replaceState(null, '', next);
    }, [activeTab, searchQuery, filterSubject, filterStatus, sortBy, page, selectedId, gradingAttemptInput]);

    useEffect(() => {
        if (restoreScrollYRef.current == null) return;
        const y = restoreScrollYRef.current;
        restoreScrollYRef.current = null;
        window.requestAnimationFrame(() => window.scrollTo({ top: y, behavior: 'auto' }));
    }, [quizzes]);

    useEffect(() => {
        const id = Number(selectedItem?.id || 0);
        setSelectedId(Number.isFinite(id) && id > 0 ? id : null);
    }, [selectedItem]);

    // Quiz CRUD Operations
    const handleCreateQuiz = async (status: 'draft' | 'published') => {
        const metaErr = validateQuizFormMeta();
        if (metaErr) {
            showNotification({ type: 'warning', title: 'Quiz form', message: metaErr });
            return;
        }
        const payloadQuestions = buildBackendQuestionsFromSelection();
        if (!payloadQuestions.length) {
            showNotification({
                type: 'warning',
                title: 'Create quiz',
                message: 'Please add/select at least one question before creating.',
            });
            return;
        }
        try {
            setSavingQuiz(true);
            preserveScrollForNextRender();
            const createdRes: any = await api.post('/quizzes', {
                userId: lecturerUserId,
                title: quizForm.title,
                questions: payloadQuestions,
                status,
            });
            await loadLecturerQuizzes();
            await loadQuestionBankFromApi({ merge: true });
            const newQuizId = Number(
                createdRes?.id ??
                    createdRes?.quizId ??
                    createdRes?.data?.id ??
                    createdRes?.data?.quizId ??
                    0
            );
            resetQuizForm();
            setEditingQuizId(null);
            showNotification({
                type: 'success',
                title: 'Create quiz',
                message: status === 'published' ? 'Quiz published successfully!' : 'Draft saved successfully!',
            });
            if (status === 'published') {
                setActiveTab('published');
                if (Number.isFinite(newQuizId) && newQuizId > 0) {
                    setSelectedId(newQuizId);
                }
                if (
                    location.pathname.startsWith('/quiz/') ||
                    location.pathname.startsWith('/lecturer/quiz/')
                ) {
                    navigate('/', { replace: true, state: { instructorMainTab: 'quizzes' as const } });
                }
            } else {
                setActiveTab('draft');
                if (Number.isFinite(newQuizId) && newQuizId > 0) {
                    setSelectedId(newQuizId);
                }
                if (
                    location.pathname.startsWith('/quiz/') ||
                    location.pathname.startsWith('/lecturer/quiz/')
                ) {
                    navigate('/?tab=draft', { replace: true, state: { instructorMainTab: 'quizzes' as const } });
                }
            }
        } catch {
            showNotification({
                type: 'error',
                title: 'Create quiz',
                message: 'Unable to create quiz right now.',
            });
        } finally {
            setSavingQuiz(false);
        }
    };

    const buildBackendQuestionsFromSelection = () => {
        const selectedQuestions = questionBank.filter((q) => quizForm.selectedQuestions.includes(q.id));
        return selectedQuestions.map((q) => {
            const type = String(q?.type || 'multiple-choice').trim().toLowerCase();
            if (type === 'short-answer') {
                return {
                    question: q.question,
                    type: 'short-answer',
                    mediaUrl: String(q.mediaUrl || '').trim() || undefined,
                    correctAnswer: String(q.correctAnswer || '').trim(),
                    ...(String(q.explanation || '').trim()
                        ? { explanation: String(q.explanation).trim() }
                        : {}),
                };
            }
            const opts = Array.isArray(q.options) && q.options.length
                ? q.options
                : type === 'true-false'
                  ? ['True', 'False']
                  : ['Option A', 'Option B', 'Option C', 'Option D'];
            const normalizedOpts = type === 'true-false' ? [String(opts[0] ?? 'True'), String(opts[1] ?? 'False')] : opts;
            const correctIdx = resolveCorrectAnswerIndex(normalizedOpts, q?.correctAnswer);
            return {
                question: q.question,
                type: type === 'true-false' ? 'true-false' : 'multiple-choice',
                mediaUrl: String(q.mediaUrl || '').trim() || undefined,
                options: {
                    A: String(normalizedOpts[0] ?? ''),
                    B: String(normalizedOpts[1] ?? ''),
                    C: type === 'true-false' ? '' : String(normalizedOpts[2] ?? ''),
                    D: type === 'true-false' ? '' : String(normalizedOpts[3] ?? ''),
                },
                correctAnswer: correctIdx,
                ...(String(q.explanation || '').trim()
                    ? { explanation: String(q.explanation).trim() }
                    : {}),
            };
        });
    };

    const handleUpdateQuiz = async (status: 'draft' | 'published') => {
        if (!editingQuizId || editingQuizId <= 0) {
            showNotification({
                type: 'warning',
                title: 'Update quiz',
                message: 'Generate quiz with AI first so the quiz is saved before updating.',
            });
            return;
        }
        if (sharedEditMode) {
            showNotification({
                type: 'info',
                title: 'Comment only',
                message: 'Shared student quizzes are comment-only. Editing questions/answers is disabled.',
            });
            return;
        }
        const metaErr = validateQuizFormMeta();
        if (metaErr) {
            showNotification({ type: 'warning', title: 'Quiz form', message: metaErr });
            return;
        }

        const payloadQuestions = buildBackendQuestionsFromSelection();
        if (!payloadQuestions.length) {
            showNotification({
                type: 'warning',
                title: 'Update quiz',
                message: 'Please generate/select at least one question before updating.',
            });
            return;
        }

        const quizIdJustSaved = editingQuizId;
        try {
            setSavingQuiz(true);
            preserveScrollForNextRender();
            await api.patch(`/quizzes/${editingQuizId}`, {
                userId: lecturerUserId,
                title: quizForm.title,
                questions: payloadQuestions,
            });
            if (status === 'published') {
                await api.post(`/quizzes/${editingQuizId}/publish`, { userId: lecturerUserId });
            }
            await loadLecturerQuizzes();
            await loadQuestionBankFromApi({ merge: true });
            resetQuizForm();
            setEditingQuizId(null);
            setSharedEditMode(false);
            if (status === 'published') {
                setActiveTab('published');
                if (Number.isFinite(quizIdJustSaved) && quizIdJustSaved > 0) {
                    setSelectedId(quizIdJustSaved);
                }
                if (
                    location.pathname.startsWith('/quiz/') ||
                    location.pathname.startsWith('/lecturer/quiz/')
                ) {
                    navigate('/', { replace: true, state: { instructorMainTab: 'quizzes' as const } });
                }
            } else {
                setActiveTab('draft');
                if (Number.isFinite(quizIdJustSaved) && quizIdJustSaved > 0) {
                    setSelectedId(quizIdJustSaved);
                }
                if (
                    location.pathname.startsWith('/quiz/') ||
                    location.pathname.startsWith('/lecturer/quiz/')
                ) {
                    navigate('/?tab=draft', { replace: true, state: { instructorMainTab: 'quizzes' as const } });
                }
            }
            showNotification({
                type: 'success',
                title: 'Update quiz',
                message: status === 'published' ? 'Quiz updated and published successfully!' : 'Draft updated successfully!',
            });
        } catch {
            showNotification({
                type: 'error',
                title: 'Update quiz',
                message: 'Unable to save quiz changes right now.',
            });
        } finally {
            setSavingQuiz(false);
        }
    };

    const handlePublishQuiz = async (quizId: number) => {
        if (!Number.isFinite(quizId) || quizId <= 0) {
            showNotification({
                type: 'warning',
                title: 'Publish quiz',
                message: 'Generate quiz with AI first, then publish the generated quiz.',
            });
            return;
        }
        try {
            preserveScrollForNextRender();
            await api.post(`/quizzes/${quizId}/publish`, { userId: lecturerUserId });
            await loadLecturerQuizzes();
            showNotification({
                type: 'success',
                title: 'Publish quiz',
                message: 'Quiz published successfully!',
            });
        } catch {
            showNotification({
                type: 'error',
                title: 'Publish quiz',
                message: 'Unable to publish quiz.',
            });
        }
    };

    const handleDeleteQuiz = async () => {
        if (!selectedItem || deletingQuiz) return;
        if (!Number.isFinite(selectedItem.id) || selectedItem.id <= 0) {
            showNotification({
                type: 'error',
                title: 'Delete quiz',
                message: 'Only saved drafts can be deleted.',
            });
            return;
        }
        setDeletingQuiz(true);
        try {
            preserveScrollForNextRender();
            await api.delete(`/quizzes/${selectedItem.id}`);
            await loadLecturerQuizzes();
            setModalType(null);
            setSelectedItem(null);
            showNotification({
                type: 'success',
                title: 'Delete quiz',
                message: 'Quiz deleted successfully!',
            });
        } catch {
            showNotification({
                type: 'error',
                title: 'Delete quiz',
                message: 'Unable to delete quiz.',
            });
        } finally {
            setDeletingQuiz(false);
        }
    };

    const handleEditQuiz = async (quiz: Quiz) => {
        const isSharedQuiz = Boolean(quiz?.sharedForReview) || activeTab === 'shared';
        const fallbackSelectedIds = Array.isArray(quiz.questions)
            ? quiz.questions
                .map((q: any) => Number(q?.id ?? q?.question_id))
                .filter((id: number) => Number.isFinite(id))
            : [];

        if (!Number.isFinite(quiz.id) || quiz.id <= 0) {
            setEditingQuizId(null);
            setSharedEditMode(isSharedQuiz);
            setQuizForm({
                title: quiz.title,
                subject: quiz.subject,
                duration: quiz.duration.toString(),
                passPercentage: quiz.passPercentage.toString(),
                attemptsAllowed: quiz.attemptsAllowed === 'unlimited' ? '999' : quiz.attemptsAllowed,
                startDate: quiz.startDate || '',
                endDate: quiz.endDate || '',
                selectedQuestions: fallbackSelectedIds,
            });
            setActiveTab('edit');
            return;
        }

        try {
            const detail: any = await api.get(`/quizzes/${quiz.id}`, {
                params: { userId: lecturerUserId },
            });
            const row = detail?.data || detail || {};
            let detailQuestions = Array.isArray(row?.questions) ? row.questions : [];
            if (isSharedQuiz) {
                try {
                    const sharedRes: any = await api.get(`/quizzes/${quiz.id}/shared-student-result`, {
                        params: { userId: lecturerUserId },
                    });
                    const sharedPayload = sharedRes?.data || sharedRes || {};
                    const sharedAnswers = Array.isArray(sharedPayload?.answers)
                        ? sharedPayload.answers
                        : Array.isArray(sharedPayload?.data?.answers)
                            ? sharedPayload.data.answers
                            : [];
                    const mappedFromStudentAttempt = sharedAnswers.map((a: any, idx: number) => {
                        const opts = Array.isArray(a?.options)
                            ? a.options
                            : (a?.options && typeof a.options === 'object')
                                ? [a.options.A, a.options.B, a.options.C, a.options.D]
                                : [];
                        const selectedLetter = String(a?.selectedAnswer || '').trim().toUpperCase();
                        const selectedText = String(a?.selected_answer || '').trim();
                        return {
                            id: a?.questionId || a?.question_id || `shared-q-${idx + 1}`,
                            question: a?.question_text || a?.question || `Question ${idx + 1}`,
                            options: opts,
                            // In shared-review mode, preselect what student actually chose.
                            correct_answer:
                                (['A', 'B', 'C', 'D'].includes(selectedLetter) ? selectedLetter : '') ||
                                selectedText ||
                                a?.correctAnswer ||
                                'A',
                        };
                    });
                    if (mappedFromStudentAttempt.length) {
                        detailQuestions = mappedFromStudentAttempt;
                    }
                } catch {
                    // fallback to quiz detail questions if shared attempt endpoint unavailable
                }
            }
            const normalized = normalizeGeneratedQuestions(detailQuestions, quiz.subject, quiz.documentCategory);
            const selectedIds = normalized
                .map((q: any) => Number(q?.id))
                .filter((id: number) => Number.isFinite(id));

            if (normalized.length) {
                mergeQuestionsIntoBank(normalized);
            }
            setEditingQuizId(quiz.id);
            setSharedEditMode(isSharedQuiz);
            const codeFromCourse =
                row?.course_code != null && String(row.course_code).trim() !== ''
                    ? String(row.course_code).trim()
                    : row?.courseCode != null && String(row.courseCode).trim() !== ''
                      ? String(row.courseCode).trim()
                      : '';
            setQuizForm({
                title: String(row?.title || quiz.title),
                subject: codeFromCourse || quiz.subject,
                duration: quiz.duration.toString(),
                passPercentage: quiz.passPercentage.toString(),
                attemptsAllowed: quiz.attemptsAllowed === 'unlimited' ? '999' : quiz.attemptsAllowed,
                startDate: quiz.startDate || '',
                endDate: quiz.endDate || '',
                selectedQuestions: selectedIds.length ? selectedIds : fallbackSelectedIds,
            });
            setActiveTab('edit');
        } catch {
            await loadLecturerQuizzes();
            showNotification({
                type: 'error',
                title: 'Edit quiz',
                message: 'This quiz no longer exists. Quiz list has been refreshed.',
            });
        }
    };

    const handleOpenAiQuestionEditor = (quiz: Quiz) => {
        // Open lecturer-only question editing flow for AI-generated quiz content.
        // This is NOT quiz-taking mode (no timer, no score calculation).
        setEditingQuizId(quiz.id > 0 ? quiz.id : null);
        setSharedEditMode(false);
        setQuizForm({
            title: quiz.title || '',
            subject: quiz.subject || '',
            duration: String(quiz.duration || 10),
            passPercentage: String(quiz.passPercentage || 70),
            attemptsAllowed: quiz.attemptsAllowed || '1',
            startDate: '',
            endDate: '',
            selectedQuestions: Array.isArray(quiz.questions)
                ? quiz.questions
                    .map((q: any) => Number(q?.id))
                    .filter((id: number) => Number.isFinite(id))
                : [],
        });
        setActiveTab('edit');
    };

    // Same normalization strategy as StudentQuizSection, with extra shape tolerance.
    const normalizeGeneratedQuestions = (
        quizItems: any[] = [],
        subject: string,
        materialCategory?: string
    ): Question[] => {
        const cat =
            materialCategory != null && String(materialCategory).trim() !== ''
                ? String(materialCategory).trim()
                : '';
        return quizItems.map((q: any, idx: number) => {
            const rawType = String(q?.type || q?.question_type || q?.questionType || 'multiple-choice')
                .trim()
                .toLowerCase();
            const type: 'multiple-choice' | 'true-false' | 'short-answer' =
                rawType === 'short-answer'
                    ? 'short-answer'
                    : rawType === 'true-false'
                        ? 'true-false'
                        : 'multiple-choice';
            const optionsObj = q?.options || {};
            const optionsFromObject = LETTERS.map((k) => optionsObj[k]).filter(Boolean);
            const optionsFromArray = Array.isArray(q?.options) ? q.options : [];
            const optionsFromFlatFields = [
                q?.option_a,
                q?.option_b,
                q?.option_c,
                q?.option_d,
            ].filter(Boolean);
            const options = (optionsFromObject.length
                ? optionsFromObject
                : optionsFromArray.length
                    ? optionsFromArray
                    : optionsFromFlatFields).map((x: any) => String(x));
            const normalizedOptions = type === 'short-answer'
                ? []
                : type === 'true-false'
                    ? [String(options[0] ?? 'True'), String(options[1] ?? 'False')]
                    : options.length
                        ? options.map((x: any) => String(x))
                        : ['Option A', 'Option B', 'Option C', 'Option D'];
            const correctAnswerIdx = resolveCorrectAnswerIndex(
                normalizedOptions,
                q?.correct_answer ?? q?.correctAnswer
            );
            const rawPid = q?.id ?? q?.question_id;
            const id = quizSnapshotQuestionId(rawPid, idx, Date.now());
            return {
                id,
                question: String(q?.question || q?.question_text || `Question ${idx + 1}`),
                type,
                topic: subject || 'General',
                difficulty: 'medium' as const,
                ...(cat ? { category: cat } : {}),
                options: normalizedOptions,
                correctAnswer:
                    type === 'short-answer'
                        ? String(q?.correct_answer ?? q?.correctAnswer ?? '')
                        : normalizedOptions[correctAnswerIdx] || normalizedOptions[0],
                mediaUrl: String(q?.mediaUrl ?? q?.media_url ?? '').trim() || undefined,
                explanation:
                    q?.explanation != null && String(q.explanation).trim()
                        ? String(q.explanation).trim()
                        : q?.question_explanation != null && String(q.question_explanation).trim()
                          ? String(q.question_explanation).trim()
                          : undefined,
            };
        });
    };

    const handleOpenViewQuiz = async (quiz: Quiz) => {
        setSelectedItem(quiz);
        setSelectedId(Number(quiz?.id || 0) || null);
        setModalType('view-quiz');
        setSharedCommentText('');
        setSharedComments([]);
        setSharedAttemptId(null);
        setManualGrades({});
        if (Boolean(quiz?.sharedForReview) && Number.isFinite(quiz.id) && quiz.id > 0) {
            void loadQuizComments(quiz.id);
        }
        if (!Number.isFinite(quiz.id) || quiz.id <= 0) {
            setViewQuizLoading(false);
            return;
        }
        const seq = ++viewQuizFetchSeq.current;
        setViewQuizLoading(true);
        try {
            const detail: any = await api.get(`/quizzes/${quiz.id}`, {
                params: { userId: lecturerUserId },
            });
            if (seq !== viewQuizFetchSeq.current) return;
            const row = detail?.data || detail || {};
            const detailQuestions = Array.isArray(row?.questions) ? row.questions : [];
            const normalized = normalizeGeneratedQuestions(detailQuestions, quiz.subject, quiz.documentCategory);
            let selectedByQuestion = new Map<string, string>();
            let selectedByIndex: string[] = [];
            let answerMetaByIndex: any[] = [];
            if (Boolean(quiz?.sharedForReview)) {
                try {
                    const sharedRes: any = await api.get(`/quizzes/${quiz.id}/shared-student-result`, {
                        params: { userId: lecturerUserId },
                    });
                    const sharedPayload = sharedRes?.data || sharedRes || {};
                    const attemptIdNum = Number(sharedPayload?.attemptId ?? sharedPayload?.data?.attemptId ?? 0);
                    setSharedAttemptId(Number.isFinite(attemptIdNum) && attemptIdNum > 0 ? attemptIdNum : null);
                    const answers = Array.isArray(sharedPayload?.answers)
                        ? sharedPayload.answers
                        : Array.isArray(sharedPayload?.data?.answers)
                            ? sharedPayload.data.answers
                            : [];
                    answerMetaByIndex = answers;
                    selectedByIndex = answers.map((a: any) =>
                        String(a?.selected_answer ?? '').trim() ||
                        String(a?.selectedAnswer ?? '').trim() ||
                        ''
                    );
                    selectedByQuestion = new Map(
                        answers.map((a: any) => [
                            String(a?.questionId ?? a?.question_id ?? ''),
                            String(a?.selected_answer ?? '').trim() ||
                                String(a?.selectedAnswer ?? '').trim() ||
                                '',
                        ])
                    );
                    const manualRows = Array.isArray(sharedPayload?.manualGrades)
                        ? sharedPayload.manualGrades
                        : Array.isArray(sharedPayload?.data?.manualGrades)
                            ? sharedPayload.data.manualGrades
                            : [];
                    if (manualRows.length) {
                        const mapped: Record<string, { score: string; feedback: string }> = {};
                        manualRows.forEach((g: any) => {
                            const key = String(g?.questionId ?? '').trim();
                            if (!key) return;
                            mapped[key] = {
                                score: String(g?.score ?? ''),
                                feedback: String(g?.feedback ?? ''),
                            };
                        });
                        setManualGrades(mapped);
                    }
                } catch {
                    // keep view mode even if shared attempt details are unavailable
                }
            }
            setSelectedItem((prev: any) => {
                if (!prev || prev.id !== quiz.id) return prev;
                const withStudentSelected = normalized.map((q: any, idx: number) => {
                    const answerMeta = answerMetaByIndex[idx] || {};
                    const picked =
                        selectedByQuestion.get(String(q?.id ?? '')) ||
                        selectedByQuestion.get(String(q?.questionId ?? q?.question_id ?? '')) ||
                        selectedByIndex[idx] ||
                        '';
                    return {
                        ...q,
                        questionType: String(answerMeta?.question_type || q?.type || 'multiple-choice'),
                        manualQuestionId: String(answerMeta?.questionId ?? q?.id ?? idx),
                        studentSelectedAnswer: picked,
                    };
                });
                return {
                    ...prev,
                    title: String(row?.title || prev.title),
                    questions: withStudentSelected.length ? withStudentSelected : prev.questions,
                    participants: Number(
                        row?.attemptsCount ??
                            row?.attempts_count ??
                            prev.participants ??
                            0
                    ),
                    averageScore: Number(
                        row?.scorePercent ??
                            row?.averageScorePercent ??
                            row?.average_score_percent ??
                            prev.averageScore ??
                            0
                    ),
                };
            });
        } catch {
            showNotification({
                type: 'error',
                title: 'Quiz details',
                message: 'Could not load questions for this quiz.',
            });
        } finally {
            if (seq === viewQuizFetchSeq.current) {
                setViewQuizLoading(false);
            }
        }
    };

    const extractGeneratedQuizItems = (res: any): any[] => {
        const looksLikeQuestion = (row: any) => {
            if (!row || typeof row !== 'object') return false;
            return (
                typeof row?.question === 'string' ||
                typeof row?.question_text === 'string' ||
                row?.options != null ||
                row?.option_a != null
            );
        };

        // Fast paths for known API response shapes.
        const directBuckets = [
            res?.data?.quiz,
            res?.data?.questions,
            res?.data?.items,
            res?.quiz,
            res?.questions,
            res?.items,
            Array.isArray(res?.data) ? res.data : null,
            res,
        ];
        for (const b of directBuckets) {
            if (Array.isArray(b) && b.length > 0) {
                if (looksLikeQuestion(b[0])) return b;
            }
        }

        // Deep search fallback for nested payload wrappers.
        const queue: any[] = [res];
        const visited = new Set<any>();
        while (queue.length) {
            const cur = queue.shift();
            if (!cur || typeof cur !== 'object' || visited.has(cur)) continue;
            visited.add(cur);
            if (Array.isArray(cur)) {
                if (cur.length > 0 && looksLikeQuestion(cur[0])) return cur;
                for (const item of cur) queue.push(item);
                continue;
            }
            for (const v of Object.values(cur)) queue.push(v);
        }

        return [];
    };

    const numQuestionsForGenerate = (quiz: Quiz): number => {
        const estimated = Array.isArray(quiz?.questions) ? quiz.questions.length : 0;
        if (Number.isFinite(estimated) && estimated > 0) {
            return Math.min(25, Math.max(1, Math.floor(estimated)));
        }
        return 10;
    };

    const handleGenerateAndEditWithAI = async (quiz: Quiz) => {
        try {
            const s3Key = String(quiz?.s3Key || '').trim();
            if (!s3Key) {
                showNotification({
                    type: 'warning',
                    title: 'Generate AI quiz',
                    message: 'This document is not ready for AI generation right now.',
                });
                return;
            }
            const createdBy = Number(lecturerUserId);
            if (!Number.isFinite(createdBy) || createdBy <= 0) {
                showNotification({
                    type: 'warning',
                    title: 'Generate AI quiz',
                    message: 'Your account ID is missing. Please sign in again.',
                });
                return;
            }
            try {
                setAiGeneratingQuizId(quiz.id);
                setLecturerQuizGeneratingStatus('running', {
                    title: quiz.title || 'AI Quiz',
                    quizId: quiz.id,
                });
                const res: any = await api.post(
                    '/quiz/generate',
                    {
                        s3Key,
                        quizId: quiz.id > 0 ? quiz.id : undefined,
                        documentId: quiz.documentId,
                        persist: true,
                        quizTitle: quiz.title,
                        numQuestions: numQuestionsForGenerate(quiz),
                        language: 'English',
                        createdBy,
                    },
                    { timeout: 180000 }
                );
                if (res && res?.success === false) {
                    const backendMessage = String(res?.message || res?.data?.message || '').trim();
                    setLecturerQuizGeneratingStatus('failed', {
                        title: quiz.title || 'AI Quiz',
                        error: backendMessage || 'AI generation is temporarily unavailable.',
                        quizId: quiz.id,
                    });
                    showNotification({
                        type: 'warning',
                        title: 'Generate AI quiz',
                        message: backendMessage || 'AI generation is temporarily unavailable. Please try again in a moment.',
                        duration: Math.min(20000, Math.max(8000, (backendMessage.length || 0) * 40)),
                    });
                    return;
                }
                const autoOpen = Boolean(res?.autoOpen ?? res?.data?.autoOpen);
                const navigateTo = String(res?.navigateTo ?? res?.data?.navigateTo ?? '').trim();
                const navigateReplace = (res as any)?.navigateReplace ?? (res as any)?.data?.navigateReplace;
                const generatedQuizId = Number(
                    res?.data?.quizId ?? res?.data?.data?.quizId ?? res?.quizId ?? quiz.id ?? 0
                );
                if (autoOpen && navigateTo) {
                    const useReplace = navigateReplace !== false;
                    const qid =
                        Number.isFinite(generatedQuizId) && generatedQuizId > 0 ? generatedQuizId : quiz.id;
                    setLecturerQuizGeneratingStatus('completed', {
                        title: quiz.title || 'AI Quiz',
                        quizId: qid,
                        autoOpen: false,
                        navigateTo: '',
                        navigateReplace: useReplace,
                    });
                    navigate(navigateTo, { replace: useReplace });
                    return;
                }
                const generatedRaw = extractGeneratedQuizItems(res);
                const generatedQuestions = normalizeGeneratedQuestions(generatedRaw, quiz.subject, quiz.documentCategory);
                if (!generatedQuestions.length) {
                    const backendMessage = String(res?.message || res?.data?.message || '').trim();
                    setLecturerQuizGeneratingStatus('failed', {
                        title: quiz.title || 'AI Quiz',
                        error: backendMessage || 'No question returned from AI for this document.',
                        quizId: quiz.id,
                    });
                    showNotification({
                        type: 'warning',
                        title: 'Generate AI quiz',
                        message: backendMessage || 'No question returned from AI for this document.',
                    });
                    return;
                }
                const persistedQuizId = Number(
                    res?.data?.quizId ?? res?.data?.data?.quizId ?? res?.quizId ?? quiz.id ?? 0
                );

                // Đồng bộ từ bảng `quiz` (GET /quizzes/:id), không lấy từ question_bank.
                let selectedAfterSync: number[] = [];
                if (Number.isFinite(persistedQuizId) && persistedQuizId > 0 && lecturerUserId != null && lecturerUserId !== '') {
                    try {
                        const detail: any = await api.get(`/quizzes/${persistedQuizId}`, {
                            params: { userId: lecturerUserId },
                        });
                        const row = detail?.data ?? detail;
                        const rawQs = Array.isArray(row?.questions) ? row.questions : [];
                        const mergedFromQuiz = mapQuizDetailRowsToQuestions(rawQs, quiz.subject, persistedQuizId);
                        if (mergedFromQuiz.length) {
                            setQuestionBank((prev) => {
                                const byId = new Map<number, Question>();
                                prev.forEach((x) => {
                                    if (x && Number.isFinite(x.id)) byId.set(x.id, x);
                                });
                                mergedFromQuiz.forEach((x) => byId.set(x.id, x));
                                return Array.from(byId.values());
                            });
                            selectedAfterSync = mergedFromQuiz
                                .map((x) => x.id)
                                .filter((id: number) => Number.isFinite(id));
                        }
                    } catch {
                        /* DB / network */
                    }
                }
                if (!selectedAfterSync.length && generatedQuestions.length) {
                    mergeQuestionsIntoBank(generatedQuestions);
                    selectedAfterSync = generatedQuestions
                        .map((q) => q.id)
                        .filter((id: number) => Number.isFinite(id));
                }

                setQuizForm({
                    title: quiz.title || '',
                    subject: quiz.subject || '',
                    duration: String(quiz.duration || 10),
                    passPercentage: String(quiz.passPercentage || 70),
                    attemptsAllowed: quiz.attemptsAllowed || '1',
                    startDate: '',
                    endDate: '',
                    selectedQuestions: selectedAfterSync,
                });
                setEditingQuizId(Number.isFinite(persistedQuizId) && persistedQuizId > 0 ? persistedQuizId : null);
                setActiveTab('edit');
                setLecturerQuizGeneratingStatus('completed', {
                    title: quiz.title || 'AI Quiz',
                    quizId: Number.isFinite(persistedQuizId) ? persistedQuizId : quiz.id,
                    autoOpen,
                    navigateTo,
                });
            } catch (err: unknown) {
                const backendMsg = getApiErrorMessage(err);
                setLecturerQuizGeneratingStatus('failed', {
                    title: quiz.title || 'AI Quiz',
                    error: backendMsg || 'AI generation is temporarily unavailable.',
                    quizId: quiz.id,
                });
                showNotification({
                    type: 'error',
                    title: 'Generate AI quiz',
                    message:
                        backendMsg ||
                        'AI generation is temporarily unavailable. Please try another document or try again in a moment.',
                    duration: Math.min(25000, Math.max(10000, (backendMsg.length || 0) * 45)),
                });
            } finally {
                setAiGeneratingQuizId(null);
            }
        } finally {
            onInitialAiDocumentConsumed?.();
        }
    };

    useEffect(() => {
        const rawKey = initialAiDocument?.s3Key?.trim();
        if (!rawKey) return;
        setActiveTab('all');
        setHighlightedS3Key(rawKey);
        const timer = window.setTimeout(() => setHighlightedS3Key(''), 8000);
        onInitialAiDocumentConsumed?.();
        return () => window.clearTimeout(timer);
    }, [initialAiDocument, onInitialAiDocumentConsumed]);

    useEffect(() => {
        const rawKey = fileHighlightRequest?.s3Key?.trim();
        const nonce = fileHighlightRequest?.nonce;
        if (!rawKey || nonce == null) return;
        setActiveTab('all');
        setHighlightedS3Key(rawKey);
        const timer = window.setTimeout(() => setHighlightedS3Key(''), 8000);
        onFileHighlightConsumed?.();
        return () => window.clearTimeout(timer);
    }, [fileHighlightRequest?.nonce, fileHighlightRequest?.s3Key, onFileHighlightConsumed]);

    useEffect(() => {
        if (!highlightedS3Key || loadingCloudData) return;
        const target = quizCardRefs.current[highlightedS3Key];
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, [highlightedS3Key, filteredQuizzes, loadingCloudData]);

    useEffect(() => {
        setScheduleDisplay({
            startDate: formatDateTimeForDisplay(quizForm.startDate || ''),
            endDate: formatDateTimeForDisplay(quizForm.endDate || ''),
        });
    }, [quizForm.startDate, quizForm.endDate]);

    useEffect(() => {
        return () => {
            if (questionMediaPreviewUrl.startsWith('blob:')) {
                URL.revokeObjectURL(questionMediaPreviewUrl);
            }
        };
    }, [questionMediaPreviewUrl]);

    useEffect(() => {
        setQuestionMediaPreviewFailed(false);
    }, [questionMediaPreviewUrl, questionForm.mediaUrl]);

    useEffect(() => {
        quizzesRef.current = quizzes;
    }, [quizzes]);

    useEffect(() => {
        if (focusQuizId == null || !Number.isFinite(focusQuizId) || focusQuizId <= 0) return;
        if (lecturerUserId == null || lecturerUserId === '') return;
        if (focusOpenHandledRef.current === focusQuizId) return;

        const runFocusOpen = async () => {
            if (autostartRunningRef.current) return;
            try {
                autostartRunningRef.current = true;
                const quizId = focusQuizId;

                const buildTargetFromDetail = (row: any): Quiz | null => {
                    if (!row || typeof row !== 'object') return null;
                    const detailQuestions = Array.isArray(row?.questions) ? row.questions : [];
                    const subj = String(row?.courseCode || 'DOC');
                    const docCat = String(row?.documentCategory || '');
                    const normalized = normalizeGeneratedQuestions(detailQuestions, subj, docCat);
                    return {
                        id: quizId,
                        title: String(row?.title || 'Quiz'),
                        subject: subj,
                        documentTypeLabel: 'Specialized',
                        documentCategory: docCat,
                        status: String(row?.isPublished || row?.publishedAt ? 'published' : 'draft') as
                            | 'draft'
                            | 'published',
                        questions: normalized,
                        duration: 10,
                        passPercentage: 70,
                        attemptsAllowed: '1',
                        participants: 0,
                        averageScore: 0,
                        createdDate: String(row?.createdAt || ''),
                        s3Key: String(row?.sourceKey || ''),
                    } as Quiz;
                };

                const tryOpenFromDetailApi = async (): Promise<boolean> => {
                    try {
                        const detail: any = await api.get(`/quizzes/${quizId}`, {
                            params: { userId: lecturerUserId },
                        });
                        const row = detail?.data || detail || {};
                        const target = buildTargetFromDetail(row);
                        if (!target) return false;
                        await handleEditQuiz(target);
                        return true;
                    } catch {
                        return false;
                    }
                };

                // Fast path: one quiz-detail request — do not wait for full cloud catalog APIs.
                if (await tryOpenFromDetailApi()) {
                    focusOpenHandledRef.current = focusQuizId;
                    void loadLecturerQuizzes();
                    return;
                }

                // Fallback: hydrate list / retry (slow path).
                const maxAttempts = 8;
                for (let i = 0; i < maxAttempts; i += 1) {
                    let target = quizzesRef.current.find((q) => Number(q?.id) === quizId);
                    if (!target && (await tryOpenFromDetailApi())) {
                        focusOpenHandledRef.current = focusQuizId;
                        void loadLecturerQuizzes();
                        return;
                    }
                    if (!target) {
                        await loadLecturerQuizzes();
                        target = quizzesRef.current.find((q) => Number(q?.id) === quizId);
                    }
                    if (target) {
                        await handleEditQuiz(target);
                        focusOpenHandledRef.current = focusQuizId;
                        void loadLecturerQuizzes();
                        break;
                    }
                    await new Promise((resolve) => window.setTimeout(resolve, 1200));
                }
            } catch {
                // ignore
            } finally {
                autostartRunningRef.current = false;
            }
        };
        void runFocusOpen();
    }, [focusQuizId, lecturerUserId]);

    useEffect(() => {
        const runAutoStart = async () => {
            if (autostartRunningRef.current) return;
            if (focusQuizId != null && focusQuizId > 0) return;
            try {
                const raw = localStorage.getItem(LECTURER_QUIZ_AUTOSTART_KEY);
                if (!raw) return;
                const parsed = JSON.parse(raw) as { quizId?: number | null; title?: string };
                const quizId = Number(parsed?.quizId ?? 0);
                if (!Number.isFinite(quizId) || quizId <= 0) return;
                autostartRunningRef.current = true;
                // Ensure Quizzes list tab is visible before opening editor.
                setActiveTab('all');
                const maxAttempts = 8;
                for (let i = 0; i < maxAttempts; i += 1) {
                    let target = quizzesRef.current.find((q) => Number(q?.id) === quizId);
                    if (!target) {
                        await loadLecturerQuizzes();
                        target = quizzesRef.current.find((q) => Number(q?.id) === quizId);
                    }
                    if (!target) {
                        try {
                            const detail: any = await api.get(`/quizzes/${quizId}`, {
                                params: { userId: lecturerUserId },
                            });
                            const row = detail?.data || detail || {};
                            const detailQuestions = Array.isArray(row?.questions) ? row.questions : [];
                            const normalized = normalizeGeneratedQuestions(detailQuestions, String(row?.courseCode || 'DOC'));
                            target = {
                                id: quizId,
                                title: String(row?.title || parsed?.title || 'AI Quiz'),
                                subject: String(row?.courseCode || 'DOC'),
                                documentTypeLabel: 'Specialized',
                                status: String(row?.isPublished || row?.publishedAt ? 'published' : 'draft') as 'draft' | 'published',
                                questions: normalized,
                                duration: 10,
                                passPercentage: 70,
                                attemptsAllowed: '1',
                                participants: 0,
                                averageScore: 0,
                                createdDate: String(row?.createdAt || ''),
                                s3Key: String(row?.sourceKey || ''),
                                documentCategory: String(row?.documentCategory || ''),
                            } as Quiz;
                        } catch {
                            // keep retry loop
                        }
                    }
                    if (target) {
                        await handleEditQuiz(target);
                        try {
                            localStorage.removeItem(LECTURER_QUIZ_AUTOSTART_KEY);
                        } catch {
                            // ignore
                        }
                        break;
                    }
                    await new Promise((resolve) => window.setTimeout(resolve, 1200));
                }
            } catch {
                // ignore autostart errors
            } finally {
                autostartRunningRef.current = false;
            }
        };
        void runAutoStart();
        const onStorage = (e: StorageEvent) => {
            if (e.key === LECTURER_QUIZ_AUTOSTART_KEY) void runAutoStart();
        };
        const onCustom = () => void runAutoStart();
        window.addEventListener('storage', onStorage);
        window.addEventListener(LECTURER_QUIZ_AUTOSTART_EVENT, onCustom);
        return () => {
            window.removeEventListener('storage', onStorage);
            window.removeEventListener(LECTURER_QUIZ_AUTOSTART_EVENT, onCustom);
        };
    }, [quizzes, focusQuizId]);

    const resetQuizForm = () => {
        setSharedEditMode(false);
        setQuizForm({
            title: '',
            subject: '',
            duration: '',
            passPercentage: '70',
            attemptsAllowed: '1',
            startDate: '',
            endDate: '',
            selectedQuestions: [],
        });
    };

    // Question CRUD Operations
    const handleAddQuestion = async () => {
        try {
            await api.post('/questions/bank', {
                userId: lecturerUserId,
                question: questionForm.question,
                type: questionForm.type,
                topic: questionForm.topic,
                category: questionForm.category || undefined,
                difficulty: questionForm.difficulty,
                options: questionForm.type === 'multiple-choice' ? questionForm.options.filter(o => o) : undefined,
                correctAnswer: normalizeCorrectAnswerForSubmit(questionForm),
                mediaUrl: String(questionForm.mediaUrl || '').trim() || undefined,
                explanation: String(questionForm.explanation || '').trim() || undefined,
            });
            await loadQuestionBankFromApi({ merge: true });
            resetQuestionForm();
            setModalType(null);
            showNotification({
                type: 'success',
                title: 'Question bank',
                message: 'Question added successfully!',
            });
        } catch {
            showNotification({
                type: 'error',
                title: 'Question bank',
                message: 'Unable to add question right now.',
            });
        }
    };

    const handleUpdateQuestion = async () => {
        if (!editingQuestionId) return;
        if (editingQuestionId < 0) {
            const id = editingQuestionId;
            const opts =
                questionForm.type === 'multiple-choice' ? questionForm.options.filter((o) => o) : undefined;
            setQuestionBank((prev) =>
                prev.map((q) => {
                    if (q.id !== id) return q;
                    return {
                        ...q,
                        question: questionForm.question,
                        type: questionForm.type,
                        topic: questionForm.topic,
                        difficulty: questionForm.difficulty,
                        category: questionForm.category || undefined,
                        options: opts ?? q.options,
                        correctAnswer: normalizeCorrectAnswerForSubmit(questionForm),
                        mediaUrl: String(questionForm.mediaUrl || '').trim() || undefined,
                        explanation: String(questionForm.explanation || '').trim() || undefined,
                    };
                })
            );
            resetQuestionForm();
            setEditingQuestionId(null);
            setModalType(null);
            showNotification({
                type: 'success',
                title: 'Question bank',
                message: 'Question updated locally.',
            });
            return;
        }
        try {
            await api.patch(`/questions/bank/${editingQuestionId}`, {
                userId: lecturerUserId,
                question: questionForm.question,
                type: questionForm.type,
                topic: questionForm.topic,
                category: questionForm.category || undefined,
                difficulty: questionForm.difficulty,
                options: questionForm.type === 'multiple-choice' ? questionForm.options.filter(o => o) : undefined,
                correctAnswer: normalizeCorrectAnswerForSubmit(questionForm),
                mediaUrl: String(questionForm.mediaUrl || '').trim() || undefined,
                explanation: String(questionForm.explanation || '').trim() || undefined,
            });
            await loadQuestionBankFromApi({ merge: true });
            resetQuestionForm();
            setEditingQuestionId(null);
            setModalType(null);
            showNotification({
                type: 'success',
                title: 'Question bank',
                message: 'Question updated successfully!',
            });
        } catch {
            showNotification({
                type: 'error',
                title: 'Question bank',
                message: 'Unable to update question right now.',
            });
        }
    };

    const isQuestionBankRow = (q: { id?: number } | null) =>
        q != null && isPersistedQuestionBankId(q.id);

    const handleDeleteQuestion = async () => {
        if (!selectedItem) return;
        if (!isQuestionBankRow(selectedItem)) {
            setQuestionBank((prev) => prev.filter((q) => q.id !== selectedItem.id));
            setModalType(null);
            setSelectedItem(null);
            showNotification({
                type: 'info',
                title: 'Ngân hàng câu hỏi',
                message:
                    'Đã gỡ câu khỏi danh sách. Đây là câu đang gắn với quiz (AI/chi tiết quiz), không phải bản ghi riêng trong ngân hàng trên server — không thể xóa bằng API ngân hàng.',
            });
            return;
        }
        try {
            await api.delete(`/questions/bank/${selectedItem.id}`, {
                params: { userId: lecturerUserId },
            });
            setQuestionBank((prev) => prev.filter((q) => q.id !== selectedItem.id));
            // After deletion, replace local list with server truth (no merge),
            // otherwise stale rows can be kept from previous state.
            await loadQuestionBankFromApi();
            setQuestionBank((prev) => prev.filter((q) => Number(q.id) !== Number(selectedItem.id)));
            setModalType(null);
            setSelectedItem(null);
            showNotification({
                type: 'success',
                title: 'Question bank',
                message: 'Question deleted successfully!',
            });
        } catch (err: unknown) {
            showNotification({
                type: 'error',
                title: 'Question bank',
                message: getApiErrorMessage(err) || 'Unable to delete question right now.',
            });
        }
    };

    const handleEditQuestion = (question: Question) => {
        const opts = question.options || ['', '', '', ''];
        const rawCorrect = String(question.correctAnswer || '').trim();
        let mappedCorrect = rawCorrect;
        if (question.type === 'multiple-choice') {
            const upper = rawCorrect.toUpperCase();
            if (LETTERS.includes(upper)) {
                mappedCorrect = upper;
            } else {
                const idx = opts.findIndex((o) => String(o || '').trim() === rawCorrect);
                mappedCorrect = idx >= 0 ? LETTERS[idx] : upper.slice(0, 1);
            }
        } else if (question.type === 'true-false') {
            const v = rawCorrect.toLowerCase();
            if (v === 'true') mappedCorrect = 'A';
            if (v === 'false') mappedCorrect = 'B';
        }
        setEditingQuestionId(question.id);
        const ck = question.category != null && String(question.category).trim() !== '';
        const cat = ck
            ? (String(question.category).trim().toLowerCase().replace(/_/g, '-') as
                  | 'general'
                  | 'general-major'
                  | 'specialized')
            : '';
        const safeCat =
            cat === 'general' || cat === 'general-major' || cat === 'specialized' ? cat : '';
        setQuestionForm({
            question: question.question,
            type: question.type,
            topic: question.topic,
            category: safeCat,
            difficulty: question.difficulty,
            options: opts,
            correctAnswer: mappedCorrect,
            mediaUrl: String(question.mediaUrl || ''),
            explanation: String(question.explanation || '').trim(),
        });
        setQuestionMediaPreviewUrl((prev) => {
            if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
            return '';
        });
        setModalType('edit-question');
    };

    const resetQuestionForm = () => {
        setQuestionForm({
            question: '',
            type: 'multiple-choice',
            topic: '',
            category: '',
            difficulty: 'medium',
            options: ['', '', '', ''],
            correctAnswer: '',
            mediaUrl: '',
            explanation: '',
        });
        setQuestionMediaPreviewUrl((prev) => {
            if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
            return '';
        });
    };

    const openAddQuestionModal = () => {
        const selectedRows = questionBank.filter((q) => quizForm.selectedQuestions.includes(q.id));
        const topicFromQuiz = String(quizForm.subject || '').trim();
        const topicFallback = String(selectedRows[0]?.topic || '').trim();
        const topic = topicFromQuiz || topicFallback || '';

        const difficultyCounts = new Map<string, number>();
        selectedRows.forEach((q) => {
            const k = String(q?.difficulty || '').trim().toLowerCase();
            if (!k) return;
            difficultyCounts.set(k, (difficultyCounts.get(k) || 0) + 1);
        });
        const difficulty =
            Array.from(difficultyCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] === 'easy'
                ? 'easy'
                : Array.from(difficultyCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] === 'hard'
                  ? 'hard'
                  : 'medium';

        const catRaw = String(selectedRows.find((q) => String(q?.category || '').trim())?.category || '').trim().toLowerCase();
        const category =
            catRaw === 'general' || catRaw === 'general-major' || catRaw === 'specialized'
                ? (catRaw as '' | 'general' | 'general-major' | 'specialized')
                : '';

        resetQuestionForm();
        setEditingQuestionId(null);
        setQuestionForm((prev) => ({
            ...prev,
            topic,
            difficulty,
            category,
        }));
        setModalType('add-question');
    };

    const normalizeCorrectAnswerForSubmit = (form: typeof questionForm) => {
        const raw = String(form.correctAnswer || '').trim();
        if (!raw) return '';
        if (form.type === 'multiple-choice') {
            const upper = raw.toUpperCase();
            if (LETTERS.includes(upper)) return upper;
            const idx = form.options.findIndex((opt) => String(opt || '').trim() === raw);
            if (idx >= 0 && idx < LETTERS.length) return LETTERS[idx];
            return upper.slice(0, 1);
        }
        if (form.type === 'true-false') {
            const v = raw.toLowerCase();
            if (v === 'true' || v === 'a') return 'A';
            if (v === 'false' || v === 'b') return 'B';
        }
        return raw;
    };

    const updateScheduleField = (field: 'startDate' | 'endDate', displayValue: string) => {
        setScheduleDisplay((prev) => ({ ...prev, [field]: displayValue }));
        const parsed = parseDisplayDateTimeToIso(displayValue);
        if (parsed === '') {
            setQuizForm((prev) => ({ ...prev, [field]: '' }));
            return;
        }
        if (typeof parsed === 'string') {
            setQuizForm((prev) => ({ ...prev, [field]: parsed }));
        }
    };

    const validateScheduleFieldOnBlur = (field: 'startDate' | 'endDate') => {
        const raw = String(scheduleDisplay[field] || '').trim();
        if (!raw) return;
        const parsed = parseDisplayDateTimeToIso(raw);
        if (parsed == null) {
            showNotification({
                type: 'warning',
                title: 'Schedule format',
                message: 'Please use date format dd/mm/yyyy HH:mm (for example: 01/05/2026 14:30).',
            });
        }
    };

    const handlePickQuestionMedia = () => {
        questionMediaInputRef.current?.click();
    };

    const handleQuestionMediaFileChange = async (file: File | null) => {
        if (!file) return;
        const mime = String(file.type || '').toLowerCase();
        const isImage = mime.startsWith('image/');
        const isVideo = mime.startsWith('video/');
        if (!isImage && !isVideo) {
            showNotification({
                type: 'warning',
                title: 'Question media',
                message: 'Only image/video files are allowed.',
            });
            return;
        }
        const maxBytes = isVideo ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
        if (file.size > maxBytes) {
            showNotification({
                type: 'warning',
                title: 'Question media',
                message: isVideo ? 'Video must be <= 50MB.' : 'Image must be <= 10MB.',
            });
            return;
        }
        const localPreview = URL.createObjectURL(file);
        setQuestionMediaPreviewUrl((prev) => {
            if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
            return localPreview;
        });
        setUploadingQuestionMedia(true);
        try {
            const base = getApiBaseUrl().replace(/\/$/, '');
            const token = getStoredAuthToken();
            const headers: HeadersInit = {};
            if (token) headers.Authorization = `Bearer ${token}`;
            const uploadTo = async (endpoint: string) => {
                const form = new FormData();
                form.append('mediaFile', file);
                const res = await fetch(`${base}${endpoint}`, {
                    method: 'POST',
                    headers,
                    body: form,
                });
                const payload: any = await res.json().catch(() => ({}));
                return { res, payload };
            };
            let { res, payload } = await uploadTo('/questions/media/upload-s3');
            // Backward-compatible fallback: if S3 route is unavailable/not configured,
            // fallback to local upload endpoint so lecturer workflow is not blocked.
            const backendMsg = String(payload?.message || '').toLowerCase();
            const shouldFallbackLocal =
                res.status === 404 ||
                (res.status >= 500 && (backendMsg.includes('s3 is not configured') || backendMsg.includes('s3')));
            if (!res.ok && shouldFallbackLocal) {
                ({ res, payload } = await uploadTo('/questions/media/upload'));
            }
            if (!res.ok) {
                const msg = String(payload?.message || '').trim() || 'Unable to upload media right now.';
                throw new Error(msg);
            }
            const uploadedUrl = String(
                payload?.data?.fileUrl ||
                    payload?.data?.url ||
                    payload?.data?.location ||
                    payload?.fileUrl ||
                    payload?.url ||
                    payload?.location ||
                    payload?.path ||
                    ''
            ).trim();
            if (!uploadedUrl) throw new Error('Upload succeeded but no media URL returned.');

            const canRenderPreview = await new Promise<boolean>((resolve) => {
                const done = (ok: boolean) => resolve(ok);
                const timer = window.setTimeout(() => done(false), 6000);
                if (isImage) {
                    const img = new Image();
                    img.onload = () => {
                        window.clearTimeout(timer);
                        done(true);
                    };
                    img.onerror = () => {
                        window.clearTimeout(timer);
                        done(false);
                    };
                    img.src = `${uploadedUrl}${uploadedUrl.includes('?') ? '&' : '?'}_t=${Date.now()}`;
                    return;
                }
                if (isVideo) {
                    const v = document.createElement('video');
                    v.preload = 'metadata';
                    v.onloadeddata = () => {
                        window.clearTimeout(timer);
                        done(true);
                    };
                    v.onerror = () => {
                        window.clearTimeout(timer);
                        done(false);
                    };
                    v.src = `${uploadedUrl}${uploadedUrl.includes('?') ? '&' : '?'}_t=${Date.now()}`;
                    return;
                }
                window.clearTimeout(timer);
                done(true);
            });

            if (!canRenderPreview && uploadedUrl.includes('amazonaws.com')) {
                // S3 object may be private/not publicly readable in current bucket policy.
                // Retry with local upload endpoint so preview can render immediately.
                const local = await uploadTo('/questions/media/upload');
                if (local.res.ok) {
                    const localUrl = String(
                        local.payload?.data?.fileUrl ||
                            local.payload?.data?.url ||
                            local.payload?.data?.location ||
                            local.payload?.fileUrl ||
                            local.payload?.url ||
                            local.payload?.location ||
                            local.payload?.path ||
                            ''
                    ).trim();
                    if (localUrl) {
                        setQuestionForm((prev) => ({ ...prev, mediaUrl: localUrl }));
                        showNotification({
                            type: 'success',
                            title: 'Question media',
                            message: 'Media uploaded successfully.',
                        });
                        return;
                    }
                }
            }

            setQuestionForm((prev) => ({ ...prev, mediaUrl: uploadedUrl }));
            showNotification({
                type: 'success',
                title: 'Question media',
                message: 'Media uploaded successfully.',
            });
        } catch (err: unknown) {
            showNotification({
                type: 'error',
                title: 'Question media',
                message: getApiErrorMessage(err) || 'Unable to upload media right now.',
            });
        } finally {
            if (questionMediaInputRef.current) questionMediaInputRef.current.value = '';
            setUploadingQuestionMedia(false);
        }
    };

    const toggleQuestionSelection = (questionId: number) => {
        if (quizForm.selectedQuestions.includes(questionId)) {
            setQuizForm({
                ...quizForm,
                selectedQuestions: quizForm.selectedQuestions.filter(id => id !== questionId),
            });
        } else {
            setQuizForm({
                ...quizForm,
                selectedQuestions: [...quizForm.selectedQuestions, questionId],
            });
        }
    };

    const ensureFourOptions = (opts?: string[]) => {
        const o = [...(opts || [])].map((x) => String(x ?? ''));
        while (o.length < 4) o.push('');
        return o.slice(0, 4);
    };

    const patchQuestionInBank = (questionId: number, patch: Partial<Question>) => {
        setQuestionBank((qb) =>
            qb.map((q) => (q.id === questionId ? { ...q, ...patch } : q))
        );
    };

    // Render Modal
    const renderModal = () => {
        if (!modalType) return null;

        const closeModal = () => {
            viewQuizFetchSeq.current += 1;
            setViewQuizLoading(false);
            setModalType(null);
            setSelectedItem(null);
            setSelectedId(null);
            if (modalType === 'add-question' || modalType === 'edit-question') {
                resetQuestionForm();
                setEditingQuestionId(null);
            }
        };

        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                    {/* Delete Quiz Modal */}
                    {modalType === 'delete-quiz' && (
                        <div className="p-6">
                            <h3 className="mb-4">Delete Quiz</h3>
                            <p className="text-gray-600 mb-6">
                                Are you sure you want to delete "{selectedItem?.title}"? This action cannot be undone.
                            </p>
                            <div className="flex items-center gap-3 justify-end">
                                <button
                                    type="button"
                                    onClick={closeModal}
                                    className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={handleDeleteQuiz}
                                    disabled={deletingQuiz}
                                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    {deletingQuiz ? 'Deleting...' : 'Delete'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Delete Question Modal */}
                    {modalType === 'delete-question' && (
                        <div className="p-6">
                            <h3 className="mb-4">
                                {isQuestionBankRow(selectedItem) ? 'Delete Question' : 'Remove from list'}
                            </h3>
                            <p className="text-gray-600 mb-6">
                                {isQuestionBankRow(selectedItem) ? (
                                    <>
                                        Are you sure you want to delete this question from the question bank? This action
                                        cannot be undone.
                                    </>
                                ) : (
                                    <>
                                        This line is a quiz-linked question (not a separate bank record). You can remove
                                        it from this list only; it will not call the server question-bank delete API.
                                    </>
                                )}
                            </p>
                            <div className="flex items-center gap-3 justify-end">
                                <button
                                    type="button"
                                    onClick={closeModal}
                                    className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={handleDeleteQuestion}
                                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                                >
                                    {isQuestionBankRow(selectedItem) ? 'Delete' : 'Remove from list'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* View Quiz Modal */}
                    {modalType === 'view-quiz' && selectedItem && (
                        <div className="p-6">
                            <div className="flex items-center justify-between mb-6">
                                <h3>{selectedItem.title}</h3>
                                <button
                                    type="button"
                                    onClick={closeModal}
                                    className="p-2 hover:bg-gray-100 rounded-lg"
                                    aria-label="Close Modal"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                            <div className="space-y-4">
                                {Boolean((selectedItem as any)?.sharedForReview) && (
                                    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                                        Shared quiz is in comment-only mode. Editing questions and answers is disabled.
                                    </div>
                                )}
                                {Boolean((selectedItem as any)?.sharedForReview) ? (
                                    <div className="rounded-lg border border-gray-100 bg-gray-50/80 px-4 py-3">
                                        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                            <div>
                                                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                                                    Student
                                                </dt>
                                                <dd className="mt-1 text-gray-900 font-medium">
                                                    {resolveSharedStudentDisplayName(selectedItem as Quiz)}
                                                </dd>
                                            </div>
                                            <div>
                                                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                                                    Shared
                                                </dt>
                                                <dd className="mt-1 text-gray-900 font-medium tabular-nums">
                                                    {formatSharedAtLabel((selectedItem as any)?.sharedAt)}
                                                </dd>
                                            </div>
                                            <div>
                                                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                                                    Course code
                                                </dt>
                                                <dd className="mt-1 text-gray-900 font-medium">{selectedItem.subject}</dd>
                                            </div>
                                        </dl>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <p className="text-gray-500 text-sm">Document Type</p>
                                            <p className="text-gray-900">{selectedItem.documentTypeLabel ?? ''}</p>
                                        </div>
                                        <div>
                                            <p className="text-gray-500 text-sm">Course code</p>
                                            <p className="text-gray-900">{selectedItem.subject}</p>
                                        </div>
                                        <div>
                                            <p className="text-gray-500 text-sm">Status</p>
                                            <p className="text-gray-900">{selectedItem.status}</p>
                                        </div>
                                        <div>
                                            <p className="text-gray-500 text-sm">Duration</p>
                                            <p className="text-gray-900">{selectedItem.duration} minutes</p>
                                        </div>
                                        <div>
                                            <p className="text-gray-500 text-sm">Pass Percentage</p>
                                            <p className="text-gray-900">{selectedItem.passPercentage}%</p>
                                        </div>
                                        <div>
                                            <p className="text-gray-500 text-sm">Participants</p>
                                            <p className="text-gray-900">{selectedItem.participants}</p>
                                        </div>
                                        <div>
                                            <p className="text-gray-500 text-sm">Average Score</p>
                                            <p className="text-gray-900">{selectedItem.averageScore}%</p>
                                        </div>
                                    </div>
                                )}
                                <div>
                                    <p className="text-gray-500 text-sm mb-2">
                                        Questions ({(selectedItem.questions ?? []).length})
                                    </p>
                                    {viewQuizLoading && selectedItem.id > 0 && (
                                        <p className="text-sm text-blue-600 mb-2">Loading question text…</p>
                                    )}
                                    {(selectedItem.questions ?? []).length > 0 ? (
                                        <div className="space-y-3">
                                            {(selectedItem.questions ?? []).map((q: any, idx: number) => {
                                                const text =
                                                    q?.question ??
                                                    q?.question_text ??
                                                    (q == null ? '' : '');
                                                const opts = Array.isArray(q?.options)
                                                    ? q.options
                                                    : LETTERS.map((L) => q?.options?.[L]).filter(Boolean);
                                                const isShortAnswer =
                                                    String(q?.questionType || q?.type || '').toLowerCase() === 'short-answer' ||
                                                    !opts ||
                                                    opts.length === 0;
                                                const manualQid = String(q?.manualQuestionId ?? q?.questionId ?? q?.id ?? idx);
                                                const manualRow = manualGrades[manualQid] || { score: '', feedback: '' };
                                                const studentSelectedText = String(q?.studentSelectedAnswer || '').trim().toLowerCase();
                                                const mediaRawView = String(q?.mediaUrl ?? q?.media_url ?? '').trim();
                                                const mediaSrcView = normalizeMediaPreviewUrl(mediaRawView);

                                                return (
                                                    <div key={idx} className="p-3 bg-gray-50 rounded-lg">
                                                        <p className="text-gray-900 font-semibold text-lg">
                                                            {idx + 1}. {text || ''}
                                                        </p>
                                                        {mediaRawView ? (
                                                            <div className="mt-3 rounded-lg border border-gray-200 bg-white p-2">
                                                                {(() => {
                                                                    const youtubeId = parseYoutubeVideoId(mediaRawView);
                                                                    if (youtubeId) {
                                                                        return (
                                                                            <iframe
                                                                                src={`https://www.youtube.com/embed/${youtubeId}`}
                                                                                title={`Question ${idx + 1} media`}
                                                                                className="w-full max-w-xl h-56 rounded border border-gray-200"
                                                                                allowFullScreen
                                                                            />
                                                                        );
                                                                    }
                                                                    if (isLikelyImageMedia(mediaRawView)) {
                                                                        return (
                                                                            <img
                                                                                src={mediaSrcView}
                                                                                alt={`Question ${idx + 1} media`}
                                                                                className="max-h-64 rounded border border-gray-200 object-contain bg-gray-50"
                                                                                onError={(e) => {
                                                                                    const img = e.currentTarget;
                                                                                    const cur = String(img.getAttribute('src') || '').trim();
                                                                                    if (mediaRawView && cur !== mediaRawView) {
                                                                                        img.setAttribute('src', mediaRawView);
                                                                                        return;
                                                                                    }
                                                                                    img.style.display = 'none';
                                                                                }}
                                                                            />
                                                                        );
                                                                    }
                                                                    if (isLikelyVideoMedia(mediaRawView)) {
                                                                        return (
                                                                            <video
                                                                                src={mediaSrcView}
                                                                                controls
                                                                                className="max-h-64 w-full max-w-xl rounded border border-gray-200 bg-black"
                                                                                onError={(e) => {
                                                                                    const video = e.currentTarget;
                                                                                    const cur = String(video.getAttribute('src') || '').trim();
                                                                                    if (mediaRawView && cur !== mediaRawView) {
                                                                                        video.setAttribute('src', mediaRawView);
                                                                                        video.load();
                                                                                        return;
                                                                                    }
                                                                                }}
                                                                            />
                                                                        );
                                                                    }
                                                                    return (
                                                                        <p className="text-sm text-gray-500">
                                                                            Attachment:{' '}
                                                                            <a
                                                                                href={mediaSrcView}
                                                                                target="_blank"
                                                                                rel="noopener noreferrer"
                                                                                className="text-blue-600 underline break-all"
                                                                            >
                                                                                {mediaRawView}
                                                                            </a>
                                                                        </p>
                                                                    );
                                                                })()}
                                                            </div>
                                                        ) : null}
                                                        {!isShortAnswer && opts && opts.length > 0 && (
                                                            <ul className="mt-3 space-y-1.5">
                                                                {opts.map((opt: string, oi: number) => (
                                                                    <li
                                                                        key={oi}
                                                                        className={`text-base rounded px-2 py-1 ${studentSelectedText && studentSelectedText === String(opt || '').trim().toLowerCase()
                                                                                ? 'bg-red-50 text-red-700 border border-red-200'
                                                                                : 'text-gray-700'
                                                                            }`}
                                                                    >
                                                                        <span className="font-semibold mr-2">{LETTERS[oi] || `${oi + 1}.`}</span>
                                                                        {opt}
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        )}
                                                        {studentSelectedText && (
                                                            <p className="mt-2 text-sm text-red-700">
                                                                Student selected: {String(q?.studentSelectedAnswer)}
                                                            </p>
                                                        )}
                                                        {q?.correctAnswer != null && String(q.correctAnswer).length > 0 && (
                                                            <p className="mt-2 text-sm text-green-700">
                                                                Correct: {String(q.correctAnswer)}
                                                            </p>
                                                        )}
                                                        {Boolean((selectedItem as any)?.sharedForReview) && isShortAnswer && (
                                                            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                                                                <p className="text-sm text-amber-900">
                                                                    Student answer: {String(q?.studentSelectedAnswer || '(empty)')}
                                                                </p>
                                                                <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2">
                                                                    <input
                                                                        type="number"
                                                                        min={0}
                                                                        step={1}
                                                                        value={manualRow.score}
                                                                        onChange={(e) =>
                                                                            setManualGrades((prev) => ({
                                                                                ...prev,
                                                                                [manualQid]: {
                                                                                    score: e.target.value,
                                                                                    feedback: prev[manualQid]?.feedback || '',
                                                                                },
                                                                            }))
                                                                        }
                                                                        placeholder="Score"
                                                                        className="px-3 py-2 border border-amber-300 rounded-lg bg-white"
                                                                    />
                                                                    <input
                                                                        type="text"
                                                                        value={manualRow.feedback}
                                                                        onChange={(e) =>
                                                                            setManualGrades((prev) => ({
                                                                                ...prev,
                                                                                [manualQid]: {
                                                                                    score: prev[manualQid]?.score || '',
                                                                                    feedback: e.target.value,
                                                                                },
                                                                            }))
                                                                        }
                                                                        placeholder="Feedback"
                                                                        className="md:col-span-2 px-3 py-2 border border-amber-300 rounded-lg bg-white"
                                                                    />
                                                                </div>
                                                                <div className="mt-2 flex justify-end">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => void handleSaveManualGrade(manualQid)}
                                                                        disabled={
                                                                            savingManualGradeKey === manualQid ||
                                                                            Number(sharedAttemptId || 0) <= 0
                                                                        }
                                                                        className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs hover:bg-amber-700 disabled:opacity-60"
                                                                    >
                                                                        {savingManualGradeKey === manualQid ? 'Saving...' : 'Save score'}
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        )}
                                                        {String(q?.explanation ?? q?.Explanation ?? '').trim() ? (
                                                            <details className="mt-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
                                                                <summary className="cursor-pointer text-sm font-medium text-gray-700">
                                                                    Explanation (shown to students after submit)
                                                                </summary>
                                                                <p className="mt-2 text-sm text-gray-600 whitespace-pre-wrap">
                                                                    {String(q.explanation ?? q.Explanation)}
                                                                </p>
                                                            </details>
                                                        ) : null}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <p className="text-gray-500">No questions added yet</p>
                                    )}
                                </div>
                                {Boolean((selectedItem as any)?.sharedForReview) && (
                                    <div className="border-t border-gray-200 pt-4">
                                        <p className="text-gray-700 font-medium mb-2">Comments</p>
                                        {commentsLoading ? (
                                            <p className="text-sm text-gray-500 mb-3">Loading comments...</p>
                                        ) : sharedComments.length === 0 ? (
                                            <p className="text-sm text-gray-500 mb-3">No comments yet.</p>
                                        ) : (
                                            <div className="space-y-2 mb-3 max-h-48 overflow-y-auto">
                                                {sharedComments.map((c: any) => (
                                                    <div key={String(c?.id)} className="rounded-lg bg-gray-50 p-3 border border-gray-200">
                                                        <p className="text-xs text-gray-500">
                                                            {String(c?.author || 'Lecturer')} • {formatHourMinute(c?.createdAt)}
                                                        </p>
                                                        <p className="text-sm text-gray-800 mt-1">{String(c?.text || '')}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        <div className="flex gap-2">
                                            <input
                                                type="text"
                                                value={sharedCommentText}
                                                onChange={(e) => setSharedCommentText(e.target.value)}
                                                placeholder="Write a comment for this shared quiz..."
                                                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                            />
                                            <button
                                                type="button"
                                                onClick={handlePostQuizComment}
                                                disabled={savingComment || !sharedCommentText.trim()}
                                                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                                            >
                                                {savingComment ? 'Posting...' : 'Comment'}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Add/Edit Question Modal */}
                    {(modalType === 'add-question' || modalType === 'edit-question') && (
                        <div className="p-6">
                            <div className="flex items-center justify-between mb-6">
                                <h3>{editingQuestionId ? 'Edit Question' : 'Add New Question'}</h3>
                                <button
                                    type="button"
                                    onClick={closeModal}
                                    className="p-2 hover:bg-gray-100 rounded-lg"
                                    aria-label="Close Modal"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-gray-700 mb-2">Question</label>
                                    <textarea
                                        value={questionForm.question}
                                        onChange={(e) => setQuestionForm({ ...questionForm, question: e.target.value })}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        rows={3}
                                        placeholder="Enter your question"
                                    />
                                </div>
                                <div className="grid grid-cols-3 gap-4">
                                    <div>
                                        <label className="block text-gray-700 mb-2">Type</label>
                                        <select
                                            value={questionForm.type}
                                            onChange={(e) => setQuestionForm({ ...questionForm, type: e.target.value as any })}
                                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                            aria-label="Question Type"
                                        >
                                            <option value="multiple-choice">Multiple Choice</option>
                                            <option value="true-false">True/False</option>
                                            <option value="short-answer">Short Answer</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-gray-700 mb-2">Course code</label>
                                        <input
                                            type="text"
                                            value={questionForm.topic}
                                            onChange={(e) => setQuestionForm({ ...questionForm, topic: e.target.value })}
                                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                            placeholder="e.g., CS201"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-gray-700 mb-2">Difficulty</label>
                                        <select
                                            value={questionForm.difficulty}
                                            onChange={(e) => setQuestionForm({ ...questionForm, difficulty: e.target.value as any })}
                                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                            aria-label="Question Difficulty"
                                        >
                                            <option value="easy">Easy</option>
                                            <option value="medium">Medium</option>
                                            <option value="hard">Hard</option>
                                        </select>
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-gray-700 mb-2">Material category (optional)</label>
                                    <select
                                        value={questionForm.category}
                                        onChange={(e) =>
                                            setQuestionForm({
                                                ...questionForm,
                                                category: e.target.value as typeof questionForm.category,
                                            })
                                        }
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        aria-label="Material category"
                                    >
                                        <option value="">— Not set —</option>
                                        <option value="general">General</option>
                                        <option value="general-major">General Major</option>
                                        <option value="specialized">Specialized</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-gray-700 mb-2">Media (optional)</label>
                                    <div className="flex items-center gap-2 mb-2">
                                        <button
                                            type="button"
                                            onClick={handlePickQuestionMedia}
                                            disabled={uploadingQuestionMedia}
                                            className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60"
                                        >
                                            {uploadingQuestionMedia ? 'Uploading...' : 'Upload image/video'}
                                        </button>
                                        <input
                                            ref={questionMediaInputRef}
                                            type="file"
                                            accept="image/*,video/*"
                                            className="hidden"
                                            onChange={(e) => {
                                                const f = e.target.files?.[0] || null;
                                                void handleQuestionMediaFileChange(f);
                                            }}
                                        />
                                    </div>
                                    {String(questionMediaPreviewUrl || questionForm.mediaUrl || '').trim() && (
                                        <div className="mt-3 rounded-lg border border-gray-200 p-3 bg-gray-50">
                                            <p className="text-xs text-gray-500 mb-2">Preview</p>
                                            {(() => {
                                                const rawMediaSrc = String(questionMediaPreviewUrl || questionForm.mediaUrl || '').trim();
                                                const previewSrc = normalizeMediaPreviewUrl(rawMediaSrc);
                                                if (questionMediaPreviewFailed) {
                                                    return (
                                                        <p className="text-sm text-gray-600">
                                                            Preview is unavailable for this media.
                                                        </p>
                                                    );
                                                }
                                                const youtubeId = parseYoutubeVideoId(rawMediaSrc);
                                                if (youtubeId) {
                                                    return (
                                                        <iframe
                                                            src={`https://www.youtube.com/embed/${youtubeId}`}
                                                            title="YouTube preview"
                                                            className="w-full aspect-video rounded border border-gray-200"
                                                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                                            referrerPolicy="strict-origin-when-cross-origin"
                                                            allowFullScreen
                                                        />
                                                    );
                                                }
                                                if (previewSrc.startsWith('blob:') || isLikelyImageMedia(rawMediaSrc)) {
                                                    return (
                                                        <img
                                                            src={previewSrc}
                                                            alt="Question media preview"
                                                            className="max-h-52 w-auto rounded border border-gray-200"
                                                            onError={(e) => {
                                                                const img = e.currentTarget;
                                                                const current = String(img.getAttribute('src') || '').trim();
                                                                if (rawMediaSrc && current !== rawMediaSrc) {
                                                                    img.setAttribute('src', rawMediaSrc);
                                                                    return;
                                                                }
                                                                setQuestionMediaPreviewFailed(true);
                                                            }}
                                                        />
                                                    );
                                                }
                                                if (isLikelyVideoMedia(rawMediaSrc)) {
                                                    return (
                                                        <video
                                                            src={previewSrc}
                                                            controls
                                                            className="max-h-56 w-full rounded border border-gray-200 bg-black"
                                                            onError={(e) => {
                                                                const video = e.currentTarget;
                                                                const current = String(video.getAttribute('src') || '').trim();
                                                                if (rawMediaSrc && current !== rawMediaSrc) {
                                                                    video.setAttribute('src', rawMediaSrc);
                                                                    video.load();
                                                                    return;
                                                                }
                                                                setQuestionMediaPreviewFailed(true);
                                                            }}
                                                        />
                                                    );
                                                }
                                                return (
                                                    <p className="text-sm text-gray-600">
                                                        Media attached.
                                                    </p>
                                                );
                                            })()}
                                        </div>
                                    )}
                                </div>

                                {questionForm.type === 'multiple-choice' && (
                                    <div>
                                        <label className="block text-gray-700 mb-2">Options</label>
                                        <div className="space-y-2">
                                            {questionForm.options.map((option, idx) => (
                                                <div key={idx} className="flex items-center gap-2">
                                                    <span className="text-gray-600">{String.fromCharCode(65 + idx)}.</span>
                                                    <input
                                                        type="text"
                                                        value={option}
                                                        onChange={(e) => {
                                                            const newOptions = [...questionForm.options];
                                                            newOptions[idx] = e.target.value;
                                                            setQuestionForm({ ...questionForm, options: newOptions });
                                                        }}
                                                        className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                                        placeholder={`Option ${idx + 1}`}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {(questionForm.type === 'multiple-choice' ||
                                    questionForm.type === 'true-false') && (
                                    <div>
                                        <label className="block text-gray-700 mb-2">Correct Answer</label>
                                        {questionForm.type === 'multiple-choice' ? (
                                            <select
                                                value={questionForm.correctAnswer}
                                                onChange={(e) => setQuestionForm({ ...questionForm, correctAnswer: e.target.value })}
                                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                                aria-label="Correct Answer"
                                            >
                                                <option value="">Select correct answer</option>
                                                {questionForm.options.filter(o => o).map((option, idx) => (
                                                    <option key={idx} value={LETTERS[idx]}>
                                                        {LETTERS[idx]}. {option}
                                                    </option>
                                                ))}
                                            </select>
                                        ) : questionForm.type === 'true-false' ? (
                                            <select
                                                value={questionForm.correctAnswer}
                                                onChange={(e) => setQuestionForm({ ...questionForm, correctAnswer: e.target.value })}
                                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                                aria-label="Correct Answer"
                                            >
                                                <option value="">Select correct answer</option>
                                                <option value="A">True</option>
                                                <option value="B">False</option>
                                            </select>
                                        ) : (
                                            <input
                                                type="text"
                                                value={questionForm.correctAnswer}
                                                onChange={(e) => setQuestionForm({ ...questionForm, correctAnswer: e.target.value })}
                                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                                aria-label="Correct Answer"
                                                placeholder="Enter expected short answer"
                                            />
                                        )}
                                    </div>
                                )}

                                <div>
                                    <label className="block text-gray-700 mb-2">
                                        Explanation for students (optional)
                                    </label>
                                    <p className="text-xs text-gray-500 mb-2">
                                        Shown only after students submit the quiz — not while they are taking it.
                                    </p>
                                    <textarea
                                        value={questionForm.explanation}
                                        onChange={(e) =>
                                            setQuestionForm({ ...questionForm, explanation: e.target.value })
                                        }
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        rows={3}
                                        placeholder="Why the correct answer is correct (optional)"
                                    />
                                </div>

                                <div className="flex items-center gap-3 justify-end pt-4 border-t border-gray-200">
                                    <button
                                        type="button"
                                        onClick={closeModal}
                                        className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={editingQuestionId ? handleUpdateQuestion : handleAddQuestion}
                                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                    >
                                        {editingQuestionId ? 'Update' : 'Add'} Question
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Select Questions Modal */}
                    {modalType === 'select-questions' && (
                        <div className="p-6">
                            <div className="flex items-center justify-between mb-6">
                                <h3>Select Questions from Bank</h3>
                                <button
                                    type="button"
                                    onClick={closeModal}
                                    className="p-2 hover:bg-gray-100 rounded-lg"
                                    aria-label="Close Modal"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                            <div className="space-y-4 max-h-96 overflow-y-auto">
                                {loadingQuestionBank ? (
                                    <p className="text-gray-500 text-center py-8">Loading question bank…</p>
                                ) : questionBank.length === 0 ? (
                                    <p className="text-gray-500 text-center py-8">
                                        No questions yet. Generate a quiz with AI or add questions after they are stored on the server.
                                    </p>
                                ) : (
                                    questionBank
                                        .filter((q) => q != null)
                                        .map((question) => (
                                    <div
                                        key={question.id}
                                        className={`p-4 border rounded-lg cursor-pointer transition-colors ${quizForm.selectedQuestions.includes(question.id)
                                            ? 'border-blue-600 bg-blue-50'
                                            : 'border-gray-200 hover:border-blue-300'
                                            }`}
                                        onClick={() => toggleQuestionSelection(question.id)}
                                    >
                                        <div className="flex items-start justify-between">
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <input
                                                        type="checkbox"
                                                        checked={quizForm.selectedQuestions.includes(question.id)}
                                                        onChange={() => { }}
                                                        className="w-4 h-4"
                                                        aria-label={`Select question: ${question?.question ?? ''}`}
                                                    />
                                                    <span className="px-2 py-1 rounded text-xs bg-blue-100 text-blue-700">
                                                        {question.type}
                                                    </span>
                                                    <span className={`px-2 py-1 rounded text-xs ${question.difficulty === 'easy' ? 'bg-green-100 text-green-700' :
                                                        question.difficulty === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                                                            'bg-red-100 text-red-700'
                                                        }`}>
                                                        {question.difficulty}
                                                    </span>
                                                </div>
                                                <p className="text-gray-900">{question?.question ?? ''}</p>
                                            </div>
                                        </div>
                                    </div>
                                        ))
                                )}
                            </div>
                            <div className="flex items-center justify-between pt-4 border-t border-gray-200 mt-4">
                                <p className="text-gray-600">{quizForm.selectedQuestions.length} questions selected</p>
                                <button
                                    type="button"
                                    onClick={closeModal}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                >
                                    Done
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    // Render All Quizzes
    const renderAllQuizzes = () => (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h2>All Quizzes</h2>
                <button
                    onClick={() => setActiveTab('create')}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                    <Plus size={20} />
                    Create Quiz
                </button>
            </div>

            {loadingCloudData && (
                <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-blue-700">
                    Loading data...
                </div>
            )}

            {/* Filters */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={20} />
                        <input
                            type="text"
                            placeholder="Search quizzes..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                    </div>
                    <select
                        title="Filter by Subject"
                        value={filterSubject}
                        onChange={(e) => setFilterSubject(e.target.value)}
                        className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                        <option value="all">All Subjects</option>
                        <option value="CS201">CS201</option>
                        <option value="CS202">CS202</option>
                        <option value="CS203">CS203</option>
                        <option value="CS301">CS301</option>
                    </select>
                    <select
                        title="Filter by Status"
                        value={filterStatus}
                        onChange={(e) => setFilterStatus(e.target.value)}
                        className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                        <option value="all">All Status</option>
                        <option value="draft">Draft</option>
                        <option value="published">Published</option>
                    </select>
                </div>
            </div>

            {/* Quizzes List */}
            <div className="space-y-4">
                {filteredQuizzes.length === 0 ? (
                    <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                        {loadingCloudData ? ' ' : 'No quizzes available right now.'}
                    </div>
                ) : (
                    filteredQuizzes.map((quiz) => (
                        <div
                            key={quiz.id}
                            ref={(el) => {
                                const key = String(quiz.s3Key || '').trim();
                                if (!key) return;
                                quizCardRefs.current[key] = el;
                            }}
                            className={`bg-white rounded-lg border p-6 hover:shadow-md transition-shadow ${
                                highlightedS3Key && String(quiz.s3Key || '').trim() === highlightedS3Key
                                    ? 'border-blue-600 ring-4 ring-blue-300/70 shadow-md bg-blue-50/80'
                                    : 'border-gray-200'
                            }`}
                        >
                            <div className="flex items-start justify-between mb-4">
                                <div className="flex-1">
                                    <div className="flex items-center gap-3 mb-2">
                                        <h3 className="text-gray-900">{quiz.title}</h3>
                                        {quiz.status === 'published' && (
                                            <span className="px-3 py-1 rounded-full text-xs bg-green-100 text-green-700">
                                                Published
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1 text-sm text-gray-600">
                                        <p>
                                            <span className="text-gray-500">Document Type: </span>
                                            {quiz.documentTypeLabel}
                                        </p>
                                        <p>
                                            <span className="text-gray-500">Course code: </span>
                                            <span className="text-gray-900 font-medium">{quiz.subject}</span>
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => void handleGenerateAndEditWithAI(quiz)}
                                        disabled={aiGeneratingQuizId != null}
                                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
                                        title={
                                            !String(quiz.s3Key || '').trim()
                                                ? 'This quiz has no linked document (s3Key). Link a document or recreate the quiz from a document.'
                                                : 'Generate questions with AI and open editor'
                                        }
                                    >
                                        {aiGeneratingQuizId === quiz.id ? 'Generating...' : 'Generate & Edit with AI'}
                                    </button>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                <div className="flex items-center gap-2 text-gray-600">
                                    <FileText size={16} />
                                    <span>{quiz.questions.length} Questions</span>
                                </div>
                                <div className="flex items-center gap-2 text-gray-600">
                                    <Users size={16} />
                                    <span>{quiz.participants} Participants</span>
                                </div>
                                {quiz.status === 'published' && (
                                    <div className="flex items-center gap-2 text-gray-600">
                                        <TrendingUp size={16} />
                                        <span>Avg: {quiz.averageScore}%</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );

    // Render Draft Quizzes
    const renderDraftQuizzes = () => (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h2>Draft Quizzes</h2>
                <button
                    onClick={() => setActiveTab('create')}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                    <Plus size={20} />
                    Create Quiz
                </button>
            </div>

            <div className="space-y-4">
                {filteredQuizzes.length === 0 ? (
                    <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                        {loadingCloudData ? ' ' : 'No draft quizzes available right now.'}
                    </div>
                ) : (
                    filteredQuizzes.map((quiz) => (
                        <div key={quiz.id} className="bg-white rounded-lg border border-gray-200 p-6">
                            <div className="flex items-start justify-between mb-4">
                                <div>
                                    <h3 className="text-gray-900 mb-2">{quiz.title}</h3>
                                    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1 text-sm text-gray-600">
                                        <p>
                                            <span className="text-gray-500">Document Type: </span>
                                            {quiz.documentTypeLabel}
                                        </p>
                                        <p>
                                            <span className="text-gray-500">Course code: </span>
                                            <span className="text-gray-900 font-medium">{quiz.subject}</span>
                                        </p>
                                    </div>
                                    <p className="text-gray-500 text-sm mt-1">
                                        Created: {formatDateTimeWithSeconds(quiz.createdDate)}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => handlePublishQuiz(quiz.id)}
                                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                    >
                                        Publish
                                    </button>
                                    <button
                                        aria-label="Edit Quiz"
                                        onClick={() => handleEditQuiz(quiz)}
                                        className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                    >
                                        <Edit3 size={20} />
                                    </button>
                                    <button
                                        aria-label="Delete Quiz"
                                        onClick={() => {
                                            setSelectedItem(quiz);
                                            setModalType('delete-quiz');
                                        }}
                                        className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                    >
                                        <Trash2 size={20} />
                                    </button>
                                </div>
                            </div>
                            <div className="flex items-center gap-4 text-sm text-gray-600">
                                <span>{quiz.questions.length} Questions</span>
                                <span>•</span>
                                <span>{quiz.duration} minutes</span>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );

    // Render Published Quizzes
    const renderPublishedQuizzes = () => (
        <div>
            <h2 className="mb-6">Published Quizzes</h2>
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
                <div className="relative max-w-xl">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={20} />
                    <input
                        type="text"
                        placeholder="Search published quizzes..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                </div>
            </div>

            <div className="space-y-4">
                {filteredQuizzes.length === 0 ? (
                    <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                        {loadingCloudData ? ' ' : 'No published quizzes available right now.'}
                    </div>
                ) : (
                    filteredQuizzes.map((quiz) => (
                        <div key={quiz.id} className="bg-white rounded-lg border border-gray-200 p-6">
                            <div className="flex items-start justify-between mb-4">
                                <div>
                                    <h3 className="text-gray-900 mb-2">{quiz.title}</h3>
                                    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1 text-sm text-gray-600">
                                        <p>
                                            <span className="text-gray-500">Document Type: </span>
                                            {quiz.documentTypeLabel}
                                        </p>
                                        <p>
                                            <span className="text-gray-500">Course code: </span>
                                            <span className="text-gray-900 font-medium">{quiz.subject}</span>
                                        </p>
                                    </div>
                                    <p className="text-gray-500 text-sm mt-1">Published: {formatDateTimeWithSeconds(quiz.publishedDate)}</p>
                                    <p className="text-gray-500 text-sm">
                                        Published by: {quiz.creatorName || 'Lecturer'}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => handleOpenViewQuiz(quiz)}
                                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                    >
                                        View Details
                                    </button>
                                    <button
                                        aria-label="Delete Published Quiz"
                                        onClick={() => {
                                            setSelectedItem(quiz);
                                            setModalType('delete-quiz');
                                        }}
                                        className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                    >
                                        <Trash2 size={20} />
                                    </button>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-gray-200">
                                <div>
                                    <p className="text-gray-500 text-sm mb-1">Participants</p>
                                    <p className="text-gray-900">{quiz.participants} students</p>
                                </div>
                                <div>
                                    <p className="text-gray-500 text-sm mb-1">Duration</p>
                                    <p className="text-gray-900">{quiz.duration} minutes</p>
                                </div>
                                <div>
                                    <p className="text-gray-500 text-sm mb-1">Questions</p>
                                    <p className="text-gray-900">{quiz.questions.length} questions</p>
                                </div>
                                <div>
                                    <p className="text-gray-500 text-sm mb-1">Average Score</p>
                                    <p className="text-gray-900">{quiz.averageScore}%</p>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );

    const renderSharedQuizzes = () => (
        <div>
            <h2 className="mb-6">Shared by Students</h2>

            <div className="space-y-4">
                {filteredQuizzes.length === 0 ? (
                    <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                        {loadingCloudData ? ' ' : 'No student-shared quizzes available right now.'}
                    </div>
                ) : (
                    filteredQuizzes.map((quiz) => (
                        <div key={quiz.id} className="bg-white rounded-lg border border-gray-200 p-6">
                            <div className="flex items-start justify-between mb-4">
                                <div>
                                    <div className="flex items-center gap-3 mb-2">
                                        <h3 className="text-gray-900">{quiz.title}</h3>
                                        <span className="px-3 py-1 rounded-full text-xs bg-indigo-100 text-indigo-700">
                                            Shared
                                        </span>
                                    </div>
                                    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1 text-sm text-gray-600">
                                        <p>
                                            <span className="text-gray-500">Document Type: </span>
                                            {quiz.documentTypeLabel || 'N/A'}
                                        </p>
                                        <p>
                                            <span className="text-gray-500">Course code: </span>
                                            <span className="text-gray-900 font-medium">{quiz.subject}</span>
                                        </p>
                                    </div>
                                    <div className="mt-3 rounded-lg border border-gray-100 bg-gray-50/80 px-4 py-3 text-sm">
                                        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
                                            <div>
                                                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                                                    Student
                                                </dt>
                                                <dd className="mt-0.5 text-gray-900 font-medium">
                                                    {resolveSharedStudentDisplayName(quiz)}
                                                </dd>
                                            </div>
                                            <div>
                                                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                                                    Shared
                                                </dt>
                                                <dd className="mt-0.5 text-gray-900 font-medium tabular-nums">
                                                    {formatSharedAtLabel(quiz.sharedAt || quiz.createdDate)}
                                                </dd>
                                            </div>
                                        </dl>
                                    </div>
                                </div>
                                <button
                                    onClick={() => handleOpenViewQuiz(quiz)}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                >
                                    View Quiz
                                </button>
                            </div>

                            <div className="flex items-center gap-4 text-sm text-gray-600">
                                <span>{quiz.questions.length} Questions</span>
                                <span>•</span>
                                <span>{quiz.participants} Attempts</span>
                                <span>•</span>
                                <span>Status: {quiz.status === 'published' ? 'Published' : 'Draft'}</span>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );

    // Render Analytics
    const renderAnalytics = () => {
        const totalQuizzes = Number(analytics.summary.totalQuizzes || 0);
        const totalParticipants = Number(analytics.summary.totalParticipants || 0);
        const avgScore = Number(analytics.summary.averageScorePercent || 0);
        const completionRate = Number(analytics.summary.completionRatePercent || 0);
        const performanceRows = Array.isArray(analytics.performance) ? analytics.performance : [];
        const challengingRows = Array.isArray(analytics.challengingQuestions) ? analytics.challengingQuestions : [];

        return (
            <div>
                <h2 className="mb-6">Quiz Results & Analytics</h2>
                {loadingAnalytics && (
                    <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-blue-700">
                        Loading analytics from server…
                    </div>
                )}

                {/* Overall Statistics */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                    <div className="bg-white rounded-lg border border-gray-200 p-6">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="p-2 bg-blue-100 text-blue-600 rounded-lg">
                                <FileText size={20} />
                            </div>
                            <p className="text-gray-600">Total Quizzes</p>
                        </div>
                        <h3>{totalQuizzes}</h3>
                    </div>
                    <div className="bg-white rounded-lg border border-gray-200 p-6">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="p-2 bg-green-100 text-green-600 rounded-lg">
                                <Users size={20} />
                            </div>
                            <p className="text-gray-600">Total Participants</p>
                        </div>
                        <h3>{totalParticipants}</h3>
                    </div>
                    <div className="bg-white rounded-lg border border-gray-200 p-6">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="p-2 bg-purple-100 text-purple-600 rounded-lg">
                                <TrendingUp size={20} />
                            </div>
                            <p className="text-gray-600">Average Score</p>
                        </div>
                        <h3>{avgScore.toFixed(1)}%</h3>
                    </div>
                    <div className="bg-white rounded-lg border border-gray-200 p-6">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="p-2 bg-orange-100 text-orange-600 rounded-lg">
                                <CheckCircle size={20} />
                            </div>
                            <p className="text-gray-600">Completion Rate</p>
                        </div>
                        <h3>{completionRate.toFixed(1)}%</h3>
                    </div>
                </div>

                {/* Quiz Performance Table */}
                <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                    <div className="p-6 border-b border-gray-200">
                        <h3>Quiz Performance</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-gray-600">Quiz Title</th>
                                    <th className="px-6 py-3 text-left text-gray-600">Participants</th>
                                    <th className="px-6 py-3 text-left text-gray-600">Avg Score</th>
                                    <th className="px-6 py-3 text-left text-gray-600">Pass Rate</th>
                                    <th className="px-6 py-3 text-left text-gray-600">Difficulty</th>
                                    <th className="px-6 py-3 text-left text-gray-600">Student attempts</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {performanceRows.map((quiz) => (
                                    <tr key={quiz.quizId} className="hover:bg-gray-50">
                                        <td className="px-6 py-4 text-gray-900">{quiz.title}</td>
                                        <td className="px-6 py-4 text-gray-600">{quiz.participants}</td>
                                        <td className="px-6 py-4">
                                            <span className={`px-3 py-1 rounded-full text-sm ${Number(quiz.averageScorePercent || 0) >= 80 ? 'bg-green-100 text-green-700' :
                                                Number(quiz.averageScorePercent || 0) >= 60 ? 'bg-yellow-100 text-yellow-700' :
                                                    'bg-red-100 text-red-700'
                                                }`}>
                                                {Number(quiz.averageScorePercent || 0).toFixed(1)}%
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-gray-600">
                                            {Number(quiz.passRatePercent || 0).toFixed(1)}%
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className="px-3 py-1 rounded-full text-sm bg-blue-100 text-blue-700">
                                                {String(quiz.difficulty || 'Medium')}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4">
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void openStudentAttemptsModal(
                                                        Number(quiz.quizId),
                                                        String(quiz.title || 'Quiz')
                                                    )
                                                }
                                                className="text-sm font-medium text-blue-600 hover:underline"
                                            >
                                                View / grade
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {performanceRows.length === 0 && (
                                    <tr>
                                        <td colSpan={6} className="px-6 py-6 text-center text-gray-500">
                                            No analytics data available yet.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Question Analysis */}
                <div className="bg-white rounded-lg border border-gray-200 p-6 mt-6">
                    <h3 className="mb-4">Most Challenging Questions</h3>
                    <div className="space-y-4">
                        {challengingRows.map((item, idx) => (
                            <div key={item.questionId || idx} className="border-b border-gray-100 pb-4 last:border-0">
                                <div className="flex justify-between items-start mb-2">
                                    <p className="text-gray-900">{item.question}</p>
                                    <span className="text-gray-600 text-sm">{item.attempts} attempts</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className="flex-1 bg-gray-200 rounded-full h-2">
                                        <div
                                            className={`h-2 rounded-full ${Number(item.correctRatePercent || 0) >= 70 ? 'bg-green-500' :
                                                Number(item.correctRatePercent || 0) >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                                                }`}
                                            style={{ width: `${Math.max(0, Math.min(100, Number(item.correctRatePercent || 0)))}%` }}
                                        />
                                    </div>
                                    <span className="text-gray-600 text-sm">{Number(item.correctRatePercent || 0).toFixed(1)}% correct</span>
                                </div>
                            </div>
                        ))}
                        {challengingRows.length === 0 && (
                            <p className="text-gray-500">No question attempt data yet.</p>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    const renderGrading = () => {
        const detail = gradingDetail;
        const attempt = detail?.attempt;
        const questions = Array.isArray(detail?.questions) ? detail.questions : [];
        const answersArr = Array.isArray(attempt?.answers) ? attempt.answers : [];
        return (
            <div>
                <h2 className="mb-2">Grade by attempt</h2>
                <p className="text-sm text-gray-600 mb-4 max-w-3xl">
                    Load a student&apos;s submitted quiz, choose <strong>Correct</strong> or <strong>Incorrect</strong>{' '}
                    for each question, then save. Your choices update how this attempt is marked.
                </p>
                <ol className="text-sm text-gray-600 mb-6 max-w-3xl list-decimal list-inside space-y-2">
                    <li>
                        Easiest: go to <strong>Analytics</strong>, pick a quiz, click <strong>View / grade</strong>, then{' '}
                        <strong>Open Grading tab</strong> next to a student — the attempt loads here automatically.
                    </li>
                    <li>
                        Or type the <strong>attempt number</strong> yourself (the ID shown when a student finishes the
                        quiz, or that someone shares with you), then click <strong>Load submission</strong>.
                    </li>
                    <li>
                        This screen stays blank until you load an attempt. That&apos;s normal if you haven&apos;t entered
                        an ID yet or clicked load from Analytics.
                    </li>
                </ol>

                <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 flex flex-wrap items-end gap-3">
                    <div className="min-w-[200px] flex-1">
                        <label htmlFor="grading-attempt-id" className="block text-sm font-medium text-gray-700 mb-1">
                            Attempt ID
                        </label>
                        <input
                            id="grading-attempt-id"
                            type="text"
                            inputMode="numeric"
                            placeholder="e.g. 12"
                            value={gradingAttemptInput}
                            onChange={(e) => setGradingAttemptInput(e.target.value)}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            const id = Number(String(gradingAttemptInput || '').trim());
                            if (!Number.isFinite(id) || id <= 0) {
                                showNotification({
                                    type: 'warning',
                                    title: 'Grading',
                                    message: 'Enter a valid numeric attempt ID.',
                                });
                                return;
                            }
                            void loadGradingReview(id);
                        }}
                        disabled={loadingGrading}
                        className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-60"
                    >
                        {loadingGrading ? 'Loading…' : 'Load submission'}
                    </button>
                </div>

                {loadingGrading && (
                    <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-blue-700">
                        Loading grading data…
                    </div>
                )}

                {attempt && !loadingGrading ? (
                    <div className="space-y-4">
                        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm">
                            <p className="font-medium text-gray-900">{String(detail?.quizTitle || 'Quiz')}</p>
                            <p className="mt-1 text-gray-600">
                                Score: <strong>{Number(attempt?.scorePercent ?? 0)}%</strong>
                                {' · '}
                                Correct / total:{' '}
                                <strong>
                                    {Number(attempt?.correctCount ?? 0)} / {Number(attempt?.totalQuestions ?? 0)}
                                </strong>
                            </p>
                        </div>

                        <div className="flex flex-wrap justify-end gap-2 mb-2">
                            <button
                                type="button"
                                onClick={() => void saveGradingMarks()}
                                disabled={savingGrading || !questions.length}
                                className="px-5 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
                            >
                                {savingGrading ? 'Saving…' : 'Save grades'}
                            </button>
                        </div>

                        {questions.map((q: any, idx: number) => {
                            const qKey = questionKeyForAttemptRow(q, idx);
                            const ans = answersArr.find(
                                (a: any) => String(a?.questionId ?? a?.question_id ?? '') === qKey
                            );
                            const studentText = formatStudentAnswerForLecturerDisplay(ans);
                            const marked = gradingMarks[qKey] === true;
                            return (
                                <div
                                    key={qKey}
                                    className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
                                >
                                    <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
                                        <p className="text-sm font-medium text-gray-900">
                                            Question {idx + 1}
                                            <span className="ml-2 font-normal text-gray-500">
                                                ({String(q?.type ?? q?.question_type ?? 'mcq').replace(/_/g, '-')})
                                            </span>
                                        </p>
                                        <div className="flex rounded-lg border border-gray-300 overflow-hidden shrink-0">
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setGradingMarks((prev) => ({ ...prev, [qKey]: true }))
                                                }
                                                className={`px-4 py-2 text-sm font-medium transition-colors ${
                                                    marked
                                                        ? 'bg-emerald-600 text-white'
                                                        : 'bg-white text-gray-600 hover:bg-gray-50'
                                                }`}
                                            >
                                                Correct
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setGradingMarks((prev) => ({ ...prev, [qKey]: false }))
                                                }
                                                className={`px-4 py-2 text-sm font-medium border-l border-gray-300 transition-colors ${
                                                    !marked
                                                        ? 'bg-red-600 text-white'
                                                        : 'bg-white text-gray-600 hover:bg-gray-50'
                                                }`}
                                            >
                                                Incorrect
                                            </button>
                                        </div>
                                    </div>
                                    <p className="text-gray-800 mb-2">{String(q?.question ?? q?.question_text ?? '')}</p>
                                    <p className="text-sm text-gray-600">
                                        Student answer:{' '}
                                        <span className="text-gray-900">{studentText || '—'}</span>
                                    </p>
                                    {String(q?.explanation ?? q?.Explanation ?? '').trim() ? (
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
                                                    {String(q.explanation ?? q.Explanation)}
                                                </p>
                                            </div>
                                        </details>
                                    ) : null}
                                </div>
                            );
                        })}
                        {questions.length === 0 ? (
                            <p className="text-sm text-gray-500">No question snapshot available for this quiz.</p>
                        ) : null}
                    </div>
                ) : null}

                {!attempt && !loadingGrading ? (
                    <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-sm text-gray-600">
                        <p className="font-medium text-gray-800 mb-2">Nothing loaded yet</p>
                        <p>
                            Enter an <strong>attempt number</strong> above and click{' '}
                            <strong>Load submission</strong>, or open a submission from{' '}
                            <strong>Analytics → View / grade</strong>. If nothing appears, check that the student has
                            finished the quiz and that you&apos;re grading a quiz you manage.
                        </p>
                    </div>
                ) : null}
            </div>
        );
    };

    // Render Question Bank
    const renderQuestionBank = () => (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h2>Question Bank</h2>
                <button
                    onClick={openAddQuestionModal}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                    <Plus size={20} />
                    Add Question
                </button>
            </div>

            {loadingQuestionBank && (
                <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-blue-700">
                    Loading questions from server…
                </div>
            )}

            {/* Filters */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <select
                        title='Question Type'
                        value={qbFilterType}
                        onChange={(e) => setQbFilterType(e.target.value)}
                        className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                        <option value="all">All Types</option>
                        <option value="multiple-choice">Multiple Choice</option>
                        <option value="true-false">True/False</option>
                        <option value="short-answer">Short Answer</option>
                    </select>
                    <select
                        title="Filter by material category"
                        aria-label="Filter by material category"
                        value={qbFilterCategory}
                        onChange={(e) => setQbFilterCategory(e.target.value as QbCategoryFilter)}
                        className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                        <option value="all">All categories</option>
                        <option value="general">General</option>
                        <option value="general-major">General Major</option>
                        <option value="specialized">Specialized</option>
                        <option value="uncategorized">Uncategorized</option>
                    </select>
                    <select
                        title='Filter by Difficulty'
                        value={qbFilterDifficulty}
                        onChange={(e) => setQbFilterDifficulty(e.target.value)}
                        className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                        <option value="all">All Difficulty</option>
                        <option value="easy">Easy</option>
                        <option value="medium">Medium</option>
                        <option value="hard">Hard</option>
                    </select>
                </div>
            </div>

            {/* Questions List */}
            <div className="space-y-4">
                {filteredQuestions.length === 0 ? (
                    <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                        {persistedBankQuestions.length === 0
                            ? 'No questions in the bank yet. Generate a quiz with AI (persist) or add a question.'
                            : 'No questions match these filters. Set Category / Type / Difficulty to “All” or adjust your filters.'}
                    </div>
                ) : (
                    filteredQuestions.map((question) => (
                        <div key={question.id} className="bg-white rounded-lg border border-gray-200 p-6">
                            <div className="flex items-start justify-between mb-4">
                                <div className="flex-1">
                                    <div className="flex items-center gap-3 mb-2">
                                        <span className="px-3 py-1 rounded-full text-xs bg-blue-100 text-blue-700">
                                            {question.type}
                                        </span>
                                        <span className={`px-3 py-1 rounded-full text-xs ${question.difficulty === 'easy' ? 'bg-green-100 text-green-700' :
                                            question.difficulty === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                                                'bg-red-100 text-red-700'
                                            }`}>
                                            {question.difficulty}
                                        </span>
                                        <span className="text-gray-500 text-sm">{question.topic}</span>
                                        {question.category ? (
                                            <span className="px-3 py-1 rounded-full text-xs bg-slate-100 text-slate-700">
                                                {formatDocumentTypeLabel(question.category)}
                                            </span>
                                        ) : null}
                                    </div>
                                    <p className="text-gray-900 mb-3">{question.question}</p>
                                    {question.type !== 'short-answer' && question.options && (
                                        <div className="space-y-1 text-sm text-gray-600">
                                            {(question.type === 'true-false'
                                                ? question.options.slice(0, 2)
                                                : question.options
                                            ).map((option, idx) => (
                                                <p key={idx} className={option === question.correctAnswer ? 'text-green-600' : ''}>
                                                    {String.fromCharCode(65 + idx)}. {option}
                                                    {option === question.correctAnswer && ' ✓'}
                                                </p>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div className="flex items-center gap-2 ml-4">
                                    <button
                                        aria-label="Edit Question"
                                        onClick={() => handleEditQuestion(question)}
                                        className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                    >
                                        <Edit3 size={20} />
                                    </button>
                                    <button
                                        aria-label="Delete Question"
                                        onClick={() => {
                                            setSelectedItem(question);
                                            setModalType('delete-question');
                                        }}
                                        className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                    >
                                        <Trash2 size={20} />
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );

    // Render Create/Edit Quiz
    const renderQuizForm = () => {
        const isEdit = activeTab === 'edit';

        return (
            <div>
                <div className="flex items-center gap-4 mb-6">
                    <button
                        aria-label="Back to Quiz List"
                        onClick={() => {
                            resetQuizForm();
                            setEditingQuizId(null);
                            setActiveTab('all');
                        }}
                        className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                        <ArrowLeft size={20} />
                    </button>
                    <h2>{isEdit ? 'Edit Quiz' : 'Create New Quiz'}</h2>
                </div>

                {aiGeneratingQuizId != null && (
                    <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-blue-900 text-sm">
                        Generating quiz questions with AI… This may take a few minutes. Stay on this screen.
                    </div>
                )}

                <div className="bg-white rounded-lg border border-gray-200 p-6">
                    <form className="space-y-6" onSubmit={(e) => e.preventDefault()}>
                        {/* Basic Information */}
                        {!sharedEditMode && <div>
                            <h3 className="mb-4">Basic Information</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-gray-700 mb-2">Quiz Title *</label>
                                    <input
                                        type="text"
                                        value={quizForm.title}
                                        onChange={(e) => setQuizForm({ ...quizForm, title: e.target.value })}
                                        placeholder="Enter quiz title"
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-gray-700 mb-2">Course Code *</label>
                                    <input
                                        type="text"
                                        value={quizForm.subject}
                                        onChange={(e) => setQuizForm({ ...quizForm, subject: e.target.value })}
                                        placeholder="e.g., CS201"
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        required
                                    />
                                </div>
                            </div>
                        </div>}

                        {/* Quiz Settings */}
                        {!sharedEditMode && <div>
                            <h3 className="mb-4">Quiz Settings</h3>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                    <label className="block text-gray-700 mb-2">Duration (minutes) *</label>
                                    <input
                                        type="number"
                                        value={quizForm.duration}
                                        onChange={(e) => setQuizForm({ ...quizForm, duration: e.target.value })}
                                        placeholder="60"
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-gray-700 mb-2">Pass Percentage *</label>
                                    <input
                                        type="number"
                                        value={quizForm.passPercentage}
                                        onChange={(e) => setQuizForm({ ...quizForm, passPercentage: e.target.value })}
                                        placeholder="70"
                                        min={1}
                                        max={100}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        required
                                    />
                                    <p className="text-xs text-gray-500 mt-1">
                                        Minimum score (%) required to pass. Students at or above this value are graded as pass.
                                    </p>
                                </div>
                                <div>
                                    <label className="block text-gray-700 mb-2">Attempts Allowed *</label>
                                    <input
                                        type="number"
                                        title="Attempts Allowed"
                                        min={1}
                                        max={999}
                                        value={
                                            quizForm.attemptsAllowed === 'unlimited'
                                                ? 999
                                                : Math.min(999, Math.max(1, Number(quizForm.attemptsAllowed) || 1))
                                        }
                                        onChange={(e) => {
                                            const raw = e.target.value;
                                            const n =
                                                raw === ''
                                                    ? 1
                                                    : Math.min(999, Math.max(1, Math.floor(Number(raw))));
                                            setQuizForm({ ...quizForm, attemptsAllowed: String(n) });
                                        }}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        required
                                    />
                                </div>
                            </div>
                        </div>}

                        {/* Question Selection */}
                        {!sharedEditMode ? (
                        <div>
                            <div className="flex items-center justify-between mb-4">
                                <h3>Questions ({quizForm.selectedQuestions.length} selected)</h3>
                                <button
                                    type="button"
                                    onClick={() => {
                                        void (async () => {
                                            await loadQuestionBankFromApi({ merge: true });
                                            setModalType('select-questions');
                                        })();
                                    }}
                                    className="flex items-center gap-2 px-4 py-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                >
                                    <Database size={20} />
                                    Select from Question Bank
                                </button>
                            </div>
                            {quizForm.selectedQuestions.length > 0 ? (
                                <div className="border border-gray-300 rounded-lg p-4 space-y-2">
                                    {questionBank
                                        .filter(q => quizForm.selectedQuestions.includes(q.id))
                                        .map((question, idx) => {
                                            const opts = ensureFourOptions(question.options);
                                            const qType = String(question.type || 'multiple-choice').toLowerCase();
                                            const isMc = qType === 'multiple-choice';
                                            const isTf = qType === 'true-false';
                                            const mediaRaw = String(question.mediaUrl || '').trim();
                                            const mediaSrc = normalizeMediaPreviewUrl(mediaRaw);

                                            return (
                                                <div key={question.id} className="p-3 bg-gray-50 rounded-lg border border-gray-100">
                                                    <div className="flex items-start justify-between gap-3">
                                                        <span className="text-gray-600 shrink-0 pt-2">{idx + 1}.</span>
                                                        <div className="flex-1 space-y-3 min-w-0">
                                                            <label className="block text-sm text-gray-600">Question</label>
                                                            <textarea
                                                                value={question.question}
                                                                onChange={(e) =>
                                                                    patchQuestionInBank(question.id, {
                                                                        question: e.target.value,
                                                                    })
                                                                }
                                                                rows={2}
                                                                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                                                            />
                                                            {mediaRaw && (
                                                                <div>
                                                                    <label className="block text-sm text-gray-600 mb-1">
                                                                        Media
                                                                    </label>
                                                                    <div className="mt-2 rounded-lg border border-gray-200 bg-white p-2">
                                                                        {(() => {
                                                                            const youtubeId = parseYoutubeVideoId(mediaRaw);
                                                                            if (youtubeId) {
                                                                                return (
                                                                                    <iframe
                                                                                        src={`https://www.youtube.com/embed/${youtubeId}`}
                                                                                        title={`Question media ${idx + 1}`}
                                                                                        className="w-full max-w-xl h-56 rounded border border-gray-200"
                                                                                        allowFullScreen
                                                                                    />
                                                                                );
                                                                            }
                                                                            if (isLikelyImageMedia(mediaRaw)) {
                                                                                return (
                                                                                    <img
                                                                                        src={mediaSrc}
                                                                                        alt={`Question ${idx + 1} media`}
                                                                                        className="max-h-64 rounded border border-gray-200 object-contain bg-gray-50"
                                                                                        onError={(e) => {
                                                                                            const img = e.currentTarget;
                                                                                            const current = String(img.getAttribute('src') || '').trim();
                                                                                            const raw = String(mediaRaw || '').trim();
                                                                                            if (raw && current !== raw) {
                                                                                                img.setAttribute('src', raw);
                                                                                                return;
                                                                                            }
                                                                                            img.style.display = 'none';
                                                                                            const holder = img.parentElement;
                                                                                            if (holder && !holder.querySelector('[data-media-fallback]')) {
                                                                                                const p = document.createElement('p');
                                                                                                p.setAttribute('data-media-fallback', '1');
                                                                                                p.className = 'text-sm text-gray-500';
                                                                                                p.textContent = 'Preview is unavailable for this media.';
                                                                                                holder.appendChild(p);
                                                                                            }
                                                                                        }}
                                                                                    />
                                                                                );
                                                                            }
                                                                            if (isLikelyVideoMedia(mediaRaw)) {
                                                                                return (
                                                                                    <video
                                                                                        src={mediaSrc}
                                                                                        controls
                                                                                        className="max-h-64 w-full max-w-xl rounded border border-gray-200 bg-black"
                                                                                        onError={(e) => {
                                                                                            const video = e.currentTarget;
                                                                                            const current = String(video.getAttribute('src') || '').trim();
                                                                                            const raw = String(mediaRaw || '').trim();
                                                                                            if (raw && current !== raw) {
                                                                                                video.setAttribute('src', raw);
                                                                                                video.load();
                                                                                                return;
                                                                                            }
                                                                                        }}
                                                                                    />
                                                                                );
                                                                            }
                                                                            return (
                                                                                <p className="text-sm text-gray-500">
                                                                                    Media attached.
                                                                                </p>
                                                                            );
                                                                        })()}
                                                                    </div>
                                                                </div>
                                                            )}
                                                            {isMc ? (
                                                                <div className="space-y-2">
                                                                    <p className="text-sm text-gray-600">Answer choices</p>
                                                                    {opts.map((opt, optIdx) => {
                                                                        const letter = LETTERS[optIdx];
                                                                        const isCorrect =
                                                                            String(question.correctAnswer || '') ===
                                                                            String(opt);
                                                                        return (
                                                                            <div
                                                                                key={`${question.id}-opt-${optIdx}`}
                                                                                className="flex flex-wrap items-center gap-2 sm:gap-3"
                                                                            >
                                                                                <span className="w-6 text-gray-500 shrink-0">
                                                                                    {letter}.
                                                                                </span>
                                                                                <input
                                                                                    type="text"
                                                                                    value={opt}
                                                                                    onChange={(e) => {
                                                                                        const next = [...opts];
                                                                                        const prevText = next[optIdx];
                                                                                        next[optIdx] = e.target.value;
                                                                                        let nextCorrect = question.correctAnswer;
                                                                                        if (
                                                                                            String(nextCorrect) ===
                                                                                            String(prevText)
                                                                                        ) {
                                                                                            nextCorrect = e.target.value;
                                                                                        }
                                                                                        patchQuestionInBank(question.id, {
                                                                                            options: next,
                                                                                            correctAnswer: nextCorrect,
                                                                                        });
                                                                                    }}
                                                                                    className="flex-1 min-w-[120px] px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                                                                />
                                                                                <label className="flex items-center gap-1.5 text-sm text-gray-700 shrink-0 cursor-pointer">
                                                                                    <input
                                                                                        type="radio"
                                                                                        name={`correct-${question.id}`}
                                                                                        checked={isCorrect}
                                                                                        onChange={() =>
                                                                                            patchQuestionInBank(
                                                                                                question.id,
                                                                                                {
                                                                                                    correctAnswer: opt,
                                                                                                }
                                                                                            )
                                                                                        }
                                                                                        className="rounded-full"
                                                                                    />
                                                                                    Correct
                                                                                </label>
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            ) : isTf ? (
                                                                <div className="space-y-2">
                                                                    <p className="text-sm text-gray-600">Answer choices</p>
                                                                    {[
                                                                        { key: 'A', label: 'True' },
                                                                        { key: 'B', label: 'False' },
                                                                    ].map((row) => {
                                                                        const current = String(question.correctAnswer || '').trim().toLowerCase();
                                                                        const isCorrect =
                                                                            current === row.key.toLowerCase() ||
                                                                            current === row.label.toLowerCase();
                                                                        return (
                                                                            <div
                                                                                key={`${question.id}-tf-${row.key}`}
                                                                                className="flex items-center justify-between gap-3"
                                                                            >
                                                                                <span className="text-gray-900">{row.label}</span>
                                                                                <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
                                                                                    <input
                                                                                        type="radio"
                                                                                        name={`correct-${question.id}`}
                                                                                        checked={isCorrect}
                                                                                        onChange={() =>
                                                                                            patchQuestionInBank(question.id, {
                                                                                                options: ['True', 'False'],
                                                                                                correctAnswer: row.key,
                                                                                            })
                                                                                        }
                                                                                        className="rounded-full"
                                                                                    />
                                                                                    Correct
                                                                                </label>
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            ) : (
                                                                <div>
                                                                    <label className="block text-sm text-gray-600 mb-1">
                                                                        Correct / expected answer
                                                                    </label>
                                                                    <input
                                                                        type="text"
                                                                        value={String(question.correctAnswer ?? '')}
                                                                        onChange={(e) =>
                                                                            patchQuestionInBank(question.id, {
                                                                                correctAnswer: e.target.value,
                                                                            })
                                                                        }
                                                                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                                                    />
                                                                </div>
                                                            )}
                                                            <div className="mt-3 border-t border-gray-200 pt-3">
                                                                <label className="block text-sm font-medium text-gray-800">
                                                                    Explanation{' '}
                                                                    <span className="font-normal text-gray-500">(optional)</span>
                                                                </label>
                                                                <p className="text-xs text-gray-500 mt-0.5 mb-2">
                                                                    Shown to students after they submit (correct or incorrect). Use
                                                                    it to explain why the right answer is correct.
                                                                </p>
                                                                <textarea
                                                                    value={String(question.explanation ?? '')}
                                                                    onChange={(e) =>
                                                                        patchQuestionInBank(question.id, {
                                                                            explanation: e.target.value,
                                                                        })
                                                                    }
                                                                    rows={3}
                                                                    placeholder="e.g. Why the correct option matches the source material…"
                                                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                                                                />
                                                            </div>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            aria-label="Remove Question"
                                                            onClick={() => toggleQuestionSelection(question.id)}
                                                            className="text-red-600 hover:bg-red-50 p-2 rounded-lg shrink-0"
                                                        >
                                                            <X size={16} />
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                </div>
                            ) : (
                                <div className="border border-gray-300 rounded-lg p-4 bg-gray-50 text-center text-gray-500">
                                    <p>No questions added yet. Select questions from the question bank.</p>
                                </div>
                            )}
                        </div>
                        ) : (
                            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-800 text-sm">
                                Shared student quizzes are comment-only. Question editing and question-bank selection are disabled.
                            </div>
                        )}

                        {/* Schedule */}
                        {!sharedEditMode && <div>
                            <h3 className="mb-4">Schedule (Optional)</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-gray-700 mb-2">Start Date & Time</label>
                                    <input
                                        type="text"
                                        aria-label="Start Date & Time"
                                        value={scheduleDisplay.startDate}
                                        placeholder="dd/mm/yyyy HH:mm"
                                        onChange={(e) => updateScheduleField('startDate', e.target.value)}
                                        onBlur={() => validateScheduleFieldOnBlur('startDate')}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                    />
                                </div>
                                <div>
                                    <label className="block text-gray-700 mb-2">End Date & Time</label>
                                    <input
                                        aria-label="End Date & Time"
                                        type="text"
                                        value={scheduleDisplay.endDate}
                                        placeholder="dd/mm/yyyy HH:mm"
                                        onChange={(e) => updateScheduleField('endDate', e.target.value)}
                                        onBlur={() => validateScheduleFieldOnBlur('endDate')}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                    />
                                </div>
                            </div>
                        </div>}

                        {/* Action Buttons */}
                        <div className="flex items-center gap-3 pt-4 border-t border-gray-200">
                            {sharedEditMode ? (
                                <div className="px-4 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-sm">
                                    Comment-only mode for shared student quizzes. Editing is disabled.
                                </div>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (isEdit) {
                                                handleUpdateQuiz('published');
                                            } else {
                                                handleCreateQuiz('published');
                                            }
                                        }}
                                        disabled={savingQuiz}
                                        className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                    >
                                        {savingQuiz ? 'Saving...' : isEdit ? 'Update & Publish' : 'Publish Quiz'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (isEdit) {
                                                handleUpdateQuiz('draft');
                                            } else {
                                                handleCreateQuiz('draft');
                                            }
                                        }}
                                        disabled={savingQuiz}
                                        className="px-6 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                                    >
                                        <Save size={18} className="inline mr-2" />
                                        {savingQuiz ? 'Saving...' : isEdit ? 'Update Draft' : 'Save as Draft'}
                                    </button>
                                </>
                            )}
                            <button
                                type="button"
                                onClick={() => {
                                    resetQuizForm();
                                    setEditingQuizId(null);
                                    setActiveTab('all');
                                }}
                                className="px-6 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        );
    };

    const renderStudentAttemptsModal = () => {
        if (!studentAttemptsOpen) return null;
        const detail = studentAttemptDetail;
        const attempt = detail?.attempt;
        const questions = Array.isArray(detail?.questions) ? detail.questions : [];
        const answersArr = Array.isArray(attempt?.answers) ? attempt.answers : [];

        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
                <div className="bg-white rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-xl">
                    <div className="p-6 border-b border-gray-200 flex items-start justify-between gap-3">
                        <div>
                            <h3 className="text-lg font-semibold text-gray-900">
                                {studentAttemptsStep === 'list' ? 'Student attempts' : 'Grade attempt'}
                            </h3>
                            <p className="text-sm text-gray-600 mt-1">{studentAttemptsTitle}</p>
                        </div>
                        <button
                            type="button"
                            aria-label="Close"
                            onClick={closeStudentAttemptsModal}
                            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500"
                        >
                            <X size={22} />
                        </button>
                    </div>

                    <div className="p-6">
                        {studentAttemptsStep === 'list' && (
                            <>
                                {loadingStudentAttempts ? (
                                    <p className="text-sm text-blue-600">Loading attempts…</p>
                                ) : studentAttemptsList.length === 0 ? (
                                    <p className="text-sm text-gray-500">No completed attempts yet for this quiz.</p>
                                ) : (
                                    <div className="overflow-x-auto border border-gray-200 rounded-lg">
                                        <table className="w-full text-sm">
                                            <thead className="bg-gray-50 text-left">
                                                <tr>
                                                    <th className="px-4 py-2 text-gray-600">Student</th>
                                                    <th className="px-4 py-2 text-gray-600">Score</th>
                                                    <th className="px-4 py-2 text-gray-600">Completed</th>
                                                    <th className="px-4 py-2 text-gray-600"> </th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-gray-100">
                                                {studentAttemptsList.map((row: any) => (
                                                    <tr key={String(row?.attemptId)}>
                                                        <td className="px-4 py-3">
                                                            <span className="text-gray-900">{String(row?.studentName || 'Student')}</span>
                                                            {row?.studentEmail ? (
                                                                <span className="block text-xs text-gray-500">{String(row.studentEmail)}</span>
                                                            ) : null}
                                                        </td>
                                                        <td className="px-4 py-3">
                                                            {Number(row?.scorePercent ?? 0)}%
                                                        </td>
                                                        <td className="px-4 py-3 text-gray-600">
                                                            {formatDateTimeWithSeconds(row?.completedAt) || '—'}
                                                        </td>
                                                        <td className="px-4 py-3 text-right">
                                                            <div className="flex flex-wrap justify-end gap-2">
                                                                <button
                                                                    type="button"
                                                                    onClick={() => void openStudentAttemptDetail(Number(row?.attemptId))}
                                                                    className="text-blue-600 hover:underline font-medium"
                                                                >
                                                                    Open / grade
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={() =>
                                                                        openGradingTabForAttempt(Number(row?.attemptId))
                                                                    }
                                                                    className="text-emerald-700 hover:underline font-medium text-sm"
                                                                >
                                                                    Open Grading tab
                                                                </button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </>
                        )}

                        {studentAttemptsStep === 'detail' && (
                            <>
                                <div className="mb-4 flex flex-wrap items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setStudentAttemptsStep('list');
                                            setStudentAttemptDetail(null);
                                            setStudentAttemptDetailId(null);
                                            setAttemptDetailGrades({});
                                        }}
                                        className="text-sm text-blue-600 hover:underline"
                                    >
                                        ← Back to list
                                    </button>
                                </div>
                                {loadingStudentAttemptDetail ? (
                                    <p className="text-sm text-blue-600">Loading attempt…</p>
                                ) : attempt ? (
                                    <div className="space-y-4">
                                        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm">
                                            <p>
                                                <span className="text-gray-500">Score: </span>
                                                <strong>{Number(attempt?.scorePercent ?? 0)}%</strong>
                                                {' · '}
                                                <span className="text-gray-500">Questions: </span>
                                                <strong>
                                                    {Number(attempt?.correctCount ?? 0)} / {Number(attempt?.totalQuestions ?? 0)}
                                                </strong>
                                            </p>
                                        </div>
                                        {questions.map((q: any, idx: number) => {
                                            const qKey = questionKeyForAttemptRow(q, idx);
                                            const ans = answersArr.find(
                                                (a: any) => String(a?.questionId ?? a?.question_id ?? '') === qKey
                                            );
                                            const studentText = formatStudentAnswerForLecturerDisplay(ans);
                                            const short = isShortAnswerAttemptQ(q);
                                            return (
                                                <div
                                                    key={qKey}
                                                    className={`rounded-lg border p-4 ${short ? 'border-amber-200 bg-amber-50/40' : 'border-gray-200 bg-white'}`}
                                                >
                                                    <p className="text-sm font-medium text-gray-900 mb-1">
                                                        Question {idx + 1}
                                                        {short ? (
                                                            <span className="ml-2 text-xs font-normal uppercase text-amber-800">Short answer</span>
                                                        ) : null}
                                                    </p>
                                                    <p className="text-gray-800 mb-2">{String(q?.question ?? q?.question_text ?? '')}</p>
                                                    <p className="text-sm text-gray-600">
                                                        Student answer:{' '}
                                                        <span className="text-gray-900">{studentText || '—'}</span>
                                                    </p>
                                                    {short ? (
                                                        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
                                                            <input
                                                                type="number"
                                                                min={0}
                                                                step={1}
                                                                placeholder="Score"
                                                                value={attemptDetailGrades[qKey]?.score ?? ''}
                                                                onChange={(e) =>
                                                                    setAttemptDetailGrades((prev) => ({
                                                                        ...prev,
                                                                        [qKey]: {
                                                                            score: e.target.value,
                                                                            feedback: prev[qKey]?.feedback || '',
                                                                        },
                                                                    }))
                                                                }
                                                                className="px-3 py-2 border border-amber-300 rounded-lg bg-white"
                                                            />
                                                            <input
                                                                type="text"
                                                                placeholder="Feedback"
                                                                value={attemptDetailGrades[qKey]?.feedback ?? ''}
                                                                onChange={(e) =>
                                                                    setAttemptDetailGrades((prev) => ({
                                                                        ...prev,
                                                                        [qKey]: {
                                                                            score: prev[qKey]?.score || '',
                                                                            feedback: e.target.value,
                                                                        },
                                                                    }))
                                                                }
                                                                className="md:col-span-2 px-3 py-2 border border-amber-300 rounded-lg bg-white"
                                                            />
                                                            <div className="md:col-span-3 flex justify-end">
                                                                <button
                                                                    type="button"
                                                                    onClick={() => void handleSaveAttemptDetailGrade(qKey)}
                                                                    disabled={savingAttemptDetailGradeKey === qKey}
                                                                    className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700 disabled:opacity-60"
                                                                >
                                                                    {savingAttemptDetailGradeKey === qKey ? 'Saving…' : 'Save grade'}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ) : null}
                                                </div>
                                            );
                                        })}
                                        {questions.length === 0 ? (
                                            <p className="text-sm text-gray-500">No question snapshot on server for this quiz.</p>
                                        ) : null}
                                    </div>
                                ) : (
                                    <p className="text-sm text-gray-500">Could not display this attempt.</p>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    const renderContent = () => {
        switch (activeTab) {
            case 'all':
                return renderAllQuizzes();
            case 'draft':
                return renderDraftQuizzes();
            case 'published':
                return renderPublishedQuizzes();
            case 'shared':
                return renderSharedQuizzes();
            case 'analytics':
                return renderAnalytics();
            case 'grading':
                return renderGrading();
            case 'question-bank':
                return renderQuestionBank();
            case 'create':
            case 'edit':
                return renderQuizForm();
            default:
                return renderAllQuizzes();
        }
    };

    return (
        <div>
            {/* Sub-navigation */}
            {activeTab !== 'create' && activeTab !== 'edit' && (
                <div className="bg-white rounded-lg border border-gray-200 p-2 mb-6">
                    <div className="flex flex-wrap gap-2">
                        <button
                            onClick={() => setActiveTab('all')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'all'
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <FileText size={18} />
                            All Quizzes
                        </button>
                        <button
                            onClick={() => setActiveTab('draft')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'draft'
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <Edit3 size={18} />
                            Drafts
                        </button>
                        <button
                            onClick={() => setActiveTab('published')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'published'
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <CheckCircle size={18} />
                            Published
                        </button>
                        <button
                            onClick={() => setActiveTab('shared')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'shared'
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <Users size={18} />
                            Shared by Students
                        </button>
                        <button
                            onClick={() => setActiveTab('analytics')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'analytics'
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <BarChart3 size={18} />
                            Analytics
                        </button>
                        <button
                            onClick={() => setActiveTab('grading')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'grading'
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <ClipboardCheck size={18} />
                            Grading
                        </button>
                        <button
                            onClick={() => setActiveTab('question-bank')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'question-bank'
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <Database size={18} />
                            Question Bank
                        </button>
                    </div>
                </div>
            )}

            {/* Content */}
            {renderContent()}

            {/* Modals */}
            {renderModal()}
            {renderStudentAttemptsModal()}
        </div>
    );
}
