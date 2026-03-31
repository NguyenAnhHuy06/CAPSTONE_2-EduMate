import { useState } from 'react';
import {
    FileText,
    Edit3,
    CheckCircle,
    BarChart3,
    Database,
    Plus,
    Search,
    Clock,
    Users,
    Eye,
    Trash2,
    TrendingUp,
    X,
    Save,
    ArrowLeft,
} from 'lucide-react';

interface Quiz {
    id: number;
    title: string;
    subject: string;
    status: 'draft' | 'published';
    questions: any[];
    duration: number;
    passPercentage: number;
    attemptsAllowed: string;
    participants: number;
    averageScore: number;
    createdDate: string;
    publishedDate?: string;
    startDate?: string;
    endDate?: string;
}

interface Question {
    id: number;
    question: string;
    type: 'multiple-choice' | 'true-false' | 'short-answer';
    topic: string;
    difficulty: 'easy' | 'medium' | 'hard';
    options?: string[];
    correctAnswer?: string;
}

interface QuizManagementProps {
    user: any;
}

type QuizTab = 'all' | 'draft' | 'published' | 'analytics' | 'question-bank' | 'create' | 'edit';
type ModalType = 'delete-quiz' | 'delete-question' | 'view-quiz' | 'add-question' | 'edit-question' | 'select-questions' | null;

