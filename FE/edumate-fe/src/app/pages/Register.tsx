import { useState } from 'react';
import { BookOpen, User, GraduationCap } from 'lucide-react';
import api from '../../services/api';

interface RegisterProps {
  onRegister: (role: 'instructor' | 'student', userData: any) => void;
  onBackToLogin: () => void;
}

export function Register({ onRegister, onBackToLogin }: RegisterProps) {
  const [role, setRole] = useState<'instructor' | 'student'>('student');
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    id: '',
    password: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState<'form' | 'otp'>('form');
  const [otpCode, setOtpCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    // Required fields validation
    if (!formData.fullName.trim()) {
      newErrors.fullName = 'Full Name is required';
    }

    if (!formData.email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Please enter a valid email address';
    }

    if (!formData.id.trim()) {
      newErrors.id = `${role === 'instructor' ? 'Lecturer' : 'Student'} ID is required`;
    }

    if (!formData.password) {
      newErrors.password = 'Password is required';
    } else if (formData.password.length < 6) {
      newErrors.password = 'Password must be at least 6 characters';
    }

    if (!formData.confirmPassword) {
      newErrors.confirmPassword = 'Please confirm your password';
    } else if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage('');

    if (step === 'otp') {
      setSubmitting(true);
      try {
        const verifyRes: any = await api.post('/auth/verify-otp', {
          email: formData.email,
          otp_code: otpCode,
        });
        if (!verifyRes?.success) {
          setErrors({ otpCode: 'OTP verification failed.' });
          return;
        }
        const user = verifyRes?.data?.user || {
          user_id: formData.id,
          full_name: formData.fullName,
          email: formData.email,
          role: role === 'instructor' ? 'LECTURER' : 'STUDENT',
        };
        const appRole: 'instructor' | 'student' = role;
        onRegister(appRole, user);
      } catch (err: any) {
        setErrors({ otpCode: String(err?.response?.data?.message || 'OTP verification failed.') });
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!validateForm()) return;

    setSubmitting(true);
    try {
      const res: any = await api.post('/auth/register', {
        full_name: formData.fullName,
        email: formData.email,
        password: formData.password,
        role: role === 'instructor' ? 'LECTURER' : 'STUDENT',
        user_code: formData.id,
      });
      if (!res?.success) {
        setErrors({ email: 'Registration failed.' });
        return;
      }
      setStep('otp');
      setMessage('OTP has been sent. Check server log (dev mode).');
    } catch (err: any) {
      setErrors({ email: String(err?.response?.data?.message || 'Registration failed.') });
    } finally {
      setSubmitting(false);
    }
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData({ ...formData, [field]: value });
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors({ ...errors, [field]: '' });
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
          <p className="text-gray-600">Create Your Account</p>
        </div>

        {/* Register Card */}
        <div className="bg-white border border-gray-200 rounded-lg p-8 shadow-sm">
          <h2 className="text-center mb-6">Register</h2>

          {/* Role Selection */}
          {step === 'form' && (
          <div className="grid grid-cols-2 gap-3 mb-6">
            <button
              type="button"
              onClick={() => setRole('student')}
              className={`p-4 rounded-lg border-2 transition-colors ${
                role === 'student'
                  ? 'border-blue-600 bg-blue-50'
                  : 'border-gray-200 hover:border-blue-300'
              }`}
            >
              <User className={`mx-auto mb-2 ${role === 'student' ? 'text-blue-600' : 'text-gray-400'}`} size={24} />
              <div className={role === 'student' ? 'text-blue-600' : 'text-gray-600'}>
                Student
              </div>
            </button>
            <button
              type="button"
              onClick={() => setRole('instructor')}
              className={`p-4 rounded-lg border-2 transition-colors ${
                role === 'instructor'
                  ? 'border-blue-600 bg-blue-50'
                  : 'border-gray-200 hover:border-blue-300'
              }`}
            >
              <GraduationCap className={`mx-auto mb-2 ${role === 'instructor' ? 'text-blue-600' : 'text-gray-400'}`} size={24} />
              <div className={role === 'instructor' ? 'text-blue-600' : 'text-gray-600'}>
                Instructor
              </div>
            </button>
          </div>
          )}

          {/* Registration Form */}
          <form onSubmit={handleSubmit}>
            {step === 'form' ? (
              <>
            <div className="mb-4">
              <label className="block text-gray-700 mb-2">
                Full Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formData.fullName}
                onChange={(e) => handleInputChange('fullName', e.target.value)}
                className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                  errors.fullName ? 'border-red-500' : 'border-gray-300'
                }`}
                placeholder="Enter your full name"
              />
              {errors.fullName && (
                <p className="text-red-500 text-sm mt-1">{errors.fullName}</p>
              )}
            </div>

            <div className="mb-4">
              <label className="block text-gray-700 mb-2">
                Email <span className="text-red-500">*</span>
              </label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => handleInputChange('email', e.target.value)}
                className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                  errors.email ? 'border-red-500' : 'border-gray-300'
                }`}
                placeholder="Enter your email"
              />
              {errors.email && (
                <p className="text-red-500 text-sm mt-1">{errors.email}</p>
              )}
            </div>

            <div className="mb-4">
              <label className="block text-gray-700 mb-2">
                {role === 'instructor' ? 'Lecturer ID' : 'Student ID'} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formData.id}
                onChange={(e) => handleInputChange('id', e.target.value)}
                className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                  errors.id ? 'border-red-500' : 'border-gray-300'
                }`}
                placeholder={`Enter your ${role === 'instructor' ? 'lecturer' : 'student'} ID`}
              />
              {errors.id && (
                <p className="text-red-500 text-sm mt-1">{errors.id}</p>
              )}
            </div>

            <div className="mb-4">
              <label className="block text-gray-700 mb-2">
                Password <span className="text-red-500">*</span>
              </label>
              <input
                type="password"
                value={formData.password}
                onChange={(e) => handleInputChange('password', e.target.value)}
                className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                  errors.password ? 'border-red-500' : 'border-gray-300'
                }`}
                placeholder="Enter your password"
              />
              {errors.password && (
                <p className="text-red-500 text-sm mt-1">{errors.password}</p>
              )}
            </div>

            <div className="mb-6">
              <label className="block text-gray-700 mb-2">
                Confirm Password <span className="text-red-500">*</span>
              </label>
              <input
                type="password"
                value={formData.confirmPassword}
                onChange={(e) => handleInputChange('confirmPassword', e.target.value)}
                className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                  errors.confirmPassword ? 'border-red-500' : 'border-gray-300'
                }`}
                placeholder="Confirm your password"
              />
              {errors.confirmPassword && (
                <p className="text-red-500 text-sm mt-1">{errors.confirmPassword}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition-colors"
            >
              {submitting ? 'Sending OTP...' : `Register as ${role === 'instructor' ? 'Instructor' : 'Student'}`}
            </button>
              </>
            ) : (
              <>
                <div className="mb-4">
                  <label className="block text-gray-700 mb-2">
                    OTP Code <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                    className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                      errors.otpCode ? 'border-red-500' : 'border-gray-300'
                    }`}
                    placeholder="Enter 6-digit OTP"
                  />
                  {errors.otpCode && <p className="text-red-500 text-sm mt-1">{errors.otpCode}</p>}
                </div>
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition-colors"
                >
                  {submitting ? 'Verifying...' : 'Verify OTP & Complete Registration'}
                </button>
              </>
            )}
            {message && <p className="text-green-600 text-sm mt-3">{message}</p>}
          </form>

          <div className="mt-6 text-center">
            <p className="text-gray-600">
              Already have an account?{' '}
              <button
                onClick={onBackToLogin}
                className="text-blue-600 hover:text-blue-700"
              >
                Sign In
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
