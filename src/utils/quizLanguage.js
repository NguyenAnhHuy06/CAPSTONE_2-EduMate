/**
 * Quiz output language: match document (Vietnamese vs English) when hint is Auto.
 */

function detectTextLanguageVIorEN(text) {
  const t = String(text || "");
  if (!t.trim()) return "en";

  const sample = t.length > 16000 ? t.slice(0, 16000) : t;

  const viDiacritics = (sample.match(/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/g) || []).length;
  const viStops =
    (
      sample.match(
        /\b(và|là|của|cho|để|trong|ngoài|một|những|các|với|không|có|khi|thì|nếu|đã|đang|trên|dưới|từ|tại|này|đó|như|theo|được|phải|cần|còn|hay|hoặc|nhưng|vì|nên|về|các|nội|dung|câu|hỏi|đáp|án|tài|liệu|chương|học|sinh|viên|giảng|trình)\b/gi
      ) || []
    ).length;
  const enStops =
    (sample.match(/\b(the|and|is|are|to|of|in|that|it|for|on|with|as|at|by|an|this|which|from|not)\b/gi) || [])
      .length;

  const viScore = viDiacritics * 2 + viStops * 3;
  const enScore = enStops * 2;

  if (viScore >= 4 && viScore >= enScore) return "vi";
  return "en";
}

function resolveQuizLanguage(languageHint, textForDetect) {
  const hint = String(languageHint || "").trim().toLowerCase();
  if (!hint || hint === "auto") return detectTextLanguageVIorEN(textForDetect);
  if (
    hint === "vi" ||
    hint.startsWith("vi") ||
    hint.includes("vietnam") ||
    hint.includes("vietnamese") ||
    hint.includes("tiếng") ||
    hint.includes("tieng")
  ) {
    return "vi";
  }
  if (hint === "en" || hint.startsWith("en") || hint.includes("english")) return "en";
  return detectTextLanguageVIorEN(textForDetect);
}

function languageLabel(lang) {
  return lang === "vi" ? "Tiếng Việt" : "English";
}

function languageRequirement(lang) {
  return lang === "vi"
    ? "You MUST write every question, every option, and all visible text in Vietnamese using correct Vietnamese diacritics. Do not answer in English unless the provided context is entirely in English."
    : "Write questions, options, and any text in English.";
}

module.exports = {
  detectTextLanguageVIorEN,
  resolveQuizLanguage,
  languageLabel,
  languageRequirement,
};
