import { useEffect, useMemo, useState } from 'react'
import { Search, Filter, FileText, Download, MessageSquare, Eye, CheckCircle, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from 'lucide-react'
import { DocumentDetail } from '../pages/DocumentDetail'
import api from '@/services/api'
import { useNotification } from '../pages/NotificationContext'

interface DocumentLibraryProps {
  userRole: 'instructor' | 'student'
  user: any
  onInstructorCreateQuizWithAi?: (doc: CourseMaterialDoc) => void
  /** Switch to Quizzes tab and highlight the quiz row for this document’s file. */
  onInstructorMoveToQuizFile?: (doc: CourseMaterialDoc) => void
  /** Student: leave document detail and jump to Quizzes tab with that source file highlighted (not Documents list). */
  onStudentOpenInQuizzes?: (doc: CourseMaterialDoc) => void
}

export type CourseMaterialDoc = {
  id: string | number
  title: string
  type: 'general' | 'general-major' | 'specialized'
  courseCode: string
  courseName: string
  author: string
  authorRole: 'instructor' | 'student'
  uploadDate: string
  downloads: number
  comments: number
  views: number
  description: string
  uploadDescription?: string
  s3Key?: string
  fileUrl?: string
  documentId?: number | null
  chunkCount?: number
  attemptsCount?: number
  inDatabase?: boolean
  estimatedQuestions?: number
  highCredibility: boolean
  isLecturerUpload: boolean
  categoryKey: 'general' | 'general-major' | 'specialized' | 'uncategorized'
  status?: string
  year?: string
  semester?: string
  subject?: string
}
const STUDENT_FLASHCARD_NAVIGATE_KEY = 'edumate_student_flashcard_navigate'

function buildDocFocusKey(doc: Partial<CourseMaterialDoc> | null | undefined): string {
  const rawId = doc?.documentId ?? doc?.id
  if (rawId != null && rawId !== '' && Number.isFinite(Number(rawId))) {
    return `docid:${Number(rawId)}`
  }
  const s3 = String(doc?.s3Key || '').trim()
  if (s3) return `s3:${s3}`
  return `title:${String(doc?.title || '').trim().toLowerCase()}`
}

function formatYmd(value: string | Date | undefined | null): string {
  if (value == null || value === '') return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(d.getTime())) return '—'
  return d.toISOString().slice(0, 10)
}

function deriveMaterialType(api: any): 'general' | 'general-major' | 'specialized' {
  const chunks = Number(api.chunkCount || 0)
  const inDb = !!api.inDatabase
  if (inDb && chunks >= 10) return 'specialized'
  if (inDb && chunks >= 4) return 'general-major'
  return 'general'
}

