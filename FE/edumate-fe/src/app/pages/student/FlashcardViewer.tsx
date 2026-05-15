import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, ClipboardList, Edit2, Play, X } from 'lucide-react';
import api from '../../../services/api';
import { EDUMATE_FLASHCARDS_SAVED_EVENT } from '../FlashcardCreator';
import {
  getCurrentUserId,
  mergeApiWithLocalFlashcards,
  readLocalFlashcardSets,
} from '../../../utils/flashcardLocalSets';

interface FlashcardViewerProps {
  document: any;
  user?: any;
  onBack: () => void;
  /** Open creator with this set’s cards (Edit flashcard). */
  onEditSet?: (payload: { setId: string; cards: Array<{ id: string; front: string; back: string }> }) => void;
}

interface Flashcard {
  id: string;
  question: string;
  answer: string;
  setId?: string;
  createdAt?: string;
}

function previewText(raw: string, maxLen: number) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '—';
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

function unwrapFlashcardRows(res: any): any[] {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.data)) return res.data;
  if (Array.isArray(res.flashcards)) return res.flashcards;
  if (res.data && typeof res.data === 'object' && Array.isArray((res.data as any).flashcards)) {
    return (res.data as any).flashcards;
  }
  if (Array.isArray(res.items)) return res.items;
  if (res.data && typeof res.data === 'object' && Array.isArray((res.data as any).items)) {
    return (res.data as any).items;
  }
  return [];
}

