const fs = require("fs");
const os = require("os");
const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const WordExtractor = require("word-extractor");

const MAX_CHARS = 120_000;

/** pdf.js (pdf-parse) often warns on TrueType fonts; text extraction is usually still fine. */
function withPdfNoiseSuppressed(fn) {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    const msg = String(args[0] ?? "");
    if (msg.includes("TT: undefined function") || msg.includes("TT: undefined funciton")) {
      return;
    }
    originalWarn.apply(console, args);
  };
  return Promise.resolve(fn()).finally(() => {
    console.warn = originalWarn;
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
    return truncate(data.text);
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
 * @param {string} extension ví dụ ".pdf"
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

  throw new Error("Định dạng file không hỗ trợ trích văn bản (PDF/Word).");
}

module.exports = { extractDocumentText, MAX_CHARS };
