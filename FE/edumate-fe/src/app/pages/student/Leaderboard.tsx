import { useEffect, useState, useCallback } from 'react';
import { Award, TrendingUp, Medal, Crown, RefreshCw, Trophy, Users, Target } from 'lucide-react';
import api from '../../../services/api';

interface LeaderboardEntry {
  rank: number;
  userId: string | number;
  name: string;
  email?: string;
  avgScore: number;
  totalAttempts: number;
  bestScore: number;
  isCurrentUser?: boolean;
}

interface LeaderboardResponse {
  data: LeaderboardEntry[];
  myRank?: {
    rank: number;
    avgScore: number;
    totalAttempts: number;
    bestScore: number;
  } | null;
  total?: number;
}

interface LeaderboardProps {
  user: any;
}

// Màu avatar theo index – đa dạng, không trùng
const AVATAR_COLORS = [
  'bg-violet-500', 'bg-blue-500', 'bg-emerald-500', 'bg-rose-500',
  'bg-amber-500', 'bg-cyan-500', 'bg-fuchsia-500', 'bg-teal-500',
  'bg-orange-500', 'bg-indigo-500', 'bg-lime-500', 'bg-pink-500',
];

function getAvatarColor(userId: string | number, index: number): string {
  const seed = typeof userId === 'number' ? userId : userId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_COLORS[(seed + index) % AVATAR_COLORS.length];
}

function getInitials(name: string): string {
  if (!name || !name.trim()) return '?';
  return name
    .trim()
    .split(/\s+/)
    .map((n) => n[0]?.toUpperCase() ?? '')
    .slice(0, 2)
    .join('');
}

function ScoreBadge({ score }: { score: number }) {
  const colorClass =
    score >= 90
      ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
      : score >= 75
      ? 'bg-blue-100 text-blue-700 border-blue-200'
      : score >= 60
      ? 'bg-amber-100 text-amber-700 border-amber-200'
      : 'bg-red-100 text-red-700 border-red-200';

  return (
    <span className={`px-2.5 py-1 rounded-full text-sm border font-medium ${colorClass}`}>
      {score}%
    </span>
  );
}

function RankIcon({ rank }: { rank: number }) {
  if (rank === 1) return <Crown size={20} className="text-yellow-500" />;
  if (rank === 2) return <Medal size={20} className="text-slate-400" />;
  if (rank === 3) return <Medal size={20} className="text-amber-600" />;
  return null;
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1)
    return (
      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-yellow-100 text-yellow-700 text-sm font-bold border border-yellow-200">
        <Crown size={14} /> #1
      </span>
    );
  if (rank === 2)
    return (
      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-slate-100 text-slate-600 text-sm font-bold border border-slate-200">
        <Medal size={14} /> #2
      </span>
    );
  if (rank === 3)
    return (
      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-amber-100 text-amber-700 text-sm font-bold border border-amber-200">
        <Medal size={14} /> #3
      </span>
    );
  return (
    <span className="inline-flex items-center px-3 py-1 rounded-full bg-gray-100 text-gray-600 text-sm font-bold border border-gray-200">
      #{rank}
    </span>
  );
}



