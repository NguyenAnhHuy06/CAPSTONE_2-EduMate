import { useState, useEffect, useMemo } from 'react';
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
} from 'lucide-react';
import { useNotification } from '../NotificationContext';
import api from '@/services/api';
import { safeNotificationMessage } from '@/utils/safeErrorMessage';

interface StudentQuizSectionProps {
    user: any;
}

type QuizTab = 'available' | 'completed' | 'my-practice';

interface QuizAnswer {
    questionId: string;
    selectedAnswer: number;
}

const LETTERS = ['A', 'B', 'C', 'D'];

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

function normalizeQuestions(quizItems: any[] = []) {
    return quizItems.map((q: any, idx: number) => {
        const optionsObj = q?.options || {};
        const options = LETTERS.map((k) => optionsObj[k]).filter(Boolean);
        const correctLetter = String(q?.correct_answer || 'A').toUpperCase();
        const correctAnswer = Math.max(0, LETTERS.indexOf(correctLetter));
        return {
            id: q?.id || `q-${idx + 1}`,
            question: q?.question || `Question ${idx + 1}`,
            options: options.length ? options : ['Option A', 'Option B', 'Option C', 'Option D'],
            correctAnswer,
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
        const options = [
            q?.option_a ?? q?.options?.A ?? '',
            q?.option_b ?? q?.options?.B ?? '',
            q?.option_c ?? q?.options?.C ?? '',
            q?.option_d ?? q?.options?.D ?? '',
        ].map((x: any) => String(x || '').trim()).filter(Boolean);
        const correctLetter = String(q?.correct_answer || 'A').toUpperCase();
        const correctAnswer = Math.max(0, LETTERS.indexOf(correctLetter));
        return {
            id: q?.question_id || q?.id || `stored-q-${idx + 1}`,
            question: q?.question_text || q?.question || `Question ${idx + 1}`,
            options: options.length ? options : ['Option A', 'Option B', 'Option C', 'Option D'],
            correctAnswer,
        };
    });
}

export function StudentQuizSection({ user }: StudentQuizSectionProps) {
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
    const [quizSubmitted, setQuizSubmitted] = useState(false);
    const [quizResult, setQuizResult] = useState<any>(null);
    const [timerId, setTimerId] = useState<NodeJS.Timeout | null>(null);
    const [isGeneratingQuiz, setIsGeneratingQuiz] = useState(false);

    const [availableQuizzes, setAvailableQuizzes] = useState<any[]>([]);
    const [completedQuizzes, setCompletedQuizzes] = useState<any[]>([]);

    const [practiceQuizzes, setPracticeQuizzes] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    const loadConnectedData = async (opts?: { quiet?: boolean }) => {
        if (!opts?.quiet) setLoading(true);
        try {
            const uid = user?.user_id ?? user?.id ?? user?.userId;
            const [docsRes, historyRes, publishedRes] = await Promise.all([
                api.get('/documents/for-quiz'),
                api.get('/quizzes/history', {
                    params: {
                        limit: 200,
                        ...(uid != null && uid !== '' ? { userId: uid } : {}),
                    },
                }),
                api.get('/quizzes/published'),
            ]);

            const rows = Array.isArray(historyRes?.data) ? historyRes.data : [];
            const attemptsByTitle = new Map<string, number>();
            rows.forEach((h: any) => {
                const k = String(h?.title || '').trim().toLowerCase();
                if (!k) return;
                attemptsByTitle.set(k, Number(h?.attemptsCount || 0));
            });

            const docs = Array.isArray(docsRes?.data) ? docsRes.data : [];
            const mappedAvailable = docs.map((d: any, idx: number) => ({
                id: d?.documentId || d?.id || `doc-${idx + 1}`,
                title: d?.title || d?.fileName || `Document ${idx + 1}`,
                subject: d?.courseCode || d?.subjectCode || 'DOC',
                s3Key: d?.s3Key || '',
                instructor: 'AI Generated',
                questions: [],
                chunkCount: Number(d?.chunkCount || 0),
                estimatedQuestions: Number(d?.estimatedQuestions || 0) || 5,
                duration: 10,
                myAttempts: Number(
                    d?.attemptsCount ??
                        attemptsByTitle.get(String(d?.title || d?.fileName || '').trim().toLowerCase()) ??
                        0
                ),
                dueDate: 'No due date',
                status: 'available',
            }));
            setAvailableQuizzes(mappedAvailable);
            const mappedCompleted = rows.map((h: any) => ({
                id: h?.quizId || h?.id,
                title: h?.title || 'Quiz',
                subject: h?.courseCode || 'DOC',
                instructor: 'AI Generated',
                questions: Array.from({ length: Number(h?.questionCount || 5) }).map((_, i) => ({ id: `h-q-${i}`, question: '', options: [], correctAnswer: 0 })),
                duration: 10,
                myScore: Number(h?.scorePercent ?? 0),
                attempts: Number(h?.attemptsCount ?? 0),
                completedDate: h?.lastAttemptAt || h?.createdAt || '',
                status: 'completed',
                userAnswers: [],
            }));
            setCompletedQuizzes(mappedCompleted);

            const pubRows = Array.isArray(publishedRes?.data) ? publishedRes.data : [];
            const mappedPublished = pubRows.map((h: any) => ({
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
            }));
            setPracticeQuizzes(mappedPublished);
        } catch {
            // Do not surface connection errors in the UI; fall back to empty lists.
            setAvailableQuizzes([]);
            setCompletedQuizzes([]);
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

    const currentTabQuizzes = useMemo(() => {
        if (activeTab === 'available') return availableQuizzes;
        if (activeTab === 'completed') return completedQuizzes;
        return practiceQuizzes;
    }, [activeTab, availableQuizzes, completedQuizzes, practiceQuizzes]);

    const subjectOptions = useMemo(() => {
        const set = new Set<string>();
        [...availableQuizzes, ...completedQuizzes, ...practiceQuizzes].forEach((q) => {
            const s = String(q?.subject ?? '').trim();
            if (s) set.add(s);
        });
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }, [availableQuizzes, completedQuizzes, practiceQuizzes]);

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

    /** Each successful Take Quiz records one attempt (phase start) for accurate counts. */
    const recordAttemptStart = async (quizId: string | number | undefined) => {
        const id = Number(quizId);
        if (!Number.isFinite(id) || id <= 0) return;
        try {
            await api.post('/quiz/attempts', {
                quizId: id,
                userId: user?.user_id ?? user?.id ?? user?.userId,
                phase: 'start',
            });
            await loadConnectedData({ quiet: true });
        } catch (err: unknown) {
            showNotification({
                type: 'warning',
                title: 'Could not record attempt',
                message: safeNotificationMessage(err, 'attemptRecord'),
            });
        }
    };

    const startQuiz = async (quiz: any) => {
        try {
            if (!quiz?.s3Key && quiz?.id) {
                const detailRes = await api.get(`/quizzes/${quiz.id}`);
                const detail = detailRes?.data || {};
                const questions = normalizeStoredQuestions(detail?.questions || []);
                if (!questions.length) {
                    showNotification({
                        type: 'warning',
                        title: 'Take Quiz',
                        message: 'This quiz has no published questions yet.',
                    });
                    return;
                }
                const generatedQuiz = {
                    ...quiz,
                    id: detail?.quiz_id || quiz.id,
                    title: detail?.title || quiz.title,
                    questions,
                };
                await recordAttemptStart(generatedQuiz.id);
                setSelectedQuiz(generatedQuiz);
                setCurrentQuestionIndex(0);
                setAnswers([]);
                setTimeRemaining((generatedQuiz.duration || 10) * 60);
                setQuizSubmitted(false);
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
            setIsGeneratingQuiz(true);
            setShowQuizTaking(false);
            setShowResults(false);
            setQuizSubmitted(false);
            const res = await api.post(
                '/quiz/generate',
                {
                    s3Key: quiz?.s3Key,
                    persist: true,
                    quizTitle: quiz?.title,
                    numQuestions: numQuestionsForGenerate(quiz),
                    language: 'English',
                    createdBy: user?.user_id ?? user?.id ?? user?.userId,
                },
                { timeout: 180000 }
            );
            if (res && (res as any).success === false) {
                setIsGeneratingQuiz(false);
                showNotification({
                    type: 'warning',
                    title: 'Generate Quiz',
                    message: safeNotificationMessage(null, 'quizGenerate'),
                });
                return;
            }
            const quizData = (res as any)?.data || {};
            const questions = normalizeQuestions(quizData.quiz || []);
            if (!questions.length) {
                showNotification({
                    type: 'warning',
                    title: 'Generate Quiz',
                    message: 'No question returned from AI for this document.',
                });
                setIsGeneratingQuiz(false);
                return;
            }
            const generatedQuiz = {
                ...quiz,
                id: quizData.quizId || quiz.id,
                questions,
            };

            await recordAttemptStart(generatedQuiz.id);
            setSelectedQuiz(generatedQuiz);
            setCurrentQuestionIndex(0);
            setAnswers([]);
            setTimeRemaining((generatedQuiz.duration || 10) * 60);
            setQuizSubmitted(false);
            setShowQuizTaking(true);
            setIsGeneratingQuiz(false);

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
            setIsGeneratingQuiz(false);
            showNotification({
                type: 'warning',
                title: 'Generate Quiz',
                message: safeNotificationMessage(err, 'quizGenerate'),
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
                    a.questionId === questionId ? { ...a, selectedAnswer: answerIndex } : a
                );
            }
            return [...prev, { questionId, selectedAnswer: answerIndex }];
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

        // Clear the timer
        if (timerId) {
            clearInterval(timerId);
            setTimerId(null);
        }

        // Calculate score
        let correctCount = 0;
        const questions = safeQuizQuestions;

        questions.forEach((q: any) => {
            const userAnswer = answers.find((a) => a.questionId === q.id);
            if (userAnswer && userAnswer.selectedAnswer === q.correctAnswer) {
                correctCount++;
            }
        });

        const score = Math.round((correctCount / questions.length) * 100);

        const result = {
            quizId: selectedQuiz.id,
            score,
            correctAnswers: correctCount,
            totalQuestions: questions.length,
            timeTaken: selectedQuiz.duration * 60 - timeRemaining,
            answers: answers,
            completedDate: new Date().toISOString().split('T')[0],
        };

        setQuizResult(result);
        setQuizSubmitted(true);
        setShowQuizTaking(false);

        // Attempt was recorded on Take Quiz; submit only updates the score (backend finish).
        if (activeTab === 'available') {
            setCompletedQuizzes((prev) => [
                ...prev,
                {
                    ...selectedQuiz,
                    myScore: score,
                    attempts: Number(selectedQuiz.myAttempts ?? 0),
                    completedDate: result.completedDate,
                    status: 'completed',
                    userAnswers: answers.map((a) => a.selectedAnswer),
                },
            ]);
        } else if (activeTab === 'my-practice') {
            setPracticeQuizzes((prev) =>
                prev.map((q) =>
                    q.id === selectedQuiz.id ? { ...q, myScore: score } : q
                )
            );
        }

        // Show success notification
        showNotification({
            type: 'success',
            title: 'Quiz Submitted!',
            message: `You scored ${score}%. ${correctCount} out of ${questions.length} correct.`,
            duration: 5000,
        });

        setShowResults(true);

        try {
            await api.post('/quiz/attempts', {
                quizId: selectedQuiz.id,
                userId: user?.user_id ?? user?.id ?? user?.userId,
                score: correctCount,
                phase: 'complete',
            });
            await loadConnectedData();
        } catch {
            // keep UI flow even if attempt save fails
        }
    };

    const renderAvailableQuizzes = () => (
        <div className="space-y-4">
            {filteredQuizzes().map((quiz) => (
                <div key={quiz.id} className="bg-white rounded-lg border border-gray-200 p-6 hover:shadow-md transition-shadow">
                    <div className="flex items-start justify-between mb-4">
                        <div className="flex-1">
                            <h3 className="text-gray-900 mb-2">{quiz.title}</h3>
                            <p className="text-gray-600 mb-1">Subject: {quiz.subject}</p>

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

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-gray-200 text-sm">
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
                            <p className="text-gray-900">{Number(quiz.myAttempts || 0)}</p>
                        </div>

                        <div>
                            <p className="text-gray-500 mb-1">Due Date</p>
                            {'dueDate' in quiz ? (
                                <p className="text-gray-900">{quiz.dueDate}</p>
                            ) : (
                                <p className="text-gray-900">N/A</p>
                            )}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );

    const renderCompletedQuizzes = () => (
        <div className="space-y-4">
            {filteredQuizzes().map((quiz) => (
                <div key={quiz.id} className="bg-white rounded-lg border border-gray-200 p-6">
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
                            </div>
                            <p className="text-gray-600 mb-1">Subject: {quiz.subject}</p>

                            {'instructor' in quiz ? (
                                <p className="text-gray-500 text-sm">Instructor: {quiz.instructor}</p>
                            ) : (
                                <p className="text-gray-500 text-sm">Instructor: N/A</p>
                            )}

                            {'completedDate' in quiz ? (
                                <p className="text-gray-500 text-sm">Completed: {quiz.completedDate}</p>
                            ) : (
                                <p className="text-gray-500 text-sm">Completed: N/A</p>
                            )}
                        </div>
                        <button
                            onClick={async () => {
                                const score = 'myScore' in quiz ? Number(quiz.myScore || 0) : 0;
                                const fallbackAnswers = 'userAnswers' in quiz ? quiz.userAnswers : [];
                                let fullQuiz = quiz;

                                try {
                                    if (quiz?.id != null) {
                                        const detailRes = await api.get(`/quizzes/${quiz.id}`);
                                        const detail = detailRes?.data || {};
                                        const qs = normalizeStoredQuestions(detail?.questions || []);
                                        if (qs.length) {
                                            fullQuiz = {
                                                ...quiz,
                                                title: detail?.title || quiz.title,
                                                questions: qs,
                                            };
                                        }
                                    }
                                } catch {
                                    // fallback to summarized history data
                                }

                                const quizQuestionsLen = Array.isArray(fullQuiz.questions) ? fullQuiz.questions.length : 0;
                                setSelectedQuiz(fullQuiz);
                                setQuizResult({
                                    score,
                                    correctAnswers: Math.round((score / 100) * quizQuestionsLen),
                                    totalQuestions: quizQuestionsLen,
                                    timeTaken: Math.max(0, Number(fullQuiz.duration || 10) - 5),
                                    answers: fallbackAnswers,
                                });
                                setShowResults(true);
                            }}
                            className="flex items-center gap-2 px-4 py-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                        >
                            <Eye size={20} />
                            View Results
                        </button>
                    </div>

                    <div className="grid grid-cols-3 gap-4 pt-4 border-t border-gray-200 text-sm">
                        <div>
                            <p className="text-gray-500 mb-1">Questions</p>
                            <p className="text-gray-900">{quiz.questions.length}</p>
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
                                <p className="text-gray-600 mb-1">Subject: {quiz.subject}</p>

                                {'createdDate' in quiz && (
                                    <p className="text-gray-500 text-sm">Created: {quiz.createdDate}</p>
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
        const currentAnswer = answers.find((a) => a.questionId === currentQuestion.id);
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
                                <p className="text-gray-600">{safeQuizQuestions.length} Questions • {selectedQuiz.duration} minutes</p>
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
                            <div className="space-y-3">
                                {currentQuestion.options.map((option: string, idx: number) => (
                                    <label
                                        key={idx}
                                        className={`flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors ${currentAnswer?.selectedAnswer === idx
                                            ? 'border-blue-500 bg-blue-50'
                                            : 'border-gray-300 hover:bg-blue-50 hover:border-blue-300'
                                            }`}
                                    >
                                        <input
                                            type="radio"
                                            name={`question-${currentQuestion.id}`}
                                            checked={currentAnswer?.selectedAnswer === idx}
                                            onChange={() => handleAnswerSelect(currentQuestion.id, idx)}
                                            className="w-4 h-4 text-blue-600"
                                        />
                                        <span className="text-gray-900">{option}</span>
                                    </label>
                                ))}
                            </div>
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
        if (!isGeneratingQuiz) return null;
        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-xl max-w-lg w-full p-6 border border-gray-200">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center text-blue-700">
                            <Play size={20} />
                        </div>
                        <h3 className="text-gray-900 font-semibold text-lg">Generating quiz…</h3>
                    </div>
                    <p className="text-gray-600">
                        Please wait. We are indexing & generating questions based on your selected document.
                    </p>
                    <div className="mt-5">
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-2 bg-blue-600 rounded-full animate-pulse" style={{ width: '45%' }} />
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const renderQuizResults = () => {
        if (!showResults || !selectedQuiz || !quizResult) return null;

        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
                    <div className="p-6 border-b border-gray-200">
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
                                }}
                                className="text-gray-500 hover:text-gray-700"
                            >
                                <X size={24} />
                            </button>
                        </div>
                    </div>

                    <div className="p-6">
                        {/* Score Summary */}
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                            <div className="bg-blue-50 rounded-lg p-4 text-center">
                                <div className="text-blue-600 mb-2">
                                    <Award size={32} className="mx-auto" />
                                </div>
                                <p className="text-gray-600 text-sm mb-1">Your Score</p>
                                <p className="text-2xl text-blue-600">{quizResult.score}%</p>
                            </div>
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
                                <p className="text-2xl text-purple-600">{Math.floor(quizResult.timeTaken / 60)}m</p>
                            </div>
                        </div>

                        {/* Question Review */}
                        <div>
                            <h3 className="mb-4">Answer Review</h3>
                            <div className="space-y-4">
                                {selectedQuiz.questions.map((q: any, idx: number) => {
                                    const userAnswer = answers.find((a) => a.questionId === q.id);
                                    const isCorrect = userAnswer && userAnswer.selectedAnswer === q.correctAnswer;

                                    return (
                                        <div key={q.id} className={`rounded-lg border-2 p-4 ${isCorrect ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
                                            }`}>
                                            <div className="flex items-start gap-3 mb-3">
                                                <span className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-white ${isCorrect ? 'bg-green-500' : 'bg-red-500'
                                                    }`}>
                                                    {isCorrect ? '✓' : '✗'}
                                                </span>
                                                <div className="flex-1">
                                                    <p className="text-gray-900 mb-3"><strong>Question {idx + 1}:</strong> {q.question}</p>
                                                    <div className="space-y-2">
                                                        <div>
                                                            <p className="text-sm text-gray-600">Your Answer:</p>
                                                            <p className={isCorrect ? 'text-green-700' : 'text-red-700'}>
                                                                {userAnswer ? q.options[userAnswer.selectedAnswer] : 'Not answered'}
                                                            </p>
                                                        </div>
                                                        {!isCorrect && (
                                                            <div>
                                                                <p className="text-sm text-gray-600">Correct Answer:</p>
                                                                <p className="text-green-700">{q.options[q.correctAnswer]}</p>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    <div className="p-6 border-t border-gray-200">
                        <button
                            onClick={() => {
                                setShowResults(false);
                                setSelectedQuiz(null);
                                setQuizResult(null);
                            }}
                            className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition-colors"
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
                    No quizzes available right now.
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
            {activeTab === 'my-practice' && renderPracticeQuizzes()}

            {/* Modals */}
            {renderGeneratingModal()}
            {renderQuizTaking()}
            {renderQuizResults()}
        </div>
    );
}
