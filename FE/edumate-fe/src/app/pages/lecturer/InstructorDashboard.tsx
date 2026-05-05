import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BookOpen, Upload, FileText, CheckCircle, TrendingUp, User, Home, ClipboardList, Loader2, XCircle, Heart } from 'lucide-react';
import { Sidebar } from '../Sidebar';
import { DocumentLibrary } from '../DocumentLibrary';
import { UploadDocument } from '../UploadDocument';
import { Profile } from '../Profile';
import { QuizManagement, type InitialAiDocumentPayload } from '../lecturer/QuizManagement';
import api from '@/services/api';

const LECTURER_QUIZ_GENERATING_KEY = 'edumate_lecturer_quiz_generating';
const LECTURER_QUIZ_AUTOSTART_KEY = 'edumate_lecturer_quiz_autostart';
const LECTURER_QUIZ_AUTOSTART_EVENT = 'edumate:lecturer-quiz-autostart';
type LecturerQuizJobState = {
    running: boolean;
    status?: 'idle' | 'running' | 'completed' | 'failed';
    title?: string;
    error?: string;
    quizId?: number | null;
    autoOpen?: boolean;
    navigateTo?: string;
    navigateReplace?: boolean;
    startedAt?: number;
    updatedAt?: number;
};

type InstructorMainTab = 'overview' | 'documents' | 'upload' | 'quizzes' | 'profile';

interface InstructorDashboardProps {
  user: any;
  onLogout: () => void;
  onUserUpdate?: (user: any) => void;
  onOpenDonate?: () => void;
  focusQuizId?: number | null;
  initialMainTab?: InstructorMainTab;
}

