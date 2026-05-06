import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Upload,
  FileText,
  TrendingUp,
  Award,
  Brain,
  User,
  Home,
  Target,
  Trophy,
  ClipboardList,
  Loader2,
  CheckCircle2,
  XCircle,
  Heart,
} from 'lucide-react';
import { Sidebar } from '../Sidebar';
import { DocumentLibrary } from '../DocumentLibrary';
import { UploadDocument } from '../UploadDocument';
import { Profile } from '../Profile';
import { Leaderboard } from './Leaderboard';
import { ProgressTracker } from '../student/ProgressTracker';
import { StudentQuizSection } from '../student/StudentQuizSection';
import api from '../../../services/api';
import { NotificationBell } from '@/app/components/NotificationBell';

interface StudentDashboardProps {
  user: any;
  onLogout: () => void;
  onUserUpdate?: (user: any) => void;
  onOpenDonate?: () => void;
}

type DashboardTab =
  | 'dashboard'
  | 'documents'
  | 'upload'
  | 'quizzes'
  | 'progress'
  | 'leaderboard'
  | 'profile';

type ProgressSummary = {
  overall: {
    progressPercent: number;
    completedMaterials: number;
    totalMaterials: number;
    averageScorePercent: number | null;
    studyHoursLabel: string | null;
  };
  courses: Array<{
    courseId: number;
    name: string;
    code: string;
    progressPercent: number;
    totalMaterials: number;
    completedMaterials: number;
    quizScorePercent: number | null;
    lastActivityAt: string | null;
  }>;
  streak: {
    currentDays: number;
    longestDays: number;
  };
};

type QuizHistoryRow = {
  title?: string;
  scorePercent?: number;
  lastAttemptAt?: string;
  createdAt?: string;
  courseCode?: string;
  subjectCode?: string;
};

type LeaderboardResponse = {
  data?: Array<any>;
  myRank?: {
    rank: number;
    avgScore: number;
    totalAttempts: number;
    bestScore: number;
  } | null;
};

const STUDENT_QUIZ_GENERATING_KEY = 'edumate_student_quiz_generating';
const STUDENT_FLASHCARD_GENERATING_KEY = 'edumate_student_flashcard_generating';
const STUDENT_FLASHCARD_NAVIGATE_KEY = 'edumate_student_flashcard_navigate';
const STUDENT_SUCCESS_NOTIFICATIONS_KEY = 'edumate_student_success_notifications';
const STUDENT_QUIZ_TAKING_EVENT = 'edumate:student-quiz-taking';

type StudentQuizJobState = {
  running: boolean;
  status?: 'idle' | 'running' | 'completed' | 'failed';
  jobId?: string;
  title?: string;
  error?: string;
  documentId?: number | null;
  s3Key?: string;
  startedAt?: number;
  updatedAt?: number;
};

type StudentSuccessNotification = {
  id: string;
  type: 'quiz' | 'flashcard';
  title: string;
  documentId?: number | null;
  s3Key?: string;
  createdAt: number;
};

const EMPTY_SUMMARY: ProgressSummary = {
  overall: {
    progressPercent: 0,
    completedMaterials: 0,
    totalMaterials: 0,
    averageScorePercent: null,
    studyHoursLabel: null,
  },
  courses: [],
  streak: { currentDays: 0, longestDays: 0 },
};

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';

  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return 'just now';

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;

  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;

  const day = Math.floor(hr / 24);
  if (day < 14) return `${day} day${day === 1 ? '' : 's'} ago`;

  return new Date(iso).toLocaleDateString();
}

function getUserId(user: any) {
  return user?.user_id ?? user?.id ?? user?.userId ?? null;
}

