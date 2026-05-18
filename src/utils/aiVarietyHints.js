/** Deterministic variety angles from a seed so each generation run differs. */
function buildGenerationVarietyHints(seed) {
  const s = String(seed || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const angles = [
    "definitions and key terminology",
    "cause-and-effect and relationships",
    "comparisons, contrasts, and distinctions",
    "steps, processes, and procedures",
    "concrete examples and applications",
    "names, dates, figures, and factual details",
    "requirements, constraints, and rules stated in the text",
    "common misconceptions the text clarifies",
  ];
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  const i0 = Math.abs(h) % angles.length;
  const i1 = (Math.abs(h >>> 8) + 3) % angles.length;
  return {
    seed: s,
    primary: angles[i0],
    secondary: angles[i1 !== i0 ? i1 : (i1 + 1) % angles.length],
  };
}

function flashcardVarietyBlock(seed) {
  const { primary, secondary } = buildGenerationVarietyHints(seed);
  return [
    `Generation batch id: ${seed}.`,
    "Create a NEW flashcard set that must NOT reuse generic templates (e.g. avoid vague questions like \"What is the main topic of the thesis?\" unless the text explicitly centers on that).",
    `Emphasize: ${primary} and ${secondary}.`,
    "Pull specific facts, terms, and details from different parts of the source text.",
    "Each card must be answerable only from the provided text.",
  ].join("\n");
}

function quizVarietyBlock(seed) {
  const { primary, secondary } = buildGenerationVarietyHints(seed);
  return [
    `Generation batch id: ${seed}.`,
    "Produce a NEW question set — vary wording and angles; do not repeat boilerplate stems from prior runs.",
    "Each question must test a DIFFERENT fact, term, or idea from the context (no duplicate or near-duplicate stems).",
    "Avoid generic templates such as \"What is the main topic?\", \"What is the purpose of the document?\", or \"Which statement is true?\" unless unavoidable.",
    `Emphasize question styles around: ${primary} and ${secondary}.`,
    "Mix recall, application, and short scenario-style items when the context supports it.",
  ].join("\n");
}

function priorQuestionsAvoidBlock(stems) {
  const list = (Array.isArray(stems) ? stems : [])
    .map((s) => String(s || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!list.length) return "";
  const unique = [...new Set(list)].slice(0, 30);
  return [
    "Do NOT repeat, paraphrase, or lightly reword any of these existing questions:",
    ...unique.map((s, i) => `${i + 1}. ${s}`),
    "Invent completely new questions about other details in the context.",
  ].join("\n");
}

module.exports = {
  buildGenerationVarietyHints,
  flashcardVarietyBlock,
  quizVarietyBlock,
  priorQuestionsAvoidBlock,
};
