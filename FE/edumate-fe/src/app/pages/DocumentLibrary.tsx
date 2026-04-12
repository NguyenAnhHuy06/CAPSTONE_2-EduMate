import { useEffect, useState } from 'react';
import { Search, Filter, FileText, Download, MessageSquare, Eye, CheckCircle } from 'lucide-react';
import { DocumentDetail } from '../pages/DocumentDetail';
import api from '../../services/api';

interface DocumentLibraryProps {
  userRole: 'instructor' | 'student';
  user: any;
}

export function DocumentLibrary({ userRole, user }: DocumentLibraryProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'general' | 'general-major' | 'specialized'>('all');
  const [selectedDocument, setSelectedDocument] = useState<any>(null);
  const [ documents, setDocuments ] = useState<any[]>([]);
  const [ loading, setLoading ] = useState(true);
  const [ error, setError ] = useState('');

  // // Mock documents data
  // const documents = [
  //   {
  //     id: 1,
  //     title: 'Introduction to Data Structures',
  //     type: 'general',
  //     courseCode: 'CS101',
  //     courseName: 'Computer Science Fundamentals',
  //     author: 'Dr. Sarah Johnson',
  //     authorRole: 'instructor',
  //     uploadDate: '2026-03-25',
  //     downloads: 145,
  //     comments: 12,
  //     views: 234,
  //     description: 'Comprehensive guide covering basic data structures including arrays, linked lists, and stacks.',
  //     highCredibility: true,
  //   },
  //   {
  //     id: 2,
  //     title: 'Advanced Algorithms - Sorting',
  //     type: 'specialized',
  //     courseCode: 'CS301',
  //     courseName: 'Algorithm Analysis',
  //     author: 'Alex Smith',
  //     authorRole: 'student',
  //     uploadDate: '2026-03-28',
  //     downloads: 87,
  //     comments: 8,
  //     views: 156,
  //     description: 'Detailed notes on various sorting algorithms with complexity analysis.',
  //     highCredibility: false,
  //   },
  //   {
  //     id: 3,
  //     title: 'Database Normalization Guide',
  //     type: 'general-major',
  //     courseCode: 'DB201',
  //     courseName: 'Database Management',
  //     author: 'Dr. Sarah Johnson',
  //     authorRole: 'instructor',
  //     uploadDate: '2026-03-27',
  //     downloads: 203,
  //     comments: 15,
  //     views: 312,
  //     description: 'Step-by-step guide to database normalization from 1NF to BCNF.',
  //     highCredibility: true,
  //   },
  //   {
  //     id: 4,
  //     title: 'Web Development Best Practices',
  //     type: 'general',
  //     courseCode: 'WEB102',
  //     courseName: 'Web Technologies',
  //     author: 'Jordan Lee',
  //     authorRole: 'student',
  //     uploadDate: '2026-03-26',
  //     downloads: 98,
  //     comments: 6,
  //     views: 187,
  //     description: 'Collection of best practices for modern web development.',
  //     highCredibility: false,
  //   },
  //   {
  //     id: 5,
  //     title: 'Machine Learning Fundamentals',
  //     type: 'specialized',
  //     courseCode: 'AI401',
  //     courseName: 'Artificial Intelligence',
  //     author: 'Dr. Michael Chen',
  //     authorRole: 'instructor',
  //     uploadDate: '2026-03-24',
  //     downloads: 267,
  //     comments: 23,
  //     views: 445,
  //     description: 'Introduction to machine learning concepts, algorithms, and applications.',
  //     highCredibility: true,
  //   },
  // ];
useEffect(() => {
  const loadDocuments = async () => {
    try {
      setLoading(true);
      setError('');

      const res: any = await api.get('/documents/recent');
      const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];

      const mapped = rows.map((doc: any) => ({
        id: doc.id,
        documentId: doc.id,
        title: doc.title,
        s3Key: doc.s3Key,
        type: doc.type || 'general',
        courseCode: doc.courseCode || 'N/A',
        courseName: doc.courseName || 'Unknown Course',
        author: doc.author || 'Unknown',
        authorRole: doc.authorRole || 'instructor',
        uploadDate: doc.uploadedAt || '',
        downloads: doc.downloads || 0,
        comments: doc.comments || 0,
        views: doc.views || 0,
        description: doc.description || '',
        highCredibility: true,
      }));

      setDocuments(mapped);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Could not load documents.');
    } finally {
      setLoading(false);
    }
  };

  loadDocuments();
}, []);

const filteredDocuments = documents.filter((doc) => {
  const matchesSearch =
    (doc.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (doc.courseCode || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (doc.courseName || '').toLowerCase().includes(searchQuery.toLowerCase());

  const matchesType = typeFilter === 'all' || doc.type === typeFilter;
  return matchesSearch && matchesType;
});

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <p className="text-gray-600">Loading documents...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg border border-red-200 p-6">
        <p className="text-red-600">{error}</p>
      </div>
    );
  }

  if (selectedDocument) {
    return (
      <DocumentDetail
        document={selectedDocument}
        userRole={userRole}
        user={user}
        onBack={() => setSelectedDocument(null)}
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
              aria-label="Filter documents by type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as any)}
              className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              <option value="all">All Types</option>
              <option value="general">General</option>
              <option value="general-major">General Major</option>
              <option value="specialized">Specialized</option>
            </select>
          </div>
        </div>
      </div>

      {/* Documents List */}
      <div className="space-y-4">
        {filteredDocuments.map((doc) => (
          <div
            key={doc.id}
            className="bg-white rounded-lg border border-gray-200 p-6 hover:shadow-md transition-shadow cursor-pointer"
            onClick={() => setSelectedDocument(doc)}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-gray-900">{doc.title}</h3>
                  {doc.highCredibility && (
                    <span className="flex items-center gap-1 bg-green-100 text-green-700 px-2 py-1 rounded text-xs">
                      <CheckCircle size={14} />
                      High Credibility
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 text-gray-600 mb-2">
                  <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded text-xs">
                    {doc.type === 'general' ? 'General' : doc.type === 'general-major' ? 'General Major' : 'Specialized'}
                  </span>
                  <span>{doc.courseCode}</span>
                  <span>•</span>
                  <span>{doc.courseName}</span>
                </div>
                <p className="text-gray-600 mb-3">{doc.description}</p>
                <div className="flex items-center gap-4 text-gray-500">
                  <span>By {doc.author} ({doc.authorRole})</span>
                  <span>•</span>
                  <span>{doc.uploadDate || 'Unknown date'}</span>
                </div>
              </div>
              <FileText className="text-blue-600" size={32} />
            </div>

            <div className="flex items-center gap-6 pt-3 border-t border-gray-100">
              <div className="flex items-center gap-2 text-gray-600">
                <Eye size={16} />
                <span>{doc.views} views</span>
              </div>
              <div className="flex items-center gap-2 text-gray-600">
                <Download size={16} />
                <span>{doc.downloads} downloads</span>
              </div>
              <div className="flex items-center gap-2 text-gray-600">
                <MessageSquare size={16} />
                <span>{doc.comments} comments</span>
              </div>
            </div>
          </div>
        ))}

        {filteredDocuments.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <FileText className="mx-auto mb-4 text-gray-400" size={48} />
            <p>No documents found matching your search criteria.</p>
          </div>
        )}
      </div>
    </div>
  );
}
