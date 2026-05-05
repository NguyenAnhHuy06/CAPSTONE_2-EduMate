/**
 * teamDb.js — Adapter mysql2 raw queries từ codebase team.
 * Đã điều chỉnh để tương thích hoàn toàn với schema eudmate.sql:
 *   - Primary key users: user_id (INT)
 *   - Column: full_name thay vì name
 *   - Role: ENUM viết HOA 'STUDENT'/'LECTURER' thay vì 'lecturer'/'teacher'
 */
const path = require("path");
const mysql = require("mysql2/promise");
const {
  normalizeQuestionInputCore,
  normalizeShortAnswerText,
} = require("../utils/questionTypes");

function createPoolConfig() {
  return {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME,
  };
}

let pool;
const columnExistenceCache = new Map();

function isConfigured() {
  const dbName = String(process.env.DB_NAME || "").trim();
  const dbUser = String(process.env.DB_USER || "").trim();
  return !!(dbName && dbUser);
}

function getPool() {
  if (!isConfigured()) throw new Error("MySQL chưa cấu hình (DB_*).");
  if (!pool) {
    pool = mysql.createPool({
      ...createPoolConfig(),
      waitForConnections: true,
      connectionLimit: 10,
      enableKeepAlive: true,
    });
  }
  return pool;
}

async function ensureQuizLifecycleColumns() {
  const p = getPool();
  const stmts = [
    "ALTER TABLE quizzes ADD COLUMN is_published TINYINT(1) NOT NULL DEFAULT 0",
    "ALTER TABLE quizzes ADD COLUMN published_at DATETIME NULL DEFAULT NULL",
    "ALTER TABLE quizzes ADD COLUMN source_file_url VARCHAR(512) NULL DEFAULT NULL",
    "ALTER TABLE quizzes ADD COLUMN document_id INT NULL DEFAULT NULL",
    "ALTER TABLE quizzes ADD COLUMN shared_from_student TINYINT(1) NOT NULL DEFAULT 0",
    "ALTER TABLE quizzes ADD COLUMN shared_by_user_id INT NULL DEFAULT NULL",
    "ALTER TABLE quizzes ADD COLUMN lecturer_edited TINYINT(1) NOT NULL DEFAULT 0",
    "ALTER TABLE quizzes ADD COLUMN lecturer_edited_by INT NULL DEFAULT NULL",
    "ALTER TABLE quizzes ADD COLUMN lecturer_edited_at DATETIME NULL DEFAULT NULL",
    "ALTER TABLE quiz_questions ADD COLUMN media_type VARCHAR(16) NULL DEFAULT NULL",
    "ALTER TABLE quiz_questions ADD COLUMN media_url VARCHAR(1024) NULL DEFAULT NULL",
    "ALTER TABLE question_bank_items ADD COLUMN media_type VARCHAR(16) NULL DEFAULT NULL",
    "ALTER TABLE question_bank_items ADD COLUMN media_url VARCHAR(1024) NULL DEFAULT NULL",
    "ALTER TABLE quiz_questions ADD COLUMN question_type VARCHAR(32) NOT NULL DEFAULT 'multiple-choice'",
    "ALTER TABLE quiz_questions MODIFY COLUMN correct_answer VARCHAR(2048) NOT NULL",
    "ALTER TABLE quiz_answers MODIFY COLUMN user_answer VARCHAR(2048) NULL DEFAULT NULL",
    "ALTER TABLE quiz_questions ADD COLUMN explanation TEXT NULL",
  ];
  for (const sql of stmts) {
    try { await p.execute(sql); }
    catch (e) { if (e.code !== "ER_DUP_FIELDNAME") console.warn("ensureQuizLifecycleColumns:", e.message); }
  }
  columnExistenceCache.clear();
}

async function ensureManualGradeColumns() {
  const p = getPool();
  const stmts = [
    "ALTER TABLE quiz_answers ADD COLUMN manual_override TINYINT(1) NOT NULL DEFAULT 0",
    "ALTER TABLE quiz_attempts ADD COLUMN manual_graded_at DATETIME NULL DEFAULT NULL",
    "ALTER TABLE quiz_attempts ADD COLUMN manual_graded_by_user_id INT NULL DEFAULT NULL",
  ];
  for (const sql of stmts) {
    try {
      await p.execute(sql);
    } catch (e) {
      if (e.code !== "ER_DUP_FIELDNAME") {
        console.warn("ensureManualGradeColumns:", e.message);
      }
    }
  }
  columnExistenceCache.clear();
}

async function hasTableColumn(tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (columnExistenceCache.has(key)) return columnExistenceCache.get(key);
  try {
    const [rows] = await getPool().execute(
      `SELECT 1
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND COLUMN_NAME = ?
       LIMIT 1`,
      [String(tableName), String(columnName)]
    );
    const hasColumn = rows.length > 0;
    columnExistenceCache.set(key, hasColumn);
    return hasColumn;
  } catch (_) {
    columnExistenceCache.set(key, false);
    return false;
  }
}

async function initDb() {
  const p = getPool();
  await p.execute("SELECT 1");
  try { await ensureQuizLifecycleColumns(); }
  catch (e) { console.warn("ensureQuizLifecycleColumns (init):", e.message); }
  try { await ensureManualGradeColumns(); }
  catch (e) { console.warn("ensureManualGradeColumns (init):", e.message); }
  console.log("[teamDb] MySQL connection pool ready.");
}

function trunc255(s) {
  const t = String(s ?? "").trim();
  return t.length <= 255 ? t : `${t.slice(0, 252)}...`;
}

function parseOptionalInt(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function upsertDocument(row) {
  const p = getPool();
  const key = String(row.s3Key || "").trim();
  if (!key) throw new Error("Thiếu s3Key.");
  const [existing] = await p.execute("SELECT document_id FROM documents WHERE file_url = ? LIMIT 1", [key]);
  const title = String(row.title || "").trim() || path.basename(key);
  const courseId = parseOptionalInt(row.courseId);
  const uploaderId = parseOptionalInt(row.uploaderId);
  const status = row.status || 'pending';

  if (existing.length) {
    const id = existing[0].document_id;
    await p.execute(
      "UPDATE documents SET title = ?, version = IFNULL(version, 0) + 1, course_id = COALESCE(?, course_id), uploader_id = COALESCE(?, uploader_id), status = ? WHERE document_id = ?",
      [title, courseId, uploaderId, status, id]
    );
    return id;
  }
  const [hdr] = await p.execute(
    "INSERT INTO documents (title, course_id, uploader_id, file_url, version, status) VALUES (?,?,?,?,1,?)",
    [title, courseId, uploaderId, key, status]
  );
  return hdr.insertId;
}

async function ensureDocumentStub(s3Key, partial = {}) {
  const p = getPool();
  const key = String(s3Key || "").trim();
  const [existing] = await p.execute("SELECT document_id FROM documents WHERE file_url = ? LIMIT 1", [key]);
  if (existing.length) return existing[0].document_id;
  const title = partial.title || path.basename(key);
  const [hdr] = await p.execute(
    "INSERT INTO documents (title, course_id, uploader_id, file_url, version) VALUES (?,?,?,?,1)",
    [title, parseOptionalInt(partial.courseId), parseOptionalInt(partial.uploaderId), key]
  );
  return hdr.insertId;
}

async function deleteChunksByDocumentId(documentId) {
  await getPool().execute("DELETE FROM document_segments WHERE document_id = ?", [documentId]);
}

async function insertSegment(documentId, contentText, embedding) {
  await getPool().execute(
    "INSERT INTO document_segments (document_id, content, embedding) VALUES (?,?,?)",
    [documentId, contentText, JSON.stringify(embedding)]
  );
}

async function insertChunk(documentId, _chunkIndex, contentText, embedding) {
  await insertSegment(documentId, contentText, embedding);
}

async function getDocumentIdByS3Key(s3Key) {
  const k = String(s3Key || "").trim();
  if (!k) return null;
  const [rows] = await getPool().execute("SELECT document_id FROM documents WHERE file_url = ? LIMIT 1", [k]);
  return rows.length ? rows[0].document_id : null;
}

async function countChunksByS3Key(s3Key) {
  const [rows] = await getPool().execute(
    "SELECT COUNT(*) AS n FROM document_segments s INNER JOIN documents d ON d.document_id = s.document_id WHERE d.file_url = ?",
    [s3Key]
  );
  return Number(rows[0]?.n || 0);
}

async function getConcatenatedChunksByS3Key(s3Key) {
  const [rows] = await getPool().execute(
    "SELECT s.content FROM document_segments s INNER JOIN documents d ON d.document_id = s.document_id WHERE d.file_url = ? ORDER BY s.segment_id ASC",
    [s3Key]
  );
  return rows.map(r => r.content).join("\n\n");
}

async function listSegmentsByS3Key(s3Key) {
  const [rows] = await getPool().execute(
    "SELECT s.segment_id, s.document_id, s.content, s.embedding FROM document_segments s INNER JOIN documents d ON d.document_id = s.document_id WHERE d.file_url = ? ORDER BY s.segment_id ASC",
    [s3Key]
  );
  return rows.map((r, idx) => {
    let emb = [];
    try { emb = JSON.parse(r.embedding || "[]"); } catch { emb = []; }
    return { segmentId: r.segment_id, documentId: r.document_id, section: idx + 1, content: r.content, embedding: Array.isArray(emb) ? emb : [] };
  });
}

async function hasCompleteEmbeddingsForS3Key(s3Key) {
  const n = await countChunksByS3Key(s3Key);
  if (n === 0) return false;
  const segs = await listSegmentsByS3Key(s3Key);
  return segs.length > 0 && segs.every(s => Array.isArray(s.embedding) && s.embedding.length > 0);
}

async function getMetaMapForS3Keys(keys) {
  if (!keys.length) return new Map();
  const p = getPool();
  const placeholders = keys.map(() => "?").join(",");
  const [docs] = await p.execute(
    `SELECT d.document_id, d.title, d.file_url, d.course_id, d.uploader_id, d.created_at, d.status,
      c.course_code,
      (SELECT COUNT(*) FROM document_segments s WHERE s.document_id = d.document_id) AS chunk_count
     FROM documents d LEFT JOIN courses c ON c.course_id = d.course_id
     WHERE d.file_url IN (${placeholders})`,
    keys
  );
  const m = new Map();
  for (const d of docs) m.set(d.file_url, d);
  return m;
}

async function countAttemptsBySourceFileUrls(s3Keys) {
  const uniq = [...new Set((s3Keys || []).map(k => String(k || "").trim()).filter(Boolean))];
  if (!uniq.length) return new Map();
  const placeholders = uniq.map(() => "?").join(",");
  const p = getPool();
  try {
    const [rows] = await p.execute(
      `SELECT t.k, COUNT(*) AS n FROM (
         SELECT d.file_url AS k, qa.attempt_id FROM quiz_attempts qa
         INNER JOIN quizzes q ON q.quiz_id = qa.quiz_id
         INNER JOIN documents d ON d.document_id = q.document_id
         WHERE d.file_url IN (${placeholders})
         UNION
         SELECT q.source_file_url AS k, qa.attempt_id FROM quiz_attempts qa
         INNER JOIN quizzes q ON q.quiz_id = qa.quiz_id
         WHERE q.source_file_url IN (${placeholders})
       ) t WHERE t.k IS NOT NULL AND TRIM(t.k) <> '' GROUP BY t.k`,
      [...uniq, ...uniq]
    );
    const m = new Map();
    for (const r of rows) if (r.k) m.set(String(r.k), Number(r.n || 0));
    return m;
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") return new Map();
    throw e;
  }
}

async function listDocumentsRecent(limit = 10) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);

  const sql = `
    SELECT
      d.document_id,
      d.title,
      d.file_url,
      d.course_id,
      d.uploader_id,
      d.created_at,
      d.status,
      (SELECT COUNT(*) FROM document_segments s WHERE s.document_id = d.document_id) AS chunk_count
    FROM documents d
    ORDER BY d.created_at DESC
    LIMIT ${safeLimit}
  `;

  const [rows] = await getPool().query(sql);
  return rows;
}

