import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Sparkles,
  Edit2,
  Save,
  Trash2,
  Plus,
  CheckCircle,
  RotateCw,
} from 'lucide-react';
import { useNotification } from './NotificationContext';
import api, { getApiErrorMessage, getStoredAuthToken } from '../../services/api';
import { getCurrentUserId, upsertLocalFlashcardSet } from '../../utils/flashcardLocalSets';
import {
  flashcardGenerateLanguageFields,
  inferFlashcardOutputLanguage,
} from '../../utils/inferFlashcardOutputLanguage';

const STUDENT_FLASHCARD_GENERATING_KEY = 'edumate_student_flashcard_generating';
/** Fired after flashcards are persisted so lists (e.g. Study My Flashcards) can refetch. */
export const EDUMATE_FLASHCARDS_SAVED_EVENT = 'edumate:flashcards-saved';

function emitFlashcardsSaved(documentId: number) {
  window.dispatchEvent(
    new CustomEvent(EDUMATE_FLASHCARDS_SAVED_EVENT, { detail: { documentId } })
  );
}

/** New set on each manual save (create flow). Edit flow uses `initialEdit.setId` instead. */
function newFlashcardSaveSetId() {
  return `flashcard-save-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type StudentFlashcardJobStatus = 'idle' | 'running' | 'completed' | 'failed';

export type FlashcardInitialEdit = {
  setId: string;
  cards: Array<{ id: string; front: string; back: string }>;
};

interface FlashcardCreatorProps {
  document: any;
  user?: any;
  onBack: () => void;
  /** When set, creator opens with these cards (e.g. from Study My Flashcards → Edit). */
  initialEdit?: FlashcardInitialEdit | null;
  /** Extra text (e.g. AI summary on document page) to infer output language for generation. */
  contentLanguageHint?: string;
}

interface Flashcard {
  id: string;
  front: string;
  back: string;
}

export function FlashcardCreator({
  document,
  user,
  onBack,
  initialEdit = null,
  contentLanguageHint = '',
}: FlashcardCreatorProps) {
  const { showNotification } = useNotification();

  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [flashcards, setFlashcards] = useState<Flashcard[]>([]);
  const [flashcardSetId, setFlashcardSetId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [flippedCards, setFlippedCards] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);
  const [authBlocked, setAuthBlocked] = useState(false);
  const generateInFlightRef = useRef(false);
  /** Set id already written to MySQL (generate or save) — reuse on next Save to avoid duplicate sets. */
  const [persistedSetId, setPersistedSetId] = useState<string | null>(null);

  const resolvedGenLanguage = useMemo(
    () => inferFlashcardOutputLanguage(document, contentLanguageHint),
    [document, contentLanguageHint]
  );

  const setFlashcardGeneratingStatus = (
    status: StudentFlashcardJobStatus,
    extra?: { jobId?: string; title?: string; error?: string; documentId?: number | null; s3Key?: string }
  ) => {
    const prevRaw = localStorage.getItem(STUDENT_FLASHCARD_GENERATING_KEY);
    let prev: any = null;
    try {
      prev = prevRaw ? JSON.parse(prevRaw) : null;
    } catch {
      prev = null;
    }
    const jobId = extra?.jobId || prev?.jobId || `job-${Date.now()}`;
    try {
      localStorage.setItem(
        STUDENT_FLASHCARD_GENERATING_KEY,
        JSON.stringify({
          running: status === 'running',
          status,
          jobId,
          title: extra?.title ?? prev?.title ?? '',
          error: extra?.error ?? '',
          documentId: extra?.documentId ?? prev?.documentId ?? null,
          s3Key: extra?.s3Key ?? prev?.s3Key ?? '',
          startedAt: prev?.startedAt ?? Date.now(),
          updatedAt: Date.now(),
        })
      );
    } catch {
      // ignore storage failures
    }
    window.dispatchEvent(new Event('edumate:student-flashcard-generating'));
  };

  const documentId =
  document?.documentId != null && Number.isFinite(Number(document.documentId))
    ? Number(document.documentId)
    : null;
    
  const s3Key = document?.s3Key;

  useEffect(() => {
    if (!initialEdit?.cards?.length) return;
    setFlashcards(
      initialEdit.cards.map((c) => ({
        id: String(c.id),
        front: String(c.front || ''),
        back: String(c.back || ''),
      }))
    );
    setFlashcardSetId(initialEdit.setId);
    setPersistedSetId(initialEdit.setId);
    setSaved(false);
    setEditingId(null);
    setFlippedCards(new Set());
  }, [initialEdit]);

  const resolveSaveSetId = () => {
    const editingSetId =
      initialEdit?.setId != null && String(initialEdit.setId).trim() !== ''
        ? String(initialEdit.setId).trim()
        : null;
    if (editingSetId) return editingSetId;
    const fromState = String(flashcardSetId || persistedSetId || '').trim();
    if (fromState) return fromState;
    return newFlashcardSaveSetId();
  };

  const persistFlashcards = async (cards: Flashcard[], setId?: string | null) => {
    if (!documentId) {
      return { ok: false, message: 'Missing document ID, so flashcards could not be saved automatically.' };
    }
    const validFlashcards = cards.filter((card) => card.front.trim() && card.back.trim());
    if (!validFlashcards.length) {
      return { ok: false, message: 'No valid flashcards to save.' };
    }
    const payload = {
      document_id: documentId,
      ...(setId ? { flashcard_set_id: setId } : {}),
      flashcards: validFlashcards.map((card) => ({
        front_text: card.front,
        back_text: card.back,
      })),
    };
    const res: any = await api.post('/flashcards', payload);
    if (res?.success === false) {
      return { ok: false, message: res?.message || 'Could not save flashcards.' };
    }
    return { ok: true, message: '' };
  };

  const generateFlashcards = async () => {
    if (generateInFlightRef.current || generating) return;

    const newJobId = `flashcard-gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const varietySeed = newJobId;
    const jobTitle = String(document?.title || 'AI Flashcards');
    const token = getStoredAuthToken();
    if (authBlocked && token) {
      setAuthBlocked(false);
    }
    if (!token) {
      setAuthBlocked(true);
      showNotification({
        type: 'warning',
        title: 'Authentication required',
        message: 'Please login and try again.',
        duration: 4000,
      });
      return;
    }

    if (authBlocked && !token) {
      showNotification({
        type: 'warning',
        title: 'Authentication required',
        message: 'Please login again before generating flashcards.',
        duration: 4000,
      });
      return;
    }

    if (!s3Key) {
      showNotification({
        type: 'error',
        title: 'Missing document key',
        message: 'This document does not have s3Key, so AI generation cannot run.',
        duration: 4000,
      });
      return;
    }

    generateInFlightRef.current = true;
    setGenerating(true);
    setFlashcardSetId(newJobId);
    setFlashcardGeneratingStatus('running', {
      jobId: newJobId,
      title: jobTitle,
      documentId,
      s3Key: String(s3Key || ''),
    });

    try {
      const res: any = await api.post('/flashcards/generate', {
        s3Key,
        ...(documentId != null ? { documentId } : {}),
        flashcardSetId: newJobId,
        flashcard_set_id: newJobId,
        varietySeed,
        ...flashcardGenerateLanguageFields(resolvedGenLanguage),
      });

      if (res?.success === false) {
        setFlashcardGeneratingStatus('failed', {
          jobId: newJobId,
          title: jobTitle,
          error: res?.message || 'Could not generate flashcards.',
        });
        showNotification({
          type: 'error',
          title: 'Generation failed',
          message: res?.message || 'Could not generate flashcards.',
          duration: 4000,
        });
        return;
      }

      const cards = Array.isArray(res?.data) ? res.data : [];

      const mapped: Flashcard[] = cards.map((card: any, index: number) => ({
        id: String(index + 1),
        front: String(card?.front || card?.front_text || ''),
        back: String(card?.back || card?.back_text || ''),
      }));

      setFlashcards(mapped);

      const savedSetId = String(
        res?.flashcardSetId ?? res?.saved?.flashcardSetId ?? newJobId
      ).trim();

      setFlashcardSetId(savedSetId);
      setPersistedSetId(savedSetId);
      setFlashcardGeneratingStatus('completed', {
        jobId: savedSetId,
        title: jobTitle,
      });
      if (documentId != null) emitFlashcardsSaved(documentId);
      showNotification({
        type: 'success',
        title: 'Flashcards generated',
        message: `Saved ${mapped.length} cards to Study My Flashcards. Editing? Use "Update saved set" (same set, not a new one).`,
        duration: 3000,
      });
    } catch (err: any) {
      setFlashcardGeneratingStatus('failed', {
        jobId: newJobId,
        title: jobTitle,
        error: getApiErrorMessage(err, 'Could not generate flashcards.'),
      });
      if (err?.response?.status === 401) {
        setAuthBlocked(true);
      }
      showNotification({
        type: 'error',
        title: 'Generation failed',
        message: getApiErrorMessage(err, 'Could not generate flashcards.'),
        duration: 4000,
      });
    } finally {
      generateInFlightRef.current = false;
      setGenerating(false);
    }
  };

  const updateFlashcard = (id: string, field: 'front' | 'back', value: string) => {
    setFlashcards((prev) =>
      prev.map((card) => (card.id === id ? { ...card, [field]: value } : card))
    );
  };

  const deleteFlashcard = (id: string) => {
    setFlashcards((prev) => prev.filter((card) => card.id !== id));
    setFlippedCards((prev) => {
      const newSet = new Set(prev);
      newSet.delete(id);
      return newSet;
    });
  };

  const addNewFlashcard = () => {
    const newCard: Flashcard = {
      id: Date.now().toString(),
      front: '',
      back: '',
    };
    setFlashcards((prev) => [...prev, newCard]);
    setEditingId(newCard.id);
  };

  const toggleFlip = (id: string) => {
    setFlippedCards((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      return newSet;
    });
  };

  const handleSave = async () => {
    const token = getStoredAuthToken();
    if (authBlocked && token) {
      setAuthBlocked(false);
    }
    if (!token || (authBlocked && !token)) {
      setAuthBlocked(true);
      showNotification({
        type: 'warning',
        title: 'Authentication required',
        message: 'Please login and try again.',
        duration: 4000,
      });
      return;
    }

    if (!documentId) {
      showNotification({
        type: 'error',
        title: 'Missing document ID',
        message: 'This document does not have documentId/id, so flashcards cannot be saved.',
        duration: 4000,
      });
      return;
    }

    setSaving(true);

    try {
      const setId = resolveSaveSetId();
      setFlashcardSetId(setId);
      setPersistedSetId(setId);
      const saveResult = await persistFlashcards(flashcards, setId);
      if (!saveResult.ok) {
        showNotification({
          type: 'warning',
          title: 'Save failed',
          message: saveResult.message || 'Could not save flashcards.',
          duration: 4000,
        });
        return;
      }

      if (documentId != null) emitFlashcardsSaved(documentId);
      if (documentId != null) {
        const uid = getCurrentUserId(user) ?? 0;
        const valid = flashcards.filter((card) => card.front.trim() && card.back.trim());
        upsertLocalFlashcardSet({
          documentId,
          userId: uid,
          setId,
          savedAt: new Date().toISOString(),
          cards: valid.map((c) => ({ id: c.id, front: c.front, back: c.back })),
        });
      }

      showNotification({
        type: 'success',
        title: 'Flashcards Saved!',
        message: 'Your flashcards have been saved to your study collection.',
        duration: 3000,
      });

      setSaved(true);
      setTimeout(() => {
        onBack();
      }, 1500);
    } catch (err: any) {
      if (err?.response?.status === 401) {
        setAuthBlocked(true);
      }
      showNotification({
        type: 'error',
        title: 'Save failed',
        message: getApiErrorMessage(err, 'Could not save flashcards.'),
        duration: 4000,
      });
    } finally {
      setSaving(false);
    }
  };

  if (saved) {
    return (
      <div className="flex items-center justify-center min-h-[600px]">
        <div className="text-center">
          <div className="bg-green-100 text-green-600 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle size={48} />
          </div>
          <h2 className="text-green-600 mb-2">Flashcards Saved!</h2>
          <p className="text-gray-600">Your flashcards have been saved to your study collection.</p>
        </div>
      </div>
    );
  }

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
        <h2 className="mb-2">AI Flashcard Creator</h2>
        <p className="text-gray-600 mb-4">
          Generate flashcards based on: <span className="text-blue-600">{document?.title}</span>
        </p>

        {flashcards.length === 0 ? (
          <button
            onClick={generateFlashcards}
            disabled={generating || authBlocked}
            className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-400"
          >
            {generating ? (
              <>
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white" />
                Generating Flashcards...
              </>
            ) : authBlocked ? (
              'Authentication required'
            ) : (
              <>
                <Sparkles size={20} />
                Generate Flashcards with AI
              </>
            )}
          </button>
        ) : (
          <div className="flex gap-3">
            <button
              onClick={addNewFlashcard}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors"
            >
              <Plus size={18} />
              Add Flashcard
            </button>
            <button
              onClick={handleSave}
              disabled={saving || authBlocked}
              title={
                persistedSetId
                  ? 'Update the flashcard set already saved on the server'
                  : 'Save as a new flashcard set'
              }
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-400"
            >
              <Save size={18} />
              {saving
                ? 'Saving...'
                : persistedSetId
                  ? 'Update saved set'
                  : 'Save Flashcards'}
            </button>
          </div>
        )}
      </div>

      {flashcards.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {flashcards.map((card, index) => (
            <div key={card.id} className="bg-white rounded-lg border border-gray-200 p-6">
              <div className="flex items-start justify-between mb-4">
                <span className="text-gray-500">Card {index + 1}</span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    aria-label="Edit Flashcard"
                    onClick={() => setEditingId(editingId === card.id ? null : card.id)}
                    className="p-1 text-blue-600 hover:bg-blue-50 rounded transition-colors"
                  >
                    <Edit2 size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="Delete Flashcard"
                    onClick={() => deleteFlashcard(card.id)}
                    className="p-1 text-red-600 hover:bg-red-50 rounded transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              {editingId === card.id ? (
                <div className="space-y-3">
                  <div>
                    <label htmlFor={`front-${card.id}`} className="block text-gray-700 mb-1 text-sm">
                      Front
                    </label>
                    <textarea
                      id={`front-${card.id}`}
                      value={card.front}
                      onChange={(e) => updateFlashcard(card.id, 'front', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                      rows={2}
                    />
                  </div>
                  <div>
                    <label htmlFor={`back-${card.id}`} className="block text-gray-700 mb-1 text-sm">
                      Back
                    </label>
                    <textarea
                      id={`back-${card.id}`}
                      value={card.back}
                      onChange={(e) => updateFlashcard(card.id, 'back', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                      rows={3}
                    />
                  </div>
                </div>
              ) : (
                <div
                  onClick={() => toggleFlip(card.id)}
                  className="cursor-pointer min-h-[180px] flex flex-col justify-between"
                >
                  <div className="flex-1 flex items-center justify-center">
                    <p className="text-gray-900 text-center">
                      {flippedCards.has(card.id) ? card.back : card.front}
                    </p>
                  </div>
                  <div className="flex items-center justify-center pt-4 border-t border-gray-100 text-blue-600">
                    <RotateCw size={16} className="mr-2" />
                    <span className="text-sm">
                      {flippedCards.has(card.id) ? 'Click to see question' : 'Click to see answer'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}