export function FlashcardViewer({ document, user, onBack, onEditSet }: FlashcardViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [flashcards, setFlashcards] = useState<Flashcard[]>([]);
  const [viewMode, setViewMode] = useState<'list' | 'study'>('list');
  const [activeSetId, setActiveSetId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showStudyPicker, setShowStudyPicker] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const documentId =
  document?.documentId != null && Number.isFinite(Number(document.documentId))
    ? Number(document.documentId)
    : null;

  const userId = useMemo(() => getCurrentUserId(user), [user]);

  const loadFlashcards = useCallback(
    async (opts?: { preserveActiveSet?: boolean; silent?: boolean }) => {
      const silent = Boolean(opts?.silent);
      if (!documentId) {
        setError('Missing document ID.');
        if (!silent) setLoading(false);
        return;
      }

      if (!silent) {
        setLoading(true);
        setError('');
      }

      try {
        const res: any = await api.get(`/flashcards/document/${documentId}`, {
          params: { userId: userId ?? 0, _t: Date.now() },
        });

        if (res?.success === false) {
          setError(res?.message || 'Could not load flashcards.');
          if (!silent) setFlashcards([]);
          return;
        }

        const rows = unwrapFlashcardRows(res);

        const mapped: Flashcard[] = rows.map((card: any) => ({
          id: String(card.flashcard_id ?? card.id ?? ''),
          question: String(card.front_text ?? card.front ?? card.question ?? ''),
          answer: String(card.back_text ?? card.back ?? card.answer ?? ''),
          setId: String(
            card.flashcard_set_id ?? card.set_id ?? card.setId ?? ''
          ).trim() || undefined,
          createdAt: String(card.created_at ?? card.createdAt ?? '').trim() || undefined,
        })).filter((c) => c.id);

        const locals = readLocalFlashcardSets(Number(documentId), userId);
        const merged = mergeApiWithLocalFlashcards(mapped, locals);

        setError('');
        setFlashcards(merged);
        if (opts?.preserveActiveSet) {
          setActiveSetId((prev) => {
            if (prev == null) return null;
            const groupIds = new Set(
              merged.map((c) => (c.setId && c.setId.trim() ? c.setId.trim() : 'default'))
            );
            return groupIds.has(prev) ? prev : null;
          });
        } else {
          setActiveSetId(null);
        }
      } catch (err: any) {
        setError(err?.response?.data?.message || err?.message || 'Could not load flashcards.');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [documentId, userId]
  );

  useEffect(() => {
    void loadFlashcards({ preserveActiveSet: false, silent: false });
  }, [loadFlashcards]);

  useEffect(() => {
    const handler = (ev: Event) => {
      const e = ev as CustomEvent<{ documentId?: number }>;
      if (Number(e.detail?.documentId) !== Number(documentId)) return;
      void loadFlashcards({ preserveActiveSet: true, silent: true });
    };
    window.addEventListener(EDUMATE_FLASHCARDS_SAVED_EVENT, handler as EventListener);
    return () => window.removeEventListener(EDUMATE_FLASHCARDS_SAVED_EVENT, handler as EventListener);
  }, [documentId, loadFlashcards]);

  const setGroups = useMemo(() => {
    const groups = new Map<string, { setId: string; createdAt: string | null; cards: Flashcard[] }>();
    const fallbackSetId = 'default';
    for (const c of flashcards) {
      const sid = c.setId && c.setId.trim() ? c.setId.trim() : fallbackSetId;
      const createdAt = c.createdAt && c.createdAt.trim() ? c.createdAt.trim() : null;
      const existing = groups.get(sid);
      if (!existing) {
        groups.set(sid, { setId: sid, createdAt, cards: [c] });
      } else {
        existing.cards.push(c);
        if (!existing.createdAt && createdAt) existing.createdAt = createdAt;
      }
    }
    // newest first when createdAt exists, otherwise keep insertion order
    return Array.from(groups.values()).sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  }, [flashcards]);

  const activeSet = useMemo(() => {
    if (!activeSetId) return null;
    return setGroups.find((g) => g.setId === activeSetId) || null;
  }, [activeSetId, setGroups]);

  const filteredFlashcards = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = activeSet ? activeSet.cards : flashcards;
    if (!q) return base;
    return base.filter((c) => c.question.toLowerCase().includes(q) || c.answer.toLowerCase().includes(q));
  }, [activeSet, flashcards, query]);

  const handleFlip = () => {
    setIsFlipped(!isFlipped);
  };

  const handleNext = () => {
    if (currentIndex < filteredFlashcards.length - 1) {
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

  const beginStudyForSet = (setId: string) => {
    setActiveSetId(setId);
    setQuery('');
    setCurrentIndex(0);
    setIsFlipped(false);
    setShowStudyPicker(false);
    setViewMode('study');
  };

  const onHeaderStudyClick = () => {
    if (setGroups.length === 0) return;
    setShowStudyPicker(true);
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
              You have not created any flashcards for: <span className="text-blue-600">{document?.title}</span>
            </p>
        </div>
      </div>
    );
  }

  const studyCards = filteredFlashcards;
  const safeStudyIndex = Math.min(Math.max(0, currentIndex), Math.max(0, studyCards.length - 1));
  const currentCard = studyCards[safeStudyIndex];

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
          <div className="mt-4 flex flex-wrap items-center gap-2 justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowStudyPicker(false);
                  setViewMode('list');
                }}
                className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                  viewMode === 'list'
                    ? 'bg-blue-50 border-blue-600 text-blue-700'
                    : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                <ClipboardList size={16} />
                List
              </button>
              <button
                type="button"
                onClick={onHeaderStudyClick}
                className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                  viewMode === 'study'
                    ? 'bg-blue-50 border-blue-600 text-blue-700'
                    : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
                title="Choose which flashcard set to study"
              >
                <Play size={16} />
                Study
              </button>
            </div>

            <div className="flex items-center gap-2">
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCurrentIndex(0);
                  setIsFlipped(false);
                }}
                placeholder="Search flashcards..."
                className="w-[240px] max-w-[70vw] px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-xs text-gray-500">
                {filteredFlashcards.length}/{flashcards.length}
              </span>
            </div>
          </div>
        </div>

        {viewMode === 'list' ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-gray-900">My Flashcards</h3>
                <p className="text-xs text-gray-500">Search filters the list below</p>
              </div>
              <p className="text-xs text-gray-500">
                {filteredFlashcards.length}/{flashcards.length}
              </p>
            </div>

            {activeSetId == null ? (
              setGroups.map((g, idx) => (
                <div
                  key={g.setId}
                  className="bg-white rounded-lg border border-gray-200 p-5 hover:shadow-md transition-shadow cursor-pointer"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setActiveSetId(g.setId);
                    setQuery('');
                    setCurrentIndex(0);
                    setIsFlipped(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setActiveSetId(g.setId);
                      setQuery('');
                      setCurrentIndex(0);
                      setIsFlipped(false);
                    }
                  }}
                  aria-label={`Open flashcard set ${idx + 1}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-blue-50 text-blue-700 text-sm font-semibold">
                          {idx + 1}
                        </span>
                        <h3 className="text-gray-900 truncate">Flashcard set</h3>
                      </div>
                      <p className="text-gray-600 text-sm">
                        {g.cards.length} cards
                        {g.createdAt ? (
                          <span className="text-gray-400"> • {new Date(g.createdAt).toLocaleString()}</span>
                        ) : null}
                      </p>
                      <p className="text-gray-600 text-sm leading-relaxed mt-2">
                        Preview: {previewText(g.cards[0]?.question || '', 140)}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveSetId(g.setId);
                        setQuery('');
                        setCurrentIndex(0);
                        setIsFlipped(false);
                      }}
                      className="flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors shrink-0"
                    >
                      <Play size={18} />
                      Open
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="text-sm text-blue-600 hover:text-blue-700"
                      onClick={() => {
                        setActiveSetId(null);
                        setQuery('');
                        setCurrentIndex(0);
                        setIsFlipped(false);
                      }}
                    >
                      ← Back to sets
                    </button>
                    <p className="text-xs text-gray-500">{filteredFlashcards.length} cards</p>
                  </div>
                  {onEditSet && activeSet ? (
                    <button
                      type="button"
                      onClick={() => {
                        onEditSet({
                          setId: activeSet.setId,
                          cards: activeSet.cards.map((card) => ({
                            id: card.id,
                            front: card.question,
                            back: card.answer,
                          })),
                        });
                      }}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm shrink-0"
                    >
                      <Edit2 size={18} />
                      Edit flashcard
                    </button>
                  ) : null}
                </div>

                <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
                  {filteredFlashcards.map((c, idx) => (
                    <div
                      key={c.id}
                      className="rounded-lg border border-gray-100 bg-gray-50/80 p-4 hover:bg-gray-50 cursor-pointer transition-colors"
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setViewMode('study');
                        setCurrentIndex(idx);
                        setIsFlipped(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setViewMode('study');
                          setCurrentIndex(idx);
                          setIsFlipped(false);
                        }
                      }}
                      aria-label={`Study flashcard ${idx + 1}`}
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-blue-50 text-blue-700 text-sm font-semibold shrink-0">
                          {idx + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-gray-500 mb-1">Preview</p>
                          <p className="text-gray-800 text-sm leading-relaxed">{previewText(c.question, 200)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-gray-600">Progress</span>
                <span className="text-gray-600">
                  {studyCards.length ? safeStudyIndex + 1 : 0} / {studyCards.length}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all"
                  style={{ width: `${studyCards.length ? ((safeStudyIndex + 1) / studyCards.length) * 100 : 0}%` }}
                />
              </div>
            </div>

            {studyCards.length ? (
              <>
                <div style={{ perspective: '1200px' }} className="mb-6">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label="Flip flashcard"
                    onClick={handleFlip}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleFlip();
                      }
                    }}
                    className="relative min-h-[400px] cursor-pointer"
                  >
                    <div
                      className="relative w-full h-[400px] transition-transform duration-500"
                      style={{
                        transformStyle: 'preserve-3d',
                        transform: isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
                      }}
                    >
                      <div
                        className="absolute inset-0 bg-white rounded-lg border-2 border-gray-200 p-8 flex items-center justify-center"
                        style={{ backfaceVisibility: 'hidden' }}
                      >
                        <div className="text-center">
                          <p className="text-gray-500 text-sm mb-4">Question</p>
                          <p className="text-gray-900 text-xl leading-relaxed">{currentCard.question}</p>
                        </div>
                      </div>
                      <div
                        className="absolute inset-0 bg-white rounded-lg border-2 border-gray-200 p-8 flex items-center justify-center"
                        style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
                      >
                        <div className="text-center">
                          <p className="text-gray-500 text-sm mb-4">Answer</p>
                          <p className="text-gray-900 text-xl leading-relaxed">{currentCard.answer}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <button
                    onClick={handlePrevious}
                    disabled={safeStudyIndex === 0}
                    className={`flex items-center gap-2 px-6 py-3 rounded-lg transition-colors ${
                      safeStudyIndex === 0
                        ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                        : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <ChevronLeft size={20} />
                    Previous
                  </button>

                  <div className="flex gap-2">
                    {studyCards.map((_, idx) => (
                      <button
                        type="button"
                        aria-label={`Go to flashcard ${idx + 1}`}
                        key={idx}
                        onClick={() => {
                          setCurrentIndex(idx);
                          setIsFlipped(false);
                        }}
                        className={`w-3 h-3 rounded-full transition-colors ${
                          idx === safeStudyIndex ? 'bg-blue-600' : 'bg-gray-300 hover:bg-gray-400'
                        }`}
                      />
                    ))}
                  </div>

                  <button
                    onClick={handleNext}
                    disabled={safeStudyIndex === studyCards.length - 1}
                    className={`flex items-center gap-2 px-6 py-3 rounded-lg transition-colors ${
                      safeStudyIndex === studyCards.length - 1
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
                    <strong>Tip:</strong> Click the flashcard to flip between question and answer, then use the navigation buttons to move between cards.
                  </p>
                </div>
              </>
            ) : (
              <div className="bg-white rounded-lg border border-gray-200 p-6">
                <p className="text-gray-600">No flashcards match your search.</p>
              </div>
            )}
          </>
        )}
      </div>

      {showStudyPicker && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="study-picker-title"
          onClick={() => setShowStudyPicker(false)}
        >
          <div
            className="bg-white rounded-xl border border-gray-200 shadow-xl max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 p-4 border-b border-gray-100">
              <h3 id="study-picker-title" className="text-gray-900 font-semibold">
                Choose a set to study
              </h3>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setShowStudyPicker(false)}
                className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700"
              >
                <X size={20} />
              </button>
            </div>
            <div className="overflow-y-auto p-3 space-y-2">
              {setGroups.map((g, idx) => (
                <button
                  key={g.setId}
                  type="button"
                  onClick={() => beginStudyForSet(g.setId)}
                  className="w-full text-left rounded-lg border border-gray-200 p-4 hover:border-blue-300 hover:bg-blue-50/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900">
                        Set {idx + 1}
                        <span className="text-gray-500 font-normal text-sm"> · {g.cards.length} cards</span>
                      </p>
                      {g.createdAt ? (
                        <p className="text-xs text-gray-500 mt-1">{new Date(g.createdAt).toLocaleString()}</p>
                      ) : null}
                      <p className="text-sm text-gray-600 mt-2 line-clamp-2">{previewText(g.cards[0]?.question || '', 120)}</p>
                    </div>
                    <span className="shrink-0 inline-flex items-center gap-1 text-sm text-blue-600 font-medium">
                      <Play size={16} />
                      Study
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}