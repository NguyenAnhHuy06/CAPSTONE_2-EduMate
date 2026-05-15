import api from '@/services/api';

/**
 * Backend may return { success, data } or nested shapes. Unwrap to inner payload.
 */
export function normalizeLecturerReviewPayload(raw: unknown): any {
    if (raw == null || typeof raw !== 'object') return raw;
    let cur: any = raw;
    for (let depth = 0; depth < 5; depth += 1) {
        if (cur && typeof cur === 'object') {
            if (
                'attempt' in cur ||
                ('questions' in cur && Array.isArray((cur as { questions?: unknown }).questions))
            ) {
                return cur;
            }
            const inner = (cur as { data?: unknown }).data;
            if (inner != null && typeof inner === 'object') {
                cur = inner;
                continue;
            }
        }
        break;
    }
    return cur;
}

/**
 * API may return MC index (0–3) or -1 in `selectedAnswer` while `selected_answer` is empty.
 * Produces a readable string for the lecturer UI.
 */
export function formatStudentAnswerForLecturerDisplay(ans: Record<string, unknown> | null | undefined): string {
    if (ans == null || typeof ans !== 'object') return '';
    const direct = String((ans as { selected_answer?: unknown }).selected_answer ?? '').trim();
    if (direct && direct !== '—') return direct;

    const raw = (ans as { user_answer?: unknown; selectedAnswer?: unknown }).user_answer ?? (ans as { selectedAnswer?: unknown }).selectedAnswer;
    if (raw === null || raw === undefined || raw === '') return '';

    const n = Number(raw);
    if (Number.isFinite(n) && n === -1) return '—';
    if (Number.isFinite(n) && n >= 0 && n <= 3) {
        const opts = (ans as { options?: unknown }).options;
        if (Array.isArray(opts) && opts[n] != null && String(opts[n]).trim() !== '') {
            return `${String.fromCharCode(65 + n)}: ${String(opts[n])}`;
        }
        return String.fromCharCode(65 + n);
    }

    return String(raw).trim();
}

function inferQuestionType(a: Record<string, unknown>): string {
    const o = a?.options;
    if (Array.isArray(o) && o.length >= 2) return 'multiple-choice';
    const t = String(a?.question_type ?? a?.type ?? '')
        .trim()
        .toLowerCase();
    if (t.includes('short')) return 'short-answer';
    if (t.includes('true') || t.includes('false')) return 'true-false';
    return 'multiple-choice';
}

/**
 * Normalize GET responses into the shape expected by QuizManagement grading UI:
 * { quizTitle, questions[], attempt: { scorePercent, correctCount, totalQuestions, answers[] }, questionMarks? }
 *
 * Supports:
 * - Mock server (attempt + questions + questionMarks)
 * - Real BE: flat body from GET /quiz/result/:id/lecturer or GET /quiz-v2/quiz/attempts/:id/lecturer
 */
