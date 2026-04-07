import { useState } from 'react';
import { Login } from '../app/pages/Login';
import { Register } from '../app/pages/Register';
import { InstructorDashboard } from '../app/pages/lecturer/InstructorDashboard';
import { StudentDashboard } from '../app/pages/student/StudentDashboard';
import { NotificationProvider } from '../app/pages/NotificationContext';

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [userRole, setUserRole] = useState<'instructor' | 'student' | null>(null);
  const [userData, setUserData] = useState<any>(null);

  const handleLogin = (role: 'instructor' | 'student', data: any) => {
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
      ) : userRole === 'instructor' ? (
        <InstructorDashboard user={userData} onLogout={handleLogout} />
      ) : (
        <StudentDashboard user={userData} onLogout={handleLogout} />
      )}
    </NotificationProvider>
  );
}
