import { useEffect, useMemo, useState } from 'react';
import { Search, Filter, FileText, Download, MessageSquare, Eye, CheckCircle } from 'lucide-react';
import { DocumentDetail } from '../pages/DocumentDetail';
import api from '@/services/api';
import { useNotification } from '../pages/NotificationContext';

interface DocumentLibraryProps {
  userRole: 'instructor' | 'student';
  user: any;
  /** Instructor: open Quizzes tab and run the same AI generate flow as Quiz Management. */
  onInstructorCreateQuizWithAi?: (doc: CourseMaterialDoc) => void;
}

export type CourseMaterialDoc = {
  id: string | number;
  title: string;
  type: 'general' | 'general-major' | 'specialized';
  courseCode: string;
  courseName: string;
  author: string;
  authorRole: 'instructor' | 'student';
  uploadDate: string;
  /** Successful file downloads (tracked server-side) */
  downloads: number;
  comments: number;
  /** Indexed segments (honest proxy for “visibility” / processing depth) */
  views: number;
  /** List card / material status blurb (indexing info). */
  description: string;
  /** User-written description from upload form (shown in document detail preview). */
  uploadDescription?: string;
  s3Key?: string;
  fileUrl?: string;
  documentId?: number | null;
  chunkCount?: number;
  attemptsCount?: number;
  inDatabase?: boolean;
  estimatedQuestions?: number;
  /** Lecturer/teacher uploads — shown as credibility badge */
  highCredibility: boolean;
  /** Distinct “Lecturer” tag for staff uploads (role lecturer/teacher/instructor/…) */
  isLecturerUpload: boolean;
  /** Upload `category` (general / general-major / specialized), for filtering */
  categoryKey: 'general' | 'general-major' | 'specialized' | 'uncategorized';
};

