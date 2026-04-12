import { useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import api, { getApiErrorMessage } from '@/services/api';
import { useNotification } from '../NotificationContext';
const LETTERS = ['A', 'B', 'C', 'D'];

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

/** Dedupes document→AI bootstrap when React Strict Mode remounts; each user click uses a fresh `nonce`. */
const processedInitialAiDocumentNonces = new Set<number>();

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
    /** Present when loaded from GET /questions/bank */
    quizId?: number;
    /** Set for rows from GET /questions/bank only; used to tell real bank items from quiz-only rows merged into state. */
    quizTitle?: string;
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
        const optObj = q?.options;
        let opts = [q.option_a, q.option_b, q.option_c, q.option_d].map((x: any) => String(x ?? ''));
        if (optObj && typeof optObj === 'object' && !Array.isArray(optObj)) {
            opts = LETTERS.map((L) => String(optObj[L] ?? ''));
        }
        const letter = String(q.correct_answer || 'A').toUpperCase().trim().slice(0, 1) || 'A';
        const ci = Math.max(0, LETTERS.indexOf(letter));
        const id = quizSnapshotQuestionId(q.question_id, idx, base);
        return {
            id,
            question: String(q.question_text ?? q.question ?? ''),
            type: 'multiple-choice' as const,
            topic: subject || 'General',
            difficulty: 'medium' as const,
            options: opts,
            correctAnswer: opts[ci] || opts[0] || '',
            quizId: linkQuizId,
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

/** When set from Document detail “Create Quiz with AI”, triggers the same flow as “Generate & Edit with AI”. */
export type InitialAiDocumentPayload = {
    s3Key: string;
    documentId?: number;
    title?: string;
    courseCode?: string;
    /** Set by dashboard so Strict Mode / remounts do not run generation twice for one click. */
    nonce?: number;
};

interface QuizManagementProps {
    user: any;
    initialAiDocument?: InitialAiDocumentPayload | null;
    onInitialAiDocumentConsumed?: () => void;
}

type QuizTab = 'all' | 'draft' | 'published' | 'analytics' | 'question-bank' | 'create' | 'edit';
type ModalType = 'delete-quiz' | 'delete-question' | 'view-quiz' | 'add-question' | 'edit-question' | 'select-questions' | null;

export function QuizManagement({ user, initialAiDocument, onInitialAiDocumentConsumed }: QuizManagementProps) {
    const { showNotification } = useNotification();
    const [activeTab, setActiveTab] = useState<QuizTab>(() =>
        initialAiDocument?.s3Key?.trim() ? 'edit' : 'all'
    );
    const [searchQuery, setSearchQuery] = useState('');
    const [filterSubject, setFilterSubject] = useState('all');
    const [filterStatus, setFilterStatus] = useState('all');
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
    });

    // Edit mode
    const [editingQuizId, setEditingQuizId] = useState<number | null>(null);
    const [editingQuestionId, setEditingQuestionId] = useState<number | null>(null);
    const [aiGeneratingQuizId, setAiGeneratingQuizId] = useState<number | null>(null);
    const [savingQuiz, setSavingQuiz] = useState(false);
    const [loadingCloudData, setLoadingCloudData] = useState(false);
    const [loadingQuestionBank, setLoadingQuestionBank] = useState(false);
    const [loadingAnalytics, setLoadingAnalytics] = useState(false);
    const [viewQuizLoading, setViewQuizLoading] = useState(false);
    const viewQuizFetchSeq = useRef(0);
    const handleGenerateAndEditWithAIRef = useRef<(quiz: Quiz) => Promise<void>>(async () => {});
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

    // Filtered data
    const filteredQuizzes = quizzes.filter((quiz) => {
        const matchesSearch =
            quiz.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            quiz.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
            quiz.documentTypeLabel.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesSubject = filterSubject === 'all' || quiz.subject === filterSubject;
        const matchesStatus = filterStatus === 'all' || quiz.status === filterStatus;

        // Draft tab shows persisted drafts only (valid DB quiz id).
        if (activeTab === 'draft') return quiz.status === 'draft' && quiz.id > 0 && matchesSearch && matchesSubject;
        if (activeTab === 'published') return quiz.status === 'published' && matchesSearch && matchesSubject;

        return matchesSearch && matchesSubject && matchesStatus;
    });

    const filteredQuestions = questionBank.filter((question) => {
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
        if (qbFilterCategory === 'all' || questionBank.length === 0) return;
        const anyMatch = questionBank.some((q) => {
            const catKey = normalizeMaterialCategoryKey(q?.category);
            if (qbFilterCategory === 'uncategorized') return catKey === 'uncategorized';
            return catKey === qbFilterCategory;
        });
        if (!anyMatch) setQbFilterCategory('all');
    }, [questionBank, qbFilterCategory]);

    const lecturerUserId = user?.user_id ?? user?.id ?? user?.userId;

    const loadLecturerQuizzes = async () => {
        if (lecturerUserId == null || lecturerUserId === '') return;
        setLoadingCloudData(true);
        setLoadingAnalytics(true);
        try {
            const [historyRes, docsRes, analyticsRes]: any[] = await Promise.all([
                api.get('/quizzes/history', {
                    params: { userId: lecturerUserId, limit: 500, ownerOnly: true },
                }),
                api.get('/documents/for-quiz'),
                api.get('/quizzes/analytics', {
                    params: { userId: lecturerUserId, topQuestions: 5 },
                }),
            ]);
            const rows = Array.isArray(historyRes?.data) ? historyRes.data : [];
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
                createdDate: String(q?.createdAt || '').slice(0, 10),
                publishedDate: q?.isPublished ? String(q?.publishedAt || q?.createdAt || '').slice(0, 10) : undefined,
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
                        createdDate: String(d?.createdAt || d?.uploadedAt || '').slice(0, 10),
                    };
                });

            setQuizzes([...mappedHistory, ...mappedFromDocs]);
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
        const rawId = row?.id ?? row?.item_id;
        const numId = Number(rawId);
        const stableId = Number.isFinite(numId) && numId > 0 ? numId : Date.now() + i;
        return {
            id: stableId,
            question: String(row?.question ?? ''),
            type,
            topic: String(row?.topic || 'General'),
            difficulty,
            category: catRaw || undefined,
            options,
            correctAnswer: normalizedCorrect || undefined,
            quizId: row?.quizId != null && Number.isFinite(Number(row.quizId)) ? Number(row.quizId) : undefined,
            quizTitle: row?.quizTitle != null ? String(row.quizTitle) : undefined,
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
                    prev.forEach((q) => {
                        if (q && Number.isFinite(q.id)) byId.set(q.id, q);
                    });
                    mapped.forEach((q) => {
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

    /** Earliest allowed value for `datetime-local` (current local time, minute precision). */
    const getNowDatetimeLocalFloor = () => {
        const d = new Date();
        d.setSeconds(0, 0);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
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
        loadLecturerQuizzes();
        loadQuestionBankFromApi();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lecturerUserId]);

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
            await api.post('/quizzes', {
                userId: lecturerUserId,
                title: quizForm.title,
                questions: payloadQuestions,
                status,
            });
            await loadLecturerQuizzes();
            await loadQuestionBankFromApi({ merge: true });
            resetQuizForm();
            setEditingQuizId(null);
            setActiveTab('all');
            showNotification({
                type: 'success',
                title: 'Create quiz',
                message: status === 'published' ? 'Quiz published successfully!' : 'Draft saved successfully!',
            });
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
            const opts = Array.isArray(q.options) && q.options.length
                ? q.options
                : ['Option A', 'Option B', 'Option C', 'Option D'];
            const correctIdx = Math.max(0, opts.findIndex((x) => String(x) === String(q.correctAnswer || '')));
            return {
                question: q.question,
                options: {
                    A: String(opts[0] ?? ''),
                    B: String(opts[1] ?? ''),
                    C: String(opts[2] ?? ''),
                    D: String(opts[3] ?? ''),
                },
                correctAnswer: correctIdx,
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

        try {
            setSavingQuiz(true);
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
            setActiveTab('all');
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
        if (!selectedItem) return;
        if (!Number.isFinite(selectedItem.id) || selectedItem.id <= 0) {
            showNotification({
                type: 'error',
                title: 'Delete quiz',
                message: 'Only saved drafts can be deleted.',
            });
            return;
        }
        try {
            await api.delete(`/quizzes/${selectedItem.id}`, {
                params: { userId: lecturerUserId },
            });
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
        }
    };

    const handleEditQuiz = async (quiz: Quiz) => {
        const fallbackSelectedIds = Array.isArray(quiz.questions)
            ? quiz.questions
                .map((q: any) => Number(q?.id ?? q?.question_id))
                .filter((id: number) => Number.isFinite(id))
            : [];

        if (!Number.isFinite(quiz.id) || quiz.id <= 0) {
            setEditingQuizId(null);
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
            const detailQuestions = Array.isArray(row?.questions) ? row.questions : [];
            const normalized = normalizeGeneratedQuestions(detailQuestions, quiz.subject, quiz.documentCategory);
            const selectedIds = normalized
                .map((q: any) => Number(q?.id))
                .filter((id: number) => Number.isFinite(id));

            if (normalized.length) {
                mergeQuestionsIntoBank(normalized);
            }
            setEditingQuizId(quiz.id);
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
            const correctLetter = String(q?.correct_answer || 'A').toUpperCase();
            const correctAnswerIdx = Math.max(0, LETTERS.indexOf(correctLetter));
            const normalizedOptions = options.length
                ? options.map((x: any) => String(x))
                : ['Option A', 'Option B', 'Option C', 'Option D'];
            const rawPid = q?.id ?? q?.question_id;
            const id = quizSnapshotQuestionId(rawPid, idx, Date.now());
            return {
                id,
                question: String(q?.question || q?.question_text || `Question ${idx + 1}`),
                type: 'multiple-choice' as const,
                topic: subject || 'General',
                difficulty: 'medium' as const,
                ...(cat ? { category: cat } : {}),
                options: normalizedOptions,
                correctAnswer: normalizedOptions[correctAnswerIdx] || normalizedOptions[0],
            };
        });
    };

    const handleOpenViewQuiz = async (quiz: Quiz) => {
        setSelectedItem(quiz);
        setModalType('view-quiz');
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
            setSelectedItem((prev: any) => {
                if (!prev || prev.id !== quiz.id) return prev;
                return {
                    ...prev,
                    title: String(row?.title || prev.title),
                    questions: normalized.length ? normalized : prev.questions,
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
                    showNotification({
                        type: 'warning',
                        title: 'Generate AI quiz',
                        message: backendMessage || 'AI generation is temporarily unavailable. Please try again in a moment.',
                        duration: Math.min(20000, Math.max(8000, (backendMessage.length || 0) * 40)),
                    });
                    return;
                }
                const generatedRaw = extractGeneratedQuizItems(res);
                const generatedQuestions = normalizeGeneratedQuestions(generatedRaw, quiz.subject, quiz.documentCategory);
                if (!generatedQuestions.length) {
                    const backendMessage = String(res?.message || res?.data?.message || '').trim();
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
            } catch (err: unknown) {
                const backendMsg = getApiErrorMessage(err);
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

    handleGenerateAndEditWithAIRef.current = handleGenerateAndEditWithAI;

    useEffect(() => {
        const rawKey = initialAiDocument?.s3Key?.trim();
        const nonce = initialAiDocument?.nonce;
        if (!rawKey) {
            return;
        }
        if (nonce != null && processedInitialAiDocumentNonces.has(nonce)) {
            return;
        }

        const match = quizzes.find((q) => String(q.s3Key || '').trim() === rawKey);
        const fallback: Quiz = {
            id: -Math.abs((Date.now() % 900000000) + 1000000),
            title: initialAiDocument!.title || 'Quiz',
            subject: String(initialAiDocument!.courseCode || 'DOC'),
            documentTypeLabel: '',
            documentId: initialAiDocument!.documentId,
            s3Key: rawKey,
            status: 'draft',
            questions: Array.from({ length: 10 }),
            duration: 10,
            passPercentage: 70,
            attemptsAllowed: '1',
            participants: 0,
            averageScore: 0,
            createdDate: new Date().toISOString().slice(0, 10),
        };
        const quiz: Quiz = match ?? fallback;

        if (nonce != null) {
            processedInitialAiDocumentNonces.add(nonce);
        }
        void handleGenerateAndEditWithAIRef.current(quiz);
    }, [initialAiDocument, quizzes]);

    const resetQuizForm = () => {
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

    /** Rows from GET /questions/bank always include `quizTitle`; quiz-only rows merged after AI / GET quiz do not. */
    const isQuestionBankRow = (q: { quizTitle?: string } | null) =>
        q != null && typeof q.quizTitle === 'string' && q.quizTitle.trim() !== '';

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
            await loadQuestionBankFromApi({ merge: true });
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
        });
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
                                    onClick={closeModal}
                                    className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleDeleteQuiz}
                                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                                >
                                    Delete
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
                                    onClick={closeModal}
                                    className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
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
                                    onClick={closeModal}
                                    className="p-2 hover:bg-gray-100 rounded-lg"
                                    aria-label="Close Modal"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                            <div className="space-y-4">
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
                                                return (
                                                    <div key={idx} className="p-3 bg-gray-50 rounded-lg">
                                                        <p className="text-gray-900 font-medium">
                                                            {idx + 1}. {text || ''}
                                                        </p>
                                                        {opts && opts.length > 0 && (
                                                            <ul className="mt-2 text-sm text-gray-600 list-disc pl-5 space-y-0.5">
                                                                {opts.map((opt: string, oi: number) => (
                                                                    <li key={oi}>{opt}</li>
                                                                ))}
                                                            </ul>
                                                        )}
                                                        {q?.correctAnswer != null && String(q.correctAnswer).length > 0 && (
                                                            <p className="mt-2 text-xs text-green-700">
                                                                Correct: {String(q.correctAnswer)}
                                                            </p>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <p className="text-gray-500">No questions added yet</p>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Add/Edit Question Modal */}
                    {(modalType === 'add-question' || modalType === 'edit-question') && (
                        <div className="p-6">
                            <div className="flex items-center justify-between mb-6">
                                <h3>{editingQuestionId ? 'Edit Question' : 'Add New Question'}</h3>
                                <button
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
                                        <label className="block text-gray-700 mb-2">Topic</label>
                                        <input
                                            type="text"
                                            value={questionForm.topic}
                                            onChange={(e) => setQuestionForm({ ...questionForm, topic: e.target.value })}
                                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                            placeholder="e.g., Algorithms"
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

                                {(questionForm.type === 'multiple-choice' || questionForm.type === 'true-false') && (
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
                                        ) : (
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
                                        )}
                                    </div>
                                )}

                                <div className="flex items-center gap-3 justify-end pt-4 border-t border-gray-200">
                                    <button
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
                    Fetching quiz data from cloud. Please wait...
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
                        {loadingCloudData
                            ? 'Preparing quiz data. Please wait...'
                            : 'No quizzes available right now.'}
                    </div>
                ) : (
                    filteredQuizzes.map((quiz) => (
                        <div key={quiz.id} className="bg-white rounded-lg border border-gray-200 p-6 hover:shadow-md transition-shadow">
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
                                        disabled={
                                            aiGeneratingQuizId != null ||
                                            !String(quiz.s3Key || '').trim()
                                        }
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
                        {loadingCloudData
                            ? 'Preparing quiz data. Please wait...'
                            : 'No draft quizzes available right now.'}
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
                                    <p className="text-gray-500 text-sm mt-1">Created: {quiz.createdDate}</p>
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

            <div className="space-y-4">
                {filteredQuizzes.length === 0 ? (
                    <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                        {loadingCloudData
                            ? 'Preparing quiz data. Please wait...'
                            : 'No published quizzes available right now.'}
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
                                    <p className="text-gray-500 text-sm mt-1">Published: {quiz.publishedDate}</p>
                                </div>
                                <button
                                    onClick={() => handleOpenViewQuiz(quiz)}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                >
                                    View Details
                                </button>
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
                                    </tr>
                                ))}
                                {performanceRows.length === 0 && (
                                    <tr>
                                        <td colSpan={5} className="px-6 py-6 text-center text-gray-500">
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

    // Render Question Bank
    const renderQuestionBank = () => (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h2>Question Bank</h2>
                <button
                    onClick={() => setModalType('add-question')}
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
                        {questionBank.length === 0
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
                                    {question.options && (
                                        <div className="space-y-1 text-sm text-gray-600">
                                            {question.options.map((option, idx) => (
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
                        <div>
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
                        </div>

                        {/* Quiz Settings */}
                        <div>
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
                        </div>

                        {/* Question Selection */}
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
                                            const isMc =
                                                question.type === 'multiple-choice' ||
                                                (Array.isArray(question.options) && question.options.length > 0);

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

                        {/* Schedule */}
                        <div>
                            <h3 className="mb-4">Schedule (Optional)</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-gray-700 mb-2">Start Date & Time</label>
                                    <input
                                        type="datetime-local"
                                        aria-label="Start Date & Time"
                                        value={quizForm.startDate}
                                        min={getNowDatetimeLocalFloor()}
                                        onChange={(e) => setQuizForm({ ...quizForm, startDate: e.target.value })}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                    />
                                </div>
                                <div>
                                    <label className="block text-gray-700 mb-2">End Date & Time</label>
                                    <input
                                        aria-label="End Date & Time"
                                        type="datetime-local"
                                        value={quizForm.endDate}
                                        min={(() => {
                                            const now = getNowDatetimeLocalFloor();
                                            const st = quizForm.startDate?.trim();
                                            if (st && st > now) return st;
                                            return now;
                                        })()}
                                        onChange={(e) => setQuizForm({ ...quizForm, endDate: e.target.value })}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Action Buttons */}
                        <div className="flex items-center gap-3 pt-4 border-t border-gray-200">
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

    const renderContent = () => {
        switch (activeTab) {
            case 'all':
                return renderAllQuizzes();
            case 'draft':
                return renderDraftQuizzes();
            case 'published':
                return renderPublishedQuizzes();
            case 'analytics':
                return renderAnalytics();
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
        </div>
    );
}