export function InstructorDashboard({
  user,
  onLogout,
  onUserUpdate,
  onOpenDonate,
  focusQuizId = null,
  initialMainTab,
}: InstructorDashboardProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [activeTab, setActiveTab] = useState<InstructorMainTab>(() => {
    const fromNav = (location.state as { instructorMainTab?: InstructorMainTab } | null)?.instructorMainTab;
    const valid: InstructorMainTab[] = ['overview', 'documents', 'upload', 'quizzes', 'profile'];
    if (fromNav && valid.includes(fromNav)) return fromNav;
    return initialMainTab ?? 'overview';
  });
  const [pendingAiDocument, setPendingAiDocument] = useState<InitialAiDocumentPayload | null>(null);
  const clearPendingAiDocument = useCallback(() => setPendingAiDocument(null), []);
  const [fileHighlightRequest, setFileHighlightRequest] = useState<{
    s3Key: string;
    nonce: number;
  } | null>(null);
  const clearFileHighlightRequest = useCallback(() => setFileHighlightRequest(null), []);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [quizJobState, setQuizJobState] = useState<LecturerQuizJobState | null>(null);
  const [overview, setOverview] = useState({
    materialsUploaded: 0,
    totalAttempts: 0,
    publishedQuizzes: 0,
    quizzesCreated: 0,
    activities: [] as Array<{ action: string; at: string }>,
  });

  const menuItems = [
    { id: 'overview', label: 'Overview', icon: Home },
    { id: 'documents', label: 'Documents', icon: FileText },
    { id: 'upload', label: 'Upload', icon: Upload },
    { id: 'quizzes', label: 'Quizzes', icon: ClipboardList },
    { id: 'donate', label: 'Donate', icon: Heart },
    { id: 'profile', label: 'Profile', icon: User },
  ];

  const lecturerUserId = user?.user_id ?? user?.id ?? user?.userId;

  const toTimeAgo = (dateValue?: string) => {
    if (!dateValue) return 'just now';
    const t = new Date(dateValue).getTime();
    if (!Number.isFinite(t)) return 'just now';
    const diff = Math.max(0, Date.now() - t);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} minute${mins > 1 ? 's' : ''} ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days > 1 ? 's' : ''} ago`;
  };

  useEffect(() => {
    const loadOverview = async () => {
      if (lecturerUserId == null || lecturerUserId === '') return;
      setOverviewLoading(true);
      try {
        const [docsRes, historyRes, analyticsRes]: any[] = await Promise.all([
          api.get('/documents/for-quiz'),
          api.get('/quizzes/history', {
            params: { userId: lecturerUserId, ownerOnly: true, limit: 200 },
          }),
          api.get('/quizzes/analytics', {
            params: { userId: lecturerUserId, topQuestions: 5 },
          }),
        ]);
        const docs = Array.isArray(docsRes?.data) ? docsRes.data : [];
        const ownDocs = docs.filter((d: any) => {
          const uploaderId = Number(d?.uploaderId ?? d?.uploader_id);
          const ownerId = Number(lecturerUserId);
          return Number.isFinite(uploaderId) && Number.isFinite(ownerId) && uploaderId === ownerId;
        });
        const history = Array.isArray(historyRes?.data) ? historyRes.data : [];
        const analytics = analyticsRes?.data || analyticsRes || {};
        const perf = Array.isArray(analytics?.performance) ? analytics.performance : [];

        const materialsUploaded = ownDocs.length;
        const quizzesCreated = history.length;
        const totalAttempts = perf.reduce((sum: number, q: any) => sum + Number(q?.attempts || 0), 0);
        const publishedQuizzes = perf.filter((q: any) => !!q?.isPublished).length;

        const activitiesFromDocs = ownDocs.map((d: any) => ({
          action: `Uploaded "${String(d?.title || d?.fileName || 'Document')}"`,
          at: String(d?.lastModified || d?.uploadedAt || d?.createdAt || ''),
        }));
        const activitiesFromQuiz = history.map((q: any) => {
          const title = String(q?.title || 'Quiz');
          if (q?.publishedAt || q?.isPublished) {
            return {
              action: `Published quiz "${title}"`,
              at: String(q?.publishedAt || q?.createdAt || ''),
            };
          }
          if (q?.lastAttemptAt) {
            return {
              action: `Quiz "${title}" was attempted`,
              at: String(q?.lastAttemptAt),
            };
          }
          return {
            action: `Created quiz "${title}"`,
            at: String(q?.createdAt || ''),
          };
        });
        const activities = [...activitiesFromDocs, ...activitiesFromQuiz]
          .sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime())
          .slice(0, 8);

        setOverview({
          materialsUploaded,
          quizzesCreated,
          totalAttempts,
          publishedQuizzes,
          activities,
        });
      } catch {
        setOverview({
          materialsUploaded: 0,
          quizzesCreated: 0,
          totalAttempts: 0,
          publishedQuizzes: 0,
          activities: [],
        });
      } finally {
        setOverviewLoading(false);
      }
    };
    loadOverview();
  }, [lecturerUserId]);

  useEffect(() => {
    const readJob = () => {
      try {
        const raw = localStorage.getItem(LECTURER_QUIZ_GENERATING_KEY);
        setQuizJobState(raw ? (JSON.parse(raw) as LecturerQuizJobState) : null);
      } catch {
        setQuizJobState(null);
      }
    };
    readJob();
    const onStorage = (e: StorageEvent) => {
      if (e.key === LECTURER_QUIZ_GENERATING_KEY) readJob();
    };
    const onCustom = () => readJob();
    window.addEventListener('storage', onStorage);
    window.addEventListener('edumate:lecturer-quiz-generating', onCustom);
    const timer = window.setInterval(readJob, 1200);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('edumate:lecturer-quiz-generating', onCustom);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (quizJobState?.status !== 'completed') return;
    const navTo = String(quizJobState?.navigateTo || '').trim();
    const navReplace = quizJobState?.navigateReplace !== false;
    if (navTo) {
      navigate(navTo, { replace: navReplace });
      try {
        const raw = localStorage.getItem(LECTURER_QUIZ_GENERATING_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object') {
          parsed.navigateTo = '';
          localStorage.setItem(LECTURER_QUIZ_GENERATING_KEY, JSON.stringify(parsed));
        }
      } catch {
        // ignore storage failures
      }
      setQuizJobState((prev) => (prev ? { ...prev, navigateTo: '' } : null));
      return;
    }
    try {
      localStorage.setItem(
        LECTURER_QUIZ_AUTOSTART_KEY,
        JSON.stringify({
          quizId: Number(quizJobState?.quizId ?? 0) || null,
          title: String(quizJobState?.title || 'AI Quiz'),
          updatedAt: Date.now(),
        })
      );
      window.dispatchEvent(new Event(LECTURER_QUIZ_AUTOSTART_EVENT));
    } catch {
      // ignore storage failures
    }
    setActiveTab('quizzes');
  }, [
    quizJobState?.status,
    quizJobState?.quizId,
    quizJobState?.title,
    quizJobState?.navigateTo,
    quizJobState?.navigateReplace,
    navigate,
  ]);

  useEffect(() => {
    const onReady = (e: Event) => {
      const d = (e as CustomEvent<{ navigateTo?: string; autoOpen?: boolean; navigateReplace?: boolean }>).detail;
      const to = String(d?.navigateTo || '').trim();
      if (d?.autoOpen && to) {
        navigate(to, { replace: d?.navigateReplace !== false });
      }
    };
    window.addEventListener('quiz:ready', onReady as EventListener);
    return () => window.removeEventListener('quiz:ready', onReady as EventListener);
  }, [navigate]);

  useEffect(() => {
    if (!quizJobState?.status) return;
    if (quizJobState.status === 'running' || quizJobState.status === 'idle') return;
    const timer = window.setTimeout(() => {
      try {
        localStorage.removeItem(LECTURER_QUIZ_GENERATING_KEY);
      } catch {
        // ignore storage failures
      }
      setQuizJobState(null);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [quizJobState?.status]);

  const stats = useMemo(() => ([
    { label: 'Materials Uploaded', value: String(overview.materialsUploaded), icon: FileText, color: 'bg-blue-100 text-blue-600' },
    { label: 'Total Attempts', value: String(overview.totalAttempts), icon: TrendingUp, color: 'bg-green-100 text-green-600' },
    { label: 'Published Quizzes', value: String(overview.publishedQuizzes), icon: CheckCircle, color: 'bg-purple-100 text-purple-600' },
    { label: 'Quizzes Created', value: String(overview.quizzesCreated), icon: BookOpen, color: 'bg-orange-100 text-orange-600' },
  ]), [overview]);

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar */}
      <Sidebar
        menuItems={menuItems}
        activeItem={activeTab}
        onMenuItemClick={(id) => {
          if (id === 'donate') {
            onOpenDonate?.();
            return;
          }
          setActiveTab(id as any);
        }}
        onLogout={onLogout}
        userRole="Instructor"
        userName={user.name}
        userEmail={user.email}
      />

      {/* Main Content */}
      <div className="flex-1 overflow-auto">
        {/* Top Bar for Mobile and User Info */}
        <div className="bg-white border-b border-gray-200 p-4 lg:flex lg:justify-end hidden">
          <div className="text-right">
            <p className="text-gray-900">{user.name}</p>
            <p className="text-gray-500 text-xs">{user.email}</p>
          </div>
        </div>

        {/* Content Area */}
        <div className="p-4 lg:p-8 mt-16 lg:mt-0">
          {activeTab === 'overview' && (
            <div>
              <h2 className="mb-6">Dashboard Overview</h2>
              {overviewLoading && (
                <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-blue-700">
                  Loading dashboard data...
                </div>
              )}

              {/* Stats Grid */}
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

              {/* Recent Activity */}
              <div className="bg-white rounded-lg border border-gray-200 p-6">
                <h3 className="mb-4">Recent Activity</h3>
                <div className="space-y-4">
                  {overview.activities.map((activity, idx) => (
                    <div key={idx} className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
                      <p className="text-gray-700">{activity.action}</p>
                      <p className="text-gray-500 text-sm">{toTimeAgo(activity.at)}</p>
                    </div>
                  ))}
                  {overview.activities.length === 0 && (
                    <p className="text-gray-500">No recent activity yet.</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'documents' && (
            <DocumentLibrary
              userRole="instructor"
              user={user}
              onInstructorMoveToQuizFile={(doc) => {
                const s3Key = String(doc.s3Key || '').trim();
                if (!s3Key) return;
                setFileHighlightRequest({ s3Key, nonce: Date.now() });
                setActiveTab('quizzes');
              }}
            />
          )}

          {activeTab === 'upload' && (
            <UploadDocument user={user} userRole="instructor" onUploadComplete={() => setActiveTab('documents')} />
          )}

          {activeTab === 'quizzes' && (
            <QuizManagement
              user={user}
              focusQuizId={focusQuizId}
              initialAiDocument={pendingAiDocument}
              onInitialAiDocumentConsumed={clearPendingAiDocument}
              fileHighlightRequest={fileHighlightRequest}
              onFileHighlightConsumed={clearFileHighlightRequest}
            />
          )}

          {activeTab === 'profile' && (
            <Profile user={user} onUserUpdate={onUserUpdate} />
          )}
        </div>
        {quizJobState?.status && quizJobState.status !== 'idle' && (
          <div className="fixed bottom-5 right-5 z-[80] w-[380px] max-w-[calc(100vw-24px)] bg-white rounded-xl shadow-xl border border-gray-200 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-gray-900 font-semibold text-sm">
                  {quizJobState.status === 'running'
                    ? 'Generating quiz in background'
                    : quizJobState.status === 'completed'
                      ? 'Quiz generation completed'
                      : 'Quiz generation failed'}
                </h3>
                <p className="text-xs text-gray-600 mt-0.5">{quizJobState.title || 'AI Quiz'}</p>
              </div>
              {quizJobState.status === 'running' ? (
                <Loader2 size={18} className="text-blue-600 animate-spin shrink-0" />
              ) : quizJobState.status === 'completed' ? (
                <CheckCircle size={18} className="text-green-600 shrink-0" />
              ) : (
                <XCircle size={18} className="text-red-600 shrink-0" />
              )}
            </div>
            <p className="mt-2 text-xs text-gray-700">
              {quizJobState.status === 'running'
                ? 'Please wait. You can continue using other tabs while AI generates questions.'
                : quizJobState.status === 'completed'
                  ? 'Generation finished successfully.'
                  : (quizJobState.error || 'Could not generate quiz. Please try again.')}
            </p>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-[11px] text-gray-500">
                {quizJobState.updatedAt ? new Date(quizJobState.updatedAt).toLocaleTimeString() : 'Processing...'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}