// Loading skeleton row
function SkeletonRow({ index }: { index: number }) {
  return (
    <tr className="border-b border-gray-100">
      <td className="px-6 py-4">
        <div className="w-16 h-7 bg-gray-200 rounded-full animate-pulse" />
      </td>
      <td className="px-6 py-4">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full bg-gray-200 animate-pulse`} style={{ animationDelay: `${index * 80}ms` }} />
          <div className="space-y-1.5">
            <div className="w-28 h-3.5 bg-gray-200 rounded animate-pulse" style={{ animationDelay: `${index * 80}ms` }} />
            <div className="w-20 h-2.5 bg-gray-100 rounded animate-pulse" />
          </div>
        </div>
      </td>
      <td className="px-6 py-4"><div className="w-14 h-7 bg-gray-200 rounded-full animate-pulse" /></td>
      <td className="px-6 py-4"><div className="w-8 h-4 bg-gray-200 rounded animate-pulse" /></td>
      <td className="px-6 py-4"><div className="w-12 h-4 bg-gray-200 rounded animate-pulse" /></td>
    </tr>
  );
}

// ── Top 3 Podium ──────────────────────────────────────────────────────────────
function PodiumCard({
  entry,
  position,
}: {
  entry: LeaderboardEntry;
  position: 1 | 2 | 3;
}) {
  const configs = {
    1: {
      order: 'order-2',
      height: 'h-28',
      barColor: 'bg-gradient-to-t from-yellow-500 to-yellow-300',
      ringColor: 'ring-yellow-400',
      iconBg: 'bg-yellow-50',
      textAccent: 'text-yellow-600',
      label: '1st',
      icon: <Crown size={22} className="text-yellow-500" />,
      scale: 'scale-110',
    },
    2: {
      order: 'order-1',
      height: 'h-20',
      barColor: 'bg-gradient-to-t from-slate-400 to-slate-300',
      ringColor: 'ring-slate-400',
      iconBg: 'bg-slate-50',
      textAccent: 'text-slate-500',
      label: '2nd',
      icon: <Medal size={20} className="text-slate-400" />,
      scale: '',
    },
    3: {
      order: 'order-3',
      height: 'h-14',
      barColor: 'bg-gradient-to-t from-amber-500 to-amber-400',
      ringColor: 'ring-amber-400',
      iconBg: 'bg-amber-50',
      textAccent: 'text-amber-600',
      label: '3rd',
      icon: <Medal size={20} className="text-amber-500" />,
      scale: '',
    },
  };

  const c = configs[position];

  return (
    <div className={`flex flex-col items-center gap-2 ${c.order} ${c.scale} transition-transform`}>
      {/* Medal icon */}
      <div className={`p-2 rounded-full ${c.iconBg}`}>{c.icon}</div>

      {/* Avatar */}
      <div
        className={`w-14 h-14 rounded-full ring-4 ${c.ringColor} flex items-center justify-center text-white font-bold text-lg
          ${getAvatarColor(entry.userId, entry.rank - 1)}
          ${entry.isCurrentUser ? 'ring-blue-500' : ''}`}
      >
        {getInitials(entry.name)}
      </div>

      {/* Name */}
      <div className="text-center">
        <p className={`text-sm font-semibold text-gray-800 truncate max-w-[90px] ${entry.isCurrentUser ? 'text-blue-600' : ''}`}>
          {entry.name}
          {entry.isCurrentUser && ' ✦'}
        </p>
        <p className={`text-xs ${c.textAccent} font-medium`}>{entry.avgScore}% avg</p>
      </div>

      {/* Podium bar */}
      <div className={`w-24 ${c.height} ${c.barColor} rounded-t-lg flex items-center justify-center shadow-inner`}>
        <span className="text-white font-black text-xl">{c.label}</span>
      </div>
    </div>
  );
}

type FilterTab = 'all' | 'top10' | 'top50';

// ── Main Component ────────────────────────────────────────────────────────────
export function Leaderboard({ user }: LeaderboardProps) {
  const [data, setData] = useState<LeaderboardEntry[]>([]);
  const [myRank, setMyRank] = useState<LeaderboardResponse['myRank']>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const uid = user?.user_id ?? user?.id ?? user?.userId;

  const fetchLeaderboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/leaderboard', { params: { limit: 50 } }) as any;
      const entries: LeaderboardEntry[] = Array.isArray(res?.data) ? res.data : [];

      // Mark current user
      const marked = entries.map((e) => ({
        ...e,
        isCurrentUser: uid != null && String(e.userId) === String(uid),
      }));

      setData(marked);
      setMyRank(res?.myRank ?? null);
      setLastUpdated(new Date());
    } catch (err: any) {
      // Graceful fallback – hiển thị error nhưng không crash
      setError(err?.response?.data?.message || err?.message || 'Failed to load leaderboard.');
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [uid]);

  useEffect(() => {
    fetchLeaderboard();
  }, [fetchLeaderboard]);

  // Client-side filter
  const displayed = (() => {
    if (filter === 'top10') return data.slice(0, 10);
    if (filter === 'top50') return data.slice(0, 50);
    return data;
  })();

  const top3 = data.slice(0, 3);

  // If current user is not in top entries, get self info from myRank
  const selfEntry = data.find((e) => e.isCurrentUser);
  const displayRank = selfEntry?.rank ?? myRank?.rank;
  const displayAvg = selfEntry?.avgScore ?? myRank?.avgScore;
  const displayAttempts = selfEntry?.totalAttempts ?? myRank?.totalAttempts;

  // Platform stats
  const platformAvg =
    data.length > 0
      ? Math.round(data.reduce((sum, e) => sum + e.avgScore, 0) / data.length)
      : null;

  const tabs: { id: FilterTab; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'top10', label: 'Top 10' },
    { id: 'top50', label: 'Top 50' },
  ];

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="flex items-center gap-2 mb-1">
            <Trophy className="text-yellow-500" size={26} />
            Leaderboard
          </h2>
          {lastUpdated && (
            <p className="text-gray-400 text-xs">
              Updated {lastUpdated.toLocaleTimeString()}
            </p>
          )}
        </div>
        <button
          onClick={fetchLeaderboard}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-white border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* ── Your Rank Hero Card ── */}
      <div
        className="relative overflow-hidden rounded-2xl p-6 text-white"
        style={{
          background: 'linear-gradient(135deg, #1d4ed8 0%, #4f46e5 50%, #7c3aed 100%)',
        }}
      >
        {/* Decorative circles */}
        <div className="absolute -top-8 -right-8 w-40 h-40 bg-white/10 rounded-full" />
        <div className="absolute -bottom-6 -left-4 w-28 h-28 bg-white/10 rounded-full" />

        <div className="relative flex items-center justify-between flex-wrap gap-4">
          <div>
            <p className="text-blue-100 text-sm mb-2">Your Current Rank</p>
            {loading ? (
              <div className="flex items-center gap-4">
                <div className="w-20 h-10 bg-white/20 rounded-lg animate-pulse" />
              </div>
            ) : displayRank != null ? (
              <div className="flex items-center gap-4">
                <h1 className="text-5xl font-black">#{displayRank}</h1>
                <div className="space-y-0.5">
                  {displayAvg != null && (
                    <p className="text-xl font-semibold">{displayAvg}% avg score</p>
                  )}
                  {displayAttempts != null && (
                    <p className="text-blue-200 text-sm">{displayAttempts} quiz{displayAttempts !== 1 ? 'zes' : ''} completed</p>
                  )}
                </div>
              </div>
            ) : (
              <div>
                <p className="text-2xl font-bold">Not ranked yet</p>
                <p className="text-blue-200 text-sm mt-1">
                  Complete quizzes to appear on the leaderboard
                </p>
              </div>
            )}
          </div>

          <div className="bg-white/20 backdrop-blur-sm p-4 rounded-xl">
            <Award size={52} />
          </div>
        </div>
      </div>

      {/* ── Platform Stats ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <div className="flex items-center gap-3 mb-2">
            <div className="bg-blue-100 text-blue-600 p-2.5 rounded-lg">
              <Users size={20} />
            </div>
            <div>
              <p className="text-gray-500 text-sm">Total Participants</p>
              <p className="text-2xl font-bold text-gray-900">
                {loading ? <span className="inline-block w-10 h-6 bg-gray-200 rounded animate-pulse" /> : data.length}
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <div className="flex items-center gap-3 mb-2">
            <div className="bg-purple-100 text-purple-600 p-2.5 rounded-lg">
              <Target size={20} />
            </div>
            <div>
              <p className="text-gray-500 text-sm">Platform Avg Score</p>
              <p className="text-2xl font-bold text-gray-900">
                {loading
                  ? <span className="inline-block w-10 h-6 bg-gray-200 rounded animate-pulse" />
                  : platformAvg != null
                  ? `${platformAvg}%`
                  : '—'}
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <div className="flex items-center gap-3 mb-2">
            <div className="bg-emerald-100 text-emerald-600 p-2.5 rounded-lg">
              <TrendingUp size={20} />
            </div>
            <div>
              <p className="text-gray-500 text-sm">Your Quizzes Done</p>
              <p className="text-2xl font-bold text-gray-900">
                {loading
                  ? <span className="inline-block w-10 h-6 bg-gray-200 rounded animate-pulse" />
                  : displayAttempts != null
                  ? displayAttempts
                  : '—'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Error State ── */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-5 flex items-start gap-4">
          <div className="text-red-400 mt-0.5">⚠️</div>
          <div className="flex-1">
            <p className="text-red-700 font-medium mb-1">Could not load leaderboard</p>
            <p className="text-red-500 text-sm">{error}</p>
          </div>
          <button
            onClick={fetchLeaderboard}
            className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Top 3 Podium ── */}
      {!loading && !error && top3.length >= 3 && (
        <div className="bg-gradient-to-b from-slate-50 to-white border border-gray-100 rounded-2xl p-8 shadow-sm">
          <h3 className="text-center mb-6 text-gray-600">🏆 Top Performers</h3>
          <div className="flex items-end justify-center gap-4">
            <PodiumCard entry={top3[1]} position={2} />
            <PodiumCard entry={top3[0]} position={1} />
            <PodiumCard entry={top3[2]} position={3} />
          </div>
        </div>
      )}

      {/* ── Full Leaderboard Table ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {/* Table Header + Filter Tabs */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 flex-wrap gap-3">
          <h3>Rankings</h3>
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
                  filter === tab.id
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Rank</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Student</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Avg Score</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Quizzes</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Best</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading
                ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} index={i} />)
                : displayed.length === 0 && !error
                ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-16 text-center text-gray-400">
                      <Trophy size={40} className="mx-auto mb-3 text-gray-200" />
                      <p className="text-lg font-medium text-gray-400">No rankings yet</p>
                      <p className="text-sm">Complete quizzes to appear on the leaderboard!</p>
                    </td>
                  </tr>
                )
                : displayed.map((entry, idx) => (
                  <tr
                    key={`${entry.userId}-${entry.rank}`}
                    className={`transition-colors ${
                      entry.isCurrentUser
                        ? 'bg-blue-50 hover:bg-blue-100/60'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    {/* Rank */}
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <RankIcon rank={entry.rank} />
                        <RankBadge rank={entry.rank} />
                      </div>
                    </td>

                    {/* Student */}
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0
                            ${getAvatarColor(entry.userId, idx)}`}
                        >
                          {getInitials(entry.name)}
                        </div>
                        <div>
                          <p className={`font-medium text-sm ${entry.isCurrentUser ? 'text-blue-600' : 'text-gray-900'}`}>
                            {entry.name || 'Anonymous'}
                            {entry.isCurrentUser && (
                              <span className="ml-1.5 px-1.5 py-0.5 bg-blue-100 text-blue-600 text-xs rounded-full">You</span>
                            )}
                          </p>
                          {entry.email && (
                            <p className="text-xs text-gray-400">{entry.email}</p>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Avg Score */}
                    <td className="px-6 py-4">
                      <ScoreBadge score={entry.avgScore} />
                    </td>

                    {/* Total Quizzes */}
                    <td className="px-6 py-4 text-gray-700 text-sm font-medium">
                      {entry.totalAttempts}
                    </td>

                    {/* Best Score */}
                    <td className="px-6 py-4">
                      <span className="text-gray-700 text-sm font-medium">
                        {entry.bestScore != null ? `${entry.bestScore}%` : '—'}
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        {!loading && displayed.length > 0 && (
          <div className="px-6 py-4 border-t border-gray-50 text-center text-gray-400 text-xs">
            Showing {displayed.length} of {data.length} participants · Rankings updated daily
          </div>
        )}
      </div>
    </div>
  );
}
