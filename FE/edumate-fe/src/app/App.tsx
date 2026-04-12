import { useState } from 'react';
import { Login } from '../app/pages/Login';
import { Register } from '../app/pages/Register';
import { InstructorDashboard } from '../app/pages/lecturer/InstructorDashboard';
import { StudentDashboard } from '../app/pages/student/StudentDashboard';
import { AdminDashboard } from '../app/pages/AdminDashboard';
import { NotificationProvider } from '../app/pages/NotificationContext';

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(true);
  const [showRegister, setShowRegister] = useState(false);
  const [userRole, setUserRole] = useState<'instructor' | 'student' | 'admin' | null>('student');
  const [userData, setUserData] = useState<any>({
    id: 14,
    user_id: 14,
    name: 'Demo Student',
    full_name: 'Demo Student',
    email: 'demo@dtu.edu.vn',
    role: 'STUDENT',
    user_code: 'SV0001',
  });

  const handleLogin = (role: 'instructor' | 'student' | 'admin', data: any) => {
    setUserRole(role);
    setUserData(data);
    setIsLoggedIn(true);
    setShowRegister(false);
  };

  const handleRegister = (role: 'instructor' | 'student', data: any) => {
    setUserRole(role);
    setUserData(data);
    setIsLoggedIn(true);
    setShowRegister(false);
  };

  const handleLogout = () => {
    setIsLoggedIn(false);
    setUserRole(null);
    setUserData(null);
    setShowRegister(false);
    localStorage.removeItem('edumate_token');
    localStorage.removeItem('edumate_user');
  };

  return (
    <NotificationProvider>
      {!isLoggedIn ? (
        showRegister ? (
          <Register
            onRegister={handleRegister}
            onBackToLogin={() => setShowRegister(false)}
          />
        ) : (
          <Login
            onLogin={handleLogin}
            onGoToRegister={() => setShowRegister(true)}
          />
        )
      ) : userRole === 'admin' ? (
        <AdminDashboard user={userData} onLogout={handleLogout} />
      ) : userRole === 'instructor' ? (
        <InstructorDashboard
          user={userData}
          onLogout={handleLogout}
          onUserUpdate={(u) => setUserData(u)}
        />
      ) : (
        <StudentDashboard
          user={userData}
          onLogout={handleLogout}
          onUserUpdate={(u) => setUserData(u)}
        />
      )}
    </NotificationProvider>
  );
}