export function mapToGradingUiPayload(inner: unknown): {
    quizTitle: string;
    questions: any[];
    attempt: {
        scorePercent: number;
        correctCount: number;
        totalQuestions: number;
        answers: any[];
    };
    questionMarks?: Record<string, boolean>;
    manualGrades?: unknown[];
} | null {
    if (!inner || typeof inner !== 'object') return null;
    const n = inner as Record<string, unknown>;

    if (n.attempt && Array.isArray(n.questions)) {
        const attempt = n.attempt as Record<string, unknown>;
        const answersArr = Array.isArray(attempt?.answers)
            ? (attempt.answers as Record<string, unknown>[])
            : [];
        const tpl = (n.questions as any[]) || [];
        /**
         * Template `questions[].id` may be bank/editor id; DB regrade needs `attempt.answers[].questionId`
         * (same as `quiz_answers.question_id`). Rebuild `questions` from answers when possible.
         */
        let questions: any[];
        if (answersArr.length) {
            questions = answersArr.map((a, idx) => {
                const aid = String(a?.questionId ?? a?.question_id ?? '').trim();
                const t =
                    tpl.find(
                        (q: any) =>
                            String(q?.id ?? q?.question_id ?? q?.questionId ?? '').trim() === aid
                    ) ||
                    tpl[idx] ||
                    {};
                const rawQid = a?.questionId ?? a?.question_id ?? t?.id ?? t?.question_id ?? t?.questionId ?? idx + 1;
                const num = Number(rawQid);
                const id = Number.isFinite(num) ? num : idx + 1;
                const mediaRaw = String(
                    (a as any)?.mediaUrl ??
                        (a as any)?.media_url ??
                        (t as any)?.mediaUrl ??
                        (t as any)?.media_url ??
                        ''
                ).trim();
                return {
                    ...t,
                    id,
                    questionId: id,
                    question_id: id,
                    question: String(
                        a?.question_text ?? a?.question ?? t?.question ?? t?.question_text ?? `Question ${idx + 1}`
                    ),
                    question_text: a?.question_text ?? t?.question_text,
                    type: inferQuestionType({ ...a, question_type: a.question_type ?? t?.question_type ?? t?.type }),
                    ...(mediaRaw ? { mediaUrl: mediaRaw, media_url: mediaRaw } : {}),
                };
            });
        } else {
            questions = tpl;
        }
        return {
            quizTitle: String(n.quizTitle ?? (n as any).quiz?.title ?? 'Quiz'),
            questions,
            attempt: attempt as any,
            questionMarks: n.questionMarks as Record<string, boolean> | undefined,
            manualGrades: n.manualGrades as unknown[] | undefined,
        };
    }

    const answers = Array.isArray(n.answers) ? (n.answers as Record<string, unknown>[]) : [];
    if (!answers.length) return null;

    const quizTitle = String(n.title ?? n.quizTitle ?? 'Quiz');
    const questions = answers.map((a, idx) => ({
        id: a.questionId ?? a.question_id ?? idx + 1,
        questionId: a.questionId ?? a.question_id,
        question_id: a.questionId ?? a.question_id,
        question: String(a.question_text ?? a.question ?? `Question ${idx + 1}`),
        question_text: a.question_text,
        type: inferQuestionType(a),
        ...(String((a as any)?.mediaUrl ?? (a as any)?.media_url ?? '').trim()
            ? {
                  mediaUrl: String((a as any)?.mediaUrl ?? (a as any)?.media_url).trim(),
                  media_url: String((a as any)?.mediaUrl ?? (a as any)?.media_url).trim(),
              }
            : {}),
    }));

    const attempt = {
        scorePercent: Number(n.score ?? n.scorePercent ?? 0),
        correctCount: Number(n.correct_count ?? n.correctCount ?? 0),
        totalQuestions: Number(n.total_questions ?? n.totalQuestions ?? answers.length),
        answers: answers.map((a) => {
            const row = {
                ...a,
                questionId: a.questionId ?? a.question_id,
                question_id: a.questionId ?? a.question_id,
                user_answer: a.user_answer ?? a.selectedAnswer ?? '',
                selectedAnswer: a.selectedAnswer ?? a.user_answer,
                selected_answer: a.selected_answer ?? a.selectedAnswer,
                is_correct: a.is_correct ?? a.isCorrect,
            } as Record<string, unknown>;
            const display = formatStudentAnswerForLecturerDisplay(row);
            if (display) {
                row.selected_answer = display;
            }
            return row;
        }),
    };

    return { quizTitle, questions, attempt };
}

function gradingUserQueryParams(
    lecturerUserId: string | number | null | undefined
): Record<string, string> | undefined {
    if (import.meta.env.VITE_QUIZ_GRADING_SKIP_USER_QUERY === 'true') {
        return undefined;
    }
    if (lecturerUserId == null || lecturerUserId === '') {
        return undefined;
    }
    return { userId: String(lecturerUserId) };
}

/**
 * Order: canonical BE route first. Skip `/quiz/attempts/:id/lecturer-review` here — mock `FE/server.js`
 * redirects `GET /quiz/result/:id/lecturer` → lecturer-review, so a second explicit call only produces
 * extra 404 noise when the real API has no lecturer-review route.
 */
const GRADING_GET_PATHS = (attemptId: number) => [
    `/quiz/result/${attemptId}/lecturer`,
    `/quiz-v2/quiz/attempts/${attemptId}/lecturer`,
    // Some BE versions expose only the student result endpoint (may include questions snapshot).
    `/quiz/result/${attemptId}`,
];