async function getDocumentById(documentId) {
  const id = Number(documentId);
  if (!Number.isFinite(id)) return null;
  const [rows] = await getPool().execute(
    "SELECT document_id, title, file_url, course_id, uploader_id, created_at FROM documents WHERE document_id = ? LIMIT 1",
    [id]
  );
  return rows.length ? rows[0] : null;
}

async function listSegmentsByDocumentId(documentId) {
  const id = Number(documentId);
  if (!Number.isFinite(id)) return [];
  const [rows] = await getPool().execute(
    "SELECT s.segment_id, s.document_id, s.content, s.embedding FROM document_segments s WHERE s.document_id = ? ORDER BY s.segment_id ASC",
    [id]
  );
  return rows.map((r, idx) => {
    let emb = [];
    try { emb = JSON.parse(r.embedding || "[]"); } catch { emb = []; }
    return { segmentId: r.segment_id, documentId: r.document_id, section: idx + 1, content: r.content, embedding: Array.isArray(emb) ? emb : [] };
  });
}

function scoreToPercent(score, questionCount) {
  if (score == null || score === "") return null;
  const s = Number(score), n = Number(questionCount) || 0;
  if (!Number.isFinite(s) || s < 0) return null;
  if (n > 0 && s <= n) return Math.round((100 * s) / n);
  if (s <= 100) return Math.round(s);
  return null;
}

function normalizeAttemptScorePercent(score, totalQuestions, correctCount) {
  const pctFromScore = scoreToPercent(score, totalQuestions);
  if (pctFromScore != null) return pctFromScore;
  const c = Number(correctCount);
  const t = Number(totalQuestions);
  if (Number.isFinite(c) && Number.isFinite(t) && t > 0 && c >= 0) {
    return Math.round((100 * c) / t);
  }
  return 0;
}

/**
 * Completed attempts for one quiz (FE: GET /api/quizzes/:id/attempts). Caller must authorize.
 */
async function listCompletedQuizAttemptsByQuizId(quizId) {
  const qid = Number(quizId);
  if (!Number.isFinite(qid) || qid <= 0) return [];
  const p = getPool();
  const [rows] = await p.execute(
    `SELECT qa.attempt_id, qa.user_id, qa.score, qa.correct_count, qa.total_questions, qa.completed_at,
            u.full_name AS user_name, u.email AS user_email,
            (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = qa.quiz_id) AS question_count_db
     FROM quiz_attempts qa
     LEFT JOIN users u ON u.user_id = qa.user_id
     WHERE qa.quiz_id = ? AND qa.completed_at IS NOT NULL
     ORDER BY qa.completed_at DESC, qa.attempt_id DESC`,
    [qid]
  );
  return (rows || []).map((r) => {
    const uid = r.user_id != null ? Number(r.user_id) : null;
    const label = String(r.user_name || "").trim() || (uid != null ? `User ${uid}` : "Student");
    const totalQs = Number(r.total_questions || 0) || Number(r.question_count_db || 0) || 0;
    const correctCount = Number(r.correct_count ?? 0);
    const scorePercent = normalizeAttemptScorePercent(r.score, totalQs, correctCount);
    return {
      attemptId: Number(r.attempt_id),
      userId: uid,
      studentName: label,
      studentEmail: r.user_email != null ? String(r.user_email) : null,
      scorePercent,
      correctCount: Number.isFinite(correctCount) ? correctCount : 0,
      totalQuestions: totalQs,
      completedAt: r.completed_at,
    };
  });
}

function optionLetterFromAnswer(answer) {
  const n = Number(answer);
  if (Number.isFinite(n) && n >= 0 && n <= 3) return ["A", "B", "C", "D"][n];
  const s = String(answer || "").trim().toUpperCase();
  return ["A", "B", "C", "D"].includes(s) ? s : null;
}

async function listQuizHistory(limit = 20, userId = null) {
  const p = getPool();
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const uid = parseOptionalInt(userId);

  if (uid == null) return [];

  const sql = `
    SELECT
      qa.attempt_id,
      q.quiz_id,
      q.title,
      q.created_at,
      q.is_published,
      q.lecturer_edited,
      q.lecturer_edited_by,
      q.lecturer_edited_at,
      c.course_code,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.quiz_id) AS question_count,
      (
        SELECT COUNT(*)
        FROM quiz_attempts qa2
        WHERE qa2.quiz_id = q.quiz_id
          AND qa2.user_id = qa.user_id
          AND qa2.completed_at IS NOT NULL
      ) AS attempts_count,
      qa.score AS last_score,
      qa.completed_at AS last_completed_at
    FROM quiz_attempts qa
    INNER JOIN quizzes q ON q.quiz_id = qa.quiz_id
    LEFT JOIN courses c ON c.course_id = q.course_id
    WHERE qa.user_id = ?
      AND qa.completed_at IS NOT NULL
    ORDER BY qa.completed_at DESC, qa.attempt_id DESC
    LIMIT ${lim}
  `;

  const [rows] = await p.execute(sql, [uid]);

  return rows.map(row => ({
    attemptId: row.attempt_id != null ? Number(row.attempt_id) : null,
    quizId: row.quiz_id,
    title: row.title,
    createdAt: row.created_at,
    courseCode: row.course_code,
    questionCount: Number(row.question_count || 0),
    attemptsCount: Number(row.attempts_count || 0),
    scorePercent: scoreToPercent(row.last_score, row.question_count),
    lastAttemptAt: row.last_completed_at,
    isPublished: Number(row.is_published ?? 0) === 1,
    lecturerEdited: Number(row.lecturer_edited ?? 0) === 1,
    lecturerEditedBy: row.lecturer_edited_by != null ? Number(row.lecturer_edited_by) : null,
    lecturerEditedAt: row.lecturer_edited_at || null,
  }));
}

async function listPublishedQuizzes(limit = 20) {
  const p = getPool();
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const sql = `SELECT q.quiz_id, q.title, q.created_at, q.published_at, c.course_code,
    (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.quiz_id) AS question_count,
    (SELECT COUNT(*) FROM quiz_attempts qa0 WHERE qa0.quiz_id = q.quiz_id) AS attempts_count,
    u.full_name AS creator_name
    FROM quizzes q LEFT JOIN courses c ON c.course_id = q.course_id
    LEFT JOIN users u ON u.user_id = q.created_by
    WHERE q.is_published = 1
    ORDER BY COALESCE(q.published_at, q.created_at) DESC LIMIT ${lim}`;
  try {
    const [rows] = await p.execute(sql);
    return rows.map(row => ({
      quizId: row.quiz_id, title: row.title, createdAt: row.created_at,
      publishedAt: row.published_at, courseCode: row.course_code,
      questionCount: Number(row.question_count || 0),
      attemptsCount: Number(row.attempts_count || 0), creatorName: row.creator_name || null,
    }));
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") return [];
    throw e;
  }
}

/**
 * Role values: 'STUDENT', 'LECTURER', 'ADMIN'
 */
async function getUserRole(userId) {
  if (!userId) return null;
  const [rows] = await getPool().execute("SELECT role FROM users WHERE user_id = ? LIMIT 1", [String(userId)]);
  return rows.length ? rows[0].role : null;
}

function isLecturerRole(role) {
  // Support cả ENUM uppercase (chúng ta) lẫn lowercase (team legacy)
  const normalized = String(role || "").trim().toUpperCase();
  return normalized === "LECTURER" || normalized === "TEACHER";
}

function isAdminRole(role) {
  const normalized = String(role || "").trim().toUpperCase();
  return normalized === "ADMIN";
}

async function canUserManageQuiz(quizId, userId) {
  const row = await getQuizWithQuestions(quizId);
  if (!row) return false;
  if (!userId) return false;
  const role = await getUserRole(userId);
  if (isAdminRole(role)) return true;
  // Shared quizzes can be reviewed/edited by lecturers.
  if (Number(row.shared_from_student || 0) === 1 && isLecturerRole(role)) return true;
  if (row.created_by == null || String(row.created_by) !== String(userId)) return false;
  // Owner can always access/manage own quiz draft, regardless of role.
  return true;
}

function normalizeQuestionInput(q) {
  const base = normalizeQuestionInputCore(q);
  if (!base) return null;
  const normalizedMediaType = String(
    q.media_type ?? q.mediaType ?? q.attachmentType ?? q.resourceType ?? ""
  )
    .trim()
    .toLowerCase();
  const mediaUrlRaw =
    q.media_url ??
    q.mediaUrl ??
    q.attachmentUrl ??
    q.resourceUrl ??
    q.imageUrl ??
    q.videoUrl ??
    q.audioUrl ??
    q.youtubeUrl ??
    "";
  const mediaUrl = String(mediaUrlRaw || "").trim();
  const mediaType = ["image", "video", "audio", "youtube"].includes(normalizedMediaType)
    ? normalizedMediaType
    : null;
  return {
    ...base,
    media_type: mediaType,
    media_url: mediaUrl || null,
  };
}

