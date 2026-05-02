import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { Login } from '../app/pages/Login';
import { Register } from '../app/pages/Register';
import { InstructorDashboard } from '../app/pages/lecturer/InstructorDashboard';
import { StudentDashboard } from '../app/pages/student/StudentDashboard';
import { AdminDashboard } from '../app/pages/AdminDashboard';
import { NotificationProvider } from '../app/pages/NotificationContext';

function LecturerQuizDeepLink({
  user,
  onLogout,
  onUserUpdate,
}: {
  user: any;
  onLogout: () => void;
  onUserUpdate?: (u: any) => void;
}) {
  const { quizId } = useParams();
  const id = Number(quizId);
  const focusId = Number.isFinite(id) && id > 0 ? id : null;
  return (
    <InstructorDashboard
      user={user}
      onLogout={onLogout}
      onUserUpdate={onUserUpdate}
      initialMainTab="quizzes"
      focusQuizId={focusId}
    />
  );
}

export default function App() {
  useEffect(() => {
    const token = localStorage.getItem('edumate_token');
    const rawUser = localStorage.getItem('edumate_user');

    if (!token || !rawUser) return;

    try {
      const user = JSON.parse(rawUser);
      const role: 'instructor' | 'student' | 'admin' =
        String(user?.role || '').toUpperCase() === 'ADMIN'
          ? 'admin'
          : String(user?.role || '').toUpperCase() === 'LECTURER'
            ? 'instructor'
            : 'student';

      setUserRole(role);
      setUserData(user);
      setIsLoggedIn(true);
    } catch {
      localStorage.removeItem('edumate_token');
      localStorage.removeItem('edumate_user');
    }
  }, []);
  
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [userRole, setUserRole] = useState<'instructor' | 'student' | 'admin' | null>(null);
  const [userData, setUserData] = useState<any>(null);

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
      <Routes>
        <Route
          path="/quiz/:quizId"
          element={
            isLoggedIn && userRole === 'instructor' ? (
              <LecturerQuizDeepLink
                user={userData}
                onLogout={handleLogout}
                onUserUpdate={(u) => setUserData(u)}
              />
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="/lecturer/quiz/:quizId"
          element={
            isLoggedIn && userRole === 'instructor' ? (
              <LecturerQuizDeepLink
                user={userData}
                onLogout={handleLogout}
                onUserUpdate={(u) => setUserData(u)}
              />
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="*"
          element={
            !isLoggedIn ? (
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
            )
          }
        />
      </Routes>
    </NotificationProvider>
  );
}