function mapCategoryToDocType(category: unknown): 'general' | 'general-major' | 'specialized' | null {
  const c = String(category ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  if (c === 'general-major') return 'general-major'
  if (c === 'specialized') return 'specialized'
  if (c === 'general') return 'general'
  return null
}

function normalizeMaterialCategoryKeyFromApi(
  raw: unknown
): 'general' | 'general-major' | 'specialized' | 'uncategorized' {
  const c = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  if (!c) return 'uncategorized'
  if (c === 'general-major' || c === 'general major') return 'general-major'
  if (c === 'specialized' || c === 'specialised') return 'specialized'
  if (c === 'general') return 'general'
  return 'uncategorized'
}

function mapUploaderRole(roleRaw: string | undefined): 'instructor' | 'student' {
  const u = String(roleRaw || '').toUpperCase()
  if (u.includes('STUDENT')) return 'student'
  return 'instructor'
}

function normalizeCourseName(courseCode: string, subjectName: string): string {
  const code = String(courseCode || '').trim()
  const raw = String(subjectName || '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (code && (lower === code.toLowerCase() || lower === `course ${code}`.toLowerCase())) return ''
  return raw
}

function isLecturerUploaderRole(roleRaw: string | undefined): boolean {
  const r = String(roleRaw || '').trim().toLowerCase()
  if (!r || r === 'student') return false
  const allowed = new Set(['lecturer', 'teacher', 'instructor', 'faculty', 'admin', 'lecture'])
  if (allowed.has(r)) return true
  if (r.includes('lectur') || r.includes('instruct')) return true
  return false
}

function mapApiRowToDoc(apiRow: any): CourseMaterialDoc {
  const courseCode = String(apiRow.courseCode || '').trim()
  const courseName = normalizeCourseName(courseCode, String(apiRow.subjectName || ''))
  const chunkCount = Number(apiRow.chunkCount || 0)
  const attemptsCount = Number(apiRow.attemptsCount || 0)
  const downloadCount = Number(apiRow.downloadCount ?? 0)
  const uploaderName = String(apiRow.uploaderName || '').trim()
  const author = uploaderName || 'Unknown uploader'
  const authorRole = mapUploaderRole(apiRow.uploaderRole)
  const lastMod = apiRow.lastModified ?? apiRow.created_at ?? apiRow.uploadedAt
  const categoryKey = normalizeMaterialCategoryKeyFromApi(apiRow.category)
  const type = mapCategoryToDocType(apiRow.category) ?? deriveMaterialType(apiRow)
  const rawDocId = apiRow.documentId ?? apiRow.id;
  const docId = rawDocId != null ? Number(rawDocId) : null;
  const id = docId != null && Number.isFinite(docId) ? docId : String(apiRow.s3Key || apiRow.fileName || apiRow.title)

  const description =
    chunkCount > 0
      ? `Indexed learning material with ${chunkCount} text segment${chunkCount === 1 ? '' : 's'}. Suitable for AI quizzes and study.`
      : apiRow.inDatabase
        ? 'Registered in the system; indexing may still be running.'
        : 'File in cloud storage; connect and index this document to enable AI features.'

  const uploadDescription = String(apiRow.description || '').trim()
  const uploaderRoleStr = String(apiRow.uploaderRole || '').trim()
  const highCredibility =
    typeof apiRow.highCredibility === 'boolean'
      ? apiRow.highCredibility
      : isLecturerUploaderRole(apiRow.uploaderRole)
  const isLecturerUpload = isLecturerUploaderRole(uploaderRoleStr) || highCredibility

  let year, semester, subject
  const s3Key = apiRow.s3Key || ''
  if (s3Key.startsWith('DATA/')) {
    const parts = s3Key.split('/')
    if (parts.length >= 4) {
      year = parts[1]
      semester = parts[2]
      subject = parts[3]
    }
  }

  return {
    id,
    title: String(apiRow.title || apiRow.fileName || 'Untitled document'),
    type,
    courseCode,
    courseName,
    author,
    authorRole,
    uploadDate: formatYmd(lastMod),
    downloads: downloadCount,
    comments: Number(apiRow.commentsCount ?? 0),
    views: chunkCount,
    description,
    uploadDescription: uploadDescription || undefined,
    s3Key: apiRow.s3Key,
    fileUrl: apiRow.fileUrl,
    documentId: docId,
    chunkCount,
    attemptsCount,
    inDatabase: !!apiRow.inDatabase,
    estimatedQuestions: apiRow.estimatedQuestions,
    highCredibility,
    isLecturerUpload,
    categoryKey,
    status: apiRow.status,
    year,
    semester,
    subject,
  }
}

export function DocumentLibrary({
  userRole,
  user,
  onInstructorCreateQuizWithAi,
  onInstructorMoveToQuizFile,
  onStudentOpenInQuizzes,
}: DocumentLibraryProps) {
  const { showNotification } = useNotification()
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<
    'all' | 'general' | 'general-major' | 'specialized' | 'uncategorized'
  >('all')
  const [yearFilter, setYearFilter] = useState('all')
  const [semesterFilter, setSemesterFilter] = useState('all')
  
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)

  const [selectedDocument, setSelectedDocument] = useState<CourseMaterialDoc | null>(null)
  const [documents, setDocuments] = useState<CourseMaterialDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [loadMessage, setLoadMessage] = useState<string | null>(null)
  const [pendingFocusKey, setPendingFocusKey] = useState<string | null>(null)
  const [highlightedDocKey, setHighlightedDocKey] = useState<string | null>(null)
  const [pendingFlashcardTarget, setPendingFlashcardTarget] = useState<any>(null)
  const [autoOpenFlashcardDocKey, setAutoOpenFlashcardDocKey] = useState<string | null>(null)
  const [autoOpenFlashcardMode, setAutoOpenFlashcardMode] = useState<'creator' | 'viewer' | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setLoadMessage(null)
      try {
        const res: any = await api.get('/documents/for-quiz', {
          params: {
            includeVerified: true,
            audience: userRole === 'student' ? 'student' : 'instructor',
          },
        })
        const raw = Array.isArray(res?.data) ? res.data : []
        const mapped = raw.map(mapApiRowToDoc)
        if (!cancelled) {
          setDocuments(mapped)
          if (raw.length === 0 && res?.message) setLoadMessage(String(res.message))
        }
      } catch {
        if (!cancelled) {
          setDocuments([])
          setLoadMessage('Could not load course materials. Please try again later.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userRole])

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, categoryFilter, yearFilter, semesterFilter])

  const availableYears = useMemo(() => 
    Array.from(new Set(documents.map(d => d.year).filter(Boolean))).sort(), 
    [documents]
  )
  const availableSemesters = useMemo(() => 
    Array.from(new Set(documents.map(d => d.semester).filter(Boolean))).sort(), 
    [documents]
  )

  const filteredDocuments = useMemo(() => {
    return documents.filter((doc) => {
      const q = searchQuery.toLowerCase().trim()
      const matchesSearch =
        !q ||
        (doc.title || '').toLowerCase().includes(q) ||
        (doc.courseCode || '').toLowerCase().includes(q) ||
        (doc.courseName || '').toLowerCase().includes(q)

      const matchesCategory =
        categoryFilter === 'all' ||
        (categoryFilter === 'uncategorized'
          ? doc.categoryKey === 'uncategorized'
          : doc.categoryKey === categoryFilter)

      const matchesYear = yearFilter === 'all' || doc.year === yearFilter
      const matchesSemester = semesterFilter === 'all' || doc.semester === semesterFilter

      return matchesSearch && matchesCategory && matchesYear && matchesSemester
    })
  }, [documents, searchQuery, categoryFilter, yearFilter, semesterFilter])

  const totalPages = Math.ceil(filteredDocuments.length / itemsPerPage) || 1
  const paginatedDocuments = filteredDocuments.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  )

  const getPageNumbers = (): (number | '...')[] => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
    const pages: (number | '...')[] = [1]
    if (currentPage > 3) pages.push('...')
    const start = Math.max(2, currentPage - 1)
    const end = Math.min(totalPages - 1, currentPage + 1)
    for (let i = start; i <= end; i++) pages.push(i)
    if (currentPage < totalPages - 2) pages.push('...')
    pages.push(totalPages)
    return pages
  }

  useEffect(() => {
    if (!pendingFocusKey || loading) return
    const foundInAll = documents.some((d) => buildDocFocusKey(d) === pendingFocusKey)
    if (!foundInAll) return

    const foundInFiltered = filteredDocuments.some((d) => buildDocFocusKey(d) === pendingFocusKey)
    if (!foundInFiltered) {
      if (searchQuery.trim()) setSearchQuery('')
      if (categoryFilter !== 'all') setCategoryFilter('all')
      return
    }

    const timer = window.setTimeout(() => {
      const selector = `[data-doc-focus-key="${pendingFocusKey.replace(/"/g, '\\"')}"]`
      const target = document.querySelector(selector) as HTMLElement | null
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      setHighlightedDocKey(pendingFocusKey)
      setPendingFocusKey(null)
    }, 80)

    return () => window.clearTimeout(timer)
  }, [pendingFocusKey, loading, documents, filteredDocuments, searchQuery, categoryFilter])

  useEffect(() => {
    if (!highlightedDocKey) return
    const timer = window.setTimeout(() => setHighlightedDocKey(null), 2600)
    return () => window.clearTimeout(timer)
  }, [highlightedDocKey])

  useEffect(() => {
    const readTarget = () => {
      try {
        const raw = localStorage.getItem(STUDENT_FLASHCARD_NAVIGATE_KEY)
        if (!raw) return
        const parsed = JSON.parse(raw)
        setPendingFlashcardTarget(parsed)
      } catch {
        // ignore invalid payload
      }
    }
    readTarget()
    const onStorage = (e: StorageEvent) => {
      if (e.key === STUDENT_FLASHCARD_NAVIGATE_KEY) readTarget()
    }
    const onCustom = () => readTarget()
    window.addEventListener('storage', onStorage)
    window.addEventListener('edumate:student-flashcard-navigate', onCustom)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('edumate:student-flashcard-navigate', onCustom)
    }
  }, [])

  useEffect(() => {
    if (!pendingFlashcardTarget || loading) return
    const targetDocId = Number(pendingFlashcardTarget?.documentId)
    const targetS3 = String(pendingFlashcardTarget?.s3Key || '').trim()
    const targetTitle = String(pendingFlashcardTarget?.title || '').trim().toLowerCase()
    const targetMode: 'creator' | 'viewer' =
      pendingFlashcardTarget?.mode === 'viewer' ? 'viewer' : 'creator'
    const found = documents.find((d) => {
      const docId = Number(d?.documentId ?? d?.id)
      if (Number.isFinite(targetDocId) && Number.isFinite(docId) && docId === targetDocId) return true
      if (targetS3 && String(d?.s3Key || '').trim() === targetS3) return true
      if (targetTitle && String(d?.title || '').trim().toLowerCase() === targetTitle) return true
      return false
    })
    if (!found) return
    const docKey = buildDocFocusKey(found)
    setAutoOpenFlashcardDocKey(docKey)
    setAutoOpenFlashcardMode(targetMode)
    setSelectedDocument(found)
    setPendingFlashcardTarget(null)
    localStorage.removeItem(STUDENT_FLASHCARD_NAVIGATE_KEY)
  }, [pendingFlashcardTarget, loading, documents])

  if (selectedDocument) {
    return (
      <DocumentDetail
        document={selectedDocument}
        userRole={userRole}
        user={user}
        onBack={() => setSelectedDocument(null)}
        autoOpenFlashcardMode={
          userRole === 'student' &&
          autoOpenFlashcardDocKey != null &&
          autoOpenFlashcardDocKey === buildDocFocusKey(selectedDocument)
            ? autoOpenFlashcardMode
            : null
        }
        onAutoOpenFlashcardHandled={() => {
          setAutoOpenFlashcardDocKey(null)
          setAutoOpenFlashcardMode(null)
        }}
        onOpenQuiz={
          userRole === 'student'
            ? (doc: CourseMaterialDoc) => {
                if (onStudentOpenInQuizzes) {
                  if (!String(doc?.s3Key || '').trim()) {
                    showNotification({
                      type: 'warning',
                      title: 'Open in Quizzes',
                      message:
                        'This material has no storage key yet. Open Quizzes from the sidebar after it is indexed.',
                    })
                    return
                  }
                  setSelectedDocument(null)
                  onStudentOpenInQuizzes(doc)
                  return
                }
                setSelectedDocument(null)
                setPendingFocusKey(buildDocFocusKey(doc))
              }
            : undefined
        }
        onMoveToQuizFile={
          userRole === 'instructor' && onInstructorMoveToQuizFile
            ? () => {
                const d = selectedDocument
                if (!String(d.s3Key || '').trim()) {
                  showNotification({
                    type: 'warning',
                    title: 'Open in Quizzes',
                    message:
                      'This material has no storage key yet. Re-upload or wait for indexing, then try again.',
                  })
                  return
                }
                onInstructorMoveToQuizFile(d)
              }
            : undefined
        }
        onCreateQuizWithAi={
          userRole === 'instructor' && onInstructorCreateQuizWithAi && !onInstructorMoveToQuizFile
            ? () => {
                const d = selectedDocument
                if (!String(d.s3Key || '').trim()) {
                  showNotification({
                    type: 'warning',
                    title: 'Open in Quizzes',
                    message: 'This file has no storage key yet. Re-upload or wait for indexing, then try again.',
                  })
                  return
                }
                onInstructorCreateQuizWithAi(d)
              }
            : undefined
        }
      />
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2>Course Materials</h2>
      </div>

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

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Filter className="text-gray-400" size={20} />
              <select
                aria-label="Filter by material category"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value as typeof categoryFilter)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                <option value="all">All categories</option>
                <option value="general">General</option>
                <option value="general-major">General Major</option>
                <option value="specialized">Specialized</option>
                <option value="uncategorized">Uncategorized</option>
              </select>
            </div>
            
            <div className="flex items-center gap-2">
              <select
                aria-label="Filter by year"
                value={yearFilter}
                onChange={(e) => setYearFilter(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 min-w-[140px]"
              >
                <option value="all">All Years</option>
                {availableYears.map(y => <option key={y as string} value={y as string}>{y as string}</option>)}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <select
                aria-label="Filter by semester"
                value={semesterFilter}
                onChange={(e) => setSemesterFilter(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 min-w-[150px]"
              >
                <option value="all">All Semesters</option>
                {availableSemesters.map(s => <option key={s as string} value={s as string}>{s as string}</option>)}
              </select>
            </div>
            
            {(categoryFilter !== 'all' || yearFilter !== 'all' || semesterFilter !== 'all') && (
              <button
                onClick={() => {
                  setCategoryFilter('all')
                  setYearFilter('all')
                  setSemesterFilter('all')
                  setSearchQuery('')
                }}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors ml-auto"
              >
                <X size={14} />
                Clear Filters
              </button>
            )}
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

      <div className="space-y-4">
        {paginatedDocuments.map((doc) => (
          <div
            key={String(doc.id)}
            data-doc-focus-key={buildDocFocusKey(doc)}
            className={`bg-white rounded-lg border p-6 hover:shadow-md transition-shadow cursor-pointer ${
              highlightedDocKey === buildDocFocusKey(doc)
                ? 'border-blue-500 ring-2 ring-blue-200 shadow-sm'
                : 'border-gray-200'
            }`}
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
                  {doc.year && (
                    <span className="bg-purple-100 text-purple-700 px-2 py-1 rounded text-xs font-medium">
                      {doc.year}
                    </span>
                  )}
                  {doc.semester && (
                    <span className="bg-indigo-100 text-indigo-700 px-2 py-1 rounded text-xs font-medium">
                      {doc.semester}
                    </span>
                  )}
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
                  <span>{doc.uploadDate || 'Unknown date'}</span>
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
        {!loading && filteredDocuments.length > 0 && totalPages > 1 && (
          <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mt-8 pb-4 bg-white rounded-lg border border-gray-200 p-4">
            <div className="text-sm text-gray-500">
              Showing <span className="font-semibold text-gray-700">{(currentPage - 1) * itemsPerPage + 1}</span>–<span className="font-semibold text-gray-700">{Math.min(currentPage * itemsPerPage, filteredDocuments.length)}</span> of <span className="font-semibold text-gray-700">{filteredDocuments.length}</span> documents
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => setCurrentPage(1)}
                disabled={currentPage === 1}
                className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronsLeft size={16} />
              </button>
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft size={16} />
              </button>

              {getPageNumbers().map((page, idx) =>
                page === '...' ? (
                  <span key={`dots-${idx}`} className="px-2 py-1 text-gray-400 text-sm">…</span>
                ) : (
                  <button
                    key={page}
                    onClick={() => setCurrentPage(page as number)}
                    className={`min-w-[36px] h-9 rounded-lg text-sm font-medium transition-all ${
                      currentPage === page
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    {page}
                  </button>
                )
              )}

              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight size={16} />
              </button>
              <button
                onClick={() => setCurrentPage(totalPages)}
                disabled={currentPage === totalPages}
                className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronsRight size={16} />
              </button>
            </div>

            <div className="flex items-center gap-2 text-sm text-gray-500">
              <span>Show</span>
              <select
                value={itemsPerPage}
                onChange={(e) => { setItemsPerPage(Number(e.target.value)); setCurrentPage(1); }}
                className="border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
              <span>per page</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}