export function QuizManagement({ user }: QuizManagementProps) {
    const [activeTab, setActiveTab] = useState<QuizTab>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [filterSubject, setFilterSubject] = useState('all');
    const [filterStatus, setFilterStatus] = useState('all');
    const [modalType, setModalType] = useState<ModalType>(null);
    const [selectedItem, setSelectedItem] = useState<any>(null);

    // Question Bank Filters
    const [qbFilterType, setQbFilterType] = useState('all');
    const [qbFilterTopic, setQbFilterTopic] = useState('all');
    const [qbFilterDifficulty, setQbFilterDifficulty] = useState('all');

    // Quiz State Management
    const [quizzes, setQuizzes] = useState<Quiz[]>([
        {
            id: 1,
            title: 'Introduction to Algorithms - Midterm',
            subject: 'CS201',
            status: 'published',
            questions: [],
            duration: 60,
            passPercentage: 70,
            attemptsAllowed: '2',
            participants: 45,
            averageScore: 78,
            createdDate: '2026-03-15',
            publishedDate: '2026-03-20',
        },
        {
            id: 2,
            title: 'Data Structures Week 5 Quiz',
            subject: 'CS202',
            status: 'published',
            questions: [],
            duration: 30,
            passPercentage: 70,
            attemptsAllowed: '1',
            participants: 52,
            averageScore: 82,
            createdDate: '2026-03-10',
            publishedDate: '2026-03-18',
        },
        {
            id: 3,
            title: 'Database Design Practice',
            subject: 'CS301',
            status: 'draft',
            questions: [],
            duration: 45,
            passPercentage: 70,
            attemptsAllowed: '1',
            participants: 0,
            averageScore: 0,
            createdDate: '2026-03-28',
        },
        {
            id: 4,
            title: 'OOP Concepts Final Exam',
            subject: 'CS203',
            status: 'draft',
            questions: [],
            duration: 90,
            passPercentage: 70,
            attemptsAllowed: '1',
            participants: 0,
            averageScore: 0,
            createdDate: '2026-03-29',
        },
    ]);

    // Question Bank State
    const [questionBank, setQuestionBank] = useState<Question[]>([
        {
            id: 1,
            question: 'What is the time complexity of binary search?',
            type: 'multiple-choice',
            topic: 'Algorithms',
            difficulty: 'medium',
            options: ['O(n)', 'O(log n)', 'O(n²)', 'O(1)'],
            correctAnswer: 'O(log n)',
        },
        {
            id: 2,
            question: 'A stack follows LIFO principle.',
            type: 'true-false',
            topic: 'Data Structures',
            difficulty: 'easy',
            correctAnswer: 'true',
        },
        {
            id: 3,
            question: 'Explain the difference between abstract class and interface.',
            type: 'short-answer',
            topic: 'OOP',
            difficulty: 'hard',
        },
        {
            id: 4,
            question: 'Which data structure is best for implementing a priority queue?',
            type: 'multiple-choice',
            topic: 'Data Structures',
            difficulty: 'medium',
            options: ['Array', 'Heap', 'Stack', 'Queue'],
            correctAnswer: 'Heap',
        },
    ]);

    // Quiz Form State
    const [quizForm, setQuizForm] = useState({
        title: '',
        subject: '',
        duration: '',
        passPercentage: '70',
        attemptsAllowed: '1',
        startDate: '',
        endDate: '',
        selectedQuestions: [] as number[],
    });

    // Question Form State
    const [questionForm, setQuestionForm] = useState({
        question: '',
        type: 'multiple-choice' as 'multiple-choice' | 'true-false' | 'short-answer',
        topic: '',
        difficulty: 'medium' as 'easy' | 'medium' | 'hard',
        options: ['', '', '', ''],
        correctAnswer: '',
    });

    // Edit mode
    const [editingQuizId, setEditingQuizId] = useState<number | null>(null);
    const [editingQuestionId, setEditingQuestionId] = useState<number | null>(null);

    // Filtered data
    const filteredQuizzes = quizzes.filter((quiz) => {
        const matchesSearch = quiz.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            quiz.subject.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesSubject = filterSubject === 'all' || quiz.subject === filterSubject;
        const matchesStatus = filterStatus === 'all' || quiz.status === filterStatus;

        if (activeTab === 'draft') return quiz.status === 'draft' && matchesSearch && matchesSubject;
        if (activeTab === 'published') return quiz.status === 'published' && matchesSearch && matchesSubject;

        return matchesSearch && matchesSubject && matchesStatus;
    });

    const filteredQuestions = questionBank.filter((question) => {
        const matchesType = qbFilterType === 'all' || question.type === qbFilterType;
        const matchesTopic = qbFilterTopic === 'all' || question.topic.toLowerCase() === qbFilterTopic.toLowerCase();
        const matchesDifficulty = qbFilterDifficulty === 'all' || question.difficulty === qbFilterDifficulty;
        return matchesType && matchesTopic && matchesDifficulty;
    });

    // Quiz CRUD Operations
    const handleCreateQuiz = (status: 'draft' | 'published') => {
        const selectedQuestionsData = questionBank.filter(q => quizForm.selectedQuestions.includes(q.id));

        const newQuiz: Quiz = {
            id: Date.now(),
            title: quizForm.title,
            subject: quizForm.subject,
            status,
            questions: selectedQuestionsData,
            duration: parseInt(quizForm.duration),
            passPercentage: parseInt(quizForm.passPercentage),
            attemptsAllowed: quizForm.attemptsAllowed,
            participants: 0,
            averageScore: 0,
            createdDate: new Date().toISOString().split('T')[0],
            publishedDate: status === 'published' ? new Date().toISOString().split('T')[0] : undefined,
            startDate: quizForm.startDate,
            endDate: quizForm.endDate,
        };

        setQuizzes([...quizzes, newQuiz]);
        resetQuizForm();
        setActiveTab('all');
        alert(`Quiz ${status === 'published' ? 'published' : 'saved as draft'} successfully!`);
    };

    const handleUpdateQuiz = (status: 'draft' | 'published') => {
        if (!editingQuizId) return;

        const selectedQuestionsData = questionBank.filter(q => quizForm.selectedQuestions.includes(q.id));

        setQuizzes(quizzes.map(quiz =>
            quiz.id === editingQuizId
                ? {
                    ...quiz,
                    title: quizForm.title,
                    subject: quizForm.subject,
                    status,
                    questions: selectedQuestionsData,
                    duration: parseInt(quizForm.duration),
                    passPercentage: parseInt(quizForm.passPercentage),
                    attemptsAllowed: quizForm.attemptsAllowed,
                    publishedDate: status === 'published' && !quiz.publishedDate ? new Date().toISOString().split('T')[0] : quiz.publishedDate,
                    startDate: quizForm.startDate,
                    endDate: quizForm.endDate,
                }
                : quiz
        ));

        resetQuizForm();
        setEditingQuizId(null);
        setActiveTab('all');
        alert(`Quiz updated successfully!`);
    };

    const handlePublishQuiz = (quizId: number) => {
        setQuizzes(quizzes.map(quiz =>
            quiz.id === quizId
                ? { ...quiz, status: 'published' as const, publishedDate: new Date().toISOString().split('T')[0] }
                : quiz
        ));
        alert('Quiz published successfully!');
    };

    const handleDeleteQuiz = () => {
        if (!selectedItem) return;
        setQuizzes(quizzes.filter(quiz => quiz.id !== selectedItem.id));
        setModalType(null);
        setSelectedItem(null);
        alert('Quiz deleted successfully!');
    };

    const handleEditQuiz = (quiz: Quiz) => {
        setEditingQuizId(quiz.id);
        setQuizForm({
            title: quiz.title,
            subject: quiz.subject,
            duration: quiz.duration.toString(),
            passPercentage: quiz.passPercentage.toString(),
            attemptsAllowed: quiz.attemptsAllowed,
            startDate: quiz.startDate || '',
            endDate: quiz.endDate || '',
            selectedQuestions: quiz.questions.map(q => q.id),
        });
        setActiveTab('edit');
    };

    const resetQuizForm = () => {
        setQuizForm({
            title: '',
            subject: '',
            duration: '',
            passPercentage: '70',
            attemptsAllowed: '1',
            startDate: '',
            endDate: '',
            selectedQuestions: [],
        });
    };

    // Question CRUD Operations
    const handleAddQuestion = () => {
        const newQuestion: Question = {
            id: Date.now(),
            question: questionForm.question,
            type: questionForm.type,
            topic: questionForm.topic,
            difficulty: questionForm.difficulty,
            options: questionForm.type === 'multiple-choice' ? questionForm.options.filter(o => o) : undefined,
            correctAnswer: questionForm.correctAnswer,
        };

        setQuestionBank([...questionBank, newQuestion]);
        resetQuestionForm();
        setModalType(null);
        alert('Question added successfully!');
    };

    const handleUpdateQuestion = () => {
        if (!editingQuestionId) return;

        setQuestionBank(questionBank.map(q =>
            q.id === editingQuestionId
                ? {
                    ...q,
                    question: questionForm.question,
                    type: questionForm.type,
                    topic: questionForm.topic,
                    difficulty: questionForm.difficulty,
                    options: questionForm.type === 'multiple-choice' ? questionForm.options.filter(o => o) : undefined,
                    correctAnswer: questionForm.correctAnswer,
                }
                : q
        ));

        resetQuestionForm();
        setEditingQuestionId(null);
        setModalType(null);
        alert('Question updated successfully!');
    };

    const handleDeleteQuestion = () => {
        if (!selectedItem) return;
        setQuestionBank(questionBank.filter(q => q.id !== selectedItem.id));
        setModalType(null);
        setSelectedItem(null);
        alert('Question deleted successfully!');
    };

    const handleEditQuestion = (question: Question) => {
        setEditingQuestionId(question.id);
        setQuestionForm({
            question: question.question,
            type: question.type,
            topic: question.topic,
            difficulty: question.difficulty,
            options: question.options || ['', '', '', ''],
            correctAnswer: question.correctAnswer || '',
        });
        setModalType('edit-question');
    };

    const resetQuestionForm = () => {
        setQuestionForm({
            question: '',
            type: 'multiple-choice',
            topic: '',
            difficulty: 'medium',
            options: ['', '', '', ''],
            correctAnswer: '',
        });
    };

    const toggleQuestionSelection = (questionId: number) => {
        if (quizForm.selectedQuestions.includes(questionId)) {
            setQuizForm({
                ...quizForm,
                selectedQuestions: quizForm.selectedQuestions.filter(id => id !== questionId),
            });
        } else {
            setQuizForm({
                ...quizForm,
                selectedQuestions: [...quizForm.selectedQuestions, questionId],
            });
        }
    };

    // Render Modal
    const renderModal = () => {
        if (!modalType) return null;

        const closeModal = () => {
            setModalType(null);
            setSelectedItem(null);
            if (modalType === 'add-question' || modalType === 'edit-question') {
                resetQuestionForm();
                setEditingQuestionId(null);
            }
        };

        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                    {/* Delete Quiz Modal */}
                    {modalType === 'delete-quiz' && (
                        <div className="p-6">
                            <h3 className="mb-4">Delete Quiz</h3>
                            <p className="text-gray-600 mb-6">
                                Are you sure you want to delete "{selectedItem?.title}"? This action cannot be undone.
                            </p>
                            <div className="flex items-center gap-3 justify-end">
                                <button
                                    onClick={closeModal}
                                    className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleDeleteQuiz}
                                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Delete Question Modal */}
                    {modalType === 'delete-question' && (
                        <div className="p-6">
                            <h3 className="mb-4">Delete Question</h3>
                            <p className="text-gray-600 mb-6">
                                Are you sure you want to delete this question? This action cannot be undone.
                            </p>
                            <div className="flex items-center gap-3 justify-end">
                                <button
                                    onClick={closeModal}
                                    className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleDeleteQuestion}
                                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    )}

                    {/* View Quiz Modal */}
                    {modalType === 'view-quiz' && selectedItem && (
                        <div className="p-6">
                            <div className="flex items-center justify-between mb-6">
                                <h3>{selectedItem.title}</h3>
                                <button
                                    onClick={closeModal}
                                    className="p-2 hover:bg-gray-100 rounded-lg"
                                    aria-label="Close Modal"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                            <div className="space-y-4">
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <p className="text-gray-500 text-sm">Subject</p>
                                        <p className="text-gray-900">{selectedItem.subject}</p>
                                    </div>
                                    <div>
                                        <p className="text-gray-500 text-sm">Status</p>
                                        <p className="text-gray-900">{selectedItem.status}</p>
                                    </div>
                                    <div>
                                        <p className="text-gray-500 text-sm">Duration</p>
                                        <p className="text-gray-900">{selectedItem.duration} minutes</p>
                                    </div>
                                    <div>
                                        <p className="text-gray-500 text-sm">Pass Percentage</p>
                                        <p className="text-gray-900">{selectedItem.passPercentage}%</p>
                                    </div>
                                    <div>
                                        <p className="text-gray-500 text-sm">Participants</p>
                                        <p className="text-gray-900">{selectedItem.participants}</p>
                                    </div>
                                    <div>
                                        <p className="text-gray-500 text-sm">Average Score</p>
                                        <p className="text-gray-900">{selectedItem.averageScore}%</p>
                                    </div>
                                </div>
                                <div>
                                    <p className="text-gray-500 text-sm mb-2">Questions ({selectedItem.questions.length})</p>
                                    {selectedItem.questions.length > 0 ? (
                                        <div className="space-y-2">
                                            {selectedItem.questions.map((q: any, idx: number) => (
                                                <div key={idx} className="p-3 bg-gray-50 rounded-lg">
                                                    <p className="text-gray-900">{idx + 1}. {q.question}</p>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="text-gray-500">No questions added yet</p>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Add/Edit Question Modal */}
                    {(modalType === 'add-question' || modalType === 'edit-question') && (
                        <div className="p-6">
                            <div className="flex items-center justify-between mb-6">
                                <h3>{editingQuestionId ? 'Edit Question' : 'Add New Question'}</h3>
                                <button
                                    onClick={closeModal}
                                    className="p-2 hover:bg-gray-100 rounded-lg"
                                    aria-label="Close Modal"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-gray-700 mb-2">Question</label>
                                    <textarea
                                        value={questionForm.question}
                                        onChange={(e) => setQuestionForm({ ...questionForm, question: e.target.value })}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        rows={3}
                                        placeholder="Enter your question"
                                    />
                                </div>
                                <div className="grid grid-cols-3 gap-4">
                                    <div>
                                        <label className="block text-gray-700 mb-2">Type</label>
                                        <select
                                            value={questionForm.type}
                                            onChange={(e) => setQuestionForm({ ...questionForm, type: e.target.value as any })}
                                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                            aria-label="Question Type"
                                        >
                                            <option value="multiple-choice">Multiple Choice</option>
                                            <option value="true-false">True/False</option>
                                            <option value="short-answer">Short Answer</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-gray-700 mb-2">Topic</label>
                                        <input
                                            type="text"
                                            value={questionForm.topic}
                                            onChange={(e) => setQuestionForm({ ...questionForm, topic: e.target.value })}
                                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                            placeholder="e.g., Algorithms"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-gray-700 mb-2">Difficulty</label>
                                        <select
                                            value={questionForm.difficulty}
                                            onChange={(e) => setQuestionForm({ ...questionForm, difficulty: e.target.value as any })}
                                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                            aria-label="Question Difficulty"
                                        >
                                            <option value="easy">Easy</option>
                                            <option value="medium">Medium</option>
                                            <option value="hard">Hard</option>
                                        </select>
                                    </div>
                                </div>

                                {questionForm.type === 'multiple-choice' && (
                                    <div>
                                        <label className="block text-gray-700 mb-2">Options</label>
                                        <div className="space-y-2">
                                            {questionForm.options.map((option, idx) => (
                                                <div key={idx} className="flex items-center gap-2">
                                                    <span className="text-gray-600">{String.fromCharCode(65 + idx)}.</span>
                                                    <input
                                                        type="text"
                                                        value={option}
                                                        onChange={(e) => {
                                                            const newOptions = [...questionForm.options];
                                                            newOptions[idx] = e.target.value;
                                                            setQuestionForm({ ...questionForm, options: newOptions });
                                                        }}
                                                        className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                                        placeholder={`Option ${idx + 1}`}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {(questionForm.type === 'multiple-choice' || questionForm.type === 'true-false') && (
                                    <div>
                                        <label className="block text-gray-700 mb-2">Correct Answer</label>
                                        {questionForm.type === 'multiple-choice' ? (
                                            <select
                                                value={questionForm.correctAnswer}
                                                onChange={(e) => setQuestionForm({ ...questionForm, correctAnswer: e.target.value })}
                                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                                aria-label="Correct Answer"
                                            >
                                                <option value="">Select correct answer</option>
                                                {questionForm.options.filter(o => o).map((option, idx) => (
                                                    <option key={idx} value={option}>{option}</option>
                                                ))}
                                            </select>
                                        ) : (
                                            <select
                                                value={questionForm.correctAnswer}
                                                onChange={(e) => setQuestionForm({ ...questionForm, correctAnswer: e.target.value })}
                                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                                aria-label="Correct Answer"
                                            >
                                                <option value="">Select correct answer</option>
                                                <option value="true">True</option>
                                                <option value="false">False</option>
                                            </select>
                                        )}
                                    </div>
                                )}

                                <div className="flex items-center gap-3 justify-end pt-4 border-t border-gray-200">
                                    <button
                                        onClick={closeModal}
                                        className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={editingQuestionId ? handleUpdateQuestion : handleAddQuestion}
                                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                    >
                                        {editingQuestionId ? 'Update' : 'Add'} Question
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Select Questions Modal */}
                    {modalType === 'select-questions' && (
                        <div className="p-6">
                            <div className="flex items-center justify-between mb-6">
                                <h3>Select Questions from Bank</h3>
                                <button
                                    onClick={closeModal}
                                    className="p-2 hover:bg-gray-100 rounded-lg"
                                    aria-label="Close Modal"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                            <div className="space-y-4 max-h-96 overflow-y-auto">
                                {questionBank.map((question) => (
                                    <div
                                        key={question.id}
                                        className={`p-4 border rounded-lg cursor-pointer transition-colors ${quizForm.selectedQuestions.includes(question.id)
                                            ? 'border-blue-600 bg-blue-50'
                                            : 'border-gray-200 hover:border-blue-300'
                                            }`}
                                        onClick={() => toggleQuestionSelection(question.id)}
                                    >
                                        <div className="flex items-start justify-between">
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <input
                                                        type="checkbox"
                                                        checked={quizForm.selectedQuestions.includes(question.id)}
                                                        onChange={() => { }}
                                                        className="w-4 h-4"
                                                        aria-label={`Select question: ${question.question}`}
                                                    />
                                                    <span className="px-2 py-1 rounded text-xs bg-blue-100 text-blue-700">
                                                        {question.type}
                                                    </span>
                                                    <span className={`px-2 py-1 rounded text-xs ${question.difficulty === 'easy' ? 'bg-green-100 text-green-700' :
                                                        question.difficulty === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                                                            'bg-red-100 text-red-700'
                                                        }`}>
                                                        {question.difficulty}
                                                    </span>
                                                </div>
                                                <p className="text-gray-900">{question.question}</p>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div className="flex items-center justify-between pt-4 border-t border-gray-200 mt-4">
                                <p className="text-gray-600">{quizForm.selectedQuestions.length} questions selected</p>
                                <button
                                    onClick={closeModal}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                >
                                    Done
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    // Render All Quizzes
    const renderAllQuizzes = () => (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h2>All Quizzes</h2>
                <button
                    onClick={() => setActiveTab('create')}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                    <Plus size={20} />
                    Create Quiz
                </button>
            </div>

            {/* Filters */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={20} />
                        <input
                            type="text"
                            placeholder="Search quizzes..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                    </div>
                    <select
                        title="Filter by Subject"
                        value={filterSubject}
                        onChange={(e) => setFilterSubject(e.target.value)}
                        className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                        <option value="all">All Subjects</option>
                        <option value="CS201">CS201</option>
                        <option value="CS202">CS202</option>
                        <option value="CS203">CS203</option>
                        <option value="CS301">CS301</option>
                    </select>
                    <select
                        title="Filter by Status"
                        value={filterStatus}
                        onChange={(e) => setFilterStatus(e.target.value)}
                        className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                        <option value="all">All Status</option>
                        <option value="draft">Draft</option>
                        <option value="published">Published</option>
                    </select>
                </div>
            </div>

            {/* Quizzes List */}
            <div className="space-y-4">
                {filteredQuizzes.length === 0 ? (
                    <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                        No quizzes found. Create your first quiz!
                    </div>
                ) : (
                    filteredQuizzes.map((quiz) => (
                        <div key={quiz.id} className="bg-white rounded-lg border border-gray-200 p-6 hover:shadow-md transition-shadow">
                            <div className="flex items-start justify-between mb-4">
                                <div className="flex-1">
                                    <div className="flex items-center gap-3 mb-2">
                                        <h3 className="text-gray-900">{quiz.title}</h3>
                                        <span className={`px-3 py-1 rounded-full text-xs ${quiz.status === 'published'
                                            ? 'bg-green-100 text-green-700'
                                            : 'bg-yellow-100 text-yellow-700'
                                            }`}>
                                            {quiz.status === 'published' ? 'Published' : 'Draft'}
                                        </span>
                                    </div>
                                    <p className="text-gray-600">Subject: {quiz.subject}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => {
                                            setSelectedItem(quiz);
                                            setModalType('view-quiz');
                                        }}
                                        className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                        title="View"
                                    >
                                        <Eye size={20} />
                                    </button>
                                    <button
                                        onClick={() => handleEditQuiz(quiz)}
                                        className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                        title="Edit"
                                    >
                                        <Edit3 size={20} />
                                    </button>
                                    <button
                                        onClick={() => {
                                            setSelectedItem(quiz);
                                            setModalType('delete-quiz');
                                        }}
                                        className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                        title="Delete"
                                    >
                                        <Trash2 size={20} />
                                    </button>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                <div className="flex items-center gap-2 text-gray-600">
                                    <FileText size={16} />
                                    <span>{quiz.questions.length} Questions</span>
                                </div>
                                <div className="flex items-center gap-2 text-gray-600">
                                    <Clock size={16} />
                                    <span>{quiz.duration} minutes</span>
                                </div>
                                <div className="flex items-center gap-2 text-gray-600">
                                    <Users size={16} />
                                    <span>{quiz.participants} Participants</span>
                                </div>
                                {quiz.status === 'published' && (
                                    <div className="flex items-center gap-2 text-gray-600">
                                        <TrendingUp size={16} />
                                        <span>Avg: {quiz.averageScore}%</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );

    // Render Draft Quizzes
    const renderDraftQuizzes = () => (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h2>Draft Quizzes</h2>
                <button
                    onClick={() => setActiveTab('create')}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                    <Plus size={20} />
                    Create Quiz
                </button>
            </div>

            <div className="space-y-4">
                {filteredQuizzes.length === 0 ? (
                    <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                        No draft quizzes found.
                    </div>
                ) : (
                    filteredQuizzes.map((quiz) => (
                        <div key={quiz.id} className="bg-white rounded-lg border border-gray-200 p-6">
                            <div className="flex items-start justify-between mb-4">
                                <div>
                                    <h3 className="text-gray-900 mb-2">{quiz.title}</h3>
                                    <p className="text-gray-600">Subject: {quiz.subject}</p>
                                    <p className="text-gray-500 text-sm mt-1">Created: {quiz.createdDate}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => handlePublishQuiz(quiz.id)}
                                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                    >
                                        Publish
                                    </button>
                                    <button
                                        aria-label="Edit Quiz"
                                        onClick={() => handleEditQuiz(quiz)}
                                        className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                    >
                                        <Edit3 size={20} />
                                    </button>
                                </div>
                            </div>
                            <div className="flex items-center gap-4 text-sm text-gray-600">
                                <span>{quiz.questions.length} Questions</span>
                                <span>•</span>
                                <span>{quiz.duration} minutes</span>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );

    // Render Published Quizzes
    const renderPublishedQuizzes = () => (
        <div>
            <h2 className="mb-6">Published Quizzes</h2>

            <div className="space-y-4">
                {filteredQuizzes.length === 0 ? (
                    <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                        No published quizzes found.
                    </div>
                ) : (
                    filteredQuizzes.map((quiz) => (
                        <div key={quiz.id} className="bg-white rounded-lg border border-gray-200 p-6">
                            <div className="flex items-start justify-between mb-4">
                                <div>
                                    <h3 className="text-gray-900 mb-2">{quiz.title}</h3>
                                    <p className="text-gray-600">Subject: {quiz.subject}</p>
                                    <p className="text-gray-500 text-sm mt-1">Published: {quiz.publishedDate}</p>
                                </div>
                                <button
                                    onClick={() => {
                                        setSelectedItem(quiz);
                                        setModalType('view-quiz');
                                    }}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                >
                                    View Details
                                </button>
                            </div>

                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-gray-200">
                                <div>
                                    <p className="text-gray-500 text-sm mb-1">Participants</p>
                                    <p className="text-gray-900">{quiz.participants} students</p>
                                </div>
                                <div>
                                    <p className="text-gray-500 text-sm mb-1">Duration</p>
                                    <p className="text-gray-900">{quiz.duration} minutes</p>
                                </div>
                                <div>
                                    <p className="text-gray-500 text-sm mb-1">Questions</p>
                                    <p className="text-gray-900">{quiz.questions.length} questions</p>
                                </div>
                                <div>
                                    <p className="text-gray-500 text-sm mb-1">Average Score</p>
                                    <p className="text-gray-900">{quiz.averageScore}%</p>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );

    // Render Analytics
    const renderAnalytics = () => {
        const totalQuizzes = quizzes.length;
        const totalParticipants = quizzes.reduce((sum, q) => sum + q.participants, 0);
        const avgScore = quizzes.filter(q => q.participants > 0).reduce((sum, q) => sum + q.averageScore, 0) /
            Math.max(quizzes.filter(q => q.participants > 0).length, 1);

        return (
            <div>
                <h2 className="mb-6">Quiz Results & Analytics</h2>

                {/* Overall Statistics */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                    <div className="bg-white rounded-lg border border-gray-200 p-6">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="p-2 bg-blue-100 text-blue-600 rounded-lg">
                                <FileText size={20} />
                            </div>
                            <p className="text-gray-600">Total Quizzes</p>
                        </div>
                        <h3>{totalQuizzes}</h3>
                    </div>
                    <div className="bg-white rounded-lg border border-gray-200 p-6">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="p-2 bg-green-100 text-green-600 rounded-lg">
                                <Users size={20} />
                            </div>
                            <p className="text-gray-600">Total Participants</p>
                        </div>
                        <h3>{totalParticipants}</h3>
                    </div>
                    <div className="bg-white rounded-lg border border-gray-200 p-6">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="p-2 bg-purple-100 text-purple-600 rounded-lg">
                                <TrendingUp size={20} />
                            </div>
                            <p className="text-gray-600">Average Score</p>
                        </div>
                        <h3>{avgScore.toFixed(1)}%</h3>
                    </div>
                    <div className="bg-white rounded-lg border border-gray-200 p-6">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="p-2 bg-orange-100 text-orange-600 rounded-lg">
                                <CheckCircle size={20} />
                            </div>
                            <p className="text-gray-600">Completion Rate</p>
                        </div>
                        <h3>92%</h3>
                    </div>
                </div>

                {/* Quiz Performance Table */}
                <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                    <div className="p-6 border-b border-gray-200">
                        <h3>Quiz Performance</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-gray-600">Quiz Title</th>
                                    <th className="px-6 py-3 text-left text-gray-600">Participants</th>
                                    <th className="px-6 py-3 text-left text-gray-600">Avg Score</th>
                                    <th className="px-6 py-3 text-left text-gray-600">Pass Rate</th>
                                    <th className="px-6 py-3 text-left text-gray-600">Difficulty</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {quizzes.filter(q => q.status === 'published').map((quiz) => (
                                    <tr key={quiz.id} className="hover:bg-gray-50">
                                        <td className="px-6 py-4 text-gray-900">{quiz.title}</td>
                                        <td className="px-6 py-4 text-gray-600">{quiz.participants}</td>
                                        <td className="px-6 py-4">
                                            <span className={`px-3 py-1 rounded-full text-sm ${quiz.averageScore >= 80 ? 'bg-green-100 text-green-700' :
                                                quiz.averageScore >= 60 ? 'bg-yellow-100 text-yellow-700' :
                                                    'bg-red-100 text-red-700'
                                                }`}>
                                                {quiz.averageScore}%
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-gray-600">
                                            {Math.round(quiz.averageScore * 0.9)}%
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className="px-3 py-1 rounded-full text-sm bg-blue-100 text-blue-700">
                                                Medium
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Question Analysis */}
                <div className="bg-white rounded-lg border border-gray-200 p-6 mt-6">
                    <h3 className="mb-4">Most Challenging Questions</h3>
                    <div className="space-y-4">
                        {[
                            { question: 'Explain recursion with an example', correctRate: 45, attempts: 120 },
                            { question: 'What is the time complexity of merge sort?', correctRate: 62, attempts: 156 },
                            { question: 'Difference between stack and queue', correctRate: 71, attempts: 142 },
                        ].map((item, idx) => (
                            <div key={idx} className="border-b border-gray-100 pb-4 last:border-0">
                                <div className="flex justify-between items-start mb-2">
                                    <p className="text-gray-900">{item.question}</p>
                                    <span className="text-gray-600 text-sm">{item.attempts} attempts</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className="flex-1 bg-gray-200 rounded-full h-2">
                                        <div
                                            className={`h-2 rounded-full ${item.correctRate >= 70 ? 'bg-green-500' :
                                                item.correctRate >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                                                }`}
                                            style={{ width: `${item.correctRate}%` }}
                                        />
                                    </div>
                                    <span className="text-gray-600 text-sm">{item.correctRate}% correct</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    // Render Question Bank
    const renderQuestionBank = () => (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h2>Question Bank</h2>
                <button
                    onClick={() => setModalType('add-question')}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                    <Plus size={20} />
                    Add Question
                </button>
            </div>

            {/* Filters */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <select
                        title='Question Type'
                        value={qbFilterType}
                        onChange={(e) => setQbFilterType(e.target.value)}
                        className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                        <option value="all">All Types</option>
                        <option value="multiple-choice">Multiple Choice</option>
                        <option value="true-false">True/False</option>
                        <option value="short-answer">Short Answer</option>
                    </select>
                    <select
                        title='Filter by Topic'
                        value={qbFilterTopic}
                        onChange={(e) => setQbFilterTopic(e.target.value)}
                        className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                        <option value="all">All Topics</option>
                        <option value="algorithms">Algorithms</option>
                        <option value="data structures">Data Structures</option>
                        <option value="oop">OOP</option>
                    </select>
                    <select
                        title='Filter by Difficulty'
                        value={qbFilterDifficulty}
                        onChange={(e) => setQbFilterDifficulty(e.target.value)}
                        className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                        <option value="all">All Difficulty</option>
                        <option value="easy">Easy</option>
                        <option value="medium">Medium</option>
                        <option value="hard">Hard</option>
                    </select>
                </div>
            </div>

            {/* Questions List */}
            <div className="space-y-4">
                {filteredQuestions.length === 0 ? (
                    <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                        No questions found. Add your first question!
                    </div>
                ) : (
                    filteredQuestions.map((question) => (
                        <div key={question.id} className="bg-white rounded-lg border border-gray-200 p-6">
                            <div className="flex items-start justify-between mb-4">
                                <div className="flex-1">
                                    <div className="flex items-center gap-3 mb-2">
                                        <span className="px-3 py-1 rounded-full text-xs bg-blue-100 text-blue-700">
                                            {question.type}
                                        </span>
                                        <span className={`px-3 py-1 rounded-full text-xs ${question.difficulty === 'easy' ? 'bg-green-100 text-green-700' :
                                            question.difficulty === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                                                'bg-red-100 text-red-700'
                                            }`}>
                                            {question.difficulty}
                                        </span>
                                        <span className="text-gray-500 text-sm">{question.topic}</span>
                                    </div>
                                    <p className="text-gray-900 mb-3">{question.question}</p>
                                    {question.options && (
                                        <div className="space-y-1 text-sm text-gray-600">
                                            {question.options.map((option, idx) => (
                                                <p key={idx} className={option === question.correctAnswer ? 'text-green-600' : ''}>
                                                    {String.fromCharCode(65 + idx)}. {option}
                                                    {option === question.correctAnswer && ' ✓'}
                                                </p>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div className="flex items-center gap-2 ml-4">
                                    <button
                                        aria-label="Edit Question"
                                        onClick={() => handleEditQuestion(question)}
                                        className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                    >
                                        <Edit3 size={20} />
                                    </button>
                                    <button
                                        aria-label="Delete Question"
                                        onClick={() => {
                                            setSelectedItem(question);
                                            setModalType('delete-question');
                                        }}
                                        className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                    >
                                        <Trash2 size={20} />
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );

    // Render Create/Edit Quiz
    const renderQuizForm = () => {
        const isEdit = activeTab === 'edit';

        return (
            <div>
                <div className="flex items-center gap-4 mb-6">
                    <button
                        aria-label="Back to Quiz List"
                        onClick={() => {
                            resetQuizForm();
                            setEditingQuizId(null);
                            setActiveTab('all');
                        }}
                        className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                        <ArrowLeft size={20} />
                    </button>
                    <h2>{isEdit ? 'Edit Quiz' : 'Create New Quiz'}</h2>
                </div>

                <div className="bg-white rounded-lg border border-gray-200 p-6">
                    <form className="space-y-6" onSubmit={(e) => e.preventDefault()}>
                        {/* Basic Information */}
                        <div>
                            <h3 className="mb-4">Basic Information</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-gray-700 mb-2">Quiz Title *</label>
                                    <input
                                        type="text"
                                        value={quizForm.title}
                                        onChange={(e) => setQuizForm({ ...quizForm, title: e.target.value })}
                                        placeholder="Enter quiz title"
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-gray-700 mb-2">Subject Code *</label>
                                    <input
                                        type="text"
                                        value={quizForm.subject}
                                        onChange={(e) => setQuizForm({ ...quizForm, subject: e.target.value })}
                                        placeholder="e.g., CS201"
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        required
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Quiz Settings */}
                        <div>
                            <h3 className="mb-4">Quiz Settings</h3>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                    <label className="block text-gray-700 mb-2">Duration (minutes) *</label>
                                    <input
                                        type="number"
                                        value={quizForm.duration}
                                        onChange={(e) => setQuizForm({ ...quizForm, duration: e.target.value })}
                                        placeholder="60"
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-gray-700 mb-2">Pass Percentage *</label>
                                    <input
                                        type="number"
                                        value={quizForm.passPercentage}
                                        onChange={(e) => setQuizForm({ ...quizForm, passPercentage: e.target.value })}
                                        placeholder="70"
                                        min="0"
                                        max="100"
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-gray-700 mb-2">Attempts Allowed *</label>
                                    <select
                                        title='Attempts Allowed'
                                        value={quizForm.attemptsAllowed}
                                        onChange={(e) => setQuizForm({ ...quizForm, attemptsAllowed: e.target.value })}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                    >
                                        <option value="1">1</option>
                                        <option value="2">2</option>
                                        <option value="3">3</option>
                                        <option value="unlimited">Unlimited</option>
                                    </select>
                                </div>
                            </div>
                        </div>

                        {/* Question Selection */}
                        <div>
                            <div className="flex items-center justify-between mb-4">
                                <h3>Questions ({quizForm.selectedQuestions.length} selected)</h3>
                                <button
                                    type="button"
                                    onClick={() => setModalType('select-questions')}
                                    className="flex items-center gap-2 px-4 py-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                >
                                    <Database size={20} />
                                    Select from Question Bank
                                </button>
                            </div>
                            {quizForm.selectedQuestions.length > 0 ? (
                                <div className="border border-gray-300 rounded-lg p-4 space-y-2">
                                    {questionBank
                                        .filter(q => quizForm.selectedQuestions.includes(q.id))
                                        .map((question, idx) => (
                                            <div key={question.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                                                <div className="flex items-center gap-3">
                                                    <span className="text-gray-600">{idx + 1}.</span>
                                                    <p className="text-gray-900">{question.question}</p>
                                                </div>
                                                <button
                                                    type="button"
                                                    aria-label="Remove Question"
                                                    onClick={() => toggleQuestionSelection(question.id)}
                                                    className="text-red-600 hover:bg-red-50 p-2 rounded-lg"
                                                >
                                                    <X size={16} />
                                                </button>
                                            </div>
                                        ))}
                                </div>
                            ) : (
                                <div className="border border-gray-300 rounded-lg p-4 bg-gray-50 text-center text-gray-500">
                                    <p>No questions added yet. Select questions from the question bank.</p>
                                </div>
                            )}
                        </div>

                        {/* Schedule */}
                        <div>
                            <h3 className="mb-4">Schedule (Optional)</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-gray-700 mb-2">Start Date & Time</label>
                                    <input
                                        type="datetime-local"
                                        aria-label="Start Date & Time"
                                        value={quizForm.startDate}
                                        onChange={(e) => setQuizForm({ ...quizForm, startDate: e.target.value })}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                    />
                                </div>
                                <div>
                                    <label className="block text-gray-700 mb-2">End Date & Time</label>
                                    <input
                                        aria-label="End Date & Time"
                                        type="datetime-local"
                                        value={quizForm.endDate}
                                        onChange={(e) => setQuizForm({ ...quizForm, endDate: e.target.value })}
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Action Buttons */}
                        <div className="flex items-center gap-3 pt-4 border-t border-gray-200">
                            <button
                                type="button"
                                onClick={() => {
                                    if (!quizForm.title || !quizForm.subject || !quizForm.duration) {
                                        alert('Please fill in all required fields');
                                        return;
                                    }
                                    if (isEdit) {
                                        handleUpdateQuiz('published');
                                    } else {
                                        handleCreateQuiz('published');
                                    }
                                }}
                                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                            >
                                {isEdit ? 'Update & Publish' : 'Publish Quiz'}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    if (!quizForm.title || !quizForm.subject || !quizForm.duration) {
                                        alert('Please fill in all required fields');
                                        return;
                                    }
                                    if (isEdit) {
                                        handleUpdateQuiz('draft');
                                    } else {
                                        handleCreateQuiz('draft');
                                    }
                                }}
                                className="px-6 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                            >
                                <Save size={18} className="inline mr-2" />
                                {isEdit ? 'Update Draft' : 'Save as Draft'}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    resetQuizForm();
                                    setEditingQuizId(null);
                                    setActiveTab('all');
                                }}
                                className="px-6 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        );
    };

    const renderContent = () => {
        switch (activeTab) {
            case 'all':
                return renderAllQuizzes();
            case 'draft':
                return renderDraftQuizzes();
            case 'published':
                return renderPublishedQuizzes();
            case 'analytics':
                return renderAnalytics();
            case 'question-bank':
                return renderQuestionBank();
            case 'create':
            case 'edit':
                return renderQuizForm();
            default:
                return renderAllQuizzes();
        }
    };

    return (
        <div>
            {/* Sub-navigation */}
            {activeTab !== 'create' && activeTab !== 'edit' && (
                <div className="bg-white rounded-lg border border-gray-200 p-2 mb-6">
                    <div className="flex flex-wrap gap-2">
                        <button
                            onClick={() => setActiveTab('all')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'all'
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <FileText size={18} />
                            All Quizzes
                        </button>
                        <button
                            onClick={() => setActiveTab('draft')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'draft'
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <Edit3 size={18} />
                            Drafts
                        </button>
                        <button
                            onClick={() => setActiveTab('published')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'published'
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <CheckCircle size={18} />
                            Published
                        </button>
                        <button
                            onClick={() => setActiveTab('analytics')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'analytics'
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <BarChart3 size={18} />
                            Analytics
                        </button>
                        <button
                            onClick={() => setActiveTab('question-bank')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'question-bank'
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <Database size={18} />
                            Question Bank
                        </button>
                    </div>
                </div>
            )}

            {/* Content */}
            {renderContent()}

            {/* Modals */}
            {renderModal()}
        </div>
    );
}
