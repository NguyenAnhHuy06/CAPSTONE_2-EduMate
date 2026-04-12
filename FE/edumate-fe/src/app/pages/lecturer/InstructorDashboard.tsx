import { useState } from 'react';
import { BookOpen, Upload, FileText, MessageSquare, TrendingUp, User, Home, ClipboardList } from 'lucide-react';
import { Sidebar } from '../Sidebar';
import { DocumentLibrary } from '../DocumentLibrary';
import { UploadDocument } from '../UploadDocument';
import { Profile } from '../Profile';
import { QuizManagement } from '../lecturer/QuizManagement';

interface InstructorDashboardProps {
  user: any;
  onLogout: () => void;
}

export function InstructorDashboard({ user, onLogout }: InstructorDashboardProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'documents' | 'upload' | 'quizzes' | 'profile'>('overview');

  const menuItems = [
    { id: 'overview', label: 'Overview', icon: Home },
    { id: 'documents', label: 'Documents', icon: FileText },
    { id: 'upload', label: 'Upload', icon: Upload },
    { id: 'quizzes', label: 'Quizzes', icon: ClipboardList },
    { id: 'profile', label: 'Profile', icon: User },
  ];

  const stats = [
    { label: 'Materials Uploaded', value: '24', icon: FileText, color: 'bg-blue-100 text-blue-600' },
    { label: 'Total Views', value: '1,234', icon: TrendingUp, color: 'bg-green-100 text-green-600' },
    { label: 'Comments Received', value: '87', icon: MessageSquare, color: 'bg-purple-100 text-purple-600' },
    { label: 'Quizzes Created', value: '15', icon: BookOpen, color: 'bg-orange-100 text-orange-600' },
  ];

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
                  {[
                    { action: 'New comment on "Introduction to Algorithms"', time: '2 hours ago' },
                    { action: 'Quiz completed by 15 students', time: '5 hours ago' },
                    { action: 'Uploaded "Data Structures - Week 3"', time: '1 day ago' },
                    { action: 'Document downloaded 23 times', time: '2 days ago' },
                  ].map((activity, idx) => (
                    <div key={idx} className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
                      <p className="text-gray-700">{activity.action}</p>
                      <p className="text-gray-500 text-sm">{activity.time}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'documents' && (
            <DocumentLibrary userRole="instructor" user={user} />
          )}

          {activeTab === 'upload' && (
            <UploadDocument userRole="instructor" onUploadComplete={() => setActiveTab('documents')} />
          )}

          {activeTab === 'quizzes' && (
            <QuizManagement user={user} />
          )}

          {activeTab === 'profile' && (
            <Profile user={user} />
          )}
        </div>
      </div>
    </div>
  );
}
