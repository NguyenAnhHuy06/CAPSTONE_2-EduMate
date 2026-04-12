import { useState } from 'react';
import { BookOpen, Upload, FileText, TrendingUp, Award, Brain, User, Home, Target, Trophy, ClipboardList } from 'lucide-react';
import { Sidebar } from '../Sidebar';
import { DocumentLibrary } from '../DocumentLibrary';
import { UploadDocument } from '../UploadDocument';
import { Profile } from '../Profile';
import { Leaderboard } from './Leaderboard';
import { ProgressTracker } from '../student/ProgressTracker';
import { StudentQuizSection } from '../student/StudentQuizSection';

interface StudentDashboardProps {
    user: any;
    onLogout: () => void;
    onUserUpdate?: (user: any) => void;
}

export function StudentDashboard({ user, onLogout, onUserUpdate }: StudentDashboardProps) {
    const [activeTab, setActiveTab] = useState<'dashboard' | 'documents' | 'upload' | 'quizzes' | 'progress' | 'leaderboard' | 'profile'>('dashboard');

    const menuItems = [
        { id: 'dashboard', label: 'Dashboard', icon: Home },
        { id: 'documents', label: 'Documents', icon: FileText },
        { id: 'upload', label: 'Upload', icon: Upload },
        { id: 'quizzes', label: 'Quizzes', icon: ClipboardList },
        { id: 'progress', label: 'Progress', icon: Target },
        { id: 'leaderboard', label: 'Leaderboard', icon: Trophy },
        { id: 'profile', label: 'Profile', icon: User },
    ];

    const stats = [
        { label: 'Materials Studied', value: '42', icon: FileText, color: 'bg-blue-100 text-blue-600' },
        { label: 'Quizzes Completed', value: '28', icon: Brain, color: 'bg-green-100 text-green-600' },
        { label: 'Study Streak', value: '7 days', icon: TrendingUp, color: 'bg-purple-100 text-purple-600' },
        { label: 'Ranking', value: '#12', icon: Award, color: 'bg-orange-100 text-orange-600' },
    ];

    return (
        <div className="flex min-h-screen bg-gray-50">
            {/* Sidebar */}
            <Sidebar
                menuItems={menuItems}
                activeItem={activeTab}
                onMenuItemClick={(id: string) => setActiveTab(id as typeof activeTab)}
                onLogout={onLogout}
                userRole="Student"
                userName={user.name}
                userEmail={user.email}
            />
            {/* Main Content */}
            <div className="flex-1 overflow-auto">
                {/* Top Bar for Desktop User Info */}
                <div className="bg-white border-b border-gray-200 p-4 lg:flex lg:justify-end hidden">
                    <div className="text-right">
                        <p className="text-gray-900">{user.name}</p>
                        <p className="text-gray-500 text-xs">{user.email}</p>
                    </div>
                </div>

                {/* Content Area */}
                <div className="p-4 lg:p-8 mt-16 lg:mt-0">
                    {activeTab === 'dashboard' && (
                        <div>
                            <h2 className="mb-6">My Dashboard</h2>

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

                            {/* Quick Progress Overview */}
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                <div className="bg-white rounded-lg border border-gray-200 p-6">
                                    <h3 className="mb-4">Recent Activity</h3>
                                    <div className="space-y-4">
                                        {[
                                            { action: 'Completed quiz on "Database Design"', time: '1 hour ago', score: '85%' },
                                            { action: 'Studied "Object-Oriented Programming"', time: '3 hours ago' },
                                            { action: 'Created 12 flashcards', time: '1 day ago' },
                                            { action: 'Uploaded "Project Notes"', time: '2 days ago' },
                                        ].map((activity, idx) => (
                                            <div key={idx} className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
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
                                    <div className="space-y-4">
                                        {[
                                            { course: 'Data Structures', progress: 75 },
                                            { course: 'Algorithms', progress: 60 },
                                            { course: 'Database Systems', progress: 85 },
                                            { course: 'Web Development', progress: 45 },
                                        ].map((course) => (
                                            <div key={course.course}>
                                                <div className="flex justify-between mb-2">
                                                    <p className="text-gray-700">{course.course}</p>
                                                    <p className="text-gray-600">{course.progress}%</p>
                                                </div>
                                                <div className="w-full bg-gray-200 rounded-full h-2">
                                                    <div
                                                        className="bg-blue-600 h-2 rounded-full"
                                                        style={{ width: `${course.progress}%` }}
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
                        <DocumentLibrary userRole="student" user={user} />
                    )}

                    {activeTab === 'upload' && (
                        <UploadDocument user={user} userRole="student" onUploadComplete={() => setActiveTab('documents')} />
                    )}

                    {activeTab === 'quizzes' && (
                        <StudentQuizSection user={user} />
                    )}

                    {activeTab === 'progress' && (
                        <ProgressTracker user={user} />
                    )}

                    {activeTab === 'leaderboard' && (
                        <Leaderboard user={user} />
                    )}

                    {activeTab === 'profile' && (
                        <Profile user={user} onUserUpdate={onUserUpdate} />
                    )}
                </div>
            </div>
        </div>
    );
}
