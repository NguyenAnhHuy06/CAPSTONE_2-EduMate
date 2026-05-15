/** Vietnamese Latin letters (covers common NFC text from PDFs / UI). */
const VI_CHARS =
  /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴĐ]/;

export type FlashcardGenLanguage = 'vi' | 'en';

/**
 * Prefer Vietnamese when document metadata / hints contain Vietnamese script.
 * Otherwise English (stable default when the source filename is ASCII-only).
 */
export function inferFlashcardOutputLanguage(
  document: Record<string, unknown> | null | undefined,
  extraText?: string
): FlashcardGenLanguage {
  const raw = String(
    document?.language ?? document?.lang ?? document?.locale ?? ''
  )
    .trim()
    .toLowerCase();
  if (/^vi/.test(raw) || raw === 'vn' || raw === 'vietnamese') return 'vi';
  if (/^en/.test(raw) || raw === 'english' || raw === 'us' || raw === 'uk') return 'en';

  const chunks = [
    document?.title,
    document?.fileName,
    document?.originalName,
    document?.originalFileName,
    document?.s3Key,
    document?.description,
    document?.uploadDescription,
    document?.displayDescription,
    document?.summary,
    document?.abstract,
    extraText,
  ]
    .filter((x) => x != null && String(x).trim() !== '')
    .map((x) => String(x));

  const text = chunks.join('\n');
  if (VI_CHARS.test(text)) return 'vi';

  return 'en';
}

/** Several keys so different API versions can pick one up for the LLM prompt. */
export function flashcardGenerateLanguageFields(lang: FlashcardGenLanguage) {
  const locale = lang === 'vi' ? 'vi-VN' : 'en-US';
  return {
    outputLanguage: lang,
    output_language: lang,
    language: lang,
    flashcardLanguage: lang,
    locale,
    promptLanguage: lang,
  };
}
