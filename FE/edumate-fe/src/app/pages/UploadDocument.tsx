// File: src/app/pages/UploadDocument.tsx

import { useCallback, useRef, useState } from 'react';
import { Upload, FileText, CheckCircle } from 'lucide-react';

import api, { getApiBaseUrl } from '@/services/api';
import { SAFE_ERROR, sanitizeApiUserMessage } from '@/utils/safeErrorMessage';

type CourseSuggestion = {
  course_code: string;
  course_name: string;
};

function normalizeCourseSuggestion(row: Record<string, unknown>): CourseSuggestion | null {
  const course_code = String(
    row.course_code ?? row.courseCode ?? row.subject_code ?? row.subjectCode ?? ''
  ).trim();
  const course_name = String(
    row.course_name ?? row.courseName ?? row.subject_name ?? row.subjectName ?? ''
  ).trim();
  if (!course_code && !course_name) return null;
  return {
    course_code: course_code || course_name,
    course_name: course_name || course_code,
  };
}

interface UploadDocumentProps {
  userRole: 'instructor' | 'student';
  onUploadComplete: () => void;
  /** When set, sent as `uploaderId` so `documents.uploader_id` is stored (JWT on the server also supplies this). */
  user?: { user_id?: number; id?: number; userId?: number } | null;
}

