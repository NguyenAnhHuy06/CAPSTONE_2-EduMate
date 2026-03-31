import { useState, useEffect } from 'react';
import {
    FileText,
    Search,
    Clock,
    CheckCircle,
    Play,
    Eye,
    BarChart3,
    Award,
    X,
} from 'lucide-react';
import { useNotification } from '../NotificationContext';

interface StudentQuizSectionProps {
    user: any;
}

type QuizTab = 'available' | 'completed' | 'my-practice';

interface QuizAnswer {
    questionId: string;
    selectedAnswer: number;
}

export function StudentQuizSection({ user }: StudentQuizSectionProps) {
    const { showNotification, showConfirm } = useNotification();
    const [activeTab, setActiveTab] = useState<QuizTab>('available');
    const [searchQuery, setSearchQuery] = useState('');
    const [filterSubject, setFilterSubject] = useState('all');
    const [selectedQuiz, setSelectedQuiz] = useState<any>(null);
    const [showQuizTaking, setShowQuizTaking] = useState(false);
    const [showResults, setShowResults] = useState(false);
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [answers, setAnswers] = useState<QuizAnswer[]>([]);
    const [timeRemaining, setTimeRemaining] = useState(0);
    const [quizSubmitted, setQuizSubmitted] = useState(false);
    const [quizResult, setQuizResult] = useState<any>(null);
    const [timerId, setTimerId] = useState<NodeJS.Timeout | null>(null);

    // Mock quiz data
    const [availableQuizzes, setAvailableQuizzes] = useState([
        {
            id: 1,
            title: 'Introduction to Algorithms - Midterm',
            subject: 'CS201',
            instructor: 'Dr. Sarah Johnson',
            questions: [
                {
                    id: 'q1',
                    question: 'What is the time complexity of binary search?',
                    options: ['O(n)', 'O(log n)', 'O(n²)', 'O(1)'],
                    correctAnswer: 1,
                },
                {
                    id: 'q2',
                    question: 'Which data structure uses LIFO?',
                    options: ['Queue', 'Stack', 'Array', 'List'],
                    correctAnswer: 1,
                },
            ],
            duration: 60,
            myAttempts: 0,
            maxAttempts: 2,
            dueDate: '2026-04-15',
            status: 'available',
        },
        {
            id: 2,
            title: 'Data Structures Week 5 Quiz',
            subject: 'CS202',
            instructor: 'Dr. Michael Chen',
            questions: [
                {
                    id: 'q3',
                    question: 'What is a Hash Table?',
                    options: ['Linear structure', 'Tree structure', 'Key-value mapping', 'Graph'],
                    correctAnswer: 2,
                },
            ],
            duration: 30,
            myAttempts: 1,
            maxAttempts: 3,
            dueDate: '2026-04-10',
            status: 'available',
        },
    ]);

    const [completedQuizzes, setCompletedQuizzes] = useState([
        {
            id: 3,
            title: 'Database Design Practice',
            subject: 'CS301',
            instructor: 'Dr. Emily Brown',
            questions: [
                {
                    id: 'q4',
                    question: 'What is normalization?',
                    options: ['Data organization', 'Data deletion', 'Data backup', 'Data encryption'],
                    correctAnswer: 0,
                },
            ],
            duration: 45,
            myScore: 85,
            attempts: 2,
            completedDate: '2026-03-25',
            status: 'completed',
            userAnswers: [0],
        },
    ]);

    const [practiceQuizzes, setPracticeQuizzes] = useState([
        {
            id: 5,
            title: 'My Practice: Sorting Algorithms',
            subject: 'CS201',
            questions: [
                {
                    id: 'q5',
                    question: 'Which sorting algorithm has O(n log n) complexity?',
                    options: ['Bubble Sort', 'Merge Sort', 'Selection Sort', 'Insertion Sort'],
                    correctAnswer: 1,
                },
            ],
            duration: 20,
            myScore: 78,
            attempts: 3,
            createdDate: '2026-03-28',
            type: 'practice',
        },
    ]);

    const filteredQuizzes = () => {
        let quizzes = activeTab === 'available' ? availableQuizzes :
            activeTab === 'completed' ? completedQuizzes : practiceQuizzes;

        return quizzes.filter((quiz) => {
            const matchesSearch = quiz.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                quiz.subject.toLowerCase().includes(searchQuery.toLowerCase());
            const matchesSubject = filterSubject === 'all' || quiz.subject === filterSubject;
            return matchesSearch && matchesSubject;
        });
    };

    const startQuiz = (quiz: any) => {
        setSelectedQuiz(quiz);
        setCurrentQuestionIndex(0);
        setAnswers([]);
        setTimeRemaining(quiz.duration * 60); // Convert to seconds
        setQuizSubmitted(false);
        setShowQuizTaking(true);

        // Start timer
        const timer = setInterval(() => {
            setTimeRemaining((prev) => {
                if (prev <= 1) {
                    clearInterval(timer);
                    handleSubmitQuiz(true); // Auto-submit when time runs out
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
        setTimerId(timer);
    };

    // Cleanup timer on unmount
    useEffect(() => {
        return () => {
            if (timerId) {
                clearInterval(timerId);
            }
        };
    }, [timerId]);

    const handleAnswerSelect = (questionId: string, answerIndex: number) => {
        setAnswers((prev) => {
            const existing = prev.find((a) => a.questionId === questionId);
            if (existing) {
                return prev.map((a) =>
                    a.questionId === questionId ? { ...a, selectedAnswer: answerIndex } : a
                );
            }
            return [...prev, { questionId, selectedAnswer: answerIndex }];
        });
    };

    const handleSubmitQuiz = async (autoSubmit = false) => {
        if (!autoSubmit) {
            const confirmed = await showConfirm({
                title: 'Submit Quiz',
                message: 'Are you sure you want to submit your quiz? You cannot change your answers after submission.',
                confirmText: 'Submit',
                cancelText: 'Continue Quiz',
                type: 'warning',
            });

            if (!confirmed) return;
        }

        // Clear the timer
        if (timerId) {
            clearInterval(timerId);
            setTimerId(null);
        }

        // Calculate score
        let correctCount = 0;
        const questions = selectedQuiz.questions;

        questions.forEach((q: any) => {
            const userAnswer = answers.find((a) => a.questionId === q.id);
            if (userAnswer && userAnswer.selectedAnswer === q.correctAnswer) {
                correctCount++;
            }
        });

        const score = Math.round((correctCount / questions.length) * 100);

        const result = {
            quizId: selectedQuiz.id,
            score,
            correctAnswers: correctCount,
            totalQuestions: questions.length,
            timeTaken: selectedQuiz.duration * 60 - timeRemaining,
            answers: answers,
            completedDate: new Date().toISOString().split('T')[0],
        };

        setQuizResult(result);
        setQuizSubmitted(true);
        setShowQuizTaking(false);

        // Update quiz attempts and move to completed if needed
        if (activeTab === 'available') {
            setAvailableQuizzes((prev) =>
                prev.map((q) =>
                    q.id === selectedQuiz.id
                        ? { ...q, myAttempts: q.myAttempts + 1 }
                        : q
                )
            );

            // Add to completed quizzes
            setCompletedQuizzes((prev) => [
                ...prev,
                {
                    ...selectedQuiz,
                    myScore: score,
                    attempts: selectedQuiz.myAttempts + 1,
                    completedDate: result.completedDate,
                    status: 'completed',
                    userAnswers: answers.map((a) => a.selectedAnswer),
                },
            ]);
        } else if (activeTab === 'my-practice') {
            setPracticeQuizzes((prev) =>
                prev.map((q) =>
                    q.id === selectedQuiz.id
                        ? { ...q, attempts: q.attempts + 1, myScore: score }
                        : q
                )
            );
        }

        // Show success notification
        showNotification({
            type: 'success',
            title: 'Quiz Submitted!',
            message: `You scored ${score}%. ${correctCount} out of ${questions.length} correct.`,
            duration: 5000,
        });

        setShowResults(true);
    };

    const renderAvailableQuizzes = () => (
        <div className="space-y-4">
            {filteredQuizzes().map((quiz) => (
                <div key={quiz.id} className="bg-white rounded-lg border border-gray-200 p-6 hover:shadow-md transition-shadow">
                    <div className="flex items-start justify-between mb-4">
                        <div className="flex-1">
                            <h3 className="text-gray-900 mb-2">{quiz.title}</h3>
                            <p className="text-gray-600 mb-1">Subject: {quiz.subject}</p>

                            {/* Kiểm tra instructor */}
                            {'instructor' in quiz && (
                                <p className="text-gray-500 text-sm">Instructor: {quiz.instructor}</p>
                            )}
                        </div>

                        {/* Kiểm tra myAttempts và maxAttempts trước khi dùng */}
                        {'myAttempts' in quiz && 'maxAttempts' in quiz ? (
                            <button
                                onClick={() => startQuiz(quiz)}
                                disabled={quiz.myAttempts >= quiz.maxAttempts}
                                className={`flex items-center gap-2 px-6 py-2 rounded-lg transition-colors ${quiz.myAttempts >= quiz.maxAttempts
                                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                                    : 'bg-blue-600 text-white hover:bg-blue-700'
                                    }`}
                            >
                                <Play size={20} />
                                {quiz.myAttempts >= quiz.maxAttempts ? 'No Attempts Left' : 'Take Quiz'}
                            </button>
                        ) : (
                            <button
                                disabled
                                className="flex items-center gap-2 px-6 py-2 rounded-lg bg-gray-300 text-gray-500 cursor-not-allowed"
                            >
                                <Play size={20} />
                                Not Available
                            </button>
                        )}
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-gray-200 text-sm">
                        <div>
                            <p className="text-gray-500 mb-1">Questions</p>
                            <p className="text-gray-900">{quiz.questions.length}</p>
                        </div>
                        <div>
                            <p className="text-gray-500 mb-1">Duration</p>
                            <p className="text-gray-900">{quiz.duration} minutes</p>
                        </div>
                        <div>
                            <p className="text-gray-500 mb-1">Attempts</p>
                            {'myAttempts' in quiz && 'maxAttempts' in quiz ? (
                                <p className="text-gray-900">{quiz.myAttempts} / {quiz.maxAttempts}</p>
                            ) : (
                                <p className="text-gray-900">N/A</p>
                            )}
                        </div>

                        <div>
                            <p className="text-gray-500 mb-1">Due Date</p>
                            {'dueDate' in quiz ? (
                                <p className="text-gray-900">{quiz.dueDate}</p>
                            ) : (
                                <p className="text-gray-900">N/A</p>
                            )}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );

    const renderCompletedQuizzes = () => (
        <div className="space-y-4">
            {filteredQuizzes().map((quiz) => (
                <div key={quiz.id} className="bg-white rounded-lg border border-gray-200 p-6">
                    <div className="flex items-start justify-between mb-4">
                        <div className="flex-1">
                            <div className="flex items-center gap-3 mb-2">
                                <h3 className="text-gray-900">{quiz.title}</h3>

                                {'myScore' in quiz && quiz.myScore !== undefined && (
                                    <span
                                        className={`px-3 py-1 rounded-full text-sm ${quiz.myScore >= 80
                                            ? 'bg-green-100 text-green-700'
                                            : quiz.myScore >= 60
                                                ? 'bg-yellow-100 text-yellow-700'
                                                : 'bg-red-100 text-red-700'
                                            }`}
                                    >
                                        Score: {quiz.myScore}%
                                    </span>
                                )}
                            </div>
                            <p className="text-gray-600 mb-1">Subject: {quiz.subject}</p>

                            {/* Kiểm tra instructor */}
                            {'instructor' in quiz ? (
                                <p className="text-gray-500 text-sm">Instructor: {quiz.instructor}</p>
                            ) : (
                                <p className="text-gray-500 text-sm">Instructor: N/A</p>
                            )}

                            {/* Kiểm tra completedDate */}
                            {'completedDate' in quiz ? (
                                <p className="text-gray-500 text-sm">Completed: {quiz.completedDate}</p>
                            ) : (
                                <p className="text-gray-500 text-sm">Completed: N/A</p>
                            )}
                        </div>
                        <button
                            onClick={() => {
                                setSelectedQuiz(quiz);

                                // Chỉ truy cập myScore và userAnswers nếu tồn tại
                                const score = 'myScore' in quiz ? quiz.myScore : 0;
                                const answers = 'userAnswers' in quiz ? quiz.userAnswers : [];

                                setQuizResult({
                                    score: score,
                                    correctAnswers: Math.round((score / 100) * quiz.questions.length),
                                    totalQuestions: quiz.questions.length,
                                    timeTaken: quiz.duration - 5,
                                    answers: answers,
                                });

                                setShowResults(true);
                            }}
                            className="flex items-center gap-2 px-4 py-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                        >
                            <Eye size={20} />
                            View Results
                        </button>
                    </div>

                    <div className="grid grid-cols-3 gap-4 pt-4 border-t border-gray-200 text-sm">
                        <div>
                            <p className="text-gray-500 mb-1">Questions</p>
                            <p className="text-gray-900">{quiz.questions.length}</p>
                        </div>
                        <div>
                            <p className="text-gray-500 mb-1">Duration</p>
                            <p className="text-gray-900">{quiz.duration} minutes</p>
                        </div>
                        <div>
                            <p className="text-gray-500 mb-1">Attempts Used</p>
                            {'attempts' in quiz ? (
                                <p className="text-gray-900">{quiz.attempts}</p>
                            ) : (
                                <p className="text-gray-400">N/A</p>
                            )}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );

    const renderPracticeQuizzes = () => (
        <div>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
                <p className="text-blue-800">
                    <strong>Practice Quizzes:</strong> Create quizzes from your study materials for practice. These are for your personal use only and help you test your knowledge.
                </p>
            </div>

            <div className="space-y-4">
                {filteredQuizzes().map((quiz) => (
                    <div key={quiz.id} className="bg-white rounded-lg border border-gray-200 p-6">
                        <div className="flex items-start justify-between mb-4">
                            <div className="flex-1">
                                <h3 className="text-gray-900 mb-2">{quiz.title}</h3>
                                <p className="text-gray-600 mb-1">Subject: {quiz.subject}</p>

                                {/* Kiểm tra xem quiz có createdDate không */}
                                {'createdDate' in quiz && (
                                    <p className="text-gray-500 text-sm">Created: {quiz.createdDate}</p>
                                )}

                                {/* Kiểm tra xem quiz có myScore không */}
                                {'myScore' in quiz && quiz.myScore !== undefined && (
                                    <p className="text-gray-600 mt-2">
                                        Latest Score: <span className="text-green-600">{quiz.myScore}%</span>
                                    </p>
                                )}
                            </div>
                            <button
                                onClick={() => startQuiz(quiz)}
                                className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                            >
                                <Play size={20} />
                                Practice
                            </button>
                        </div>

                        <div className="grid grid-cols-3 gap-4 pt-4 border-t border-gray-200 text-sm">
                            <div>
                                <p className="text-gray-500 mb-1">Questions</p>
                                <p className="text-gray-900">{quiz.questions.length}</p>
                            </div>
                            <div>
                                <p className="text-gray-500 mb-1">Duration</p>
                                <p className="text-gray-900">{quiz.duration} minutes</p>
                            </div>
                            {'myAttempts' in quiz && 'maxAttempts' in quiz ? (
                                <div>
                                    <p className="text-gray-500 mb-1">Attempts</p>
                                    <p className="text-gray-900">{quiz.myAttempts} / {quiz.maxAttempts}</p>
                                </div>
                            ) : 'N/A'}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );

    const renderQuizTaking = () => {
        if (!selectedQuiz || !showQuizTaking) return null;

        const currentQuestion = selectedQuiz.questions[currentQuestionIndex];
        const currentAnswer = answers.find((a) => a.questionId === currentQuestion.id);
        const progress = ((currentQuestionIndex + 1) / selectedQuiz.questions.length) * 100;

        const minutes = Math.floor(timeRemaining / 60);
        const seconds = timeRemaining % 60;

        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
                    <div className="p-6 border-b border-gray-200">
                        <div className="flex items-start justify-between mb-4">
                            <div>
                                <h2 className="mb-2">{selectedQuiz.title}</h2>
                                <p className="text-gray-600">{selectedQuiz.questions.length} Questions • {selectedQuiz.duration} minutes</p>
                            </div>
                            <div className="flex items-center gap-4">
                                <div className={`flex items-center gap-2 ${timeRemaining < 300 ? 'text-red-600' : 'text-orange-600'}`}>
                                    <Clock size={20} />
                                    <span className="text-xl">{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}</span>
                                </div>
                                <button
                                    aria-label="Close"
                                    onClick={async () => {
                                        const confirmed = await showConfirm({
                                            title: 'Exit Quiz',
                                            message: 'Are you sure you want to exit? Your progress will be lost and this will count as an attempt.',
                                            confirmText: 'Exit',
                                            cancelText: 'Stay',
                                            type: 'warning',
                                        });

                                        if (confirmed) {
                                            if (timerId) {
                                                clearInterval(timerId);
                                                setTimerId(null);
                                            }
                                            setShowQuizTaking(false);
                                            setSelectedQuiz(null);
                                            showNotification({
                                                type: 'info',
                                                message: 'Quiz exited. Your progress was not saved.',
                                            });
                                        }
                                    }}
                                    className="text-gray-500 hover:text-gray-700"
                                >
                                    <X size={24} />
                                </button>
                            </div>
                        </div>
                        <div className="w-full bg-gray-200 rounded-full h-2">
                            <div className="bg-blue-600 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
                        </div>
                        <p className="text-sm text-gray-600 mt-2">Question {currentQuestionIndex + 1} of {selectedQuiz.questions.length}</p>
                    </div>

                    <div className="p-6">
                        <div className="mb-6">
                            <p className="text-gray-900 mb-4"><strong>Question {currentQuestionIndex + 1}:</strong> {currentQuestion.question}</p>
                            <div className="space-y-3">
                                {currentQuestion.options.map((option: string, idx: number) => (
                                    <label
                                        key={idx}
                                        className={`flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors ${currentAnswer?.selectedAnswer === idx
                                            ? 'border-blue-500 bg-blue-50'
                                            : 'border-gray-300 hover:bg-blue-50 hover:border-blue-300'
                                            }`}
                                    >
                                        <input
                                            type="radio"
                                            name={`question-${currentQuestion.id}`}
                                            checked={currentAnswer?.selectedAnswer === idx}
                                            onChange={() => handleAnswerSelect(currentQuestion.id, idx)}
                                            className="w-4 h-4 text-blue-600"
                                        />
                                        <span className="text-gray-900">{option}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="p-6 border-t border-gray-200 flex items-center justify-between">
                        <button
                            onClick={() => setCurrentQuestionIndex(Math.max(0, currentQuestionIndex - 1))}
                            disabled={currentQuestionIndex === 0}
                            className="px-6 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Previous
                        </button>
                        <div className="flex items-center gap-3">
                            {currentQuestionIndex === selectedQuiz.questions.length - 1 ? (
                                <button
                                    onClick={() => handleSubmitQuiz()}
                                    className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                                >
                                    Submit Quiz
                                </button>
                            ) : (
                                <button
                                    onClick={() => setCurrentQuestionIndex(Math.min(selectedQuiz.questions.length - 1, currentQuestionIndex + 1))}
                                    className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                >
                                    Next
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const renderQuizResults = () => {
        if (!showResults || !selectedQuiz || !quizResult) return null;

        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
                    <div className="p-6 border-b border-gray-200">
                        <div className="flex items-start justify-between">
                            <div>
                                <h2 className="mb-2">Quiz Results</h2>
                                <p className="text-gray-600">{selectedQuiz.title}</p>
                            </div>
                            <button
                                aria-label="Close"
                                onClick={() => {
                                    setShowResults(false);
                                    setSelectedQuiz(null);
                                    setQuizResult(null);
                                }}
                                className="text-gray-500 hover:text-gray-700"
                            >
                                <X size={24} />
                            </button>
                        </div>
                    </div>

                    <div className="p-6">
                        {/* Score Summary */}
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                            <div className="bg-blue-50 rounded-lg p-4 text-center">
                                <div className="text-blue-600 mb-2">
                                    <Award size={32} className="mx-auto" />
                                </div>
                                <p className="text-gray-600 text-sm mb-1">Your Score</p>
                                <p className="text-2xl text-blue-600">{quizResult.score}%</p>
                            </div>
                            <div className="bg-green-50 rounded-lg p-4 text-center">
                                <div className="text-green-600 mb-2">
                                    <CheckCircle size={32} className="mx-auto" />
                                </div>
                                <p className="text-gray-600 text-sm mb-1">Correct</p>
                                <p className="text-2xl text-green-600">{quizResult.correctAnswers}</p>
                            </div>
                            <div className="bg-gray-50 rounded-lg p-4 text-center">
                                <div className="text-gray-600 mb-2">
                                    <FileText size={32} className="mx-auto" />
                                </div>
                                <p className="text-gray-600 text-sm mb-1">Total Questions</p>
                                <p className="text-2xl text-gray-900">{quizResult.totalQuestions}</p>
                            </div>
                            <div className="bg-purple-50 rounded-lg p-4 text-center">
                                <div className="text-purple-600 mb-2">
                                    <Clock size={32} className="mx-auto" />
                                </div>
                                <p className="text-gray-600 text-sm mb-1">Time Taken</p>
                                <p className="text-2xl text-purple-600">{Math.floor(quizResult.timeTaken / 60)}m</p>
                            </div>
                        </div>

                        {/* Question Review */}
                        <div>
                            <h3 className="mb-4">Answer Review</h3>
                            <div className="space-y-4">
                                {selectedQuiz.questions.map((q: any, idx: number) => {
                                    const userAnswer = answers.find((a) => a.questionId === q.id);
                                    const isCorrect = userAnswer && userAnswer.selectedAnswer === q.correctAnswer;

                                    return (
                                        <div key={q.id} className={`rounded-lg border-2 p-4 ${isCorrect ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
                                            }`}>
                                            <div className="flex items-start gap-3 mb-3">
                                                <span className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-white ${isCorrect ? 'bg-green-500' : 'bg-red-500'
                                                    }`}>
                                                    {isCorrect ? '✓' : '✗'}
                                                </span>
                                                <div className="flex-1">
                                                    <p className="text-gray-900 mb-3"><strong>Question {idx + 1}:</strong> {q.question}</p>
                                                    <div className="space-y-2">
                                                        <div>
                                                            <p className="text-sm text-gray-600">Your Answer:</p>
                                                            <p className={isCorrect ? 'text-green-700' : 'text-red-700'}>
                                                                {userAnswer ? q.options[userAnswer.selectedAnswer] : 'Not answered'}
                                                            </p>
                                                        </div>
                                                        {!isCorrect && (
                                                            <div>
                                                                <p className="text-sm text-gray-600">Correct Answer:</p>
                                                                <p className="text-green-700">{q.options[q.correctAnswer]}</p>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    <div className="p-6 border-t border-gray-200">
                        <button
                            onClick={() => {
                                setShowResults(false);
                                setSelectedQuiz(null);
                                setQuizResult(null);
                            }}
                            className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition-colors"
                        >
                            Close
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div>
            <h2 className="mb-6">Quizzes</h2>

            {/* Sub-navigation */}
            <div className="bg-white rounded-lg border border-gray-200 p-2 mb-6">
                <div className="flex flex-wrap gap-2">
                    <button
                        onClick={() => setActiveTab('available')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'available'
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-600 hover:bg-gray-100'
                            }`}
                    >
                        <FileText size={18} />
                        Available Quizzes
                    </button>
                    <button
                        onClick={() => setActiveTab('completed')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'completed'
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-600 hover:bg-gray-100'
                            }`}
                    >
                        <CheckCircle size={18} />
                        Completed
                    </button>
                    <button
                        onClick={() => setActiveTab('my-practice')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'my-practice'
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-600 hover:bg-gray-100'
                            }`}
                    >
                        <BarChart3 size={18} />
                        My Practice Quizzes
                    </button>
                </div>
            </div>

            {/* Filters */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                        aria-label="Filter by subject"
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
                </div>
            </div>

            {/* Content */}
            {activeTab === 'available' && renderAvailableQuizzes()}
            {activeTab === 'completed' && renderCompletedQuizzes()}
            {activeTab === 'my-practice' && renderPracticeQuizzes()}

            {/* Modals */}
            {renderQuizTaking()}
            {renderQuizResults()}
        </div>
    );
}