async function insertQuizQuestion(quizId, q) {
  const norm = normalizeQuestionInput(q);
  if (!norm) return;
  const opts = norm.options || {};
  const [a, b, c, d] = ["A", "B", "C", "D"].map((L) => trunc255(opts[L]));
  const qType = norm.question_type || "multiple-choice";
  let correctStored;
  if (qType === "short-answer") {
    correctStored = String(norm.correct_answer || "").trim().slice(0, 2048);
    if (!correctStored) return;
  } else {
    correctStored = String(norm.correct_answer || "A").toUpperCase().trim().slice(0, 1) || "A";
    if (!["A", "B", "C", "D"].includes(correctStored)) correctStored = "A";
  }
  const supportQType = await hasTableColumn("quiz_questions", "question_type");
  const supportMediaType = await hasTableColumn("quiz_questions", "media_type");
  const supportMediaUrl = await hasTableColumn("quiz_questions", "media_url");
  const supportExp = await hasTableColumn("quiz_questions", "explanation");
  const expStr = String(norm.explanation ?? "").trim();
  const expParam = expStr ? expStr.slice(0, 8000) : null;
  if (supportQType && supportMediaType && supportMediaUrl) {
    if (supportExp) {
      await getPool().execute(
        "INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_answer, question_type, media_type, media_url, explanation) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [quizId, norm.question, a, b, c, d, correctStored, qType, norm.media_type, norm.media_url, expParam]
      );
    } else {
      await getPool().execute(
        "INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_answer, question_type, media_type, media_url) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [quizId, norm.question, a, b, c, d, correctStored, qType, norm.media_type, norm.media_url]
      );
    }
    return;
  }
  if (supportQType) {
    if (supportExp) {
      await getPool().execute(
        "INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_answer, question_type, explanation) VALUES (?,?,?,?,?,?,?,?,?)",
        [quizId, norm.question, a, b, c, d, correctStored, qType, expParam]
      );
    } else {
      await getPool().execute(
        "INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_answer, question_type) VALUES (?,?,?,?,?,?,?,?)",
        [quizId, norm.question, a, b, c, d, correctStored, qType]
      );
    }
    return;
  }
  if (supportMediaType && supportMediaUrl) {
    if (supportExp) {
      await getPool().execute(
        "INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_answer, media_type, media_url, explanation) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          quizId,
          norm.question,
          a,
          b,
          c,
          d,
          qType === "short-answer" ? correctStored.slice(0, 1) : correctStored,
          norm.media_type,
          norm.media_url,
          expParam,
        ]
      );
    } else {
      await getPool().execute(
        "INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_answer, media_type, media_url) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          quizId,
          norm.question,
          a,
          b,
          c,
          d,
          qType === "short-answer" ? correctStored.slice(0, 1) : correctStored,
          norm.media_type,
          norm.media_url,
        ]
      );
    }
    return;
  }
  if (supportExp) {
    await getPool().execute(
      "INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_answer, explanation) VALUES (?,?,?,?,?,?,?,?)",
      [
        quizId,
        norm.question,
        a,
        b,
        c,
        d,
        qType === "short-answer" ? correctStored.slice(0, 1) : correctStored,
        expParam,
      ]
    );
  } else {
    await getPool().execute(
      "INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_answer) VALUES (?,?,?,?,?,?,?)",
      [
        quizId,
        norm.question,
        a,
        b,
        c,
        d,
        qType === "short-answer" ? correctStored.slice(0, 1) : correctStored,
      ]
    );
  }
}

async function saveQuizWithQuestions({ title, courseId, createdBy, questions, sourceFileUrl, documentId }) {
  const p = getPool();
  const vals = [trunc255(title || "Quiz"), parseOptionalInt(courseId), createdBy ? String(createdBy) : null];
  const src = sourceFileUrl != null && String(sourceFileUrl).trim() ? String(sourceFileUrl).trim().slice(0, 512) : null;
  const did = parseOptionalInt(documentId);
  const insertAttempts = [
    { sql: "INSERT INTO quizzes (title, course_id, created_by, is_published, source_file_url, document_id) VALUES (?,?,?,0,?,?)", params: [...vals, src, did] },
    { sql: "INSERT INTO quizzes (title, course_id, created_by, is_published, source_file_url) VALUES (?,?,?,0,?)", params: [...vals, src] },
    { sql: "INSERT INTO quizzes (title, course_id, created_by, is_published) VALUES (?,?,?,0)", params: [...vals] },
    { sql: "INSERT INTO quizzes (title, course_id, created_by) VALUES (?,?,?)", params: [...vals] },
  ];
  let hdr, lastErr = null;
  for (const a of insertAttempts) {
    try { [hdr] = await p.execute(a.sql, a.params); lastErr = null; break; }
    catch (e) { lastErr = e; if (e.code !== "ER_BAD_FIELD_ERROR") throw e; }
  }
  if (!hdr) throw lastErr || new Error("Không INSERT được quizzes.");
  const quizId = hdr.insertId;
  for (const q of questions) await insertQuizQuestion(quizId, q);
  return quizId;
}

function shapeQuizQuestionRow(r) {
  const t = String(r.question_type || "multiple-choice").trim() || "multiple-choice";
  const ex = r.explanation != null && String(r.explanation).trim() ? String(r.explanation).trim() : null;
  return {
    ...r,
    question_type: t,
    type: t,
    explanation: ex,
    media_type: r.media_type ?? null,
    media_url: r.media_url ?? null,
    mediaType: r.media_type ?? null,
    mediaUrl: r.media_url ?? null,
    options: {
      A: r.option_a,
      B: r.option_b,
      C: r.option_c,
      D: r.option_d,
    },
  };
}

async function getQuizWithQuestions(quizId) {
  const p = getPool();
  const id = Number(quizId);
  if (!Number.isFinite(id)) return null;
  const [quizzes] = await p.execute("SELECT * FROM quizzes WHERE quiz_id = ? LIMIT 1", [id]);
  if (!quizzes.length) return null;
  const supportQType = await hasTableColumn("quiz_questions", "question_type");
  const supportMediaType = await hasTableColumn("quiz_questions", "media_type");
  const supportMediaUrl = await hasTableColumn("quiz_questions", "media_url");
  const parts = [
    "question_id",
    "question_text",
    "option_a",
    "option_b",
    "option_c",
    "option_d",
    "correct_answer",
  ];
  if (supportQType) parts.push("question_type");
  if (supportMediaType && supportMediaUrl) {
    parts.push("media_type", "media_url");
  }
  if (await hasTableColumn("quiz_questions", "explanation")) {
    parts.push("explanation");
  }
  const questionSelect = `SELECT ${parts.join(", ")} FROM quiz_questions WHERE quiz_id = ? ORDER BY question_id ASC`;
  const [questions] = await p.execute(questionSelect, [id]);
  return { ...quizzes[0], questions: (questions || []).map(shapeQuizQuestionRow) };
}

async function assertQuizExists(quizId, p = getPool()) {
  const [rows] = await p.execute("SELECT 1 FROM quizzes WHERE quiz_id = ? LIMIT 1", [quizId]);
  if (!rows.length) throw new Error("Không tìm thấy quiz.");
}

async function startQuizAttempt({ quizId, userId }) {
  const p = getPool();
  const qid = Number(quizId);
  if (!Number.isFinite(qid)) throw new Error("quizId không hợp lệ.");
  await assertQuizExists(qid, p);
  await p.execute("DELETE FROM quiz_attempts WHERE quiz_id = ? AND (user_id <=> ?) AND completed_at IS NULL", [qid, userId || null]);
  await p.execute("INSERT INTO quiz_attempts (quiz_id, user_id, score, completed_at) VALUES (?,?,0,NULL)", [qid, userId || null]);
}

