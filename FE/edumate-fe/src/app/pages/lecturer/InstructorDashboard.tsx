import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, Upload, FileText, CheckCircle, TrendingUp, User, Home, ClipboardList } from 'lucide-react';
import { Sidebar } from '../Sidebar';
import { DocumentLibrary } from '../DocumentLibrary';
import { UploadDocument } from '../UploadDocument';
import { Profile } from '../Profile';
import { QuizManagement, type InitialAiDocumentPayload } from '../lecturer/QuizManagement';
import api from '@/services/api';

interface InstructorDashboardProps {
  user: any;
  onLogout: () => void;
  onUserUpdate?: (user: any) => void;
}

export function InstructorDashboard({ user, onLogout, onUserUpdate }: InstructorDashboardProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'documents' | 'upload' | 'quizzes' | 'profile'>('overview');
  const [pendingAiDocument, setPendingAiDocument] = useState<InitialAiDocumentPayload | null>(null);
  const clearPendingAiDocument = useCallback(() => setPendingAiDocument(null), []);
  const [overviewLoading, setOverviewLoading] = useState(false);
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
        const history = Array.isArray(historyRes?.data) ? historyRes.data : [];
        const analytics = analyticsRes?.data || analyticsRes || {};
        const perf = Array.isArray(analytics?.performance) ? analytics.performance : [];

        const materialsUploaded = docs.length;
        const quizzesCreated = history.length;
        const totalAttempts = perf.reduce((sum: number, q: any) => sum + Number(q?.attempts || 0), 0);
        const publishedQuizzes = perf.filter((q: any) => !!q?.isPublished).length;

        const activitiesFromDocs = docs.map((d: any) => ({
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
        onMenuItemClick={(id) => setActiveTab(id as any)}
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
              onInstructorCreateQuizWithAi={(doc) => {
                const s3Key = String(doc.s3Key || '').trim();
                if (!s3Key) return;
                setPendingAiDocument({
                  s3Key,
                  documentId: doc.documentId ?? undefined,
                  title: doc.title,
                  courseCode: String(doc.courseCode || '').trim() || undefined,
                  nonce: Date.now(),
                });
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
              initialAiDocument={pendingAiDocument}
              onInitialAiDocumentConsumed={clearPendingAiDocument}
            />
          )}

          {activeTab === 'profile' && (
            <Profile user={user} onUserUpdate={onUserUpdate} />
          )}
        </div>
      </div>
    </div>
  );
}
