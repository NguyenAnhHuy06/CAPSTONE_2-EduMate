/**
 * Client-side backup of flashcard *sets* per document.
 * Per-document storage avoids missing rows when userId from props vs save differ.
 * Still stores userId on each set for filtering when possible.
 */

const DOC_SETS_PREFIX = 'edumate_fc_doc_sets_v1:';

/** Legacy single-blob store (kept for one-way migration). */
const LEGACY_STORAGE_KEY = 'edumate_local_flashcard_sets_v1';

export type LocalFlashcardSet = {
  documentId: number;
  userId: number;
  setId: string;
  savedAt: string;
  cards: Array<{ id: string; front: string; back: string }>;
};

type LegacyShape = { sets: LocalFlashcardSet[] };

export function getCurrentUserId(user?: any): number | null {
  const candidates = [user?.user_id, user?.id, user?.userId, user?.USER_ID];
  for (const c of candidates) {
    if (c != null && c !== '' && Number.isFinite(Number(c))) return Number(c);
  }
  try {
    const raw = localStorage.getItem('edumate_user');
    if (!raw) return null;
    const u = JSON.parse(raw) as Record<string, unknown>;
    const id = u?.user_id ?? u?.id ?? u?.userId;
    if (id != null && id !== '' && Number.isFinite(Number(id))) return Number(id);
  } catch {
    return null;
  }
  return null;
}

function docKey(documentId: number) {
  return `${DOC_SETS_PREFIX}${Number(documentId)}`;
}

function readDocArray(documentId: number): LocalFlashcardSet[] {
  try {
    const raw = localStorage.getItem(docKey(documentId));
    if (!raw) return [];
    const arr = JSON.parse(raw) as LocalFlashcardSet[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeDocArray(documentId: number, sets: LocalFlashcardSet[]) {
  try {
    localStorage.setItem(docKey(documentId), JSON.stringify(sets));
  } catch {
    // ignore
  }
}

function readLegacyAll(): LocalFlashcardSet[] {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw) as LegacyShape;
    return Array.isArray(p?.sets) ? p.sets : [];
  } catch {
    return [];
  }
}

/** Merge legacy global rows for this document into doc-scoped list (once). */
function migrateLegacyIntoDoc(documentId: number): LocalFlashcardSet[] {
  const legacy = readLegacyAll().filter((s) => Number(s.documentId) === Number(documentId));
  if (!legacy.length) return readDocArray(documentId);
  const existing = readDocArray(documentId);
  const byId = new Map<string, LocalFlashcardSet>();
  legacy.forEach((s) => byId.set(String(s.setId), s));
  existing.forEach((s) => byId.set(String(s.setId), s));
  const merged = Array.from(byId.values());
  writeDocArray(documentId, merged);
  try {
    const rest = readLegacyAll().filter((s) => Number(s.documentId) !== Number(documentId));
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ sets: rest }));
  } catch {
    // ignore
  }
  return merged;
}

export function upsertLocalFlashcardSet(entry: LocalFlashcardSet) {
  const docId = Number(entry.documentId);
  migrateLegacyIntoDoc(docId);
  const arr = readDocArray(docId);
  const next = arr.filter((s) => String(s.setId) !== String(entry.setId));
  next.push(entry);
  writeDocArray(docId, next);

  // Also mirror to legacy blob so older builds still see data (optional).
  try {
    const all = readLegacyAll().filter(
      (s) =>
        !(
          Number(s.documentId) === Number(entry.documentId) &&
          Number(s.userId) === Number(entry.userId) &&
          String(s.setId) === String(entry.setId)
        )
    );
    all.push(entry);
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ sets: all }));
  } catch {
    // ignore
  }
}

export function readLocalFlashcardSets(documentId: number, userId: number | null): LocalFlashcardSet[] {
  const merged = migrateLegacyIntoDoc(Number(documentId));
  if (!merged.length) return [];

  if (userId == null || !Number.isFinite(userId)) return merged;

  const strict = merged.filter((s) => Number(s.userId) === Number(userId));
  if (strict.length) return strict;

  // Saved with userId 0 when profile id was missing — still show for this document.
  const anon = merged.filter((s) => Number(s.userId) === 0);
  if (anon.length) return anon;

  return merged;
}

export type MergeFlashcardRow = {
  id: string;
  question: string;
  answer: string;
  setId?: string;
  createdAt?: string;
};

/**
 * Prefer API rows when the same setId exists; otherwise use local snapshots.
 * If API returns only anonymous rows (no setId) but we have local sets, return local-built rows only.
 */
export function mergeApiWithLocalFlashcards(
  apiMapped: MergeFlashcardRow[],
  locals: LocalFlashcardSet[]
): MergeFlashcardRow[] {
  if (!locals.length) return apiMapped;

  const localBySetId = new Map(locals.map((l) => [String(l.setId).trim(), l]));
  const sortedLocals = [...locals].sort(
    (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime()
  );

  const out: MergeFlashcardRow[] = [];

  for (const ls of sortedLocals) {
    const sid = String(ls.setId).trim();
    const fromApi = apiMapped.filter((c) => (c.setId?.trim() || '') === sid);
    if (fromApi.length) {
      out.push(...fromApi);
    } else {
      ls.cards.forEach((card, i) => {
        out.push({
          id: String(card.id || `${sid}-l-${i}`),
          question: String(card.front || ''),
          answer: String(card.back || ''),
          setId: sid,
          createdAt: ls.savedAt,
        });
      });
    }
  }

  for (const c of apiMapped) {
    const sid = c.setId?.trim();
    if (sid && !localBySetId.has(sid)) out.push(c);
  }

  const apiAllAnonymous = apiMapped.length > 0 && apiMapped.every((c) => !c.setId?.trim());
  if (apiAllAnonymous && out.length > 0) return out;

  return out.length ? out : apiMapped;
}
