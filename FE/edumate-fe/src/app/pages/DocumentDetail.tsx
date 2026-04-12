import { useState, useEffect } from 'react';
import { ArrowLeft, Download, MessageSquare, Sparkles, CheckCircle, Send, ExternalLink, AlertCircle, Loader2 } from 'lucide-react';
import { QuizCreator } from '../pages/QuizCreator';
import { FlashcardCreator } from '../pages/FlashcardCreator';
import { FlashcardViewer } from '../pages/student/FlashcardViewer';
import { AIChatPanel } from './AIChatPanel';
import api from '../../services/api';

interface DocumentDetailProps {
  document: any;
  userRole: 'instructor' | 'student';
  user: any;
  onBack: () => void;
  onOpenQuiz?: (document: any) => void;
}

export function DocumentDetail({ document, userRole, user, onBack, onOpenQuiz }: DocumentDetailProps) {
  const [showQuizCreator, setShowQuizCreator] = useState(false);
  const [showFlashcardCreator, setShowFlashcardCreator] = useState(false);
  const [showAIChat, setShowAIChat] = useState(false);

  // Status/action states
  const [docStatus, setDocStatus] = useState(document.status || 'pending');
  const [isVerifying, setIsVerifying] = useState(false);

  // Preview state
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const isPdf = document.s3Key?.toLowerCase().endsWith('.pdf');
  // Google Docs Viewer hỗ trợ cả .doc (cũ) và .docx (mới), giữ nguyên màu sắc/định dạng
  const isWord = document.s3Key?.toLowerCase().endsWith('.docx') ||
                 document.s3Key?.toLowerCase().endsWith('.doc');

  useEffect(() => {
    if (!isPdf || !document.s3Key) return;
    const fetchPreview = async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const res = await fetch(`/api/documents/preview?key=${encodeURIComponent(document.s3Key)}`);
        const data = await res.json();
        if (data.success) {
          setPreviewUrl(data.url);
        } else {
          setPreviewError('Could not load preview.');
        }
      } catch {
        setPreviewError('Failed to connect to server.');
      } finally {
        setPreviewLoading(false);
      }
    };
    fetchPreview();
  }, [document.s3Key, isPdf]);

  // Word preview via Google Docs Viewer (giữ toàn bộ màu sắc và định dạng)
  const [wordViewerUrl, setWordViewerUrl] = useState<string | null>(null);
  const [wordLoading, setWordLoading] = useState(false);
  const [wordError, setWordError] = useState<string | null>(null);

  useEffect(() => {
    if (!isWord || !document.s3Key) return;
    const fetchWordViewer = async () => {
      setWordLoading(true);
      setWordError(null);
      try {
        // Lấy signed URL hợp lệ từ Backend
        const res = await fetch(`/api/documents/preview?key=${encodeURIComponent(document.s3Key)}`);
        const data = await res.json();
        if (data.success && data.url) {
          // Nhúng vào Google Docs Viewer để render đầy đủ màu sắc/định dạng
          const viewerUrl = `https://docs.google.com/viewer?url=${encodeURIComponent(data.url)}&embedded=true`;
          setWordViewerUrl(viewerUrl);
        } else {
          setWordError('Could not load document preview.');
        }
      } catch {
        setWordError('Failed to connect to server.');
      } finally {
        setWordLoading(false);
      }
    };
    fetchWordViewer();
  }, [document.s3Key, isWord]);
  const [comments, setComments] = useState([
    {
      id: 1,
      author: 'Emma Wilson',
      text: 'This is really helpful! Thanks for sharing.',
      date: '2026-03-29',
      role: 'student',
    },
    {
      id: 2,
      author: 'Dr. Sarah Johnson',
      text: 'Great resource. I\'ve added some additional references in the discussion.',
      date: '2026-03-28',
      role: 'instructor',
    },
  ]);
  const [newComment, setNewComment] = useState('');

  const handleAddComment = () => {
    if (newComment.trim()) {
      setComments([
        ...comments,
        {
          id: comments.length + 1,
          author: user.name,
          text: newComment,
          date: new Date().toISOString().split('T')[0],
          role: userRole,
        },
      ]);
      setNewComment('');
    }
  };

  const handleVerify = async () => {
    if (!document.documentId) return alert('No DB ID available');
    setIsVerifying(true);
    try {
      const res: any = await api.patch(`/documents/${document.documentId}/verify`);
      if (res.success) {
        setDocStatus('verified');
        alert('Document verified & indexed successfully!');
      } else {
        alert(res.message || 'Error verifying document');
      }
    } catch (e: any) {
      alert(e.message || 'Error verifying document');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleReject = async () => {
    if (!document.documentId) return alert('No DB ID available');
    setIsVerifying(true);
    try {
      const res: any = await api.patch(`/documents/${document.documentId}/reject`);
      if (res.success) {
        setDocStatus('rejected');
        alert('Document rejected.');
      } else {
        alert(res.message || 'Error rejecting document');
      }
    } catch (e: any) {
      alert(e.message || 'Error rejecting document');
    } finally {
      setIsVerifying(false);
    }
  };

  // Render QuizCreator inline khi user click nút ✨
  if (showQuizCreator) {
    return (
      <QuizCreator
        document={document}
        userRole={userRole}
        user={user}
        onBack={() => setShowQuizCreator(false)}
      />
    );
  }

  if (showFlashcardCreator) {
    // For students, use the simple viewer; for instructors, use the full creator
    if (userRole === 'student') {
      return (
        <FlashcardViewer
          document={document}
          onBack={() => setShowFlashcardCreator(false)}
        />
      );
    }
    return (
      <FlashcardCreator
        document={document}
        onBack={() => setShowFlashcardCreator(false)}
      />
    );
  }

  return (
    <div>
      {/* Back Button */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-blue-600 hover:text-blue-700 mb-6"
      >
        <ArrowLeft size={20} />
        Back to Documents
      </button>

      {/* Document Header */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <h2>{document.title}</h2>
              {document.highCredibility && (
                <span className="flex items-center gap-1 bg-green-100 text-green-700 px-2 py-1 rounded text-xs">
                  <CheckCircle size={14} />
                  High Credibility
                </span>
              )}
              {docStatus && (
                <span className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold ${
                  docStatus === 'verified' ? 'bg-green-100 text-green-700' : 
                  docStatus === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  {docStatus === 'verified' ? 'Verified' : docStatus === 'rejected' ? 'Rejected' : 'Pending Verification'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 text-gray-600 mb-3">
              <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded">
                {document.type === 'general' ? 'General' : document.type === 'general-major' ? 'General Major' : 'Specialized'}
              </span>
              <span>{document.courseCode}</span>
              <span>•</span>
              <span>{document.courseName}</span>
            </div>
            <p className="text-gray-700 mb-3">{document.description}</p>
            <div className="flex items-center gap-4 text-gray-500">
              <span>Uploaded by {document.author} ({document.authorRole})</span>
              <span>•</span>
              <span>{document.uploadDate}</span>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3 pt-4 border-t border-gray-100 items-center justify-between">
          <div className="flex gap-3">
            <button 
              onClick={() => {
                if (document.s3Key) {
                  const downloadUrl = `/api/documents/download?key=${encodeURIComponent(document.s3Key)}`;
                  window.open(downloadUrl, '_blank');
                } else {
                  alert("S3 Key not available for this document.");
                }
              }}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Download size={18} />
              Download
            </button>
            <button
              onClick={() => setShowQuizCreator(true)}
              title="Generate Quiz with AI"
              className="flex items-center gap-2 px-4 py-2 bg-white border border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors"
            >
              <Sparkles size={18} />
              Quiz
            </button>
            <button
              onClick={() => setShowFlashcardCreator(true)}
              title={userRole === 'student' ? 'Study Flashcards' : 'Generate Flashcards with AI'}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors"
            >
                <Sparkles size={18} />
              Flashcards
            </button>

            <button
              onClick={() => setShowAIChat(!showAIChat)}
              title="Chat about this document"
              className={`flex items-center gap-2 px-4 py-2 border rounded-lg transition-colors ${showAIChat ? 'bg-blue-50 border-blue-600 text-blue-600' : 'bg-white border-blue-600 text-blue-600 hover:bg-blue-50'}`}
            >
              <MessageSquare size={18} />
              {showAIChat ? 'Close Chat' : 'Chat with AI'}
            </button>
          </div>
          
          {userRole === 'instructor' && docStatus === 'pending' && (
            <div className="flex gap-2">
              <button 
                onClick={handleVerify}
                disabled={isVerifying}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                <CheckCircle size={16} />
                {isVerifying ? 'Processing...' : 'Verify'}
              </button>
              <button 
                onClick={handleReject}
                disabled={isVerifying}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-red-200 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Document Content & Chat Area */}
      <div className={`grid gap-6 ${showAIChat ? 'grid-cols-[2fr_1fr]' : 'grid-cols-1'}`}>
        <div className="bg-white rounded-lg border border-gray-200 p-4 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <h3>Document Preview</h3>
          {isPdf && previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-sm text-blue-600 hover:underline"
            >
              <ExternalLink size={14} />
              Open in new tab
            </a>
          )}
        </div>

        {/* PDF Preview */}
        {isPdf ? (
          <div className="rounded-lg border border-gray-200 overflow-hidden bg-gray-50" style={{ height: '700px' }}>
            {previewLoading && (
              <div className="flex items-center justify-center h-full text-gray-500">
                <Loader2 className="animate-spin mr-2" size={24} />
                <span>Loading preview...</span>
              </div>
            )}
            {previewError && !previewLoading && (
              <div className="flex flex-col items-center justify-center h-full text-red-500 gap-2">
                <AlertCircle size={40} />
                <p>{previewError}</p>
              </div>
            )}
            {previewUrl && !previewLoading && !previewError && (
              <iframe
                src={previewUrl}
                title={document.title}
                className="w-full h-full border-0"
                loading="lazy"
              />
            )}
          </div>
        ) : isWord ? (
          // Word (.doc & .docx) Preview - Google Docs Viewer giữ nguyên màu sắc & định dạng
          <div className="rounded-lg border border-gray-200 overflow-hidden bg-gray-50" style={{ height: '700px' }}>
            {wordLoading && (
              <div className="flex items-center justify-center h-full text-gray-500">
                <Loader2 className="animate-spin mr-2" size={24} />
                <span>Loading document preview...</span>
              </div>
            )}
            {wordError && !wordLoading && (
              <div className="flex flex-col items-center justify-center h-full text-red-500 gap-2">
                <AlertCircle size={40} />
                <p>{wordError}</p>
              </div>
            )}
            {wordViewerUrl && !wordLoading && !wordError && (
              <iframe
                src={wordViewerUrl}
                title={document.title}
                className="w-full h-full border-0"
                loading="lazy"
              />
            )}
          </div>
        ) : (
          // Non-PDF Fallback
          <div className="flex flex-col items-center justify-center bg-gray-50 rounded-lg border border-dashed border-gray-300 py-16 gap-4">
            <AlertCircle size={48} className="text-gray-400" />
            <p className="text-gray-600 text-center">
              Preview is not available for <strong>{document.s3Key?.split('.').pop()?.toUpperCase()}</strong> files.
            </p>
            <p className="text-gray-400 text-sm">Please download the file to view its contents.</p>
            <button
              onClick={() => {
                if (document.s3Key) {
                  const downloadUrl = `/api/documents/download?key=${encodeURIComponent(document.s3Key)}`;
                  window.open(downloadUrl, '_blank');
                }
              }}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Download size={18} />
              Download to View
            </button>
          </div>
        )}
        </div>

        {/* AI Chat Panel */}
        {showAIChat && (
          <div className="h-[730px]">
            <AIChatPanel
               documentId={document.documentId}
               s3Key={document.s3Key}
               onClose={() => setShowAIChat(false)}
            />
          </div>
        )}
      </div>

      {/* Discussion Section */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="mb-4 flex items-center gap-2">
          <MessageSquare size={24} />
          Discussion ({comments.length})
        </h3>

        {/* Comments List */}
        <div className="space-y-4 mb-6">
          {comments.map((comment) => (
            <div key={comment.id} className="border-b border-gray-100 pb-4 last:border-0">
              <div className="flex items-center gap-2 mb-2">
                <p className="text-gray-900">{comment.author}</p>
                <span className={`px-2 py-1 rounded text-xs ${
                  comment.role === 'instructor'
                    ? 'bg-purple-100 text-purple-700'
                    : 'bg-blue-100 text-blue-700'
                }`}>
                  {comment.role}
                </span>
                <span className="text-gray-500">•</span>
                <span className="text-gray-500">{comment.date}</span>
              </div>
              <p className="text-gray-700">{comment.text}</p>
            </div>
          ))}
        </div>

        {/* Add Comment */}
        <div>
          <label className="block text-gray-700 mb-2">
            Add a comment
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleAddComment()}
              placeholder="Share your thoughts..."
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            <button
              onClick={handleAddComment}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
            >
              <Send size={18} />
              Post
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