async function finishQuizAttempt({ quizId, userId, score, completedAt = null, answers = [], timeTaken = null }) {
  const p = getPool();
  const qid = Number(quizId);
  if (!Number.isFinite(qid)) throw new Error("quizId không hợp lệ.");
  const sc = Number(score);
  if (!Number.isFinite(sc) || sc < 0) throw new Error("score không hợp lệ.");
  const when = completedAt ? new Date(completedAt) : new Date();
  await assertQuizExists(qid, p);

  const answersJson = Array.isArray(answers) ? JSON.stringify(answers) : "[]";
  const timeTakenSecs =
    timeTaken != null && Number.isFinite(Number(timeTaken)) && Number(timeTaken) >= 0
      ? Math.floor(Number(timeTaken))
      : null;

  const [openRows] = await p.execute(
    "SELECT attempt_id FROM quiz_attempts WHERE quiz_id = ? AND (user_id <=> ?) AND completed_at IS NULL ORDER BY attempt_id DESC LIMIT 1",
    [qid, userId || null]
  );
  let attemptId;
  if (openRows.length) {
    attemptId = Number(openRows[0].attempt_id);
    await p.execute("UPDATE quiz_attempts SET score = ?, completed_at = ? WHERE attempt_id = ?", [Math.round(sc), when, attemptId]);
  } else {
    const [hdr] = await p.execute(
      "INSERT INTO quiz_attempts (quiz_id, user_id, score, completed_at) VALUES (?,?,?,?)",
      [qid, userId || null, Math.round(sc), when]
    );
    attemptId = Number(hdr.insertId);
  }

  try {
    const hasAnswersJson = await hasTableColumn("quiz_attempts", "answers_json");
    const hasTimeTaken = await hasTableColumn("quiz_attempts", "time_taken_seconds");
    if (hasAnswersJson || (hasTimeTaken && timeTakenSecs != null)) {
      const sets = [];
      const params = [];
      if (hasAnswersJson) {
        sets.push("answers_json = ?");
        params.push(answersJson);
      }
      if (hasTimeTaken && timeTakenSecs != null) {
        sets.push("time_taken_seconds = ?");
        params.push(timeTakenSecs);
      }
      if (sets.length) {
        await p.execute(`UPDATE quiz_attempts SET ${sets.join(", ")} WHERE attempt_id = ?`, [...params, attemptId]);
      }
    }
  } catch (_) {}

  const answersPayload = Array.isArray(answers) ? answers : [];
  if (!answersPayload.length) return attemptId;

  const supportQType = await hasTableColumn("quiz_questions", "question_type");
  const qSql = supportQType
    ? "SELECT question_id, correct_answer, question_type FROM quiz_questions WHERE quiz_id = ? ORDER BY question_id ASC"
    : "SELECT question_id, correct_answer FROM quiz_questions WHERE quiz_id = ? ORDER BY question_id ASC";
  const [questionRows] = await p.execute(qSql, [qid]);
  const questionsById = new Map(
    questionRows.map((q) => [
      Number(q.question_id),
      {
        correct: String(q.correct_answer ?? ""),
        type: supportQType
          ? String(q.question_type || "multiple-choice").trim() || "multiple-choice"
          : "multiple-choice",
      },
    ])
  );

  await p.execute("DELETE FROM quiz_answers WHERE attempt_id = ?", [attemptId]);
  for (let i = 0; i < answersPayload.length; i++) {
    const a = answersPayload[i];
    let questionId = Number(a?.questionId ?? a?.question_id);
    if (!Number.isFinite(questionId)) {
      const byIndex = questionRows[i];
      questionId = Number(byIndex?.question_id);
    }
    if (!Number.isFinite(questionId)) continue;

    const meta = questionsById.get(questionId);
    const qt = meta?.type || "multiple-choice";
    let storedAnswer = "";
    let isCorrect = 0;
    if (qt === "short-answer") {
      let userText = String(
        a?.shortAnswer ??
          a?.textAnswer ??
          a?.user_answer ??
          a?.userAnswer ??
          a?.answer ??
          ""
      ).trim();
      if (userText.length > 2048) userText = userText.slice(0, 2048);
      storedAnswer = userText;
      const expected = meta?.correct ?? "";
      isCorrect =
        normalizeShortAnswerText(userText) === normalizeShortAnswerText(expected) ? 1 : 0;
    } else {
      const userLetter = optionLetterFromAnswer(a?.selectedAnswer ?? a?.user_answer ?? a?.answer);
      storedAnswer = userLetter || "";
      const correctLetter = String(meta?.correct || "").toUpperCase().trim().slice(0, 1);
      isCorrect = userLetter && correctLetter && userLetter === correctLetter ? 1 : 0;
    }
    await p.execute(
      "INSERT INTO quiz_answers (attempt_id, question_id, user_answer, is_correct) VALUES (?,?,?,?)",
      [attemptId, questionId, storedAnswer, isCorrect]
    );
  }

  const [[cntRow]] = await p.execute(
    "SELECT COUNT(*) AS c FROM quiz_answers WHERE attempt_id = ? AND is_correct = 1",
    [attemptId]
  );
  const correctN = Number(cntRow?.c || 0);
  await p.execute("UPDATE quiz_attempts SET score = ? WHERE attempt_id = ?", [correctN, attemptId]);
  if (await hasTableColumn("quiz_attempts", "correct_count")) {
    await p.execute("UPDATE quiz_attempts SET correct_count = ? WHERE attempt_id = ?", [correctN, attemptId]);
  }
  const [[tqRow]] = await p.execute("SELECT COUNT(*) AS n FROM quiz_questions WHERE quiz_id = ?", [qid]);
  const totalQ = Number(tqRow?.n || 0);
  if (totalQ > 0 && (await hasTableColumn("quiz_attempts", "total_questions"))) {
    await p.execute("UPDATE quiz_attempts SET total_questions = ? WHERE attempt_id = ?", [totalQ, attemptId]);
  }

  return attemptId;
}

/** Legacy/alternate shape used by some routes — reads attempt row + answers_json. */
async function getAttemptResult(attemptId, userId) {
  const p = getPool();
  const aid = Number(attemptId);
  if (!Number.isFinite(aid)) return null;

  const sql = `
    SELECT qa.*, q.title FROM quiz_attempts qa
    INNER JOIN quizzes q ON q.quiz_id = qa.quiz_id
    WHERE qa.attempt_id = ? ${userId ? "AND (qa.user_id = ? OR qa.user_id IS NULL)" : ""}
    LIMIT 1
  `;
  const params = userId ? [aid, userId] : [aid];
  const [rows] = await p.execute(sql, params);

  if (!rows.length) return null;
  const row = rows[0];

  let answers = [];
  try {
    if (row.answers_json) answers = JSON.parse(row.answers_json);
  } catch (e) {}

  if (answers.length > 0) {
    try {
      const qIds = answers
        .map((a) => a.questionId || a.question_id)
        .filter(Boolean)
        .map((id) => String(id).replace(/[^0-9a-zA-Z_-]/g, ""));
      if (qIds.length > 0) {
        const qIdStr = qIds.map((id) => `'${id}'`).join(",");
        const [qRows] = await p.execute(
          `SELECT question_id, question_text, option_a, option_b, option_c, option_d, correct_answer FROM quiz_questions WHERE question_id IN (${qIdStr})`
        );
        const qMap = new Map();
        qRows.forEach((r) => qMap.set(String(r.question_id), r));

        const LETTERS = ["A", "B", "C", "D"];
        answers = answers.map((a) => {
          const qData = qMap.get(String(a.questionId || a.question_id));
          if (qData) {
            return {
              ...a,
              question_text: qData.question_text,
              options: [qData.option_a, qData.option_b, qData.option_c, qData.option_d],
              correctAnswer: Math.max(0, LETTERS.indexOf(String(qData.correct_answer || "A").toUpperCase())),
            };
          }
          return a;
        });
      }
    } catch (e) {
      console.error("Error fetching detail for answers:", e);
    }
  }

  return {
    attemptId: row.attempt_id,
    quizId: row.quiz_id,
    title: row.title,
    score: row.score,
    completedAt: row.completed_at,
    time_taken_seconds: row.time_taken_seconds,
    correct_count: row.correct_count,
    total_questions: row.total_questions,
    answers,
  };
}

function optionTextFromLetter(questionRow, answerLetter) {
  const letter = String(answerLetter || "").trim().toUpperCase();
  if (!["A", "B", "C", "D"].includes(letter)) return "";
  if (letter === "A") return String(questionRow?.option_a || "");
  if (letter === "B") return String(questionRow?.option_b || "");
  if (letter === "C") return String(questionRow?.option_c || "");
  if (letter === "D") return String(questionRow?.option_d || "");
  return "";
}

function isShortAnswerQuestionType(qt) {
  const t = String(qt || "multiple-choice")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  return t === "short-answer" || t === "shortanswer" || t === "essay";
}

async function getQuizAttemptResult(attemptId, userId = null) {
  const p = getPool();
  const aid = Number(attemptId);
  if (!Number.isFinite(aid) || aid <= 0) throw new Error("attemptId không hợp lệ.");
  const uid = parseOptionalInt(userId);

  const [attemptRows] = await p.execute(
    `SELECT
      qa.attempt_id,
      qa.quiz_id,
      qa.user_id,
      qa.score,
      qa.completed_at,
      q.title
     FROM quiz_attempts qa
     INNER JOIN quizzes q ON q.quiz_id = qa.quiz_id
     WHERE qa.attempt_id = ?
     LIMIT 1`,
    [aid]
  );
  if (!attemptRows.length) return null;
  const attempt = attemptRows[0];
  if (uid != null && Number(attempt.user_id) !== uid) return null;

  const [questionCountRows] = await p.execute(
    "SELECT COUNT(*) AS total_questions FROM quiz_questions WHERE quiz_id = ?",
    [attempt.quiz_id]
  );
  const totalQuestions = Number(questionCountRows?.[0]?.total_questions || 0);

  const moCol = await hasTableColumn("quiz_answers", "manual_override");
  const moSelect = moCol ? ", qa.manual_override" : "";
  const supportQType = await hasTableColumn("quiz_questions", "question_type");
  const supportExp = await hasTableColumn("quiz_questions", "explanation");
  const qTypeCol = supportQType ? "qq.question_type, " : "";
  const expCol = supportExp ? "qq.explanation, " : "";
  const [answerRows] = await p.execute(
    `SELECT
      qa.question_id,
      qa.user_answer,
      qa.is_correct${moSelect},
      qq.question_text,
      ${qTypeCol}${expCol}
      qq.option_a,
      qq.option_b,
      qq.option_c,
      qq.option_d,
      qq.correct_answer
     FROM quiz_answers qa
     INNER JOIN quiz_questions qq ON qq.question_id = qa.question_id
     WHERE qa.attempt_id = ?
     ORDER BY qq.question_id ASC`,
    [aid]
  );

  const explanationsByQuestionId = {};
  for (const r0 of answerRows || []) {
    if (supportExp && r0.explanation != null && String(r0.explanation).trim()) {
      explanationsByQuestionId[String(r0.question_id)] = String(r0.explanation).trim();
    }
  }

  const answers = (answerRows || []).map((r) => {
    const qTypeRaw = supportQType ? r.question_type : "multiple-choice";
    const isShort = isShortAnswerQuestionType(qTypeRaw);
    const correctLetterMc = String(r.correct_answer || "").trim().toUpperCase().slice(0, 1);

    if (isShort) {
      const text = String(r.user_answer ?? "");
      return {
        questionId: Number(r.question_id),
        question_text: String(r.question_text || ""),
        question_type: String(qTypeRaw || "short-answer"),
        type: String(qTypeRaw || "short-answer"),
        options: [r.option_a, r.option_b, r.option_c, r.option_d].map((x) => String(x || "")),
        selectedAnswer: text,
        selected_answer: text,
        correctAnswer: String(r.correct_answer ?? ""),
        correct_answer: String(r.correct_answer ?? ""),
        is_correct: Number(r.is_correct || 0) === 1,
        manual_override: moCol ? Number(r.manual_override || 0) === 1 : false,
      };
    }

    const selectedLetter = optionLetterFromAnswer(r.user_answer) || "";
    const correctLetter = optionLetterFromAnswer(r.correct_answer) || correctLetterMc;
    const selectedOptText = optionTextFromLetter(r, selectedLetter);
    const correctOptText = optionTextFromLetter(r, correctLetter);
    const selectedDisplay =
      selectedLetter && selectedOptText
        ? `${selectedLetter}: ${selectedOptText}`
        : selectedLetter || "—";
    return {
      questionId: Number(r.question_id),
      question_text: String(r.question_text || ""),
      question_type: String(qTypeRaw || "multiple-choice"),
      type: String(qTypeRaw || "multiple-choice"),
      options: [r.option_a, r.option_b, r.option_c, r.option_d].map((x) => String(x || "")),
      selectedAnswer: selectedLetter,
      selected_answer: selectedDisplay,
      correctAnswer: correctLetter,
      correct_answer: correctOptText || correctLetter,
      is_correct: Number(r.is_correct || 0) === 1,
      manual_override: moCol ? Number(r.manual_override || 0) === 1 : false,
    };
  });

  const scorePercent = scoreToPercent(attempt.score, totalQuestions);
  const correctCount = answers.filter((a) => a.is_correct).length;
  return {
    attemptId: Number(attempt.attempt_id),
    quizId: Number(attempt.quiz_id),
    title: attempt.title || "Quiz",
    score: Number(scorePercent ?? 0),
    correct_count: Number(correctCount),
    total_questions: totalQuestions,
    time_taken_seconds: 0,
    answers,
    completed_at: attempt.completed_at || null,
    ...(Object.keys(explanationsByQuestionId).length ? { explanationsByQuestionId } : {}),
  };
}

