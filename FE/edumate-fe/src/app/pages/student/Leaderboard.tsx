import { Award, TrendingUp, Medal } from 'lucide-react';

interface LeaderboardProps {
  user: any;
}

export function Leaderboard({ user }: LeaderboardProps) {
  const leaderboardData = [
    {
      rank: 1,
      name: 'Emma Wilson',
      points: 2850,
      quizzesCompleted: 45,
      avgScore: 94,
      avatar: 'EW',
    },
    {
      rank: 2,
      name: 'Michael Chen',
      points: 2720,
      quizzesCompleted: 42,
      avgScore: 92,
      avatar: 'MC',
    },
    {
      rank: 3,
      name: 'Sarah Johnson',
      points: 2680,
      quizzesCompleted: 40,
      avgScore: 91,
      avatar: 'SJ',
    },
    {
      rank: 4,
      name: 'David Park',
      points: 2540,
      quizzesCompleted: 38,
      avgScore: 89,
      avatar: 'DP',
    },
    {
      rank: 5,
      name: 'Lisa Anderson',
      points: 2490,
      quizzesCompleted: 37,
      avgScore: 88,
      avatar: 'LA',
    },
    {
      rank: 6,
      name: 'James Taylor',
      points: 2430,
      quizzesCompleted: 36,
      avgScore: 87,
      avatar: 'JT',
    },
    {
      rank: 7,
      name: 'Maria Garcia',
      points: 2380,
      quizzesCompleted: 35,
      avgScore: 86,
      avatar: 'MG',
    },
    {
      rank: 8,
      name: 'Robert Lee',
      points: 2340,
      quizzesCompleted: 34,
      avgScore: 85,
      avatar: 'RL',
    },
    {
      rank: 9,
      name: 'Jennifer White',
      points: 2290,
      quizzesCompleted: 33,
      avgScore: 84,
      avatar: 'JW',
    },
    {
      rank: 10,
      name: 'Thomas Brown',
      points: 2250,
      quizzesCompleted: 32,
      avgScore: 83,
      avatar: 'TB',
    },
    {
      rank: 11,
      name: 'Patricia Davis',
      points: 2190,
      quizzesCompleted: 31,
      avgScore: 82,
      avatar: 'PD',
    },
    {
      rank: 12,
      name: user.name,
      points: 2150,
      quizzesCompleted: 28,
      avgScore: 79,
      avatar: user.name.split(' ').map((n: string) => n[0]).join(''),
      isCurrentUser: true,
    },
  ];

  const getRankColor = (rank: number) => {
    if (rank === 1) return 'bg-yellow-100 text-yellow-700';
    if (rank === 2) return 'bg-gray-200 text-gray-700';
    if (rank === 3) return 'bg-orange-100 text-orange-700';
    return 'bg-blue-100 text-blue-700';
  };

  const getRankIcon = (rank: number) => {
    if (rank === 1) return <Medal className="text-yellow-600" size={24} />;
    if (rank === 2) return <Medal className="text-gray-600" size={24} />;
    if (rank === 3) return <Medal className="text-orange-600" size={24} />;
    return null;
  };

  return (
    <div>
      <h2 className="mb-6">Leaderboard</h2>

      {/* Your Rank Card */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-lg p-6 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="mb-2 opacity-90">Your Current Rank</p>
            <div className="flex items-center gap-4">
              <h1>#12</h1>
              <div>
                <p>2,150 points</p>
                <p className="opacity-90">28 quizzes completed</p>
              </div>
            </div>
          </div>
          <div className="bg-white/20 p-4 rounded-lg">
            <Award size={48} />
          </div>
        </div>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <div className="bg-white p-6 rounded-lg border border-gray-200">
          <div className="flex items-center gap-3 mb-3">
            <div className="bg-blue-100 text-blue-600 p-3 rounded-lg">
              <TrendingUp size={24} />
            </div>
            <div>
              <p className="text-gray-600">Weekly Progress</p>
              <h3 className="text-green-600">+250 pts</h3>
            </div>
          </div>
          <p className="text-gray-500">Keep up the great work!</p>
        </div>

        <div className="bg-white p-6 rounded-lg border border-gray-200">
          <div className="flex items-center gap-3 mb-3">
            <div className="bg-purple-100 text-purple-600 p-3 rounded-lg">
              <Award size={24} />
            </div>
            <div>
              <p className="text-gray-600">Average Score</p>
              <h3>79%</h3>
            </div>
          </div>
          <p className="text-gray-500">Above platform average</p>
        </div>

        <div className="bg-white p-6 rounded-lg border border-gray-200">
          <div className="flex items-center gap-3 mb-3">
            <div className="bg-orange-100 text-orange-600 p-3 rounded-lg">
              <Medal size={24} />
            </div>
            <div>
              <p className="text-gray-600">Rank Change</p>
              <h3 className="text-green-600">+3</h3>
            </div>
          </div>
          <p className="text-gray-500">From last week</p>
        </div>
      </div>

      {/* Leaderboard Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-gray-700">Rank</th>
                <th className="px-6 py-3 text-left text-gray-700">Student</th>
                <th className="px-6 py-3 text-left text-gray-700">Points</th>
                <th className="px-6 py-3 text-left text-gray-700">Quizzes</th>
                <th className="px-6 py-3 text-left text-gray-700">Avg Score</th>
              </tr>
            </thead>
            <tbody>
              {leaderboardData.map((entry) => (
                <tr
                  key={entry.rank}
                  className={`border-b border-gray-100 last:border-0 transition-colors ${
                    entry.isCurrentUser ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      {getRankIcon(entry.rank)}
                      <span className={`px-3 py-1 rounded ${getRankColor(entry.rank)}`}>
                        #{entry.rank}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-blue-600 text-white rounded-full flex items-center justify-center">
                        {entry.avatar}
                      </div>
                      <span className={entry.isCurrentUser ? 'text-blue-600' : 'text-gray-900'}>
                        {entry.name}
                        {entry.isCurrentUser && ' (You)'}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-900">
                    {entry.points.toLocaleString()} pts
                  </td>
                  <td className="px-6 py-4 text-gray-900">{entry.quizzesCompleted}</td>
                  <td className="px-6 py-4">
                    <span className={`px-3 py-1 rounded ${
                      entry.avgScore >= 90
                        ? 'bg-green-100 text-green-700'
                        : entry.avgScore >= 80
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-orange-100 text-orange-700'
                    }`}>
                      {entry.avgScore}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-6 text-center text-gray-500">
        <p>Rankings updated daily at midnight</p>
      </div>
    </div>
  );
}
