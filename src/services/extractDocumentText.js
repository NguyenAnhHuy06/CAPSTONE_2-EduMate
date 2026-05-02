const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
// pdf-parse v1.1.1 — exports trực tiếp là function
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const WordExtractor = require("word-extractor");
const execFileAsync = promisify(execFile);

const MAX_CHARS = 120_000;
const OCR_MAX_PAGES = Math.min(10, Math.max(1, Number(process.env.PDF_OCR_MAX_PAGES || 5)));
const OCR_LANG = String(process.env.PDF_OCR_LANG || "vie+eng").trim() || "vie+eng";

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
    if (isPdfFontNoise(msg)) return;
    originalWarn.apply(console, args);
  };
  console.error = (...args) => {
    const msg = String(args[0] ?? "");
    if (isPdfFontNoise(msg)) return;
    originalError.apply(console, args);
  };
  console.log = (...args) => {
    const msg = String(args[0] ?? "");
    if (isPdfFontNoise(msg)) return;
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
  return t.length <= MAX_CHARS ? t : t.slice(0, MAX_CHARS);
}

async function runPdfImageOcr(buffer) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "edumate-ocr-"));
  const pdfPath = path.join(tempDir, "input.pdf");
  fs.writeFileSync(pdfPath, buffer);

  try {
    const imagePrefix = path.join(tempDir, "page");
    await execFileAsync("pdftoppm", [
      "-png",
      "-f",
      "1",
      "-l",
      String(OCR_MAX_PAGES),
      pdfPath,
      imagePrefix,
    ]);

    const imageFiles = fs
      .readdirSync(tempDir)
      .filter((name) => /^page-\d+\.png$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!imageFiles.length) return "";

    const pages = [];
    for (const imageName of imageFiles) {
      const imagePath = path.join(tempDir, imageName);
      const { stdout } = await execFileAsync("tesseract", [
        imagePath,
        "stdout",
        "-l",
        OCR_LANG,
        "--psm",
        "6",
      ]);
      const text = String(stdout || "").trim();
      if (text) pages.push(text);
    }
    return truncate(pages.join("\n\n"));
  } catch (err) {
    const msg = String(err?.message || "").toLowerCase();
    if (msg.includes("pdftoppm") || msg.includes("tesseract") || err?.code === "ENOENT") {
      console.warn("[extractDocumentText] OCR tools not available (need pdftoppm + tesseract).");
      return "";
    }
    console.warn("[extractDocumentText] PDF OCR fallback failed:", err.message);
    return "";
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {
      // ignore temp cleanup errors
    }
  }
}

async function extractFromPdf(buffer) {
  return withPdfNoiseSuppressed(async () => {
    const data = await pdfParse(buffer);
    const textLayer = truncate(data.text);
    if (String(textLayer).trim()) return textLayer;

    const ocrText = await runPdfImageOcr(buffer);
    if (String(ocrText).trim()) return ocrText;

    throw new Error(
      "PDF không có text layer và OCR chưa sẵn sàng. Cài pdftoppm + tesseract để đọc PDF dạng ảnh/slide."
    );
  });
}

async function extractFromDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return truncate(result.value);
}

async function extractFromDoc(buffer) {
  const tmp = path.join(os.tmpdir(), `edumate-${Date.now()}-${Math.random().toString(36).slice(2)}.doc`);
  fs.writeFileSync(tmp, buffer);
  try {
    const extractor = new WordExtractor();
    const doc = await extractor.extract(tmp);
    return truncate(doc.getBody());
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}


async function extractDocumentText(buffer, extension, mimetype) {
  const ext = (extension || "").toLowerCase();
  const mime = (mimetype || "").toLowerCase();

  if (ext === ".pdf" || mime.includes("pdf")) return extractFromPdf(buffer);
  if (ext === ".docx" || ext === ".docm" || ext === ".dotx" || ext === ".dotm" ||
      mime.includes("wordprocessingml") || mime.includes("macroenabled")) return extractFromDocx(buffer);
  if (ext === ".doc" || mime === "application/msword") return extractFromDoc(buffer);

  throw new Error("Định dạng file không hỗ trợ trích văn bản (PDF/Word).");
}

module.exports = { extractDocumentText, MAX_CHARS };
