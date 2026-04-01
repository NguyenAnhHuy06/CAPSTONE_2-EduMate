import { User, Mail, Calendar, BookOpen, Award } from 'lucide-react';

interface ProfileProps {
    user: any;
}

export function Profile({ user }: ProfileProps) {
    const profileData = {
        fullName: user.name,
        email: user.email,
        role: user.role === 'instructor' ? 'Instructor' : 'Student',
        joinDate: '2025-09-15',
        department: user.role === 'instructor' ? 'Computer Science' : 'Computer Science & Engineering',
        studentId: user.role === 'student' ? 'CS2024-1234' : undefined,
        employeeId: user.role === 'instructor' ? 'INS-2023-567' : undefined,
    };

    const stats = user.role === 'instructor'
        ? [
            { label: 'Materials Uploaded', value: '24' },
            { label: 'Quizzes Created', value: '15' },
            { label: 'Total Students Reached', value: '342' },
            { label: 'High Credibility Badges', value: '15' },
        ]
        : [
            { label: 'Materials Studied', value: '42' },
            { label: 'Quizzes Completed', value: '28' },
            { label: 'Average Score', value: '79%' },
            { label: 'Current Ranking', value: '#12' },
        ];

    return (
        <div className="max-w-4xl">
            <h2 className="mb-6">Profile</h2>

            {/* Profile Card */}
            <div className="bg-white rounded-lg border border-gray-200 p-8 mb-6">
                <div className="flex items-start gap-6 mb-8">
                    <div className="w-24 h-24 bg-blue-600 text-white rounded-full flex items-center justify-center text-3xl">
                        {profileData.fullName
                            .split(' ')
                            .filter(Boolean)
                            .map((n: string) => n[0])
                            .join('')}
                    </div>
                    <div className="flex-1">
                        <h2 className="mb-2">{profileData.fullName}</h2>
                        <p className="text-blue-600 mb-4">{profileData.role}</p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="flex items-center gap-2 text-gray-600">
                                <Mail size={18} />
                                <span>{profileData.email}</span>
                            </div>
                            <div className="flex items-center gap-2 text-gray-600">
                                <Calendar size={18} />
                                <span>Joined {profileData.joinDate}</span>
                            </div>
                            <div className="flex items-center gap-2 text-gray-600">
                                <BookOpen size={18} />
                                <span>{profileData.department}</span>
                            </div>
                            <div className="flex items-center gap-2 text-gray-600">
                                <User size={18} />
                                <span>
                                    {user.role === 'instructor' ? `ID: ${profileData.employeeId}` : `ID: ${profileData.studentId}`}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-6 border-t border-gray-200">
                    {stats.map((stat) => (
                        <div key={stat.label} className="text-center">
                            <h3 className="text-blue-600 mb-1">{stat.value}</h3>
                            <p className="text-gray-600">{stat.label}</p>
                        </div>
                    ))}
                </div>
            </div>

            {/* Edit Profile Form */}
            <div className="bg-white rounded-lg border border-gray-200 p-6">
                <h3 className="mb-6">Edit Profile</h3>

                <form className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label htmlFor="fullName" className="block mb-1 font-medium">
                                Họ và tên
                            </label>

                            <input
                                id="fullName"
                                type="text"
                                defaultValue={profileData.fullName}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                            />
                        </div>
                        <div>
                            <label htmlFor="email" className="block mb-1 font-medium">
                                Email
                            </label>
                            <input
                                id="email"
                                type="email"
                                defaultValue={profileData.email}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                            />
                        </div>
                    </div>

                    <div>
                        <label htmlFor="department" className="block mb-1 font-medium">
                            Department
                        </label>
                        <input
                            id="department"
                            type="text"
                            defaultValue={profileData.department}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                    </div>

                    <div>
                        <label className="block text-gray-700 mb-2">
                            Bio
                        </label>
                        <textarea
                            rows={4}
                            placeholder={
                                user.role === 'instructor'
                                    ? 'Tell students about yourself and your teaching philosophy...'
                                    : 'Tell others about your learning interests and goals...'
                            }
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                    </div>

                    <div className="flex gap-3">
                        <button
                            type="submit"
                            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                        >
                            Save Changes
                        </button>
                        <button
                            type="button"
                            className="px-6 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </form>
            </div>

            {/* Achievements Section (for students) */}
            {user.role === 'student' && (
                <div className="bg-white rounded-lg border border-gray-200 p-6 mt-6">
                    <h3 className="mb-6">Achievements</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {[
                            { name: 'First Quiz', icon: Award, earned: true },
                            { name: '7 Day Streak', icon: Award, earned: true },
                            { name: 'Top 20 Rank', icon: Award, earned: true },
                            { name: 'Quiz Master', icon: Award, earned: false },
                        ].map((achievement) => (
                            <div
                                key={achievement.name}
                                className={`p-4 rounded-lg border-2 text-center ${achievement.earned
                                    ? 'border-blue-600 bg-blue-50'
                                    : 'border-gray-200 bg-gray-50 opacity-50'
                                    }`}
                            >
                                <achievement.icon
                                    className={`mx-auto mb-2 ${achievement.earned ? 'text-blue-600' : 'text-gray-400'
                                        }`}
                                    size={32}
                                />
                                <p className={achievement.earned ? 'text-gray-900' : 'text-gray-500'}>
                                    {achievement.name}
                                </p>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
