import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, RotateCw } from 'lucide-react';
import api from '../../../services/api';

interface FlashcardViewerProps {
  document: any;
  onBack: () => void;
}

interface Flashcard {
  id: string;
  question: string;
  answer: string;
}

export function FlashcardViewer({ document, onBack }: FlashcardViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [flashcards, setFlashcards] = useState<Flashcard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const documentId =
  document?.documentId != null && Number.isFinite(Number(document.documentId))
    ? Number(document.documentId)
    : null;

  useEffect(() => {
    const loadFlashcards = async () => {
      if (!documentId) {
        setError('Missing document ID.');
        setLoading(false);
        return;
      }

      try {
        const res: any = await api.get(`/flashcards/document/${documentId}`);

        if (res?.success === false) {
          setError(res?.message || 'Could not load flashcards.');
          setLoading(false);
          return;
        }

        const rows = Array.isArray(res?.data) ? res.data : [];

        const mapped: Flashcard[] = rows.map((card: any) => ({
          id: String(card.flashcard_id),
          question: String(card.front_text || ''),
          answer: String(card.back_text || ''),
        }));

        setFlashcards(mapped);
      } catch (err: any) {
        setError(err?.response?.data?.message || err?.message || 'Could not load flashcards.');
      } finally {
        setLoading(false);
      }
    };

    loadFlashcards();
  }, [documentId]);

  const handleFlip = () => {
    setIsFlipped(!isFlipped);
  };

  const handleNext = () => {
    if (currentIndex < flashcards.length - 1) {
      setCurrentIndex(currentIndex + 1);
      setIsFlipped(false);
    }
  };

  const handlePrevious = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
      setIsFlipped(false);
    }
  };

  if (loading) {
    return (
      <div>
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-blue-600 hover:text-blue-700 mb-6"
        >
          <ArrowLeft size={20} />
          Back to Document
        </button>

        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <p className="text-gray-600">Loading flashcards...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-blue-600 hover:text-blue-700 mb-6"
        >
          <ArrowLeft size={20} />
          Back to Document
        </button>

        <div className="bg-white rounded-lg border border-red-200 p-6">
          <p className="text-red-600">{error}</p>
        </div>
      </div>
    );
  }

  if (!flashcards.length) {
    return (
      <div>
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-blue-600 hover:text-blue-700 mb-6"
        >
          <ArrowLeft size={20} />
          Back to Document
        </button>

        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="mb-2">Study Flashcards</h2>
          <p className="text-gray-600">
              No lecturer flashcards are available for: <span className="text-blue-600">{document?.title}</span>
          </p>
        </div>
      </div>
    );
  }

  const currentCard = flashcards[currentIndex];

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-blue-600 hover:text-blue-700 mb-6"
      >
        <ArrowLeft size={20} />
        Back to Document
      </button>

      <div className="max-w-3xl mx-auto">
        <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
          <h2 className="mb-2">Study Flashcards</h2>
          <p className="text-gray-600">
            Studying: <span className="text-blue-600">{document?.title}</span>
          </p>
        </div>

        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-600">Progress</span>
            <span className="text-gray-600">
              {currentIndex + 1} / {flashcards.length}
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all"
              style={{ width: `${((currentIndex + 1) / flashcards.length) * 100}%` }}
            />
          </div>
        </div>

        <div className="bg-white rounded-lg border-2 border-gray-200 p-8 mb-6 min-h-[400px] flex flex-col">
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-gray-500 text-sm mb-4">
                {isFlipped ? 'Answer' : 'Question'}
              </p>
              <p className="text-gray-900 text-xl leading-relaxed">
                {isFlipped ? currentCard.answer : currentCard.question}
              </p>
            </div>
          </div>

          <div className="pt-6 border-t border-gray-200 mt-6">
            <button
              onClick={handleFlip}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <RotateCw size={20} />
              {isFlipped ? 'Show Question' : 'Show Answer'}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <button
            onClick={handlePrevious}
            disabled={currentIndex === 0}
            className={`flex items-center gap-2 px-6 py-3 rounded-lg transition-colors ${
              currentIndex === 0
                ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            <ChevronLeft size={20} />
            Previous
          </button>

          <div className="flex gap-2">
            {flashcards.map((_, idx) => (
              <button
                type="button"
                aria-label={`Go to flashcard ${idx + 1}`}
                key={idx}
                onClick={() => {
                  setCurrentIndex(idx);
                  setIsFlipped(false);
                }}
                className={`w-3 h-3 rounded-full transition-colors ${
                  idx === currentIndex ? 'bg-blue-600' : 'bg-gray-300 hover:bg-gray-400'
                }`}
              />
            ))}
          </div>

          <button
            onClick={handleNext}
            disabled={currentIndex === flashcards.length - 1}
            className={`flex items-center gap-2 px-6 py-3 rounded-lg transition-colors ${
              currentIndex === flashcards.length - 1
                ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            Next
            <ChevronRight size={20} />
          </button>
        </div>

        <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-blue-800 text-sm">
            <strong>Tip:</strong> Click "Show Answer" to reveal the answer, then use the navigation buttons to move between cards.
          </p>
        </div>
      </div>
    </div>
  );
}