function formatYmd(value: string | Date | undefined | null): string {
  if (value == null || value === '') return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

function deriveMaterialType(api: any): 'general' | 'general-major' | 'specialized' {
  const chunks = Number(api.chunkCount || 0);
  const inDb = !!api.inDatabase;
  if (inDb && chunks >= 10) return 'specialized';
  if (inDb && chunks >= 4) return 'general-major';
  return 'general';
}

/** Matches upload form `category`: general | general-major | specialized */
function mapCategoryToDocType(category: unknown): 'general' | 'general-major' | 'specialized' | null {
  const c = String(category ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (c === 'general-major') return 'general-major';
  if (c === 'specialized') return 'specialized';
  if (c === 'general') return 'general';
  return null;
}

/** Bucket for upload `documents.category` (filter bar). */
function normalizeMaterialCategoryKeyFromApi(
  raw: unknown
): 'general' | 'general-major' | 'specialized' | 'uncategorized' {
  const c = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (!c) return 'uncategorized';
  if (c === 'general-major' || c === 'general major') return 'general-major';
  if (c === 'specialized' || c === 'specialised') return 'specialized';
  if (c === 'general') return 'general';
  return 'uncategorized';
}

function mapUploaderRole(roleRaw: string | undefined): 'instructor' | 'student' {
  const u = String(roleRaw || '').toUpperCase();
  if (u.includes('STUDENT')) return 'student';
  return 'instructor';
}

/** Drop synthetic "Course CODE" when it duplicates `courseCode` from `course_id`. */
function normalizeCourseName(courseCode: string, subjectName: string): string {
  const code = String(courseCode || '').trim();
  const raw = String(subjectName || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (code && (lower === code.toLowerCase() || lower === `course ${code}`.toLowerCase())) return '';
  return raw;
}

/** Align with backend `LECTURER_ROLES` / `isLecturerRole` (LECTURER, INSTRUCTOR, …). */
function isLecturerUploaderRole(roleRaw: string | undefined): boolean {
  const r = String(roleRaw || '').trim().toLowerCase();
  if (!r || r === 'student') return false;
  const allowed = new Set(['lecturer', 'teacher', 'instructor', 'faculty', 'admin', 'lecture']);
  if (allowed.has(r)) return true;
  if (r.includes('lectur') || r.includes('instruct')) return true;
  return false;
}

function mapApiRowToDoc(api: any): CourseMaterialDoc {
  const courseCode = String(api.courseCode || '').trim();
  const courseName = normalizeCourseName(courseCode, String(api.subjectName || ''));
  const chunkCount = Number(api.chunkCount || 0);
  const attemptsCount = Number(api.attemptsCount || 0);
  const downloadCount = Number(api.downloadCount ?? 0);
  const uploaderName = String(api.uploaderName || '').trim();
  const author = uploaderName || 'Unknown uploader';
  const authorRole = mapUploaderRole(api.uploaderRole);
  const lastMod = api.lastModified ?? api.created_at ?? api.uploadedAt;
  const categoryKey = normalizeMaterialCategoryKeyFromApi(api.category);
  const type =
    mapCategoryToDocType(api.category) ?? deriveMaterialType(api);
  const docId = api.documentId != null ? Number(api.documentId) : null;
  const id = docId != null && Number.isFinite(docId) ? docId : String(api.s3Key || api.fileName || api.title);

  const description =
    chunkCount > 0
      ? `Indexed learning material with ${chunkCount} text segment${chunkCount === 1 ? '' : 's'}. Suitable for AI quizzes and study.`
      : api.inDatabase
        ? 'Registered in the system; indexing may still be running.'
        : 'File in cloud storage; connect and index this document to enable AI features.';

  const uploadDescription = String(api.description || '').trim();

  const uploaderRoleStr = String(api.uploaderRole || '').trim();
  const highCredibility =
    typeof api.highCredibility === 'boolean'
      ? api.highCredibility
      : isLecturerUploaderRole(api.uploaderRole);
  const isLecturerUpload = isLecturerUploaderRole(uploaderRoleStr) || highCredibility;

  return {
    id,
    title: String(api.title || api.fileName || 'Untitled document'),
    type,
    courseCode,
    courseName,
    author,
    authorRole,
    uploadDate: formatYmd(lastMod),
    downloads: downloadCount,
    comments: Number(api.commentsCount ?? 0),
    views: chunkCount,
    description,
    uploadDescription: uploadDescription || undefined,
    s3Key: api.s3Key,
    fileUrl: api.fileUrl,
    documentId: docId,
    chunkCount,
    attemptsCount,
    inDatabase: !!api.inDatabase,
    estimatedQuestions: api.estimatedQuestions,
    highCredibility,
    isLecturerUpload,
    categoryKey,
  };
}

export function DocumentLibrary({ userRole, user, onInstructorCreateQuizWithAi }: DocumentLibraryProps) {
  const { showNotification } = useNotification();
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<
    'all' | 'general' | 'general-major' | 'specialized' | 'uncategorized'
  >('all');
  const [selectedDocument, setSelectedDocument] = useState<CourseMaterialDoc | null>(null);
  const [documents, setDocuments] = useState<CourseMaterialDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadMessage, setLoadMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadMessage(null);
      try {
        const res: any = await api.get('/documents/for-quiz');
        const raw = Array.isArray(res?.data) ? res.data : [];
        const mapped = raw.map(mapApiRowToDoc);
        if (!cancelled) {
          setDocuments(mapped);
          if (raw.length === 0 && res?.message) setLoadMessage(String(res.message));
        }
      } catch {
        if (!cancelled) {
          setDocuments([]);
          setLoadMessage('Could not load course materials. Please try again later.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredDocuments = useMemo(() => {
    return documents.filter((doc) => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        doc.title.toLowerCase().includes(q) ||
        doc.courseCode.toLowerCase().includes(q) ||
        doc.courseName.toLowerCase().includes(q);

      const matchesCategory =
        categoryFilter === 'all' ||
        (categoryFilter === 'uncategorized'
          ? doc.categoryKey === 'uncategorized'
          : doc.categoryKey === categoryFilter);

      return matchesSearch && matchesCategory;
    });
  }, [documents, searchQuery, categoryFilter]);

  if (selectedDocument) {
    return (
      <DocumentDetail
        document={selectedDocument}
        userRole={userRole}
        user={user}
        onBack={() => setSelectedDocument(null)}
        onCreateQuizWithAi={
          userRole === 'instructor' && onInstructorCreateQuizWithAi
            ? () => {
                const d = selectedDocument;
                if (!String(d.s3Key || '').trim()) {
                  showNotification({
                    type: 'warning',
                    title: 'Create Quiz with AI',
                    message: 'This file has no storage key yet. Re-upload or wait for indexing, then try again.',
                  });
                  return;
                }
                onInstructorCreateQuizWithAi(d);
              }
            : undefined
        }
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2>Course Materials</h2>
      </div>

      {/* Search and Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
            <input
              type="text"
              placeholder="Search by title, course code, or course name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <div className="flex items-center gap-2">
            <Filter className="text-gray-400" size={20} />
            <select
              aria-label="Filter by material category"
              value={categoryFilter}
              onChange={(e) =>
                setCategoryFilter(
                  e.target.value as typeof categoryFilter
                )
              }
              className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              <option value="all">All categories</option>
              <option value="general">General</option>
              <option value="general-major">General Major</option>
              <option value="specialized">Specialized</option>
              <option value="uncategorized">Uncategorized</option>
            </select>
          </div>
        </div>
      </div>

      {loading && (
        <div className="bg-blue-50 border border-blue-100 text-blue-900 rounded-lg px-4 py-3 mb-4 text-sm">
          Loading course materials…
        </div>
      )}

      {!loading && loadMessage && documents.length === 0 && (
        <div className="bg-amber-50 border border-amber-100 text-amber-900 rounded-lg px-4 py-3 mb-4 text-sm">
          {loadMessage}
        </div>
      )}

      {/* Documents List */}
      <div className="space-y-4">
        {filteredDocuments.map((doc) => (
          <div
            key={String(doc.id)}
            className="bg-white rounded-lg border border-gray-200 p-6 hover:shadow-md transition-shadow cursor-pointer"
            onClick={() => setSelectedDocument(doc)}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <h3 className="text-gray-900">{doc.title}</h3>
                  {(doc.isLecturerUpload || doc.highCredibility) && (
                    <span
                      className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-800 px-2 py-1 rounded text-xs font-medium"
                      title="Uploaded by course staff — marked as reliable"
                    >
                      <CheckCircle size={14} aria-hidden />
                      Verified
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-gray-600 mb-2 flex-wrap">
                  <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded text-xs">
                    {doc.categoryKey === 'uncategorized'
                      ? 'Uncategorized'
                      : doc.categoryKey === 'general'
                        ? 'General'
                        : doc.categoryKey === 'general-major'
                          ? 'General Major'
                          : 'Specialized'}
                  </span>
                  {doc.courseCode ? <span>{doc.courseCode}</span> : null}
                  {doc.courseName ? (
                    <>
                      {doc.courseCode ? <span className="text-gray-300">·</span> : null}
                      <span>{doc.courseName}</span>
                    </>
                  ) : null}
                </div>
                <p className="text-gray-600 mb-3">{doc.description}</p>
                <div className="flex items-center gap-4 text-gray-500 flex-wrap">
                  <span>
                    By {doc.author} ({doc.authorRole})
                  </span>
                  <span>•</span>
                  <span>{doc.uploadDate}</span>
                </div>
              </div>
              <FileText className="text-blue-600 shrink-0" size={32} />
            </div>

            <div className="flex items-center gap-6 pt-3 border-t border-gray-100 flex-wrap text-sm">
              <div className="flex items-center gap-2 text-gray-600" title="Indexed text segments">
                <Eye size={16} />
                <span>
                  {doc.views} segment{doc.views === 1 ? '' : 's'}
                </span>
              </div>
              <div className="flex items-center gap-2 text-gray-600" title="File downloads">
                <Download size={16} />
                <span>
                  {doc.downloads} download{doc.downloads === 1 ? '' : 's'}
                </span>
              </div>
              <div className="flex items-center gap-2 text-gray-600">
                <MessageSquare size={16} />
                <span>
                  {doc.comments} comment{doc.comments === 1 ? '' : 's'}
                </span>
              </div>
            </div>
          </div>
        ))}

        {!loading && filteredDocuments.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <FileText className="mx-auto mb-4 text-gray-400" size={48} />
            <p>
              {documents.length === 0
                ? 'No course materials yet. Upload a document from the Upload tab.'
                : 'No documents found matching your search criteria.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