/**
 * Kết quả lượt làm cho giảng viên (cùng shape getQuizAttemptResult) sau khi kiểm tra canUserManageQuiz.
 * Chỉ cho attempt đã completed.
 */
async function getQuizAttemptResultForStaff(attemptId, staffUserId) {
  const aid = Number(attemptId);
  const sid = parseOptionalInt(staffUserId);
  if (!Number.isFinite(aid) || aid <= 0 || sid == null) return null;
  const p = getPool();
  const [rows] = await p.execute(
    `SELECT attempt_id, quiz_id, user_id
     FROM quiz_attempts
     WHERE attempt_id = ? AND completed_at IS NOT NULL
     LIMIT 1`,
    [aid]
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (!(await canUserManageQuiz(Number(row.quiz_id), sid))) return null;
  return getQuizAttemptResult(aid, row.user_id);
}

async function manualRegradeQuizAttempt({ attemptId, staffUserId, grades }) {
  await ensureManualGradeColumns();
  const p = getPool();
  const aid = Number(attemptId);
  const sid = parseOptionalInt(staffUserId);
  const list = Array.isArray(grades) ? grades : [];
  if (!Number.isFinite(aid) || sid == null) {
    const err = new Error("Yêu cầu attemptId và quyền giảng viên hợp lệ.");
    err.statusCode = 400;
    throw err;
  }
  if (!list.length) {
    const err = new Error("Gửi grades: [{ questionId, isCorrect }, ...].");
    err.statusCode = 400;
    throw err;
  }

  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const [attemptRows] = await conn.execute(
      `SELECT attempt_id, quiz_id, user_id FROM quiz_attempts WHERE attempt_id = ? AND completed_at IS NOT NULL LIMIT 1`,
      [aid]
    );
    if (!attemptRows.length) {
      const err = new Error("Không tìm thấy lượt làm đã hoàn thành.");
      err.statusCode = 404;
      throw err;
    }
    const att = attemptRows[0];
    const quizId = Number(att.quiz_id);
    if (!(await canUserManageQuiz(quizId, sid))) {
      const err = new Error("Bạn không có quyền chấm lại lượt này.");
      err.statusCode = 403;
      throw err;
    }

    const hasMo = await hasTableColumn("quiz_answers", "manual_override");
    const hasGradedAt = await hasTableColumn("quiz_attempts", "manual_graded_at");
    const hasGradedBy = await hasTableColumn("quiz_attempts", "manual_graded_by_user_id");
    const hasCorrectCount = await hasTableColumn("quiz_attempts", "correct_count");
    const hasTotalQuestions = await hasTableColumn("quiz_attempts", "total_questions");

    for (const g of list) {
      const qid = Number(g.questionId ?? g.question_id);
      const isCorrect = !!(g.isCorrect ?? g.is_correct);
      if (!Number.isFinite(qid)) continue;

      const [qBelongs] = await conn.execute(
        `SELECT 1 FROM quiz_questions WHERE quiz_id = ? AND question_id = ? LIMIT 1`,
        [quizId, qid]
      );
      if (!qBelongs.length) {
        const err = new Error(`Câu ${qid} không thuộc quiz này.`);
        err.statusCode = 400;
        throw err;
      }

      const ic = isCorrect ? 1 : 0;
      let sql;
      let params;
      if (hasMo) {
        sql =
          "UPDATE quiz_answers SET is_correct = ?, manual_override = 1 WHERE attempt_id = ? AND question_id = ?";
        params = [ic, aid, qid];
      } else {
        sql = "UPDATE quiz_answers SET is_correct = ? WHERE attempt_id = ? AND question_id = ?";
        params = [ic, aid, qid];
      }
      const [upd] = await conn.execute(sql, params);
      const affected = upd?.affectedRows ?? 0;
      if (!affected) {
        const err = new Error(`Không có dòng trả lời cho câu ${qid} trong lượt làm này.`);
        err.statusCode = 400;
        throw err;
      }
    }

    const [[cntRow]] = await conn.execute(
      `SELECT COUNT(*) AS c FROM quiz_answers WHERE attempt_id = ? AND is_correct = 1`,
      [aid]
    );
    const correctCount = Number(cntRow?.c || 0);
    const [[totRow]] = await conn.execute(
      `SELECT COUNT(*) AS n FROM quiz_questions WHERE quiz_id = ?`,
      [quizId]
    );
    const totalQuestions = Number(totRow?.n || 0);

    const updateParts = ["score = ?"];
    const uParams = [correctCount];
    if (hasCorrectCount) {
      updateParts.push("correct_count = ?");
      uParams.push(correctCount);
    }
    if (hasTotalQuestions) {
      updateParts.push("total_questions = ?");
      uParams.push(totalQuestions);
    }
    if (hasGradedAt) {
      updateParts.push("manual_graded_at = NOW()");
    }
    if (hasGradedBy) {
      updateParts.push("manual_graded_by_user_id = ?");
      uParams.push(sid);
    }
    uParams.push(aid);
    await conn.execute(
      `UPDATE quiz_attempts SET ${updateParts.join(", ")} WHERE attempt_id = ?`,
      uParams
    );

    await conn.commit();

    return {
      attemptId: aid,
      quizId,
      score: correctCount,
      correctCount,
      totalQuestions,
    };
  } catch (e) {
    try {
      await conn.rollback();
    } catch (_) {
      // ignore
    }
    if (e.statusCode) throw e;
    throw e;
  } finally {
    conn.release();
  }
}

async function getLatestQuizAttemptResultByQuizAndUser(quizId, userId) {
  const p = getPool();
  const qid = Number(quizId);
  const uid = parseOptionalInt(userId);
  if (!Number.isFinite(qid) || qid <= 0) throw new Error("quizId không hợp lệ.");
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("userId không hợp lệ.");

  const [rows] = await p.execute(
    `SELECT attempt_id
     FROM quiz_attempts
     WHERE quiz_id = ?
       AND user_id = ?
       AND completed_at IS NOT NULL
     ORDER BY attempt_id DESC
     LIMIT 1`,
    [qid, uid]
  );
  if (!rows.length) return null;
  return getQuizAttemptResult(rows[0].attempt_id, uid);
}

async function replaceQuizQuestions(quizId, questions) {
  const id = Number(quizId);
  if (!Number.isFinite(id)) throw new Error("quizId không hợp lệ.");
  const p = getPool();
  await p.execute("DELETE FROM quiz_questions WHERE quiz_id = ?", [id]);
  for (const q of (Array.isArray(questions) ? questions : [])) await insertQuizQuestion(id, q);
}

async function updateQuizTitle(quizId, title) {
  await getPool().execute("UPDATE quizzes SET title = ? WHERE quiz_id = ?", [trunc255(title || "Quiz"), Number(quizId)]);
}

async function setQuizPublished(quizId, published = true) {
  const p = getPool();
  const id = Number(quizId);
  if (!Number.isFinite(id)) throw new Error("quizId không hợp lệ.");
  if (published) {
    await p.execute("UPDATE quizzes SET is_published = 1, published_at = COALESCE(published_at, NOW()) WHERE quiz_id = ?", [id]);
  } else {
    await p.execute("UPDATE quizzes SET is_published = 0, published_at = NULL WHERE quiz_id = ?", [id]);
  }
}

async function deleteQuizById(quizId) {
  const p = getPool();
  const id = Number(quizId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("quizId không hợp lệ.");
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("DELETE FROM quiz_questions WHERE quiz_id = ?", [id]);
    await conn.execute("DELETE FROM quiz_attempts WHERE quiz_id = ?", [id]);
    const [result] = await conn.execute("DELETE FROM quizzes WHERE quiz_id = ? LIMIT 1", [id]);
    await conn.commit();
    return Number(result?.affectedRows || 0) > 0;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {
      // ignore rollback error
    }
    throw err;
  } finally {
    conn.release();
  }
}

function quizRowIsPublished(row) {
  if (!row) return false;
  if (!Object.prototype.hasOwnProperty.call(row, "is_published")) return true;
  const v = row.is_published;
  return v === 1 || v === true || v === "1";
}

async function findQuizByS3Key(s3Key) {
  const p = getPool();
  const k = String(s3Key || "").trim();
  if (!k) return null;
  // Look up by source_file_url first, then via document_id join
  const [rows] = await p.execute(
    `SELECT q.quiz_id FROM quizzes q
     WHERE q.source_file_url = ?
     ORDER BY q.created_at DESC LIMIT 1`,
    [k]
  );
  if (!rows.length) {
    // Try via documents table
    const [docRows] = await p.execute(
      "SELECT document_id FROM documents WHERE file_url = ? LIMIT 1", [k]
    );
    if (!docRows.length) return null;
    const [qRows] = await p.execute(
      `SELECT q.quiz_id FROM quizzes q
       WHERE q.document_id = ?
       ORDER BY q.created_at DESC LIMIT 1`,
      [docRows[0].document_id]
    );
    if (!qRows.length) return null;
    return qRows[0].quiz_id;
  }
  return rows[0].quiz_id;
}

