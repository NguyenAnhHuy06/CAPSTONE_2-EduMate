const fs = require("fs");
const os = require("os");
const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const WordExtractor = require("word-extractor");

const MAX_CHARS = 120_000;

/** pdf.js (pdf-parse) often warns on TrueType fonts; text extraction is usually still fine. */
function withPdfNoiseSuppressed(fn) {
  const isPdfFontNoise = (msg) =>
    msg.includes("TT: undefined function") ||
    msg.includes("TT: undefined funciton") ||
    msg.includes("Warning: TT: undefined function") ||
    msg.includes("TT: invalid function id") ||
    msg.includes("invalid function id");
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalLog = console.log;
  console.warn = (...args) => {
    const msg = String(args[0] ?? "");
    if (isPdfFontNoise(msg)) {
      return;
    }
    originalWarn.apply(console, args);
  };
  console.error = (...args) => {
    const msg = String(args[0] ?? "");
    if (isPdfFontNoise(msg)) {
      return;
    }
    originalError.apply(console, args);
  };
  console.log = (...args) => {
    const msg = String(args[0] ?? "");
    if (isPdfFontNoise(msg)) {
      return;
    }
    originalLog.apply(console, args);
  };
  return Promise.resolve(fn()).finally(() => {
    console.warn = originalWarn;
    console.error = originalError;
    console.log = originalLog;
  });
}

function truncate(text) {
  const t = String(text || "").trim();
  if (t.length <= MAX_CHARS) return t;
  return t.slice(0, MAX_CHARS);
}

async function extractFromPdf(buffer) {
  return withPdfNoiseSuppressed(async () => {
    const data = await pdfParse(buffer);
    const text = truncate(data.text);
    /** pdf-parse only reads embedded text streams — scanned/image-only PDFs often yield "". */
    if (!String(text).trim()) {
      throw new Error(
        "PDF_HAS_NO_TEXT_LAYER: This PDF has no extractable text (often scanned images). Use a text-based PDF, Word, or run OCR first."
      );
    }
    return text;
  });
}

async function extractFromDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return truncate(result.value);
}

async function extractFromDoc(buffer) {
  const tmp = path.join(
    os.tmpdir(),
    `edumate-${Date.now()}-${Math.random().toString(36).slice(2)}.doc`
  );
  fs.writeFileSync(tmp, buffer);
  try {
    const extractor = new WordExtractor();
    const doc = await extractor.extract(tmp);
    return truncate(doc.getBody());
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * @param {Buffer} buffer
 * @param {string} extension e.g. ".pdf"
 * @param {string} mimetype
 */
async function extractDocumentText(buffer, extension, mimetype) {
  const ext = (extension || "").toLowerCase();
  const mime = (mimetype || "").toLowerCase();

  if (ext === ".pdf" || mime.includes("pdf")) {
    return extractFromPdf(buffer);
  }
  if (
    ext === ".docx" ||
    ext === ".docm" ||
    ext === ".dotx" ||
    ext === ".dotm" ||
    mime.includes("wordprocessingml") ||
    mime.includes("macroenabled")
  ) {
    return extractFromDocx(buffer);
  }
  if (ext === ".doc" || mime === "application/msword") {
    return extractFromDoc(buffer);
  }

  throw new Error("Unsupported file format for text extraction (PDF/Word).");
}

module.exports = { extractDocumentText, MAX_CHARS };