export function UploadDocument({ userRole, onUploadComplete, user }: UploadDocumentProps) {
  const [formData, setFormData] = useState({
    type: 'general',
    year: '',
    semester: '',
    courseCode: '',
    courseName: '',
    topicTitle: '',
    description: '',
  });

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [courseSuggestions, setCourseSuggestions] = useState<CourseSuggestion[]>([]);
  const [showCodeSuggestions, setShowCodeSuggestions] = useState(false);
  const [showNameSuggestions, setShowNameSuggestions] = useState(false);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestRequestIdRef = useRef(0);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const fetchCourseSuggestions = useCallback(async (query: string, field: 'code' | 'name') => {
    const q = query.trim();
    if (!q) {
      setCourseSuggestions([]);
      setSuggestionsLoading(false);
      return;
    }

    const requestId = ++suggestRequestIdRef.current;
    setSuggestionsLoading(true);
    try {
      const res = (await api.get('/documents/course-suggestions', {
        params: { query: q, field },
      })) as { success?: boolean; data?: unknown[] };
      if (requestId !== suggestRequestIdRef.current) return;
      const rows = Array.isArray(res?.data) ? res.data : [];
      const mapped = rows
        .map((row) => normalizeCourseSuggestion(row as Record<string, unknown>))
        .filter((x): x is CourseSuggestion => x != null);
      setCourseSuggestions(mapped);
    } catch (err) {
      if (requestId !== suggestRequestIdRef.current) return;
      console.error('[UploadDocument] course suggestions:', err);
      setCourseSuggestions([]);
    } finally {
      if (requestId === suggestRequestIdRef.current) setSuggestionsLoading(false);
    }
  }, []);

  const scheduleCourseSuggestions = (query: string, field: 'code' | 'name') => {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestTimerRef.current = setTimeout(() => {
      void fetchCourseSuggestions(query, field);
    }, 280);
  };

  const applySuggestion = (suggestion: CourseSuggestion) => {
    setFormData((prev) => ({
      ...prev,
      courseCode: suggestion.course_code,
      courseName: suggestion.course_name || prev.courseName,
    }));
    setCourseSuggestions([]);
    setShowCodeSuggestions(false);
    setShowNameSuggestions(false);
  };

  const renderSuggestionList = (visible: boolean) => {
    if (!visible) return null;
    if (suggestionsLoading && courseSuggestions.length === 0) {
      return (
        <ul className="absolute z-10 w-full bg-white border border-gray-300 rounded-lg mt-1 shadow-lg">
          <li className="px-4 py-2 text-sm text-gray-500">Searching courses…</li>
        </ul>
      );
    }
    if (!courseSuggestions.length) return null;
    return (
      <ul className="absolute z-10 w-full bg-white border border-gray-300 rounded-lg mt-1 max-h-48 overflow-y-auto shadow-lg">
        {courseSuggestions.map((suggestion) => (
          <li
            key={`${suggestion.course_code}-${suggestion.course_name}`}
            className="px-4 py-2 hover:bg-blue-50 cursor-pointer text-sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applySuggestion(suggestion)}
          >
            <span className="font-semibold text-gray-900">{suggestion.course_code}</span>
            {suggestion.course_name ? (
              <span className="text-gray-600"> — {suggestion.course_name}</span>
            ) : null}
          </li>
        ))}
      </ul>
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!file) {
      alert('Please select a file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      alert('File must not exceed 10MB');
      return;
    }

    setUploading(true);

    try {
      const form = new FormData();

      form.append('documentFile', file);
      form.append('title', formData.topicTitle);
      form.append('category', formData.type);
      form.append('year', formData.year);
      form.append('semester', formData.semester);
      form.append('subjectCode', formData.courseCode);
      form.append('subjectName', formData.courseName);
      form.append('tags', formData.courseCode);
      form.append('description', formData.description || '');

      const uploaderId = user?.user_id ?? user?.id ?? user?.userId;
      if (uploaderId != null && String(uploaderId).trim() !== '') {
        form.append('uploaderId', String(uploaderId));
      }

      const base = getApiBaseUrl();
      const uploadUrl = `${base.replace(/\/$/, '')}/documents/upload`;

      let res;

      try {
        const token = typeof window !== 'undefined' ? localStorage.getItem('edumate_token') : null;
        const headers: HeadersInit = {};
        if (token) headers.Authorization = `Bearer ${token}`;

        res = await fetch(uploadUrl, {
          method: 'POST',
          headers,
          body: form,
        });
      } catch (err) {
        console.error('[UploadDocument] network failed:', err);
        throw new Error(SAFE_ERROR.network);
      }

      let data;

      try {
        data = await res.json();
      } catch (err) {
        console.error('[UploadDocument] invalid JSON:', err);
        throw new Error(SAFE_ERROR.generic);
      }

      if (!res.ok) {
        const msg = sanitizeApiUserMessage(String(data?.message || ''));
        throw new Error(msg || SAFE_ERROR.upload);
      }

      setUploadSuccess(true);

      setTimeout(() => {
        setUploadSuccess(false);
        setFormData({
          type: 'general',
          year: '',
          semester: '',
          courseCode: '',
          courseName: '',
          topicTitle: '',
          description: '',
        });

        setFile(null);
        const fileInput = document.getElementById('file-upload') as HTMLInputElement;

        if (fileInput) {
          fileInput.value = '';
        }

        onUploadComplete();
      }, 2000);
    } catch (err: unknown) {
      const msg =
        err instanceof Error && sanitizeApiUserMessage(err.message)
          ? err.message
          : SAFE_ERROR.upload;
      alert(msg);
    } finally {
      setUploading(false);
    }
  };

  if (uploadSuccess) {
    return (
      <div className="flex items-center justify-center min-h-[600px]">
        <div className="text-center">
          <div className="bg-green-100 text-green-600 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle size={48} />
          </div>
          <h2 className="text-green-600 mb-2">Upload Successful!</h2>
          <p className="text-gray-600">Your document has been uploaded and is now available to everyone.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="mb-8 text-2xl font-semibold">Upload Course Material</h2>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6">
        {/* File Upload */}
        <div className="mb-6">
          <label className="block text-gray-700 text-lg mb-2">Document File *</label>
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-600 transition-colors">
            <input
              type="file"
              onChange={handleFileChange}
              className="hidden"
              id="file-upload"
              accept=".pdf,.doc,.docx,.docm,.dotx,.dotm"
              required
            />
            <label htmlFor="file-upload" className="cursor-pointer">
              <Upload className="mx-auto mb-4 text-gray-400" size={48} />
              {file ? (
                <div>
                  <p className="text-blue-600 mb-1">{file.name}</p>
                  <p className="text-gray-500">Click to change file</p>
                </div>
              ) : (
                <div>
                  <p className="text-gray-700 mb-1">Click to upload or drag and drop</p>
                  <p className="text-gray-500">PDF, DOC, DOCX, DOCM, DOTX, DOTM (max 10MB)</p>
                </div>
              )}
            </label>
          </div>
        </div>

        {/* Type */}
        <div className="mb-4">
          <label className="block text-gray-700 text-lg mb-2">Document Type</label>
          <select
            name="type"
            aria-label="Select Document Type"
            value={formData.type}
            onChange={handleInputChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            required
          >
            <option value="general">General</option>
            <option value="general-major">General Major</option>
            <option value="specialized">Specialized</option>
          </select>
        </div>

        {/* Year */}
        <div className="mb-4">
          <label className="block text-gray-700 text-lg mb-2">Year *</label>
          <select
            name="year"
            aria-label="Select academic year"
            value={formData.year}
            onChange={handleInputChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            required
          >
            <option value="">Select year</option>
            <option value="YEAR 1">Year 1</option>
            <option value="YEAR 2">Year 2</option>
            <option value="YEAR 3">Year 3</option>
            <option value="YEAR 4">Year 4</option>
          </select>
        </div>

        {/* Semester */}
        <div className="mb-4">
          <label className="block text-gray-700 text-lg mb-2">Semester *</label>
          <select
            name="semester"
            aria-label="Select semester"
            value={formData.semester}
            onChange={handleInputChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            required
          >
            <option value="">Select semester</option>
            <option value="SEMESTER 1">Semester 1</option>
            <option value="SEMESTER 2">Semester 2</option>
          </select>
        </div>

        {/* Course Code */}
        <div className="mb-4 relative">
          <label className="block text-gray-700 text-lg mb-2">Course Code *</label>
          <input
            type="text"
            name="courseCode"
            value={formData.courseCode}
            onChange={(e) => {
              handleInputChange(e);
              scheduleCourseSuggestions(e.target.value, 'code');
            }}
            onFocus={() => {
              setShowCodeSuggestions(true);
              if (formData.courseCode.trim()) {
                void fetchCourseSuggestions(formData.courseCode, 'code');
              }
            }}
            onBlur={() => setTimeout(() => setShowCodeSuggestions(false), 200)}
            placeholder="e.g., CS101, MATH201"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            required
            autoComplete="off"
          />
          {renderSuggestionList(showCodeSuggestions)}
        </div>

        {/* Course Name */}
        <div className="mb-4 relative">
          <label className="block text-gray-700 text-lg mb-2">Course Name *</label>
          <input
            type="text"
            name="courseName"
            value={formData.courseName}
            onChange={(e) => {
              handleInputChange(e);
              scheduleCourseSuggestions(e.target.value, 'name');
            }}
            onFocus={() => {
              setShowNameSuggestions(true);
              if (formData.courseName.trim()) {
                void fetchCourseSuggestions(formData.courseName, 'name');
              }
            }}
            onBlur={() => setTimeout(() => setShowNameSuggestions(false), 200)}
            placeholder="e.g., Introduction to Computer Science"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            required
            autoComplete="off"
          />
          {renderSuggestionList(showNameSuggestions)}
        </div>

        {/* Topic Title */}
        <div className="mb-4">
          <label className="block text-gray-700 text-lg mb-2">Topic Title *</label>
          <input
            type="text"
            name="topicTitle"
            value={formData.topicTitle}
            onChange={handleInputChange}
            placeholder="e.g., Data Structures Overview"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            required
          />
        </div>

        {/* Description */}
        <div className="mb-6">
          <label className="block text-gray-700 text-lg mb-2">Description</label>
          <textarea
            name="description"
            value={formData.description}
            onChange={handleInputChange}
            placeholder="Provide a brief description of the document content..."
            rows={4}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={uploading || !file}
          className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {uploading ? (
            <>
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white" />
              Uploading...
            </>
          ) : (
            <>
              <FileText size={20} />
              Upload Document
            </>
          )}
        </button>
      </form>
    </div>
  );
}