async function getQuizQuestionsById(quizId) {
  const id = Number(quizId);
  if (!Number.isFinite(id)) return [];
  const supportQType = await hasTableColumn("quiz_questions", "question_type");
  const supportMediaType = await hasTableColumn("quiz_questions", "media_type");
  const supportMediaUrl = await hasTableColumn("quiz_questions", "media_url");
  const supportExp = await hasTableColumn("quiz_questions", "explanation");
  const parts = [
    "question_id",
    "question_text",
    "option_a",
    "option_b",
    "option_c",
    "option_d",
    "correct_answer",
  ];
  if (supportQType) parts.push("question_type");
  if (supportMediaType && supportMediaUrl) {
    parts.push("media_type", "media_url");
  }
  if (supportExp) parts.push("explanation");
  const questionSelect = `SELECT ${parts.join(", ")} FROM quiz_questions WHERE quiz_id = ? ORDER BY question_id ASC`;
  const [rows] = await getPool().execute(questionSelect, [id]);
  return rows.map((r) => {
    const t = String(r.question_type || "multiple-choice").trim() || "multiple-choice";
    const ex = supportExp && r.explanation != null && String(r.explanation).trim() ? String(r.explanation).trim() : "";
    return {
      id: String(r.question_id),
      question: r.question_text,
      type: t,
      question_type: t,
      options: { A: r.option_a, B: r.option_b, C: r.option_c, D: r.option_d },
      correct_answer: r.correct_answer,
      media_type: r.media_type || null,
      media_url: r.media_url || null,
      explanation: ex,
    };
  });
}


