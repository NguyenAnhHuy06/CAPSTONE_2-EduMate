import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import api from '../../services/api';

interface LoginProps {
  onLogin: (role: 'instructor' | 'student', userData: any) => void;
  onGoToRegister: () => void;
}

export function Login({ onLogin, onGoToRegister }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res: any = await api.post('/auth/login', { email, password });
      const token = res?.token || res?.data?.token || null;
      const user = res?.user || res?.data?.user || null;
      if (!res?.success || !token || !user) {
        setError('Unable to sign in. Please try again.');
        return;
      }
      const role: 'instructor' | 'student' =
        String(user?.role || '').toUpperCase() === 'LECTURER' ? 'instructor' : 'student';
      localStorage.setItem('edumate_token', token);
      localStorage.setItem('edumate_user', JSON.stringify(user));
      setError('');
      onLogin(role, user);
    } catch (err: any) {
      const apiMessage = String(err?.response?.data?.message || '').trim().toLowerCase();
      if (apiMessage === 'incorrect password.') {
        setError('Incorrect password.');
      } else {
        setError('Unable to sign in. Please check your credentials.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center mb-4">
            <div className="bg-blue-600 text-white p-3 rounded-lg">
              <BookOpen size={32} />
            </div>
          </div>
          <h1 className="text-blue-600 mb-2">EduMate</h1>
          <p className="text-gray-600">Share and Learn Together</p>
        </div>

        {/* Login Card */}
        <div className="bg-white border border-gray-200 rounded-lg p-8 shadow-sm">
          <h2 className="text-center mb-6">Sign In</h2>

          {/* Login Form */}
          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <label className="block text-gray-700 mb-2">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                placeholder="Enter your email"
                required
              />
            </div>

            <div className="mb-6">
              <label className="block text-gray-700 mb-2">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                placeholder="Enter your password"
                required
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition-colors"
            >
              {submitting ? 'Signing in...' : 'Sign In'}
            </button>
            {error && <p className="text-red-500 text-sm mt-3">{error}</p>}
          </form>

          <div className="mt-6 text-center">
            <p className="text-gray-600">
              Don't have an account?{' '}
              <button
                onClick={onGoToRegister}
                className="text-blue-600 hover:text-blue-700"
              >
                Register
              </button>
            </p>
          </div>

        </div>
      </div>
    </div>
  );
}
