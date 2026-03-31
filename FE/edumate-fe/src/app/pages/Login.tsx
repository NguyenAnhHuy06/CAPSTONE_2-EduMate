import { useState } from 'react';
import { BookOpen } from 'lucide-react';

interface LoginProps {
  onLogin: (role: 'instructor' | 'student', userData: any) => void;
  onGoToRegister: () => void;
}

export function Login({ onLogin, onGoToRegister }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Mock login - automatically determine role based on email
    // In a real app, this would be determined by the backend based on account data
    const isInstructor = email.includes('instructor') || email.includes('lecturer') || email.includes('prof') || email.includes('dr');
    const role: 'instructor' | 'student' = isInstructor ? 'instructor' : 'student';

    const userData = {
      id: Math.random().toString(36).substr(2, 9),
      name: role === 'instructor' ? 'Dr. Sarah Johnson' : 'Alex Smith',
      email: email || `${role}@edumate.com`,
      role,
    };

    onLogin(role, userData);
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
              className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Sign In
            </button>
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

          <div className="mt-4 text-center text-gray-500">
            <p className="text-sm">Demo: Use any email to login. Emails with "instructor", "lecturer", "prof", or "dr" will login as Instructor.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
