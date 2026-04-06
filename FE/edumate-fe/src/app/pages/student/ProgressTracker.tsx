import { useEffect, useState } from 'react';
import { TrendingUp, CheckCircle, Clock, Target } from 'lucide-react';
import api from '../../../services/api';

interface ProgressTrackerProps {
  user: any;
}

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
  streak: { currentDays: number; longestDays: number };
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

function normalizeProgressData(raw: unknown): ProgressSummary {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_SUMMARY };
  const d = raw as Record<string, unknown>;
  const overall = d.overall && typeof d.overall === 'object' ? (d.overall as Record<string, unknown>) : {};
  const streak = d.streak && typeof d.streak === 'object' ? (d.streak as Record<string, unknown>) : {};
  const courses = Array.isArray(d.courses) ? d.courses : [];
  return {
    overall: {
      progressPercent: Math.min(100, Math.max(0, Number(overall.progressPercent) || 0)),
      completedMaterials: Math.max(0, Number(overall.completedMaterials) || 0),
      totalMaterials: Math.max(0, Number(overall.totalMaterials) || 0),
      averageScorePercent: (() => {
        if (overall.averageScorePercent == null || overall.averageScorePercent === '') return null;
        const n = Number(overall.averageScorePercent);
        return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
      })(),
      studyHoursLabel:
        overall.studyHoursLabel != null && String(overall.studyHoursLabel).trim()
          ? String(overall.studyHoursLabel)
          : null,
    },
    courses: courses.filter((c) => c && typeof c === 'object') as ProgressSummary['courses'],
    streak: {
      currentDays: Math.max(0, Number(streak.currentDays) || 0),
      longestDays: Math.max(0, Number(streak.longestDays) || 0),
    },
  };
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day} day${day === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

export function ProgressTracker({ user }: ProgressTrackerProps) {
  const [summary, setSummary] = useState<ProgressSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const uid = user?.user_id ?? user?.id ?? user?.userId;

    if (uid == null || uid === '') {
      setSummary({ ...EMPTY_SUMMARY });
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      setLoading(true);
      try {
        const res: unknown = await api.get('/progress/summary', { params: { userId: uid } });
        if (cancelled) return;

        const body = res && typeof res === 'object' ? (res as Record<string, unknown>) : null;
        const payload = body?.data;
        setSummary(normalizeProgressData(payload));
      } catch {
        if (!cancelled) setSummary({ ...EMPTY_SUMMARY });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.user_id, user?.id, user?.userId]);

  const overall = summary.overall;
  const courses = summary.courses ?? [];
  const streak = summary.streak ?? { currentDays: 0, longestDays: 0 };

  const overallStats = [
    {
      label: 'Overall progress',
      value: `${overall.progressPercent}%`,
      icon: TrendingUp,
      color: 'bg-blue-100 text-blue-600',
    },
    {
      label: 'Materials completed',
      value:
        overall.totalMaterials > 0
          ? `${overall.completedMaterials}/${overall.totalMaterials}`
          : `${overall.completedMaterials}`,
      icon: CheckCircle,
      color: 'bg-green-100 text-green-600',
    },
    {
      label: 'Study hours',
      value: overall.studyHoursLabel && overall.studyHoursLabel.trim() ? overall.studyHoursLabel : '—',
      icon: Clock,
      color: 'bg-purple-100 text-purple-600',
    },
    {
      label: 'Average score',
      value: overall.averageScorePercent != null ? `${overall.averageScorePercent}%` : '—',
      icon: Target,
      color: 'bg-orange-100 text-orange-600',
    },
  ];

  return (
    <div>
      <h2 className="mb-6">Learning progress</h2>

      {loading && <p className="text-gray-600 mb-4">Loading…</p>}

      {/* Overall Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {overallStats.map((stat) => (
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

      {/* Course Progress */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="mb-6">Course details</h3>

        {!loading && !courses.length && (
          <p className="text-gray-600">
            No progress data yet. Take quizzes or study materials to update your progress.
          </p>
        )}

        <div className="space-y-6">
          {courses.map((course) => (
            <div key={course.courseId} className="pb-6 border-b border-gray-100 last:border-0 last:pb-0">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h4>{course.name}</h4>
                    <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded text-xs">
                      {course.code}
                    </span>
                  </div>
                  <div className="flex items-center gap-6 text-gray-600 flex-wrap">
                    <span>
                      {course.completedMaterials}/{course.totalMaterials} materials
                    </span>
                    <span>•</span>
                    <span>
                      Quiz avg:{' '}
                      {course.quizScorePercent != null ? `${course.quizScorePercent}%` : '—'}
                    </span>
                    <span>•</span>
                    <span className="text-gray-500">
                      Last activity: {formatRelativeTime(course.lastActivityAt)}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-gray-900">{course.progressPercent}%</p>
                  <p className="text-gray-500">complete</p>
                </div>
              </div>

              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className={`h-3 rounded-full transition-all ${
                    course.progressPercent >= 80
                      ? 'bg-green-600'
                      : course.progressPercent >= 50
                        ? 'bg-blue-600'
                        : 'bg-orange-600'
                  }`}
                  style={{ width: `${Math.min(100, Math.max(0, course.progressPercent))}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Study Streak */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mt-6">
        <h3 className="mb-4">Study streak</h3>
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-gray-600 mb-1">Current</p>
            <h2 className="text-blue-600">
              {streak.currentDays} day{streak.currentDays === 1 ? '' : 's'}
            </h2>
          </div>
          <div>
            <p className="text-gray-600 mb-1">Longest</p>
            <h2 className="text-gray-900">
              {streak.longestDays} day{streak.longestDays === 1 ? '' : 's'}
            </h2>
          </div>
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 7 }).map((_, idx) => {
            const active = idx < Math.min(7, Math.max(streak.currentDays, 0));
            return (
              <div
                key={idx}
                className={`flex-1 h-12 rounded ${active ? 'bg-blue-600' : 'bg-gray-200'}`}
                title={`Day ${idx + 1}`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