export function StudentDashboard({ user, onLogout, onUserUpdate, onOpenDonate }: StudentDashboardProps) {
  const [activeTab, setActiveTab] = useState<DashboardTab>('dashboard');
  const [studentQuizFileHighlight, setStudentQuizFileHighlight] = useState<{
    s3Key: string;
    nonce: number;
  } | null>(null);
  const clearStudentQuizFileHighlight = useCallback(() => setStudentQuizFileHighlight(null), []);
  const [quizJobState, setQuizJobState] = useState<StudentQuizJobState | null>(null);
  const [flashcardJobState, setFlashcardJobState] = useState<StudentQuizJobState | null>(null);
  const [successNotifs, setSuccessNotifs] = useState<StudentSuccessNotification[]>([]);

  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [summary, setSummary] = useState<ProgressSummary>(EMPTY_SUMMARY);
  const [historyRows, setHistoryRows] = useState<QuizHistoryRow[]>([]);
  const [myRank, setMyRank] = useState<LeaderboardResponse['myRank']>(null);

  const uid = getUserId(user);
  const upsertSuccessNotification = (
    type: 'quiz' | 'flashcard',
    job: StudentQuizJobState | null | undefined,
    fallbackTitle: string
  ) => {
    const jobId = String(job?.jobId || '').trim();
    if (!jobId) return;
    const notif: StudentSuccessNotification = {
      id: `${type}-${jobId}`,
      type,
      title: job?.title ? String(job.title) : fallbackTitle,
      documentId: job?.documentId ?? null,
      s3Key: job?.s3Key || '',
      createdAt: Date.now(),
    };
    setSuccessNotifs((prev) => {
      if (prev.some((x) => x.id === notif.id)) return prev;
      const next = [notif, ...prev].slice(0, 30);
      try {
        localStorage.setItem(STUDENT_SUCCESS_NOTIFICATIONS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const markNotificationAsRead = (notifId: string) => {
    setSuccessNotifs((prev) => {
      const next = prev.filter((n) => n.id !== notifId);
      try {
        localStorage.setItem(STUDENT_SUCCESS_NOTIFICATIONS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const closeQuizJobNotification = () => {
    localStorage.setItem(
      STUDENT_QUIZ_GENERATING_KEY,
      JSON.stringify({
        ...(quizJobState || {}),
        running: false,
        status: 'idle',
        updatedAt: Date.now(),
      })
    );
    window.dispatchEvent(new Event('edumate:student-quiz-generating'));
  };

  const closeFlashcardJobNotification = () => {
    localStorage.setItem(
      STUDENT_FLASHCARD_GENERATING_KEY,
      JSON.stringify({
        ...(flashcardJobState || {}),
        running: false,
        status: 'idle',
        updatedAt: Date.now(),
      })
    );
    window.dispatchEvent(new Event('edumate:student-flashcard-generating'));
  };

  const openFlashcardViewerFromNotification = () => {
    if (!flashcardJobState) return;
    localStorage.setItem(
      STUDENT_FLASHCARD_NAVIGATE_KEY,
      JSON.stringify({
        title: flashcardJobState.title || '',
        documentId: flashcardJobState.documentId ?? null,
        s3Key: flashcardJobState.s3Key || '',
        mode: 'viewer',
        updatedAt: Date.now(),
      })
    );
    window.dispatchEvent(new Event('edumate:student-flashcard-navigate'));
    setActiveTab('documents');
    closeFlashcardJobNotification();
  };

  const openStudyMyFlashcards = (target: { title?: string; documentId?: number | null; s3Key?: string }) => {
    localStorage.setItem(
      STUDENT_FLASHCARD_NAVIGATE_KEY,
      JSON.stringify({
        title: target?.title || '',
        documentId: target?.documentId ?? null,
        s3Key: target?.s3Key || '',
        mode: 'viewer',
        updatedAt: Date.now(),
      })
    );
    window.dispatchEvent(new Event('edumate:student-flashcard-navigate'));
    setActiveTab('documents');
  };

  useEffect(() => {
    const onQuizTaking = (ev: Event) => {
      const e = ev as CustomEvent<{ active?: boolean }>;
      if (!e?.detail?.active) return;
      closeQuizJobNotification();
      closeFlashcardJobNotification();
    };
    window.addEventListener(STUDENT_QUIZ_TAKING_EVENT, onQuizTaking as EventListener);
    return () => {
      window.removeEventListener(STUDENT_QUIZ_TAKING_EVENT, onQuizTaking as EventListener);
    };
  }, [quizJobState, flashcardJobState]);

  useEffect(() => {
    const readGeneratingFlag = () => {
      try {
        const raw = localStorage.getItem(STUDENT_QUIZ_GENERATING_KEY);
        if (!raw) {
          setQuizJobState(null);
          return;
        }
        const parsed = JSON.parse(raw) as StudentQuizJobState;
        setQuizJobState(parsed);
      } catch {
        setQuizJobState(null);
      }
    };

    readGeneratingFlag();
    const onStorage = (e: StorageEvent) => {
      if (e.key === STUDENT_QUIZ_GENERATING_KEY) readGeneratingFlag();
    };
    const onCustom = () => readGeneratingFlag();
    window.addEventListener('storage', onStorage);
    window.addEventListener('edumate:student-quiz-generating', onCustom);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('edumate:student-quiz-generating', onCustom);
    };
  }, []);

  useEffect(() => {
    const readGeneratingFlag = () => {
      try {
        const raw = localStorage.getItem(STUDENT_FLASHCARD_GENERATING_KEY);
        if (!raw) {
          setFlashcardJobState(null);
          return;
        }
        const parsed = JSON.parse(raw) as StudentQuizJobState;
        setFlashcardJobState(parsed);
      } catch {
        setFlashcardJobState(null);
      }
    };

    readGeneratingFlag();
    const onStorage = (e: StorageEvent) => {
      if (e.key === STUDENT_FLASHCARD_GENERATING_KEY) readGeneratingFlag();
    };
    const onCustom = () => readGeneratingFlag();
    window.addEventListener('storage', onStorage);
    window.addEventListener('edumate:student-flashcard-generating', onCustom);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('edumate:student-flashcard-generating', onCustom);
    };
  }, []);

  useEffect(() => {
    // Poll localStorage so modal stays updated even without explicit events.
    const timer = window.setInterval(() => {
      try {
        const raw = localStorage.getItem(STUDENT_QUIZ_GENERATING_KEY);
        const parsed = raw ? (JSON.parse(raw) as StudentQuizJobState) : null;
        setQuizJobState(parsed);
      } catch {
        // ignore
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      try {
        const raw = localStorage.getItem(STUDENT_FLASHCARD_GENERATING_KEY);
        const parsed = raw ? (JSON.parse(raw) as StudentQuizJobState) : null;
        setFlashcardJobState(parsed);
      } catch {
        // ignore
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STUDENT_SUCCESS_NOTIFICATIONS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) setSuccessNotifs(parsed);
    } catch {
      setSuccessNotifs([]);
    }
  }, []);

  useEffect(() => {
    if (!quizJobState?.status) return;
    if (quizJobState.status === 'completed') {
      upsertSuccessNotification('quiz', quizJobState, 'AI Quiz');
    }
    if (quizJobState.status === 'running' || quizJobState.status === 'idle') return;
    // When quiz generation completes/fails while user is in another feature,
    // move back to Quizzes so they can continue the flow immediately.
    setActiveTab('quizzes');
    const timer = window.setTimeout(() => {
      closeQuizJobNotification();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [quizJobState?.status]);

  useEffect(() => {
    if (!flashcardJobState?.status) return;
    if (flashcardJobState.status === 'completed') {
      upsertSuccessNotification('flashcard', flashcardJobState, 'AI Flashcards');
    }
    if (flashcardJobState.status === 'running' || flashcardJobState.status === 'idle') return;
    const timer = window.setTimeout(() => {
      closeFlashcardJobNotification();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [flashcardJobState?.status]);

  const menuItems = [
    { id: 'dashboard', label: 'Dashboard', icon: Home },
    { id: 'documents', label: 'Documents', icon: FileText },
    { id: 'upload', label: 'Upload', icon: Upload },
    { id: 'quizzes', label: 'Quizzes', icon: ClipboardList },
    { id: 'progress', label: 'Progress', icon: Target },
    { id: 'leaderboard', label: 'Leaderboard', icon: Trophy },
    { id: 'donate', label: 'Donate', icon: Heart },
    { id: 'profile', label: 'Profile', icon: User },
  ];

  const backgroundJobs = [
    quizJobState?.status && quizJobState.status !== 'idle'
      ? {
          key: 'quiz',
          feature: 'AI Quiz',
          title: quizJobState.title || 'AI Quiz',
          status: quizJobState.status,
          updatedAt: quizJobState.updatedAt,
        }
      : null,
    flashcardJobState?.status && flashcardJobState.status !== 'idle'
      ? {
          key: 'flashcard',
          feature: 'AI Flashcard',
          title: flashcardJobState.title || 'AI Flashcards',
          status: flashcardJobState.status,
          updatedAt: flashcardJobState.updatedAt,
        }
      : null,
  ].filter(Boolean) as Array<{
    key: string;
    feature: string;
    title: string;
    status: 'running' | 'completed' | 'failed';
    updatedAt?: number;
  }>;

  useEffect(() => {
    let cancelled = false;

    if (uid == null || uid === '') {
      setDashboardLoading(false);
      return;
    }

    (async () => {
      setDashboardLoading(true);
      try {
        const [progressRes, historyRes, leaderboardRes] = await Promise.all([
          api.get('/progress/summary', { params: { userId: uid } }),
          api.get('/quizzes/history', { params: { userId: uid, limit: 10 } }),
          api.get('/leaderboard', { params: { limit: 50 } }),
        ]);

        if (cancelled) return;

        const progressPayload =
          progressRes && typeof progressRes === 'object' && 'data' in progressRes
            ? (progressRes as any).data
            : null;

        setSummary(progressPayload || EMPTY_SUMMARY);
        setHistoryRows(Array.isArray((historyRes as any)?.data) ? (historyRes as any).data : []);
        setMyRank((leaderboardRes as any)?.myRank ?? null);
      } catch {
        if (cancelled) return;
        setSummary(EMPTY_SUMMARY);
        setHistoryRows([]);
        setMyRank(null);
      } finally {
        if (!cancelled) setDashboardLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uid]);

  const stats = useMemo(() => {
    const materialsValue =
      summary.overall.totalMaterials > 0
        ? `${summary.overall.completedMaterials}/${summary.overall.totalMaterials}`
        : `${summary.overall.completedMaterials}`;

    const quizzesCompleted = historyRows.length;
    const streakLabel = `${summary.streak.currentDays} day${summary.streak.currentDays === 1 ? '' : 's'}`;
    const rankingLabel = myRank?.rank ? `#${myRank.rank}` : '—';

    return [
      {
        label: 'Materials Studied',
        value: materialsValue,
        icon: FileText,
        color: 'bg-blue-100 text-blue-600',
      },
      {
        label: 'Quizzes Completed',
        value: String(quizzesCompleted),
        icon: Brain,
        color: 'bg-green-100 text-green-600',
      },
      {
        label: 'Study Streak',
        value: streakLabel,
        icon: TrendingUp,
        color: 'bg-purple-100 text-purple-600',
      },
      {
        label: 'Ranking',
        value: rankingLabel,
        icon: Award,
        color: 'bg-orange-100 text-orange-600',
      },
    ];
  }, [summary, historyRows, myRank]);

  const recentActivities = useMemo(() => {
    return historyRows.slice(0, 4).map((row, idx) => ({
      id: `${row.title || 'quiz'}-${idx}`,
      action: `Completed quiz on "${row.title || 'Untitled Quiz'}"`,
      time: formatRelativeTime(row.lastAttemptAt || row.createdAt),
      score:
        typeof row.scorePercent === 'number' && Number.isFinite(row.scorePercent)
          ? `${Math.round(row.scorePercent)}%`
          : null,
    }));
  }, [historyRows]);

  const topCourses = useMemo(() => {
    return (summary.courses || []).slice(0, 4);
  }, [summary.courses]);

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar
        menuItems={menuItems}
        activeItem={activeTab}
        onMenuItemClick={(id: string) => {
          if (id === 'donate') {
            onOpenDonate?.();
            return;
          }
          setActiveTab(id as DashboardTab);
        }}
        onLogout={onLogout}
        userRole="Student"
        userName={user.name}
        userEmail={user.email}
      />

      <div className="flex-1 overflow-auto">
        <div className="bg-white border-b border-gray-200 p-4 lg:flex lg:justify-end hidden">
          <div className="flex items-center gap-3">
            <NotificationBell
              localNotifications={successNotifs}
              onClearLocalNotifications={() => {
                setSuccessNotifs([]);
                localStorage.removeItem(STUDENT_SUCCESS_NOTIFICATIONS_KEY);
              }}
              onOpenLocalNotification={(n) => {
                markNotificationAsRead(n.id);

                if (n.type === 'flashcard') {
                  openStudyMyFlashcards(n);
                  return;
                }

                setActiveTab('quizzes');
              }}
            />

            <div className="text-right">
              <p className="text-gray-900">{user.name}</p>
              <p className="text-gray-500 text-xs">{user.email}</p>
            </div>
          </div>
        </div>

        <div className="p-4 lg:p-8 mt-16 lg:mt-0">
          {activeTab === 'dashboard' && (
            <div>
              <h2 className="mb-6">My Dashboard</h2>

              {dashboardLoading && (
                <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 text-gray-600">
                  Loading dashboard...
                </div>
              )}

              {backgroundJobs.length > 0 && (
                <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-gray-900">Background jobs</h3>
                    <p className="text-xs text-gray-500">Auto-refresh from live status</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-500 border-b border-gray-100">
                          <th className="py-2 pr-3 font-medium">Feature</th>
                          <th className="py-2 pr-3 font-medium">Title</th>
                          <th className="py-2 pr-3 font-medium">Status</th>
                          <th className="py-2 font-medium">Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {backgroundJobs.map((job) => (
                          <tr key={job.key} className="border-b border-gray-50 last:border-0">
                            <td className="py-2 pr-3 text-gray-700">{job.feature}</td>
                            <td className="py-2 pr-3 text-gray-700 truncate max-w-[280px]">{job.title}</td>
                            <td className="py-2 pr-3">
                              <span
                                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                                  job.status === 'running'
                                    ? 'bg-blue-50 text-blue-700'
                                    : job.status === 'completed'
                                      ? 'bg-green-50 text-green-700'
                                      : 'bg-red-50 text-red-700'
                                }`}
                              >
                                {job.status === 'running' ? (
                                  <Loader2 size={12} className="animate-spin" />
                                ) : job.status === 'completed' ? (
                                  <CheckCircle2 size={12} />
                                ) : (
                                  <XCircle size={12} />
                                )}
                                {job.status === 'running'
                                  ? 'Running'
                                  : job.status === 'completed'
                                    ? 'Completed'
                                    : 'Failed'}
                              </span>
                            </td>
                            <td className="py-2 text-gray-500">
                              {job.updatedAt ? new Date(job.updatedAt).toLocaleTimeString() : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                {stats.map((stat) => (
                  <div key={stat.label} className="bg-white p-6 rounded-lg border border-gray-200">
                    <div className="flex items-center justify-between mb-4">
                      <div className={`p-3 rounded-lg ${stat.color}`}>
                        <stat.icon size={24} />
                      </div>
                    </div>
                    <p className="text-gray-600 mb-1">{stat.label}</p>
                    <h3>{stat.value}</h3>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white rounded-lg border border-gray-200 p-6">
                  <h3 className="mb-4">Recent Activity</h3>

                  {!dashboardLoading && recentActivities.length === 0 && (
                    <p className="text-gray-600">
                      No recent activity yet. Complete quizzes to see your latest learning actions.
                    </p>
                  )}

                  <div className="space-y-4">
                    {recentActivities.map((activity) => (
                      <div
                        key={activity.id}
                        className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0"
                      >
                        <div>
                          <p className="text-gray-700">{activity.action}</p>
                          {activity.score && <p className="text-green-600 text-sm">{activity.score}</p>}
                        </div>
                        <p className="text-gray-500 text-sm">{activity.time}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-white rounded-lg border border-gray-200 p-6">
                  <h3 className="mb-4">Course Progress</h3>

                  {!dashboardLoading && topCourses.length === 0 && (
                    <p className="text-gray-600">
                      No course progress yet. Study materials and complete quizzes to build progress data.
                    </p>
                  )}

                  <div className="space-y-4">
                    {topCourses.map((course) => (
                      <div key={course.courseId}>
                        <div className="flex justify-between mb-2">
                          <p className="text-gray-700">{course.name}</p>
                          <p className="text-gray-600">{course.progressPercent}%</p>
                        </div>
                        <div className="w-full bg-gray-200 rounded-full h-2">
                          <div
                            className="bg-blue-600 h-2 rounded-full"
                            style={{ width: `${Math.min(100, Math.max(0, course.progressPercent))}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'documents' && (
            <DocumentLibrary
              userRole="student"
              user={user}
              onStudentOpenInQuizzes={(doc) => {
                const s3Key = String(doc?.s3Key || '').trim();
                if (!s3Key) return;
                setStudentQuizFileHighlight({ s3Key, nonce: Date.now() });
                setActiveTab('quizzes');
              }}
            />
          )}

          {activeTab === 'upload' && (
            <UploadDocument
              user={user}
              userRole="student"
              onUploadComplete={() => setActiveTab('documents')}
            />
          )}

          {activeTab === 'quizzes' && (
            <StudentQuizSection
              user={user}
              fileHighlightRequest={studentQuizFileHighlight}
              onFileHighlightConsumed={clearStudentQuizFileHighlight}
            />
          )}

          {activeTab === 'progress' && <ProgressTracker user={user} />}

          {activeTab === 'leaderboard' && <Leaderboard user={user} />}

          {activeTab === 'profile' && <Profile user={user} onUserUpdate={onUserUpdate} />}
        </div>
        {backgroundJobs.length > 0 &&
          activeTab !== 'dashboard' &&
          !(quizJobState && quizJobState.status && quizJobState.status !== 'idle') &&
          !(flashcardJobState && flashcardJobState.status && flashcardJobState.status !== 'idle') && (
          <div className="fixed bottom-5 left-5 z-[78] w-[420px] max-w-[calc(100vw-24px)] bg-white rounded-xl shadow-xl border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-gray-900 text-sm font-semibold">Background jobs</h3>
              <button
                type="button"
                onClick={() => setActiveTab('dashboard')}
                className="text-xs text-blue-600 hover:text-blue-700"
              >
                View dashboard
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-100">
                    <th className="py-2 pr-3 font-medium">Feature</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {backgroundJobs.map((job) => (
                    <tr key={`floating-${job.key}`} className="border-b border-gray-50 last:border-0">
                      <td className="py-2 pr-3 text-gray-700">{job.feature}</td>
                      <td className="py-2 pr-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${
                            job.status === 'running'
                              ? 'bg-blue-50 text-blue-700'
                              : job.status === 'completed'
                                ? 'bg-green-50 text-green-700'
                                : 'bg-red-50 text-red-700'
                          }`}
                        >
                          {job.status === 'running' ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : job.status === 'completed' ? (
                            <CheckCircle2 size={12} />
                          ) : (
                            <XCircle size={12} />
                          )}
                          {job.status === 'running'
                            ? 'Running'
                            : job.status === 'completed'
                              ? 'Completed'
                              : 'Failed'}
                        </span>
                      </td>
                      <td className="py-2 text-gray-500">
                        {job.updatedAt ? new Date(job.updatedAt).toLocaleTimeString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {quizJobState && quizJobState.status && quizJobState.status !== 'idle' && (
          <div className="fixed bottom-5 right-5 z-[80] w-[360px] max-w-[calc(100vw-24px)] bg-white rounded-xl shadow-xl border border-gray-200 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-gray-900 font-semibold text-sm">
                  {quizJobState.status === 'running'
                    ? 'Generating quiz in background'
                    : quizJobState.status === 'completed'
                      ? 'Quiz generation completed'
                      : 'Quiz generation failed'}
                </h3>
                <p className="text-xs text-gray-600 mt-0.5">
                  {quizJobState.title || 'AI Quiz'}
                </p>
              </div>
              {quizJobState.status === 'running' ? (
                <Loader2 size={18} className="text-blue-600 animate-spin shrink-0" />
              ) : quizJobState.status === 'completed' ? (
                <CheckCircle2 size={18} className="text-green-600 shrink-0" />
              ) : (
                <XCircle size={18} className="text-red-600 shrink-0" />
              )}
            </div>

            <div className="mt-2 text-xs">
              {quizJobState.status === 'running' ? (
                <p className="text-gray-700">
                  Please wait. You can switch to other features while this runs in the background.
                </p>
              ) : quizJobState.status === 'completed' ? (
                <p className="text-green-700">Generation finished successfully.</p>
              ) : (
                <p className="text-red-700">
                  {quizJobState.error || 'Could not generate quiz. Please try again.'}
                </p>
              )}
            </div>

            <div className="mt-3 flex items-center justify-between">
              {quizJobState.status === 'running' ? (
                <span className="text-[11px] text-gray-500">Processing...</span>
              ) : (
                <span className="text-[11px] text-gray-500">Auto closes in 5 seconds</span>
              )}
              <button
                type="button"
                onClick={closeQuizJobNotification}
                className="px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-xs"
              >
                Close
              </button>
            </div>
          </div>
        )}
        {flashcardJobState && flashcardJobState.status && flashcardJobState.status !== 'idle' && (
          <div
            className={`fixed bottom-5 right-5 z-[79] w-[360px] max-w-[calc(100vw-24px)] bg-white rounded-xl shadow-xl border border-gray-200 p-4 ${
              flashcardJobState.status === 'completed' ? 'cursor-pointer hover:shadow-2xl' : ''
            }`}
            onClick={() => {
              if (flashcardJobState.status === 'completed') {
                openFlashcardViewerFromNotification();
              }
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-gray-900 font-semibold text-sm">
                  {flashcardJobState.status === 'running'
                    ? 'Generating flashcards in background'
                    : flashcardJobState.status === 'completed'
                      ? 'Flashcard generation completed'
                      : 'Flashcard generation failed'}
                </h3>
                <p className="text-xs text-gray-600 mt-0.5">
                  {flashcardJobState.title || 'AI Flashcards'}
                </p>
              </div>
              {flashcardJobState.status === 'running' ? (
                <Loader2 size={18} className="text-blue-600 animate-spin shrink-0" />
              ) : flashcardJobState.status === 'completed' ? (
                <CheckCircle2 size={18} className="text-green-600 shrink-0" />
              ) : (
                <XCircle size={18} className="text-red-600 shrink-0" />
              )}
            </div>

            <div className="mt-2 text-xs">
              {flashcardJobState.status === 'running' ? (
                <p className="text-gray-700">
                  Please wait. You can switch to other features while this runs in the background.
                </p>
              ) : flashcardJobState.status === 'completed' ? (
                <p className="text-green-700">Generation finished successfully. Click this card to open Study My Flashcards.</p>
              ) : (
                <p className="text-red-700">
                  {flashcardJobState.error || 'Could not generate flashcards. Please try again.'}
                </p>
              )}
            </div>

            <div className="mt-3 flex items-center justify-between">
              {flashcardJobState.status === 'running' ? (
                <span className="text-[11px] text-gray-500">Processing...</span>
              ) : (
                <span className="text-[11px] text-gray-500">Auto closes in 5 seconds</span>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeFlashcardJobNotification();
                }}
                className="px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-xs"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}