/**
 * Quiz JSON for browsers (Vite :5173 → proxy /api → BE).
 * - Resolve media_url stored as bare S3 keys to /api/questions/media/file?s3Key=...
 * - Align question shape: type, question_type, options object.
 */

const MEDIA_PROXY_PATH = "/api/questions/media/file";

function isHttpLikeUrl(s) {
  return /^https?:\/\//i.test(String(s || "").trim());
}

function resolveQuestionMediaUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (isHttpLikeUrl(s)) return s;
  if (s.includes("/api/questions/media/file")) {
    return s.startsWith("/") ? s : `/${s.replace(/^\/+/, "")}`;
  }
  // Stored as object key only, e.g. question-bank-media/user-1/image/x.jpg
  if (!s.includes("://") && !s.startsWith("/")) {
    return `${MEDIA_PROXY_PATH}?s3Key=${encodeURIComponent(s)}`;
  }
  return s;
}

function normalizeQuestionsForClient(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.map((q) => {
    if (!q || typeof q !== "object") return q;
    const mediaRaw = q.media_url ?? q.mediaUrl ?? "";
    const resolved = resolveQuestionMediaUrl(mediaRaw);
    const out = { ...q };
    if (resolved) {
      out.media_url = resolved;
      out.mediaUrl = resolved;
      const mt = String(out.media_type || out.mediaType || "").toLowerCase();
      if (mt === "image" || (!mt && /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(resolved))) {
        out.imageUrl = resolved;
      }
    }
    const t =
      String(out.type || out.question_type || "multiple-choice").trim() || "multiple-choice";
    out.type = t;
    out.question_type = t;
    const hasObj =
      out.options &&
      typeof out.options === "object" &&
      !Array.isArray(out.options);
    if (!hasObj) {
      out.options = {
        A: out.option_a ?? out.optionA ?? "",
        B: out.option_b ?? out.optionB ?? "",
        C: out.option_c ?? out.optionC ?? "",
        D: out.option_d ?? out.optionD ?? "",
      };
    }
    return out;
  });
}

module.exports = {
  normalizeQuestionsForClient,
  resolveQuestionMediaUrl,
};