async function tryFetchQuizQuestionsSnapshot(quizId: number): Promise<any[] | null> {
    if (!Number.isFinite(quizId) || quizId <= 0) return null;
    try {
        const res: any = await api.get(`/quizzes/${quizId}`);
        // Match StudentQuizSection unwrap behavior.
        const payload = res?.data || res || null;
        const inner = payload?.data != null ? payload.data : payload;
        const questions = Array.isArray(inner?.questions) ? inner.questions : [];
        return questions;
    } catch {
        return null;
    }
}

function mergeMediaIntoQuestions(targetQuestions: any[], snapshotQuestions: any[]): any[] {
    if (!Array.isArray(targetQuestions) || !targetQuestions.length) return targetQuestions;
    if (!Array.isArray(snapshotQuestions) || !snapshotQuestions.length) return targetQuestions;

    const byId = new Map<string, any>();
    snapshotQuestions.forEach((q: any) => {
        const k = String(q?.id ?? q?.question_id ?? q?.questionId ?? '').trim();
        if (k) byId.set(k, q);
    });

    return targetQuestions.map((q: any) => {
        const k = String(q?.id ?? q?.question_id ?? q?.questionId ?? '').trim();
        const snap = k ? byId.get(k) : null;
        if (!snap) return q;
        const raw =
            String(q?.mediaUrl ?? q?.media_url ?? '').trim() ||
            String(snap?.mediaUrl ?? snap?.media_url ?? '').trim();
        if (!raw) return q;
        return { ...q, mediaUrl: raw, media_url: raw };
    });
}

/**
 * Load attempt + questions for manual grading (lecturer).
 */
export async function fetchLecturerReviewForGrading(
    attemptId: number,
    lecturerUserId: string | number | null | undefined
): Promise<any> {
    const params = gradingUserQueryParams(lecturerUserId);
    const config = params ? { params } : {};
    let lastError: unknown;
    for (const path of GRADING_GET_PATHS(attemptId)) {
        try {
            const res: any = await api.get(path, config);
            const norm = normalizeLecturerReviewPayload(res);
            const mapped = mapToGradingUiPayload(norm);
            if (mapped) {
                // If attempt detail does not include media, try fetch quiz snapshot by quizId and merge.
                const quizId = Number(
                    (mapped as any)?.attempt?.quizId ??
                        (mapped as any)?.quizId ??
                        (norm as any)?.quizId ??
                        (norm as any)?.attempt?.quizId ??
                        0
                );
                const hasAnyMedia = Array.isArray(mapped.questions)
                    ? mapped.questions.some((q: any) => String(q?.mediaUrl ?? q?.media_url ?? '').trim())
                    : false;
                if (!hasAnyMedia) {
                    const snap = await tryFetchQuizQuestionsSnapshot(quizId);
                    if (snap) {
                        mapped.questions = mergeMediaIntoQuestions(mapped.questions, snap);
                    }
                }
                return mapped;
            }
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError ?? new Error('Failed to load attempt.');
}

/**
 * PATCH /api/quiz/attempts/:attemptId/grade
 * Real BE expects `grades: [{ questionId, isCorrect }]`.
 * Local mock (server.js) accepts `items: [{ questionId, markedCorrect }]`.
 * We send both for compatibility.
 */
export async function patchQuizAttemptGrade(
    attemptId: number,
    items: { questionId: string; markedCorrect: boolean }[],
    lecturerUserId: string | number | null | undefined
): Promise<void> {
    const params = gradingUserQueryParams(lecturerUserId);
    const filtered = items.filter(({ questionId }) => {
        const n = Number(String(questionId ?? '').trim());
        return Number.isFinite(n) && n > 0;
    });
    const grades = filtered.map(({ questionId, markedCorrect }) => ({
        questionId: Number(String(questionId).trim()),
        isCorrect: Boolean(markedCorrect),
    }));
    const mockItems = filtered.map(({ questionId, markedCorrect }) => ({
        questionId: String(questionId).trim(),
        markedCorrect: Boolean(markedCorrect),
    }));
    if (!grades.length) {
        throw new Error('No valid question IDs to grade.');
    }
    await api.patch(
        `/quiz/attempts/${attemptId}/grade`,
        { grades, items: mockItems },
        params ? { params } : {}
    );
}
