/**
 * Safe API error responses for EduMate mock/FE server.
 * Logs full errors for developers; never exposes stack/SQL/paths to clients.
 */

const DEFAULT_SAFE_MESSAGE = "Something went wrong. Please try again.";

const TECHNICAL_PATTERNS = [
  /at\s+[\w.$/<>]+\s*\(/i,
  /node_modules/i,
  /prisma/i,
  /sequelize/i,
  /\bSQL\b/i,
  /\bER_[A-Z0-9]+\b/i,
  /\bjwt\b/i,
  /jsonwebtoken/i,
  /stack\s*trace/i,
  /syntaxerror/i,
  /typeerror/i,
  /referenceerror/i,
  /\/uploads\//i,
  /\\\\|\/[a-z]:\\/i,
  /\bENOENT\b|\bEACCES\b|\bECONNREFUSED\b|\bECONNABORTED\b/i,
  /request failed with status code/i,
  /\baxios\b/i,
  /unknown column/i,
  /duplicate entry/i,
  /cannot find module/i,
  /getaddrinfo/i,
  /access denied for user/i,
];

function isTechnicalMessage(message) {
  const m = String(message || "").trim();
  if (!m) return true;
  if (m.length > 300) return true;
  return TECHNICAL_PATTERNS.some((re) => re.test(m));
}

function toSafeUserMessage(err, fallback = DEFAULT_SAFE_MESSAGE) {
  const candidate =
    (err && typeof err.publicMessage === "string" && err.publicMessage.trim()) ||
    (err && typeof err.message === "string" && err.message.trim()) ||
    "";
  if (candidate && !isTechnicalMessage(candidate)) return candidate;
  return fallback;
}

function logApiError(err, context = "") {
  if (context) {
    console.error("[API_ERROR]", context, err);
  } else {
    console.error("[API_ERROR]", err);
  }
  if (err && typeof err.stack === "string" && err.stack.trim()) {
    console.error(err.stack);
  }
}

function sendErrorResponse(res, status, userMessage, err, context) {
  if (err) logApiError(err, context);
  return res.status(status).json({
    success: false,
    message: userMessage || DEFAULT_SAFE_MESSAGE,
  });
}

/** Express error middleware — must be registered after all routes. */
function globalApiErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  logApiError(err, `${req.method} ${req.originalUrl || req.url}`);

  const multer = require("multer");
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "File exceeds 10MB. Please choose a file 10MB or smaller.",
      });
    }
    return res.status(400).json({
      success: false,
      message: "File upload failed. Please check the file and try again.",
    });
  }

  const status =
    typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 500;

  const message =
    typeof err?.publicMessage === "string" && err.publicMessage.trim()
      ? err.publicMessage.trim()
      : status >= 500
        ? DEFAULT_SAFE_MESSAGE
        : toSafeUserMessage(err);

  return res.status(status).json({ success: false, message });
}

module.exports = {
  DEFAULT_SAFE_MESSAGE,
  isTechnicalMessage,
  toSafeUserMessage,
  logApiError,
  sendErrorResponse,
  globalApiErrorHandler,
};
