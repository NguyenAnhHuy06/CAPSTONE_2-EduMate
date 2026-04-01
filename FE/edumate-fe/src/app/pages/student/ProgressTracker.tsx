import { TrendingUp, CheckCircle, Clock, Target } from 'lucide-react';

interface ProgressTrackerProps {
  user: any;
}

export function ProgressTracker({ user }: ProgressTrackerProps) {
  const courses = [
    {
      name: 'Data Structures',
      code: 'CS201',
      progress: 75,
      totalMaterials: 20,
      completedMaterials: 15,
      quizScore: 85,
      lastActivity: '2 hours ago',
    },
    {
      name: 'Algorithms',
      code: 'CS301',
      progress: 60,
      totalMaterials: 25,
      completedMaterials: 15,
      quizScore: 78,
      lastActivity: '1 day ago',
    },
    {
      name: 'Database Systems',
      code: 'DB201',
      progress: 85,
      totalMaterials: 18,
      completedMaterials: 15,
      quizScore: 92,
      lastActivity: '3 hours ago',
    },
    {
      name: 'Web Development',
      code: 'WEB102',
      progress: 45,
      totalMaterials: 30,
      completedMaterials: 13,
      quizScore: 72,
      lastActivity: '5 days ago',
    },
    {
      name: 'Machine Learning',
      code: 'AI401',
      progress: 30,
      totalMaterials: 35,
      completedMaterials: 10,
      quizScore: 68,
      lastActivity: '1 week ago',
    },
  ];

  const overallStats = [
    {
      label: 'Overall Progress',
      value: '59%',
      icon: TrendingUp,
      color: 'bg-blue-100 text-blue-600',
    },
    {
      label: 'Completed Materials',
      value: '68/128',
      icon: CheckCircle,
      color: 'bg-green-100 text-green-600',
    },
    {
      label: 'Study Hours',
      value: '124h',
      icon: Clock,
      color: 'bg-purple-100 text-purple-600',
    },
    {
      label: 'Average Score',
      value: '79%',
      icon: Target,
      color: 'bg-orange-100 text-orange-600',
    },
  ];

  return (
    <div>
      <h2 className="mb-6">Learning Progress</h2>

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
        <h3 className="mb-6">Course Progress Details</h3>

        <div className="space-y-6">
          {courses.map((course) => (
            <div key={course.code} className="pb-6 border-b border-gray-100 last:border-0 last:pb-0">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h4>{course.name}</h4>
                    <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded text-xs">
                      {course.code}
                    </span>
                  </div>
                  <div className="flex items-center gap-6 text-gray-600">
                    <span>
                      {course.completedMaterials} of {course.totalMaterials} materials completed
                    </span>
                    <span>•</span>
                    <span>Quiz Average: {course.quizScore}%</span>
                    <span>•</span>
                    <span className="text-gray-500">Last activity: {course.lastActivity}</span>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-gray-900">{course.progress}%</p>
                  <p className="text-gray-500">Complete</p>
                </div>
              </div>

              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className={`h-3 rounded-full transition-all ${
                    course.progress >= 80
                      ? 'bg-green-600'
                      : course.progress >= 50
                      ? 'bg-blue-600'
                      : 'bg-orange-600'
                  }`}
                  style={{ width: `${course.progress}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Study Streak */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mt-6">
        <h3 className="mb-4">Study Streak</h3>
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-gray-600 mb-1">Current Streak</p>
            <h2 className="text-blue-600">7 Days</h2>
          </div>
          <div>
            <p className="text-gray-600 mb-1">Longest Streak</p>
            <h2 className="text-gray-900">14 Days</h2>
          </div>
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 7 }).map((_, idx) => (
            <div
              key={idx}
              className="flex-1 h-12 bg-blue-600 rounded"
              title={`Day ${idx + 1}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
