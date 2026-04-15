import { useState } from 'react';
import { ArrowLeft, Sparkles, Edit2, Save, Trash2, Plus, CheckCircle, Play, Award, FileText } from 'lucide-react';
import { useNotification } from '../pages/NotificationContext';

interface QuizCreatorProps {
    document: any;
    userRole: 'instructor' | 'student';
    onBack: () => void;
    onQuizCreated?: (quiz: any) => void;
}

interface Question {
    id: string;
    question: string;
    options: string[];
    correctAnswer: number;
}

interface QuizAnswer {
    questionId: string;
    selectedAnswer: number;
}

export function QuizCreator({ document, userRole, onBack, onQuizCreated }: QuizCreatorProps) {
    const { showNotification, showConfirm } = useNotification();
    const [generating, setGenerating] = useState(false);
    const [questions, setQuestions] = useState<Question[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    // Quiz taking state for students
    const [quizMode, setQuizMode] = useState<'create' | 'taking' | 'results'>('create');
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [answers, setAnswers] = useState<QuizAnswer[]>([]);
    const [quizResult, setQuizResult] = useState<any>(null);

    const generateQuiz = () => {
        setGenerating(true);

        // Mock AI generation
        setTimeout(() => {
            const generatedQuestions: Question[] = [
                {
                    id: '1',
                    question: 'What is the time complexity of binary search?',
                    options: ['O(n)', 'O(log n)', 'O(n²)', 'O(1)'],
                    correctAnswer: 1,
                },
                {
                    id: '2',
                    question: 'Which data structure uses LIFO (Last In First Out)?',
                    options: ['Queue', 'Stack', 'Array', 'Linked List'],
                    correctAnswer: 1,
                },
                {
                    id: '3',
                    question: 'What is the space complexity of merge sort?',
                    options: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'],
                    correctAnswer: 2,
                },
                {
                    id: '4',
                    question: 'Which of the following is a non-linear data structure?',
                    options: ['Array', 'Stack', 'Tree', 'Queue'],
                    correctAnswer: 2,
                },
                {
                    id: '5',
                    question: 'What is the average time complexity of hash table lookups?',
                    options: ['O(1)', 'O(n)', 'O(log n)', 'O(n²)'],
                    correctAnswer: 0,
                },
            ];
            setQuestions(generatedQuestions);
            setGenerating(false);

            // Automatically start quiz for students
            if (userRole === 'student') {
                setQuizMode('taking');
                setCurrentQuestionIndex(0);
                setAnswers([]);
            }
        }, 2000);
    };

    const updateQuestion = (id: string, field: string, value: any) => {
        setQuestions(
            questions.map((q) =>
                q.id === id ? { ...q, [field]: value } : q
            )
        );
    };

    const deleteQuestion = (id: string) => {
        setQuestions(questions.filter((q) => q.id !== id));
    };

    const addNewQuestion = () => {
        const newQuestion: Question = {
            id: Date.now().toString(),
            question: '',
            options: ['', '', '', ''],
            correctAnswer: 0,
        };
        setQuestions([...questions, newQuestion]);
        setEditingId(newQuestion.id);
    };

    const startQuiz = () => {
        setCurrentQuestionIndex(0);
        setAnswers([]);
        setQuizMode('taking');
    };

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

    const handleSubmitQuiz = async () => {
        const confirmed = await showConfirm({
            title: 'Submit Quiz',
            message: 'Are you sure you want to submit your quiz? You cannot change your answers after submission.',
            confirmText: 'Submit',
            cancelText: 'Continue Quiz',
            type: 'warning',
        });

        if (!confirmed) return;

        // Calculate score
        let correctCount = 0;
        questions.forEach((q) => {
            const userAnswer = answers.find((a) => a.questionId === q.id);
            if (userAnswer && userAnswer.selectedAnswer === q.correctAnswer) {
                correctCount++;
            }
        });

        const score = Math.round((correctCount / questions.length) * 100);

        const result = {
            score,
            correctAnswers: correctCount,
            totalQuestions: questions.length,
            answers: answers,
        };

        setQuizResult(result);
        setQuizMode('results');

        // Show success notification
        showNotification({
            type: 'success',
            title: 'Quiz Submitted!',
            message: `You scored ${score}%. ${correctCount} out of ${questions.length} correct.`,
            duration: 5000,
        });
    };

    const handleSave = () => {
        if (userRole === 'instructor') {
            // Instructors can publish quizzes
            const quiz = {
                id: Date.now().toString(),
                title: `Quiz: ${document.title}`,
                documentId: document.id,
                questions: questions,
                createdBy: 'instructor',
                status: 'published',
            };

            if (onQuizCreated) {
                onQuizCreated(quiz);
            }

            showNotification({
                type: 'success',
                title: 'Quiz Published!',
                message: 'Your quiz has been published and is now available to students.',
                duration: 4000,
            });

            setSaved(true);
            setTimeout(() => {
                onBack();
            }, 2000);
        } else {
            // Students save as practice quiz
            const practiceQuiz = {
                id: Date.now().toString(),
                title: `My Practice: ${document.title}`,
                documentId: document.id,
                questions: questions,
                type: 'practice',
                status: 'ready',
            };

            if (onQuizCreated) {
                onQuizCreated(practiceQuiz);
            }

            showNotification({
                type: 'success',
                title: 'Practice Quiz Created!',
                message: 'Your practice quiz has been created. Take the quiz to test your knowledge and see the correct answers!',
                duration: 4000,
            });

            setSaved(true);
            setTimeout(() => {
                onBack();
            }, 2000);
        }
    };

    // Render quiz taking interface
    const renderQuizTaking = () => {
        const currentQuestion = questions[currentQuestionIndex];
        const currentAnswer = answers.find((a) => a.questionId === currentQuestion.id);
        const progress = ((currentQuestionIndex + 1) / questions.length) * 100;

        return (
            <div>
                <button
                    onClick={async () => {
                        const confirmed = await showConfirm({
                            title: 'Exit Quiz',
                            message: 'Are you sure you want to exit? Your progress will not be saved.',
                            confirmText: 'Exit',
                            cancelText: 'Continue',
                            type: 'warning',
                        });

                        if (confirmed) {
                            if (userRole === 'student') {
                                // Students go back to document
                                onBack();
                            } else {
                                // Instructors go back to create view
                                setQuizMode('create');
                                setAnswers([]);
                                setCurrentQuestionIndex(0);
                            }
                        }
                    }}
                    className="flex items-center gap-2 text-blue-600 hover:text-blue-700 mb-6"
                >
                    <ArrowLeft size={20} />
                    Exit Quiz
                </button>

                <div className="bg-white rounded-lg border border-gray-200 mb-6">
                    <div className="p-6 border-b border-gray-200">
                        <h2 className="mb-2">Quiz: {document.title}</h2>
                        <p className="text-gray-600 mb-4">{questions.length} Questions</p>
                        <div className="w-full bg-gray-200 rounded-full h-2">
                            <div className="bg-blue-600 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
                        </div>
                        <p className="text-sm text-gray-600 mt-2">Question {currentQuestionIndex + 1} of {questions.length}</p>
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
                            {currentQuestionIndex === questions.length - 1 ? (
                                <button
                                    onClick={handleSubmitQuiz}
                                    className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                                >
                                    Submit Quiz
                                </button>
                            ) : (
                                <button
                                    onClick={() => setCurrentQuestionIndex(Math.min(questions.length - 1, currentQuestionIndex + 1))}
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

    // Render results interface
    const renderResults = () => {
        return (
            <div>
                <button
                    onClick={() => {
                        setQuizMode('create');
                        setAnswers([]);
                        setCurrentQuestionIndex(0);
                        setQuizResult(null);
                    }}
                    className="flex items-center gap-2 text-blue-600 hover:text-blue-700 mb-6"
                >
                    <ArrowLeft size={20} />
                    Back to Quiz
                </button>

                <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
                    <h2 className="mb-2">Quiz Results</h2>
                    <p className="text-gray-600 mb-6">{document.title}</p>

                    {/* Score Summary */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
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
                    </div>

                    {/* Question Review */}
                    <div>
                        <h3 className="mb-4">Answer Review</h3>
                        <div className="space-y-4">
                            {questions.map((q, idx) => {
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

                <div className="flex gap-3">
                    <button
                        onClick={() => {
                            setQuizMode('taking');
                            setAnswers([]);
                            setCurrentQuestionIndex(0);
                            setQuizResult(null);
                        }}
                        className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                    >
                        <Play size={20} />
                        Retake Quiz
                    </button>
                    <button
                        onClick={onBack}
                        className="px-6 py-3 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                        Back to Document
                    </button>
                </div>
            </div>
        );
    };

    // Show results view
    if (quizMode === 'results' && quizResult) {
        return renderResults();
    }

    // Show quiz taking view
    if (quizMode === 'taking') {
        return renderQuizTaking();
    }

    // Show success message after saving
    if (saved) {
        return (
            <div className="flex items-center justify-center min-h-[600px]">
                <div className="text-center">
                    <div className="bg-green-100 text-green-600 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
                        <CheckCircle size={48} />
                    </div>
                    <h2 className="text-green-600 mb-2">
                        {userRole === 'instructor' ? 'Quiz Published!' : 'Practice Quiz Created!'}
                    </h2>
                    <p className="text-gray-600">
                        {userRole === 'instructor'
                            ? 'Your quiz has been published and is now available to students.'
                            : 'Your practice quiz has been created. Take the quiz to test your knowledge and see the correct answers!'}
                    </p>
                </div>
            </div>
        );
    }

    // Show quiz creation view
    return (
        <div>
            <button
                onClick={onBack}
                className="flex items-center gap-2 text-blue-600 hover:text-blue-700 mb-6"
            >
                <ArrowLeft size={20} />
                Back to Document
            </button>

            <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
                <h2 className="mb-2">AI Quiz Creator</h2>
                <p className="text-gray-600 mb-2">
                    Generate quiz questions based on: <span className="text-blue-600">{document.title}</span>
                </p>
                {userRole === 'student' && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
                        <p className="text-blue-800 text-sm">
                            <strong>Note:</strong> This quiz is for practice only. You can take the quiz to see your results and the correct answers.
                        </p>
                    </div>
                )}

                {questions.length === 0 ? (
                    <button
                        onClick={generateQuiz}
                        disabled={generating}
                        className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-400"
                    >
                        {generating ? (
                            <>
                                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white" />
                                Generating Quiz...
                            </>
                        ) : (
                            <>
                                <Sparkles size={20} />
                                Generate Quiz with AI
                            </>
                        )}
                    </button>
                ) : (
                    <div className="flex gap-3">
                        {userRole === 'student' && (
                            <button
                                onClick={startQuiz}
                                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                            >
                                <Play size={18} />
                                Take Quiz Now
                            </button>
                        )}
                        {userRole === 'instructor' && (
                            <button
                                onClick={addNewQuestion}
                                className="flex items-center gap-2 px-4 py-2 bg-white border border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors"
                            >
                                <Plus size={18} />
                                Add Question
                            </button>
                        )}
                        <button
                            onClick={handleSave}
                            disabled={questions.length === 0}
                            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-400"
                        >
                            <Save size={18} />
                            {userRole === 'instructor' ? 'Publish Quiz' : 'Save Practice Quiz'}
                        </button>
                    </div>
                )}
            </div>

            {/* Questions List */}
            {questions.length > 0 && (
                <div className="space-y-4">
                    {questions.map((question, index) => (
                        <div key={question.id} className="bg-white rounded-lg border border-gray-200 p-6">
                            <div className="flex items-start justify-between mb-4">
                                <h4>Question {index + 1}</h4>
                                {userRole === 'instructor' && (
                                    <div className="flex gap-2">
                                        <button
                                            type="button"
                                            aria-label="Edit question"
                                            onClick={() => setEditingId(editingId === question.id ? null : question.id)}
                                            className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                        >
                                            <Edit2 size={18} />
                                        </button>
                                        <button
                                            type="button"
                                            aria-label="Delete question"
                                            onClick={() => deleteQuestion(question.id)}
                                            className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                        >
                                            <Trash2 size={18} />
                                        </button>
                                    </div>
                                )}
                            </div>

                            {editingId === question.id && userRole === 'instructor' ? (
                                <div className="space-y-4">
                                    <div>
                                        <label
                                            htmlFor={`question-${question.id}`}
                                            className="block text-gray-700 mb-2"
                                        >
                                            Question
                                        </label>

                                        <input
                                            id={`question-${question.id}`}
                                            type="text"
                                            value={question.question}
                                            onChange={(e) => updateQuestion(question.id, 'question', e.target.value)}
                                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-gray-700 mb-2">Options</label>
                                        {question.options.map((option, optIndex) => (
                                            <div key={optIndex} className="flex items-center gap-2 mb-2">
                                                <label className="flex items-center gap-2">
                                                    <input
                                                        type="radio"
                                                        name={`correct-${question.id}`}
                                                        checked={question.correctAnswer === optIndex}
                                                        onChange={() => updateQuestion(question.id, 'correctAnswer', optIndex)}
                                                        className="text-blue-600"
                                                    />
                                                    <span>Option {optIndex + 1}</span>
                                                </label>
                                                <input
                                                    type="text"
                                                    value={option}
                                                    onChange={(e) => {
                                                        const newOptions = [...question.options];
                                                        newOptions[optIndex] = e.target.value;
                                                        updateQuestion(question.id, 'options', newOptions);
                                                    }}
                                                    placeholder={`Option ${optIndex + 1}`}
                                                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                                                />
                                            </div>
                                        ))}
                                        <p className="text-gray-500 text-sm mt-2">
                                            Select the radio button to mark the correct answer
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <div>
                                    <p className="text-gray-900 mb-4">{question.question}</p>
                                    <div className="space-y-2">
                                        {question.options.map((option, optIndex) => (
                                            <div
                                                key={optIndex}
                                                className={`px-4 py-2 rounded-lg border ${userRole === 'instructor' && question.correctAnswer === optIndex
                                                    ? 'bg-green-50 border-green-500 text-green-700'
                                                    : 'bg-gray-50 border-gray-200'
                                                    }`}
                                            >
                                                {String.fromCharCode(65 + optIndex)}. {option}
                                                {userRole === 'instructor' && question.correctAnswer === optIndex && (
                                                    <span className="ml-2 text-green-600">✓ Correct</span>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                    {userRole === 'student' && (
                                        <p className="text-gray-500 text-sm mt-3">
                                            Correct answers will be revealed after you complete the quiz.
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}