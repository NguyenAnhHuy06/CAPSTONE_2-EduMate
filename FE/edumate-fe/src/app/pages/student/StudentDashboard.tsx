import { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import { Sidebar } from '../Sidebar';
import { DocumentLibrary } from '../DocumentLibrary';
import { UploadDocument } from '../UploadDocument';
import { Profile } from '../Profile';
import { Leaderboard } from './Leaderboard';
import { ProgressTracker } from '../student/ProgressTracker';
import { StudentQuizSection } from '../student/StudentQuizSection';
import api from '../../../services/api';

interface StudentDashboardProps {
  user: any;
  onLogout: () => void;
  onUserUpdate?: (user: any) => void;
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

export function StudentDashboard({ user, onLogout, onUserUpdate }: StudentDashboardProps) {
  const [activeTab, setActiveTab] = useState<DashboardTab>('dashboard');

  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [summary, setSummary] = useState<ProgressSummary>(EMPTY_SUMMARY);
  const [historyRows, setHistoryRows] = useState<QuizHistoryRow[]>([]);
  const [myRank, setMyRank] = useState<LeaderboardResponse['myRank']>(null);

  const uid = getUserId(user);

  const menuItems = [
    { id: 'dashboard', label: 'Dashboard', icon: Home },
    { id: 'documents', label: 'Documents', icon: FileText },
    { id: 'upload', label: 'Upload', icon: Upload },
    { id: 'quizzes', label: 'Quizzes', icon: ClipboardList },
    { id: 'progress', label: 'Progress', icon: Target },
    { id: 'leaderboard', label: 'Leaderboard', icon: Trophy },
    { id: 'profile', label: 'Profile', icon: User },
  ];

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
        onMenuItemClick={(id: string) => setActiveTab(id as DashboardTab)}
        onLogout={onLogout}
        userRole="Student"
        userName={user.name}
        userEmail={user.email}
      />

      <div className="flex-1 overflow-auto">
        <div className="bg-white border-b border-gray-200 p-4 lg:flex lg:justify-end hidden">
          <div className="text-right">
            <p className="text-gray-900">{user.name}</p>
            <p className="text-gray-500 text-xs">{user.email}</p>
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

          {activeTab === 'documents' && <DocumentLibrary userRole="student" user={user} />}

          {activeTab === 'upload' && (
            <UploadDocument
              user={user}
              userRole="student"
              onUploadComplete={() => setActiveTab('documents')}
            />
          )}

          {activeTab === 'quizzes' && <StudentQuizSection user={user} />}

          {activeTab === 'progress' && <ProgressTracker user={user} />}

          {activeTab === 'leaderboard' && <Leaderboard user={user} />}

          {activeTab === 'profile' && <Profile user={user} onUserUpdate={onUserUpdate} />}
        </div>
      </div>
    </div>
  );
}