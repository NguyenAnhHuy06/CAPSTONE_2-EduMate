import { useState } from 'react';
import { ArrowLeft, Download, MessageSquare, Sparkles, CheckCircle, Send } from 'lucide-react';
import { QuizCreator } from '../pages/QuizCreator';
import { FlashcardCreator } from '../pages/FlashcardCreator';
import { FlashcardViewer } from '../pages/student/FlashcardViewer';

interface DocumentDetailProps {
  document: any;
  userRole: 'instructor' | 'student';
  user: any;
  onBack: () => void;
}

export function DocumentDetail({ document, userRole, user, onBack }: DocumentDetailProps) {
  const [showQuizCreator, setShowQuizCreator] = useState(false);
  const [showFlashcardCreator, setShowFlashcardCreator] = useState(false);
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

  if (showQuizCreator) {
    return (
      <QuizCreator
        document={document}
        userRole={userRole}
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
        <div className="flex flex-wrap gap-3 pt-4 border-t border-gray-100">
          <button className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            <Download size={18} />
            Download
          </button>
          <button
            onClick={() => setShowQuizCreator(true)}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors"
          >
            <Sparkles size={18} />
            Create Quiz with AI
          </button>
          {userRole === 'student' && (
            <button
              onClick={() => setShowFlashcardCreator(true)}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors"
            >
              <Sparkles size={18} />
              Create Flashcards with AI
            </button>
          )}
        </div>
      </div>

      {/* Document Content Preview */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <h3 className="mb-4">Document Preview</h3>
        <div className="bg-gray-50 p-6 rounded-lg border border-gray-200 min-h-[400px]">
          <p className="text-gray-600 mb-4">
            This is a preview of the document content. In a real application, the actual document would be displayed here.
          </p>
          <div className="space-y-4">
            <div>
              <h4 className="mb-2">1. Introduction</h4>
              <p className="text-gray-700">
                Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
              </p>
            </div>
            <div>
              <h4 className="mb-2">2. Key Concepts</h4>
              <p className="text-gray-700">
                Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
              </p>
            </div>
            <div>
              <h4 className="mb-2">3. Examples</h4>
              <p className="text-gray-700">
                Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.
              </p>
            </div>
          </div>
        </div>
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