async function getLeaderboard({ limit = 50, requestingUserId = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const p = getPool();

  const sql = `
    SELECT
      u.user_id                                     AS userId,
      u.full_name                                        AS name,
      u.email,
      COUNT(qa.attempt_id)                          AS totalAttempts,
      ROUND(AVG(IF(qa.total_questions > 0, (qa.correct_count / qa.total_questions) * 100, qa.score)))   AS avgScore,
      ROUND(MAX(IF(qa.total_questions > 0, (qa.correct_count / qa.total_questions) * 100, qa.score)))   AS bestScore
    FROM quiz_attempts qa
    INNER JOIN users u ON u.user_id = qa.user_id
    WHERE qa.completed_at IS NOT NULL
      AND qa.user_id IS NOT NULL
    GROUP BY u.user_id, u.full_name, u.email
    ORDER BY avgScore DESC, totalAttempts DESC
  `;

  const [rows] = await p.execute(sql);

  const allRanked = rows.map((r, i) => ({
    rank: i + 1,
    userId: r.userId,
    name: r.name || 'Anonymous',
    email: r.email || null,
    avgScore: Number(r.avgScore ?? 0),
    totalAttempts: Number(r.totalAttempts ?? 0),
    bestScore: Number(r.bestScore ?? 0),
  }));

  let myRank = null;
  if (requestingUserId) {
    const found = allRanked.find(r => String(r.userId) === String(requestingUserId));
    if (found) {
      myRank = {
        rank: found.rank,
        avgScore: found.avgScore,
        totalAttempts: found.totalAttempts,
        bestScore: found.bestScore,
      };
    }
  }

  return { total: allRanked.length, data: allRanked.slice(0, lim), myRank };
}

async function getProgressSummary(userId) {
  const p = getPool();
  const uid = Number(userId);

  if (!Number.isFinite(uid) || uid <= 0) {
    throw new Error('Invalid userId.');
  }

  // 1) Tổng số tài liệu đã "học" = số document xuất hiện trong quiz history của user
  const [materialsRows] = await p.execute(
    `
    SELECT
      COUNT(DISTINCT COALESCE(q.document_id, d.document_id)) AS completedMaterials
    FROM quiz_attempts qa
    INNER JOIN quizzes q ON q.quiz_id = qa.quiz_id
    LEFT JOIN documents d ON d.document_id = q.document_id
    WHERE qa.user_id = ?
      AND qa.completed_at IS NOT NULL
    `,
    [uid]
  );

  const completedMaterials = Number(materialsRows?.[0]?.completedMaterials || 0);

  // 2) Tổng tài liệu trong hệ thống (có thể đổi sang verified-only nếu muốn)
  const [totalRows] = await p.execute(
    `
    SELECT COUNT(*) AS totalMaterials
    FROM documents
    `
  );

  const totalMaterials = Number(totalRows?.[0]?.totalMaterials || 0);

  // 3) Điểm trung bình từ quiz_attempts
  const [avgRows] = await p.execute(
    `
    SELECT
      ROUND(AVG(qa.score / qq.total * 100)) AS averageScorePercent
    FROM quiz_attempts qa
    INNER JOIN (
      SELECT quiz_id, COUNT(*) AS total
      FROM quiz_questions
      GROUP BY quiz_id
    ) qq ON qq.quiz_id = qa.quiz_id
    WHERE qa.user_id = ?
      AND qa.completed_at IS NOT NULL
      AND qq.total > 0
    `,
    [uid]
  );

  const averageScorePercent =
    avgRows?.[0]?.averageScorePercent != null
      ? Number(avgRows[0].averageScorePercent)
      : null;

  // 4) Course progress
  const [courseRows] = await p.execute(
    `
    SELECT
      COALESCE(c.course_id, 0) AS courseId,
      COALESCE(c.course_name, 'General') AS name,
      COALESCE(c.course_code, 'DOC') AS code,
      COUNT(DISTINCT q.quiz_id) AS totalMaterials,
      COUNT(DISTINCT CASE WHEN qa.completed_at IS NOT NULL THEN q.quiz_id END) AS completedMaterials,
      ROUND(AVG(
        CASE
          WHEN qa.completed_at IS NOT NULL AND qq.total > 0
          THEN qa.score / qq.total * 100
          ELSE NULL
        END
      )) AS quizScorePercent,
      MAX(qa.completed_at) AS lastActivityAt
    FROM quizzes q
    LEFT JOIN courses c ON c.course_id = q.course_id
    LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.quiz_id AND qa.user_id = ?
    LEFT JOIN (
      SELECT quiz_id, COUNT(*) AS total
      FROM quiz_questions
      GROUP BY quiz_id
    ) qq ON qq.quiz_id = q.quiz_id
    GROUP BY COALESCE(c.course_id, 0), COALESCE(c.course_name, 'General'), COALESCE(c.course_code, 'DOC')
    ORDER BY lastActivityAt DESC, name ASC
    `,
    [uid]
  );

  const courses = (courseRows || []).map((r) => {
    const total = Number(r.totalMaterials || 0);
    const completed = Number(r.completedMaterials || 0);
    return {
      courseId: Number(r.courseId || 0),
      name: r.name || 'General',
      code: r.code || 'DOC',
      progressPercent: total > 0 ? Math.round((completed / total) * 100) : 0,
      totalMaterials: total,
      completedMaterials: completed,
      quizScorePercent: r.quizScorePercent != null ? Number(r.quizScorePercent) : null,
      lastActivityAt: r.lastActivityAt || null,
    };
  });

  // 5) Streak đơn giản: đếm số ngày liên tiếp có completed_at
  const [streakRows] = await p.execute(
    `
    SELECT DISTINCT DATE(completed_at) AS activityDate
    FROM quiz_attempts
    WHERE user_id = ?
      AND completed_at IS NOT NULL
    ORDER BY activityDate DESC
    `,
    [uid]
  );

  const activityDates = (streakRows || [])
    .map((r) => (r.activityDate ? new Date(r.activityDate) : null))
    .filter(Boolean)
    .map((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());

  let currentDays = 0;
  let longestDays = 0;

  if (activityDates.length > 0) {
    let streak = 1;
    longestDays = 1;

    for (let i = 0; i < activityDates.length - 1; i++) {
      const diffDays = Math.round((activityDates[i] - activityDates[i + 1]) / (1000 * 60 * 60 * 24));
      if (diffDays === 1) {
        streak += 1;
      } else {
        longestDays = Math.max(longestDays, streak);
        streak = 1;
      }
    }
    longestDays = Math.max(longestDays, streak);

    const today = new Date();
    const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const diffFromToday = Math.round((todayOnly - activityDates[0]) / (1000 * 60 * 60 * 24));

    if (diffFromToday === 0) {
      currentDays = 1;
      for (let i = 0; i < activityDates.length - 1; i++) {
        const diffDays = Math.round((activityDates[i] - activityDates[i + 1]) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) currentDays += 1;
        else break;
      }
    } else if (diffFromToday === 1) {
      currentDays = 1;
      for (let i = 0; i < activityDates.length - 1; i++) {
        const diffDays = Math.round((activityDates[i] - activityDates[i + 1]) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) currentDays += 1;
        else break;
      }
    }
  }

  const progressPercent =
    totalMaterials > 0 ? Math.round((completedMaterials / totalMaterials) * 100) : 0;

  return {
    overall: {
      progressPercent,
      completedMaterials,
      totalMaterials,
      averageScorePercent,
      studyHoursLabel: null,
    },
    courses,
    streak: {
      currentDays,
      longestDays,
    },
  };
}

async function ensureQuestionBankForOwner(ownerUserId) {
  const p = getPool();
  const uid = Number(ownerUserId);
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("ownerUserId không hợp lệ.");

  const [rows] = await p.execute(
    "SELECT bank_id FROM question_bank WHERE owner_user_id = ? ORDER BY bank_id ASC LIMIT 1",
    [uid]
  );
  if (rows.length) return rows[0].bank_id;

  const [hdr] = await p.execute(
    "INSERT INTO question_bank (owner_user_id, title) VALUES (?, ?)",
    [uid, "Question Bank"]
  );
  return hdr.insertId;
}

async function listQuestionBankItems(ownerUserId) {
  const p = getPool();
  const uid = Number(ownerUserId);
  if (!Number.isFinite(uid) || uid <= 0) return [];

  const supportMediaType = await hasTableColumn("question_bank_items", "media_type");
  const supportMediaUrl = await hasTableColumn("question_bank_items", "media_url");
  const mediaColumns = supportMediaType && supportMediaUrl
    ? ", qbi.media_type, qbi.media_url"
    : "";
  const sql = `
    SELECT
      qbi.item_id,
      qbi.bank_id,
      qbi.owner_user_id,
      qbi.question_text,
      qbi.option_a,
      qbi.option_b,
      qbi.option_c,
      qbi.option_d,
      qbi.correct_answer,
      qbi.question_type,
      qbi.topic,
      qbi.category,
      qbi.difficulty,
      qbi.version_no,
      qbi.version,
      qbi.is_active,
      qbi.created_at,
      qbi.updated_at
      ${mediaColumns}
    FROM question_bank_items qbi
    WHERE qbi.owner_user_id = ?
      AND qbi.is_active = 1
    ORDER BY qbi.updated_at DESC, qbi.item_id DESC
  `;
  const [rows] = await p.execute(sql, [uid]);

  return rows.map((r) => ({
    id: Number(r.item_id),
    item_id: Number(r.item_id),
    bankId: Number(r.bank_id),
    ownerUserId: Number(r.owner_user_id),
    question: r.question_text || "",
    type: r.question_type || "multiple-choice",
    topic: r.topic || "General",
    category: r.category || "",
    difficulty: r.difficulty || "medium",
    options: [r.option_a, r.option_b, r.option_c, r.option_d].map((x) => String(x ?? "")),
    correctAnswer: r.correct_answer || "A",
    mediaType: r.media_type || null,
    mediaUrl: r.media_url || null,
    versionNo: Number(r.version_no || 1),
    version: Number(r.version || 1),
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null,
  }));
}

async function insertQuestionBankItem({
  ownerUserId,
  question,
  type,
  topic,
  category,
  difficulty,
  options,
  correctAnswer,
  mediaType,
  mediaUrl,
}) {
  const p = getPool();
  const uid = Number(ownerUserId);
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("ownerUserId không hợp lệ.");

  const bankId = await ensureQuestionBankForOwner(uid);
  const normalized = normalizeQuestionInput({
    question,
    options,
    correctAnswer,
    mediaType,
    mediaUrl,
  });
  if (!normalized) throw new Error("Câu hỏi không hợp lệ.");

  const safeType = String(type || "multiple-choice").trim() || "multiple-choice";
  const safeTopic = trunc255(topic || "General") || "General";
  const safeCategory = String(category || "").trim() || null;
  const safeDifficulty = String(difficulty || "medium").trim() || "medium";

  const supportMediaType = await hasTableColumn("question_bank_items", "media_type");
  const supportMediaUrl = await hasTableColumn("question_bank_items", "media_url");
  const [hdr] = supportMediaType && supportMediaUrl
    ? await p.execute(
      `INSERT INTO question_bank_items (
        bank_id, owner_user_id, question_text,
        option_a, option_b, option_c, option_d,
        correct_answer, question_type, topic, category, difficulty, media_type, media_url
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        bankId,
        uid,
        normalized.question,
        trunc255(normalized.options.A),
        trunc255(normalized.options.B),
        trunc255(normalized.options.C),
        trunc255(normalized.options.D),
        normalized.correct_answer,
        safeType,
        safeTopic,
        safeCategory,
        safeDifficulty,
        normalized.media_type,
        normalized.media_url,
      ]
    )
    : await p.execute(
      `INSERT INTO question_bank_items (
        bank_id, owner_user_id, question_text,
        option_a, option_b, option_c, option_d,
        correct_answer, question_type, topic, category, difficulty
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        bankId,
        uid,
        normalized.question,
        trunc255(normalized.options.A),
        trunc255(normalized.options.B),
        trunc255(normalized.options.C),
        trunc255(normalized.options.D),
        normalized.correct_answer,
        safeType,
        safeTopic,
        safeCategory,
        safeDifficulty,
      ]
    );

  const itemId = hdr.insertId;
  const [rows] = await p.execute(
    "SELECT * FROM question_bank_items WHERE item_id = ? LIMIT 1",
    [itemId]
  );
  return rows.length ? rows[0] : null;
}

async function updateQuestionBankItem(
  itemId,
  ownerUserId,
  { question, type, topic, category, difficulty, options, correctAnswer, mediaType, mediaUrl }
) {
  const p = getPool();
  const id = Number(itemId);
  const uid = Number(ownerUserId);

  if (!Number.isFinite(id) || id <= 0) throw new Error("itemId không hợp lệ.");
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("ownerUserId không hợp lệ.");

  const [existing] = await p.execute(
    "SELECT * FROM question_bank_items WHERE item_id = ? AND owner_user_id = ? AND is_active = 1 LIMIT 1",
    [id, uid]
  );
  if (!existing.length) throw new Error("Không tìm thấy câu hỏi trong ngân hàng.");

  const base = existing[0];

  const mergedOptions = Array.isArray(options) && options.length
    ? options
    : [base.option_a, base.option_b, base.option_c, base.option_d];

  const normalized = normalizeQuestionInput({
    question: question ?? base.question_text,
    options: mergedOptions,
    correctAnswer: correctAnswer ?? base.correct_answer,
    mediaType: mediaType ?? base.media_type,
    mediaUrl: mediaUrl ?? base.media_url,
  });
  if (!normalized) throw new Error("Câu hỏi không hợp lệ.");

  const supportMediaType = await hasTableColumn("question_bank_items", "media_type");
  const supportMediaUrl = await hasTableColumn("question_bank_items", "media_url");
  if (supportMediaType && supportMediaUrl) {
    await p.execute(
      `UPDATE question_bank_items
       SET question_text = ?,
           option_a = ?,
           option_b = ?,
           option_c = ?,
           option_d = ?,
           correct_answer = ?,
           question_type = ?,
           topic = ?,
           category = ?,
           difficulty = ?,
           media_type = ?,
           media_url = ?,
           version_no = version_no + 1,
           version = version + 1
       WHERE item_id = ? AND owner_user_id = ?`,
      [
        normalized.question,
        trunc255(normalized.options.A),
        trunc255(normalized.options.B),
        trunc255(normalized.options.C),
        trunc255(normalized.options.D),
        normalized.correct_answer,
        String(type || base.question_type || "multiple-choice").trim() || "multiple-choice",
        trunc255(topic || base.topic || "General") || "General",
        String(category ?? base.category ?? "").trim() || null,
        String(difficulty || base.difficulty || "medium").trim() || "medium",
        normalized.media_type,
        normalized.media_url,
        id,
        uid,
      ]
    );
  } else {
    await p.execute(
      `UPDATE question_bank_items
       SET question_text = ?,
           option_a = ?,
           option_b = ?,
           option_c = ?,
           option_d = ?,
           correct_answer = ?,
           question_type = ?,
           topic = ?,
           category = ?,
           difficulty = ?,
           version_no = version_no + 1,
           version = version + 1
       WHERE item_id = ? AND owner_user_id = ?`,
      [
        normalized.question,
        trunc255(normalized.options.A),
        trunc255(normalized.options.B),
        trunc255(normalized.options.C),
        trunc255(normalized.options.D),
        normalized.correct_answer,
        String(type || base.question_type || "multiple-choice").trim() || "multiple-choice",
        trunc255(topic || base.topic || "General") || "General",
        String(category ?? base.category ?? "").trim() || null,
        String(difficulty || base.difficulty || "medium").trim() || "medium",
        id,
        uid,
      ]
    );
  }

  const [rows] = await p.execute(
    "SELECT * FROM question_bank_items WHERE item_id = ? LIMIT 1",
    [id]
  );
  return rows.length ? rows[0] : null;
}

async function deleteQuestionBankItem(itemId, ownerUserId, options = {}) {
  const p = getPool();
  const id = Number(itemId);
  const uid = Number(ownerUserId);
  const allowAnyOwner = options?.allowAnyOwner === true;

  if (!Number.isFinite(id) || id <= 0) throw new Error("itemId không hợp lệ.");
  if (!allowAnyOwner && (!Number.isFinite(uid) || uid <= 0)) {
    throw new Error("ownerUserId không hợp lệ.");
  }

  const supportsIsActive = await hasTableColumn("question_bank_items", "is_active");
  const supportsVersionNo = await hasTableColumn("question_bank_items", "version_no");
  const supportsVersion = await hasTableColumn("question_bank_items", "version");

  // Try soft delete first when schema supports it.
  if (supportsIsActive) {
    const setClauses = ["is_active = 0"];
    if (supportsVersionNo) setClauses.push("version_no = version_no + 1");
    if (supportsVersion) setClauses.push("version = version + 1");
    const whereOwner = allowAnyOwner ? "" : " AND owner_user_id = ?";
    const params = allowAnyOwner ? [id] : [id, uid];
    const [result] = await p.execute(
      `UPDATE question_bank_items
       SET ${setClauses.join(", ")}
       WHERE item_id = ?${whereOwner} AND is_active = 1`,
      params
    );
    if (Number(result.affectedRows || 0) > 0) return true;

    // Idempotent behavior: if item already inactive but exists, treat as success.
    const [existingRows] = await p.execute(
      `SELECT item_id
       FROM question_bank_items
       WHERE item_id = ?${whereOwner}
       LIMIT 1`,
      params
    );
    return existingRows.length > 0;
  }

  // Legacy schema fallback: hard delete when no is_active column.
  const whereOwner = allowAnyOwner ? "" : " AND owner_user_id = ?";
  const params = allowAnyOwner ? [id] : [id, uid];
  const [result] = await p.execute(
    `DELETE FROM question_bank_items WHERE item_id = ?${whereOwner}`,
    params
  );
  return Number(result.affectedRows || 0) > 0;
}

async function getQuizAnalyticsByOwner(ownerUserId, topQuestions = 5) {
  const p = getPool();
  const uid = Number(ownerUserId);
  const tq = Math.min(Math.max(Number(topQuestions) || 5, 1), 20);

  if (!Number.isFinite(uid) || uid <= 0) {
    throw new Error("ownerUserId không hợp lệ.");
  }

  // Summary
  const [summaryRows] = await p.execute(
    `
    SELECT
      COUNT(DISTINCT q.quiz_id) AS totalQuizzes,
      COUNT(DISTINCT qa.user_id) AS totalParticipants,
      ROUND(AVG(
        CASE
          WHEN qq.total > 0 AND qa.completed_at IS NOT NULL
          THEN qa.score / qq.total * 100
          ELSE NULL
        END
      )) AS averageScorePercent,
      ROUND(
        100 * COUNT(DISTINCT CASE WHEN qa.completed_at IS NOT NULL THEN qa.attempt_id END)
        / NULLIF(COUNT(DISTINCT qa.attempt_id), 0)
      ) AS completionRatePercent
    FROM quizzes q
    LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.quiz_id
    LEFT JOIN (
      SELECT quiz_id, COUNT(*) AS total
      FROM quiz_questions
      GROUP BY quiz_id
    ) qq ON qq.quiz_id = q.quiz_id
    WHERE q.created_by = ?
    `,
    [uid]
  );

  // Performance rows per owned quiz
  const [performanceRows] = await p.execute(
    `
    SELECT
      q.quiz_id AS quizId,
      q.title,
      COUNT(DISTINCT qa.user_id) AS participants,
      COUNT(qa.attempt_id) AS attempts,
      ROUND(AVG(
        CASE
          WHEN qq.total > 0 AND qa.completed_at IS NOT NULL
          THEN qa.score / qq.total * 100
          ELSE NULL
        END
      )) AS averageScorePercent,
      ROUND(AVG(
        CASE
          WHEN qq.total > 0 AND qa.completed_at IS NOT NULL
               AND (qa.score / qq.total * 100) >= 50
          THEN 100
          WHEN qq.total > 0 AND qa.completed_at IS NOT NULL
          THEN 0
          ELSE NULL
        END
      )) AS passRatePercent,
      'medium' AS difficulty,
      q.is_published AS isPublished
    FROM quizzes q
    LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.quiz_id
    LEFT JOIN (
      SELECT quiz_id, COUNT(*) AS total
      FROM quiz_questions
      GROUP BY quiz_id
    ) qq ON qq.quiz_id = q.quiz_id
    WHERE q.created_by = ?
    GROUP BY q.quiz_id, q.title, q.is_published
    ORDER BY q.created_at DESC
    `,
    [uid]
  );

  // Most challenging questions among owned quizzes
  const [challengingRows] = await p.execute(
    `
    SELECT
      qq.question_id AS questionId,
      qq.question_text AS question,
      COUNT(qa.attempt_id) AS attempts,
      NULL AS correctRatePercent
    FROM quizzes q
    INNER JOIN quiz_questions qq ON qq.quiz_id = q.quiz_id
    LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.quiz_id AND qa.completed_at IS NOT NULL
    WHERE q.created_by = ?
    GROUP BY qq.question_id, qq.question_text
    ORDER BY attempts DESC, qq.question_id DESC
    LIMIT ${tq}
    `,
    [uid]
  );

  const summary = summaryRows?.[0] || {};

  return {
    summary: {
      totalQuizzes: Number(summary.totalQuizzes || 0),
      totalParticipants: Number(summary.totalParticipants || 0),
      averageScorePercent: Number(summary.averageScorePercent || 0),
      completionRatePercent: Number(summary.completionRatePercent || 0),
    },
    performance: (performanceRows || []).map((r) => ({
      quizId: Number(r.quizId),
      title: r.title || "Quiz",
      participants: Number(r.participants || 0),
      attempts: Number(r.attempts || 0),
      averageScorePercent: Number(r.averageScorePercent || 0),
      passRatePercent: Number(r.passRatePercent || 0),
      difficulty: r.difficulty || "medium",
      isPublished: Number(r.isPublished || 0) === 1,
    })),
    challengingQuestions: (challengingRows || []).map((r) => ({
      questionId: Number(r.questionId),
      question: r.question || "",
      attempts: Number(r.attempts || 0),
      correctRatePercent: Number(r.correctRatePercent || 0),
    })),
  };
}

async function listOwnedQuizzesHistory(limit = 20, ownerUserId = null) {
  const p = getPool();
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 500);
  const uid = parseOptionalInt(ownerUserId);
  if (uid == null) return [];

  const role = await getUserRole(uid);
  const includeShared = isLecturerRole(role) || isAdminRole(role);
  const sql = `
    SELECT
      q.quiz_id,
      q.title,
      q.created_at,
      q.published_at,
      q.is_published,
      q.shared_from_student,
      q.shared_by_user_id,
      u_shared.full_name AS shared_by_name,
      u_shared.email AS shared_by_email,
      q.document_id,
      q.source_file_url AS s3Key,
      c.course_code,
      d.category AS documentCategory,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.quiz_id) AS question_count,
      (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.quiz_id = q.quiz_id) AS attempts_count,
      (
        SELECT ROUND(AVG(
          CASE
            WHEN qq2.total > 0 AND qa2.completed_at IS NOT NULL
            THEN qa2.score / qq2.total * 100
            ELSE NULL
          END
        ))
        FROM quiz_attempts qa2
        INNER JOIN (
          SELECT quiz_id, COUNT(*) AS total
          FROM quiz_questions
          GROUP BY quiz_id
        ) qq2 ON qq2.quiz_id = qa2.quiz_id
        WHERE qa2.quiz_id = q.quiz_id
      ) AS score_percent
    FROM quizzes q
    LEFT JOIN courses c ON c.course_id = q.course_id
    LEFT JOIN documents d ON d.document_id = q.document_id
    LEFT JOIN users u_shared ON u_shared.user_id = COALESCE(q.shared_by_user_id, q.created_by)
    WHERE (q.created_by = ? ${includeShared ? "OR q.shared_from_student = 1" : ""})
    ORDER BY q.created_at DESC
    LIMIT ${lim}
  `;

  const [rows] = await p.execute(sql, [uid]);

  return rows.map((row) => ({
    quizId: Number(row.quiz_id),
    title: row.title || "Quiz",
    createdAt: row.created_at || null,
    publishedAt: row.published_at || null,
    isPublished: Number(row.is_published || 0) === 1,
    sharedFromStudent: Number(row.shared_from_student || 0) === 1,
    sharedByUserId: row.shared_by_user_id != null ? Number(row.shared_by_user_id) : null,
    sharedByName: row.shared_by_name != null ? String(row.shared_by_name) : null,
    sharedByEmail: row.shared_by_email != null ? String(row.shared_by_email) : null,
    documentId: row.document_id != null ? Number(row.document_id) : null,
    s3Key: row.s3Key || "",
    courseCode: row.course_code || "DOC",
    documentCategory: row.documentCategory || "",
    questionCount: Number(row.question_count || 0),
    attemptsCount: Number(row.attempts_count || 0),
    scorePercent: Number(row.score_percent || 0),
  }));
}

async function shareQuizForReview({ quizId, userId }) {
  const p = getPool();
  const qid = Number(quizId);
  const uid = Number(userId);
  if (!Number.isFinite(qid) || qid <= 0) throw new Error("quizId không hợp lệ.");
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("userId không hợp lệ.");
  await assertQuizExists(qid, p);

  const role = await getUserRole(uid);
  if (!String(role || "").toUpperCase().includes("STUDENT")) {
    throw new Error("Chỉ sinh viên mới chia sẻ quiz để giảng viên review.");
  }
  const [attemptRows] = await p.execute(
    `SELECT 1
     FROM quiz_attempts
     WHERE quiz_id = ?
       AND user_id = ?
       AND completed_at IS NOT NULL
     LIMIT 1`,
    [qid, uid]
  );
  if (!attemptRows.length) {
    throw new Error("Bạn cần hoàn thành quiz trước khi chia sẻ.");
  }

  await p.execute(
    `UPDATE quizzes
     SET shared_from_student = 1,
         shared_by_user_id = ?,
         is_published = 0
     WHERE quiz_id = ?`,
    [uid, qid]
  );
}

async function markQuizEditedByLecturer({ quizId, lecturerUserId }) {
  const p = getPool();
  const qid = Number(quizId);
  const uid = Number(lecturerUserId);
  if (!Number.isFinite(qid) || qid <= 0) throw new Error("quizId không hợp lệ.");
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("lecturerUserId không hợp lệ.");
  await p.execute(
    `UPDATE quizzes
     SET lecturer_edited = 1,
         lecturer_edited_by = ?,
         lecturer_edited_at = NOW()
     WHERE quiz_id = ?
       AND shared_from_student = 1`,
    [uid, qid]
  );
}

async function listEditedSharedQuizzesByStudent(limit = 50, studentUserId = null) {
  const p = getPool();
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const uid = parseOptionalInt(studentUserId);
  if (uid == null) return [];
  const sql = `
    SELECT
      q.quiz_id,
      q.title,
      q.created_at,
      q.lecturer_edited_at,
      q.document_id,
      q.source_file_url AS s3Key,
      c.course_code,
      d.category AS document_category,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.quiz_id) AS question_count,
      (
        SELECT COUNT(*)
        FROM quiz_attempts qa
        WHERE qa.quiz_id = q.quiz_id
          AND qa.user_id = ?
          AND qa.completed_at IS NOT NULL
      ) AS attempts_count
    FROM quizzes q
    LEFT JOIN courses c ON c.course_id = q.course_id
    LEFT JOIN documents d ON d.document_id = q.document_id
    WHERE q.shared_from_student = 1
      AND q.shared_by_user_id = ?
      AND q.lecturer_edited = 1
    ORDER BY COALESCE(q.lecturer_edited_at, q.created_at) DESC
    LIMIT ${lim}
  `;
  const [rows] = await p.execute(sql, [uid, uid]);
  return rows.map((row) => ({
    quizId: Number(row.quiz_id),
    title: row.title || "Quiz",
    createdAt: row.created_at || null,
    lecturerEditedAt: row.lecturer_edited_at || null,
    documentId: row.document_id != null ? Number(row.document_id) : null,
    s3Key: row.s3Key || "",
    courseCode: row.course_code || "DOC",
    documentCategory: row.document_category || "",
    questionCount: Number(row.question_count || 0),
    attemptsCount: Number(row.attempts_count || 0),
    lecturerEdited: true,
  }));
}

module.exports = {
  isConfigured, initDb, getPool,
  upsertDocument, ensureDocumentStub, deleteChunksByDocumentId,
  insertSegment, insertChunk, getDocumentIdByS3Key,
  countAttemptsBySourceFileUrls, countChunksByS3Key,
  getConcatenatedChunksByS3Key, listSegmentsByS3Key,
  getDocumentById, listSegmentsByDocumentId,
  hasCompleteEmbeddingsForS3Key, getMetaMapForS3Keys,
  listDocumentsRecent, saveQuizWithQuestions, insertQuizQuestion,
  getQuizWithQuestions, listQuizHistory, listPublishedQuizzes,
  startQuizAttempt, finishQuizAttempt, scoreToPercent,
  getQuizAttemptResult,
  getQuizAttemptResultForStaff,
  listCompletedQuizAttemptsByQuizId,
  manualRegradeQuizAttempt,
  getLatestQuizAttemptResultByQuizAndUser,
  getUserRole, canUserManageQuiz, replaceQuizQuestions,
  updateQuizTitle, setQuizPublished, deleteQuizById, quizRowIsPublished, normalizeQuestionInput,
  findQuizByS3Key, getQuizQuestionsById, getLeaderboard, getProgressSummary,
  ensureQuestionBankForOwner, listQuestionBankItems, insertQuestionBankItem, updateQuestionBankItem, deleteQuestionBankItem, getQuizAnalyticsByOwner, listOwnedQuizzesHistory,
  shareQuizForReview,
  markQuizEditedByLecturer,
  listEditedSharedQuizzesByStudent,
  getAttemptResult,
};
