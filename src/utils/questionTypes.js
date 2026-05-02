/**
 * Shared question shape for MCQ, True/False, and short answer.
 * question_type: multiple-choice | true-false | short-answer
 */

function trunc255(s) {
  const t = String(s ?? "").trim();
  return t.length <= 255 ? t : `${t.slice(0, 252)}...`;
}

function parseQuestionType(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!s) return "multiple-choice";
  if (s === "mcq" || s === "multiple-choice" || s === "multiplechoice" || s === "choice") {
    return "multiple-choice";
  }
  if (s === "tf" || s === "true-false" || s === "truefalse" || s === "boolean" || s === "bool") {
    return "true-false";
  }
  if (
    s === "short" ||
    s === "short-answer" ||
    s === "shortanswer" ||
    s === "text" ||
    s === "essay" ||
    s === "fill"
  ) {
    return "short-answer";
  }
  return "multiple-choice";
}

function rawTypeFromPayload(q) {
  return q?.type ?? q?.question_type ?? q?.questionType;
}

function pickExplanation(q) {
  const s = String(q?.explanation ?? q?.rationale ?? "").trim();
  if (!s) return "";
  return s.length > 8000 ? s.slice(0, 8000) : s;
}

function pickTrueFalseLetter(cor, opts) {
  if (cor === true || cor === 1) return "A";
  if (cor === false || cor === 0) return "B";
  const s = String(cor ?? "").trim().toLowerCase();
  if (s === "true" || s === "t" || s === "yes" || s === "1" || s === "a" || s === "đúng" || s === "dung") {
    return "A";
  }
  if (s === "false" || s === "f" || s === "no" || s === "0" || s === "b" || s === "sai") {
    return "B";
  }
  const aText = String(opts.A || "").trim().toLowerCase();
  const bText = String(opts.B || "").trim().toLowerCase();
  if (aText && s && s === aText) return "A";
  if (bText && s && s === bText) return "B";
  return "A";
}

/**
 * @returns {object|null} norm fields for DB + API
 */
function normalizeQuestionInputCore(q) {
  if (!q || typeof q !== "object") return null;
  const questionText = String(q.question ?? q.question_text ?? "").trim();
  if (!questionText) return null;

  const questionType = parseQuestionType(rawTypeFromPayload(q));

  let opts = q.options;
  if (Array.isArray(opts)) {
    const L = ["A", "B", "C", "D"];
    opts = Object.fromEntries(L.map((letter, i) => [letter, String(opts[i] ?? "").trim()]));
  } else if (opts && typeof opts === "object") {
    opts = {
      A: trunc255(opts.A ?? opts.a ?? ""),
      B: trunc255(opts.B ?? opts.b ?? ""),
      C: trunc255(opts.C ?? opts.c ?? ""),
      D: trunc255(opts.D ?? opts.d ?? ""),
    };
  } else {
    opts = {
      A: trunc255(q.option_a),
      B: trunc255(q.option_b),
      C: trunc255(q.option_c),
      D: trunc255(q.option_d),
    };
  }

  if (questionType === "true-false") {
    if (!String(opts.A || "").trim() && !String(opts.B || "").trim()) {
      opts = { A: "True", B: "False", C: "", D: "" };
    } else {
      if (!String(opts.A || "").trim()) opts.A = "True";
      if (!String(opts.B || "").trim()) opts.B = "False";
    }
    const cor = q.correct_answer ?? q.correctAnswer ?? q.correct ?? q.answer ?? q.answerKey;
    const correct = pickTrueFalseLetter(cor, opts);
    const explanation = pickExplanation(q);
    return {
      question: questionText,
      options: opts,
      correct_answer: correct,
      question_type: "true-false",
      ...(explanation ? { explanation } : {}),
    };
  }

  if (questionType === "short-answer") {
    let expected =
      q.correct_answer ?? q.correctAnswer ?? q.expectedAnswer ?? q.answer ?? q.correct ?? "";
    expected = String(expected ?? "").trim();
    if (!expected) return null;
    if (expected.length > 2048) expected = expected.slice(0, 2048);
    return {
      question: questionText,
      options: { A: "", B: "", C: "", D: "" },
      correct_answer: expected,
      question_type: "short-answer",
    };
  }

  // multiple-choice
  let cor = q.correct_answer ?? q.correctAnswer ?? q.correct ?? q.answer ?? q.answerKey;
  const rawCor = String(cor ?? "").trim();
  const rawUpper = rawCor.toUpperCase();
  if (typeof cor === "number" && cor >= 0 && cor <= 3) {
    cor = ["A", "B", "C", "D"][cor];
  } else if (/^[0-3]$/.test(rawCor)) {
    cor = ["A", "B", "C", "D"][Number(rawCor)];
  } else if (/^(OPTION[_\s-]?)?[ABCD](\.|:|\)|\s|$)/i.test(rawCor)) {
    cor = rawUpper.replace(/^OPTION[_\s-]?/i, "").trim().charAt(0);
  } else {
    cor = rawUpper;
  }
  let correct = String(cor || "A").trim().charAt(0) || "A";
  if (!["A", "B", "C", "D"].includes(correct)) {
    const entries = [
      ["A", String(opts.A || "").trim()],
      ["B", String(opts.B || "").trim()],
      ["C", String(opts.C || "").trim()],
      ["D", String(opts.D || "").trim()],
    ];
    const matched = entries.find(([, text]) => text && text.toUpperCase() === rawUpper);
    correct = matched ? matched[0] : "A";
  }
  const explanation = pickExplanation(q);
  return {
    question: questionText,
    options: opts,
    correct_answer: correct,
    question_type: "multiple-choice",
    ...(explanation ? { explanation } : {}),
  };
}

function normalizeShortAnswerText(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

module.exports = {
  parseQuestionType,
  normalizeQuestionInputCore,
  normalizeShortAnswerText,
  trunc255,
  rawTypeFromPayload,
};
