const path = require("path");
const mysql = require("mysql2/promise");

/**
 * Edumate schema: documents, document_segments, quizzes, quiz_questions, ...
 *
 * Convention: documents.file_url stores the S3 object key (e.g. documents/xxx.pdf) for ListObjects.
 * VARCHAR(255) keys may truncate; store full URLs elsewhere or widen the column.
 */

function parseMysqlUrl(url) {
  const u = new URL(url);
  const database = u.pathname.replace(/^\//, "").split("?")[0];
  if (!database) throw new Error("DATABASE_URL must include the database name.");
  return {
    host: u.hostname || "localhost",
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username || ""),
    password: decodeURIComponent(u.password || ""),
    database,
  };
}

function createPoolConfig() {
  const raw = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (raw && (raw.startsWith("mysql://") || raw.startsWith("mysql2://"))) {
    return parseMysqlUrl(raw);
  }
  return {
    host: process.env.MYSQL_HOST || process.env.DB_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT || process.env.DB_PORT || 3306),
    user: process.env.MYSQL_USER || process.env.DB_USER,
    password: process.env.MYSQL_PASSWORD ?? process.env.DB_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE || process.env.DB_NAME,
  };
}

let pool;

function isConfigured() {
  const raw = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (raw && (raw.startsWith("mysql://") || raw.startsWith("mysql2://"))) return true;
  const dbName = String(process.env.MYSQL_DATABASE || process.env.DB_NAME || "").trim();
  const dbUser = String(process.env.MYSQL_USER || process.env.DB_USER || "").trim();
  return !!(dbName && dbUser);
}

function getPool() {
  if (!isConfigured()) {
    throw new Error("MySQL is not configured (DATABASE_URL or MYSQL_*).");
  }
  if (!pool) {
    const cfg = createPoolConfig();
    pool = mysql.createPool({
      ...cfg,
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
  ];
  for (const sql of stmts) {
    try {
      await p.execute(sql);
    } catch (e) {
      if (e.code !== "ER_DUP_FIELDNAME") {
        console.warn("ensureQuizLifecycleColumns:", e.message);
      }
    }
  }
}

async function initDb() {
  const p = getPool();
  await p.execute("SELECT 1");
  try {
    await ensureQuizLifecycleColumns();
  } catch (e) {
    console.warn("ensureQuizLifecycleColumns (init):", e.message);
  }
  const [[row]] = await p.execute(
    `SELECT COUNT(*) AS c FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name IN ('documents','document_segments')`
  );
  if (Number(row.c) < 2) {
    console.warn(
      "MySQL: documents / document_segments tables missing — run the edumate CREATE TABLE script."
    );
  }
}

function trunc255(s) {
  const t = String(s ?? "").trim();
  if (t.length <= 255) return t;
  return `${t.slice(0, 252)}...`;
}

function parseOptionalInt(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseOptionalUserId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Keep integer ids numeric, preserve non-numeric ids as strings.
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

/**
 * @param {object} row
 * @param {string} row.s3Key - stored in documents.file_url
 * @param {string} row.title
 * @param {number|string|null} [row.courseId]
 * @param {number|string|null} [row.uploaderId]
 */
async function upsertDocument(row) {
  const p = getPool();
  const key = String(row.s3Key || "").trim();
  if (!key) throw new Error("Missing s3Key (maps to documents.file_url).");

  const [existing] = await p.execute(
    "SELECT document_id FROM documents WHERE file_url = ? LIMIT 1",
    [key]
  );

  const title = String(row.title || "").trim() || path.basename(key);
  const courseId = parseOptionalInt(row.courseId);
  const uploaderId = parseOptionalInt(row.uploaderId);

  if (existing.length) {
    const id = existing[0].document_id;
    await p.execute(
      `UPDATE documents SET title = ?, version = IFNULL(version, 0) + 1,
        course_id = COALESCE(?, course_id), uploader_id = COALESCE(?, uploader_id)
       WHERE document_id = ?`,
      [title, courseId, uploaderId, id]
    );
    return id;
  }

  const [hdr] = await p.execute(
    `INSERT INTO documents (title, course_id, uploader_id, file_url, version)
     VALUES (?,?,?,?,1)`,
    [title, courseId, uploaderId, key]
  );
  return hdr.insertId;
}

async function ensureDocumentStub(s3Key, partial = {}) {
  const p = getPool();
  const key = String(s3Key || "").trim();
  const base = partial.originalFilename || path.basename(key);

  const [existing] = await p.execute(
    "SELECT document_id FROM documents WHERE file_url = ? LIMIT 1",
    [key]
  );
  if (existing.length) return existing[0].document_id;

  const title = partial.title || base;
  const courseId = parseOptionalInt(partial.courseId);
  const uploaderId = parseOptionalInt(partial.uploaderId);

  const [hdr] = await p.execute(
    `INSERT INTO documents (title, course_id, uploader_id, file_url, version)
     VALUES (?,?,?,?,1)`,
    [title, courseId, uploaderId, key]
  );
  return hdr.insertId;
}

async function deleteChunksByDocumentId(documentId) {
  await getPool().execute("DELETE FROM document_segments WHERE document_id = ?", [documentId]);
}

async function insertSegment(documentId, contentText, embedding) {
  await getPool().execute(
    `INSERT INTO document_segments (document_id, content, embedding) VALUES (?,?,?)`,
    [documentId, contentText, JSON.stringify(embedding)]
  );
}

/** chunkIndex is for pipeline compatibility; segment order follows segment_id. */
async function insertChunk(documentId, _chunkIndex, contentText, embedding) {
  await insertSegment(documentId, contentText, embedding);
}

async function getDocumentIdByS3Key(s3Key) {
  const k = String(s3Key || "").trim();
  if (!k) return null;
  const [rows] = await getPool().execute(
    "SELECT document_id FROM documents WHERE file_url = ? LIMIT 1",
    [k]
  );
  return rows.length ? rows[0].document_id : null;
}

/**
 * Count attempts by S3 key: union (1) quizzes linked via documents.document_id + file_url
 * and (2) quizzes with source_file_url — avoids double-counting the same attempt.
 */
async function countAttemptsBySourceFileUrls(s3Keys) {
  const uniq = [...new Set((s3Keys || []).map((k) => String(k || "").trim()).filter(Boolean))];
  if (!uniq.length) return new Map();
  const placeholders = uniq.map(() => "?").join(",");
  const paramsDup = [...uniq, ...uniq];
  const p = getPool();
  try {
    const [rows] = await p.execute(
      `SELECT t.k, COUNT(*) AS n FROM (
         SELECT d.file_url AS k, qa.attempt_id
         FROM quiz_attempts qa
         INNER JOIN quizzes q ON q.quiz_id = qa.quiz_id
         INNER JOIN documents d ON d.document_id = q.document_id
         WHERE d.file_url IN (${placeholders})
         UNION
         SELECT q.source_file_url AS k, qa.attempt_id
         FROM quiz_attempts qa
         INNER JOIN quizzes q ON q.quiz_id = qa.quiz_id
         WHERE q.source_file_url IN (${placeholders})
       ) t
       WHERE t.k IS NOT NULL AND TRIM(t.k) <> ''
       GROUP BY t.k`,
      paramsDup
    );
    const m = new Map();
    for (const r of rows) {
      if (r.k) m.set(String(r.k), Number(r.n || 0));
    }
    return m;
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      try {
        const [rows] = await p.execute(
          `SELECT q.source_file_url AS k, COUNT(qa.attempt_id) AS n
           FROM quizzes q
           INNER JOIN quiz_attempts qa ON qa.quiz_id = q.quiz_id
           WHERE q.source_file_url IN (${placeholders})
           GROUP BY q.source_file_url`,
          uniq
        );
        const m = new Map();
        for (const r of rows) {
          if (r.k) m.set(String(r.k), Number(r.n || 0));
        }
        return m;
      } catch (e2) {
        if (e2.code === "ER_BAD_FIELD_ERROR") return new Map();
        throw e2;
      }
    }
    throw e;
  }
}

async function countChunksByS3Key(s3Key) {
  const [rows] = await getPool().execute(
    `SELECT COUNT(*) AS n FROM document_segments s
     INNER JOIN documents d ON d.document_id = s.document_id
     WHERE d.file_url = ?`,
    [s3Key]
  );
  return Number(rows[0]?.n || 0);
}

async function getConcatenatedChunksByS3Key(s3Key) {
  const [rows] = await getPool().execute(
    `SELECT s.content FROM document_segments s
     INNER JOIN documents d ON d.document_id = s.document_id
     WHERE d.file_url = ?
     ORDER BY s.segment_id ASC`,
    [s3Key]
  );
  return rows.map((r) => r.content).join("\n\n");
}

async function listSegmentsByS3Key(s3Key) {
  const [rows] = await getPool().execute(
    `SELECT s.segment_id, s.document_id, s.content, s.embedding
     FROM document_segments s
     INNER JOIN documents d ON d.document_id = s.document_id
     WHERE d.file_url = ?
     ORDER BY s.segment_id ASC`,
    [s3Key]
  );
  return rows.map((r, idx) => {
    let emb = [];
    try {
      emb = JSON.parse(r.embedding || "[]");
    } catch {
      emb = [];
    }
    return {
      segmentId: r.segment_id,
      documentId: r.document_id,
      section: idx + 1,
      content: r.content,
      embedding: Array.isArray(emb) ? emb : [],
    };
  });
}

async function getDocumentById(documentId) {
  const id = Number(documentId);
  if (!Number.isFinite(id)) return null;
  const [rows] = await getPool().execute(
    `SELECT document_id, title, file_url, course_id, uploader_id, created_at
     FROM documents WHERE document_id = ? LIMIT 1`,
    [id]
  );
  return rows.length ? rows[0] : null;
}

async function listSegmentsByDocumentId(documentId) {
  const id = Number(documentId);
  if (!Number.isFinite(id)) return [];
  const [rows] = await getPool().execute(
    `SELECT s.segment_id, s.document_id, s.content, s.embedding
     FROM document_segments s
     WHERE s.document_id = ?
     ORDER BY s.segment_id ASC`,
    [id]
  );
  return rows.map((r, idx) => {
    let emb = [];
    try {
      emb = JSON.parse(r.embedding || "[]");
    } catch {
      emb = [];
    }
    return {
      segmentId: r.segment_id,
      documentId: r.document_id,
      section: idx + 1,
      content: r.content,
      embedding: Array.isArray(emb) ? emb : [],
    };
  });
}

/**
 * True when every segment for this S3 key has a non-empty embedding vector in DB.
 */
async function hasCompleteEmbeddingsForS3Key(s3Key) {
  const n = await countChunksByS3Key(s3Key);
  if (n === 0) return false;
  const segs = await listSegmentsByS3Key(s3Key);
  return (
    segs.length > 0 &&
    segs.every((s) => Array.isArray(s.embedding) && s.embedding.length > 0)
  );
}

async function getMetaMapForS3Keys(keys) {
  if (!keys.length) return new Map();
  const p = getPool();
  const placeholders = keys.map(() => "?").join(",");
  const [docs] = await p.execute(
    `SELECT d.document_id, d.title, d.file_url, d.course_id, d.uploader_id, d.created_at,
      c.course_code,
      (SELECT COUNT(*) FROM document_segments s WHERE s.document_id = d.document_id) AS chunk_count
     FROM documents d
     LEFT JOIN courses c ON c.course_id = d.course_id
     WHERE d.file_url IN (${placeholders})`,
    keys
  );
  const m = new Map();
  for (const d of docs) {
    m.set(d.file_url, d);
  }
  return m;
}

/**
 * quiz_attempts.score: treat as **correct count** vs question_count when possible.
 * If score is in [0,100] and greater than question_count (or question_count=0), treat as **percent**.
 */
function scoreToPercent(score, questionCount) {
  if (score == null || score === "") return null;
  const s = Number(score);
  const n = Number(questionCount) || 0;
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

async function listQuizHistory(limit = 20, userId = null) {
  const p = getPool();
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const uid = parseOptionalInt(userId);

  let sql = `
    SELECT q.quiz_id, q.title, q.created_at, q.is_published,
      c.course_code,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.quiz_id) AS question_count,
      (SELECT COUNT(*) FROM quiz_attempts qa0 WHERE qa0.quiz_id = q.quiz_id) AS attempts_count,
      (SELECT qa.score FROM quiz_attempts qa WHERE qa.quiz_id = q.quiz_id AND qa.completed_at IS NOT NULL
       ORDER BY qa.completed_at DESC, qa.attempt_id DESC LIMIT 1) AS last_score,
      (SELECT qa.completed_at FROM quiz_attempts qa WHERE qa.quiz_id = q.quiz_id AND qa.completed_at IS NOT NULL
       ORDER BY qa.completed_at DESC, qa.attempt_id DESC LIMIT 1) AS last_completed_at
    FROM quizzes q
    LEFT JOIN courses c ON c.course_id = q.course_id
  `;
  const params = [];
  if (uid != null) {
    sql += ` WHERE q.created_by = ? OR EXISTS (
      SELECT 1 FROM quiz_attempts qa2 WHERE qa2.quiz_id = q.quiz_id AND qa2.user_id = ?)`;
    params.push(uid, uid);
  }
  sql += ` ORDER BY COALESCE(
      (SELECT MAX(completed_at) FROM quiz_attempts qa3 WHERE qa3.quiz_id = q.quiz_id),
      q.created_at
    ) DESC
    LIMIT ${lim}`;

  let rows;
  try {
    [rows] = await p.execute(sql, params);
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR" && String(e.sqlMessage || e.message).includes("is_published")) {
      const sqlLegacy = sql.replace("q.created_at, q.is_published,", "q.created_at,");
      [rows] = await p.execute(sqlLegacy, params);
    } else throw e;
  }
  return rows.map((row) => ({
    quizId: row.quiz_id,
    title: row.title,
    createdAt: row.created_at,
    courseCode: row.course_code,
    questionCount: Number(row.question_count || 0),
    attemptsCount: Number(row.attempts_count || 0),
    scorePercent: scoreToPercent(row.last_score, row.question_count),
    lastAttemptAt: row.last_completed_at,
    isPublished: Number(row.is_published ?? 0) === 1,
  }));
}

async function listPublishedQuizzes(limit = 20) {
  const p = getPool();
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const sql = `
    SELECT q.quiz_id, q.title, q.created_at, q.published_at,
      c.course_code,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.quiz_id) AS question_count,
      (SELECT COUNT(*) FROM quiz_attempts qa0 WHERE qa0.quiz_id = q.quiz_id) AS attempts_count,
      u.name AS creator_name
    FROM quizzes q
    LEFT JOIN courses c ON c.course_id = q.course_id
    LEFT JOIN users u ON u.user_id = q.created_by
    WHERE q.is_published = 1
    ORDER BY COALESCE(q.published_at, q.created_at) DESC
    LIMIT ${lim}
  `;
  try {
    const [rows] = await p.execute(sql);
    return rows.map((row) => ({
      quizId: row.quiz_id,
      title: row.title,
      createdAt: row.created_at,
      publishedAt: row.published_at,
      courseCode: row.course_code,
      questionCount: Number(row.question_count || 0),
      attemptsCount: Number(row.attempts_count || 0),
      creatorName: row.creator_name || null,
    }));
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR" && String(e.sqlMessage || e.message).includes("is_published")) {
      return [];
    }
    throw e;
  }
}

async function getUserRole(userId) {
  const uid = parseOptionalInt(userId);
  if (uid == null) return null;
  const [rows] = await getPool().execute("SELECT role FROM users WHERE user_id = ? LIMIT 1", [uid]);
  return rows.length ? rows[0].role : null;
}

async function findUserByEmail(email) {
  const em = String(email || "").trim().toLowerCase();
  if (!em) return null;
  const p = getPool();
  const [rows] = await p.execute(
    `SELECT user_id, email, role,
      COALESCE(NULLIF(full_name,''), NULLIF(name,''), '') AS display_name,
      password
     FROM users
     WHERE LOWER(email) = ?
     LIMIT 1`,
    [em]
  );
  return rows.length ? rows[0] : null;
}

async function createUser({ fullName, name, email, password, role, userCode }) {
  const em = String(email || "").trim().toLowerCase();
  if (!em) throw new Error("Invalid email.");
  const r = String(role || "STUDENT").trim().toUpperCase() || "STUDENT";
  const nm = String(name || fullName || "").trim() || null;
  const fn = String(fullName || name || "").trim() || null;
  const code = userCode != null && String(userCode).trim() ? String(userCode).trim().slice(0, 64) : null;
  const p = getPool();
  const [hdr] = await p.execute(
    `INSERT INTO users (email, password, role, full_name, name, user_code)
     VALUES (?,?,?,?,?,?)`,
    [em, String(password || ""), r, fn, nm, code]
  );
  return Number(hdr.insertId);
}

async function updateUserPassword(userId, hashedPassword) {
  const uid = parseOptionalInt(userId);
  if (uid == null) return false;
  await getPool().execute(`UPDATE users SET password = ? WHERE user_id = ?`, [
    String(hashedPassword || ""),
    uid,
  ]);
  return true;
}

function isLecturerRole(role) {
  const allowed = String(process.env.LECTURER_ROLES || "lecturer,teacher,Lecturer,Teacher")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const r = String(role || "")
    .trim()
    .toLowerCase();
  if (!r) return false;
  return allowed.includes(r);
}

async function canUserManageQuiz(quizId, userId) {
  const row = await getQuizWithQuestions(quizId);
  if (!row) return false;
  const uid = parseOptionalInt(userId);
  if (uid == null) return false;
  if (row.created_by == null || Number(row.created_by) !== uid) return false;
  const role = await getUserRole(uid);
  return isLecturerRole(role);
}

async function replaceQuizQuestions(quizId, questions) {
  const id = Number(quizId);
  if (!Number.isFinite(id)) throw new Error("Invalid quizId.");
  const list = Array.isArray(questions) ? questions : [];
  const p = getPool();
  await p.execute("DELETE FROM quiz_questions WHERE quiz_id = ?", [id]);
  for (const q of list) {
    await insertQuizQuestion(id, q);
  }
}

async function updateQuizTitle(quizId, title) {
  await getPool().execute(`UPDATE quizzes SET title = ? WHERE quiz_id = ?`, [
    trunc255(title || "Quiz"),
    Number(quizId),
  ]);
}

async function setQuizPublished(quizId, published = true) {
  const p = getPool();
  const id = Number(quizId);
  if (!Number.isFinite(id)) throw new Error("Invalid quizId.");
  try {
    if (published) {
      await p.execute(
        `UPDATE quizzes SET is_published = 1, published_at = COALESCE(published_at, NOW()) WHERE quiz_id = ?`,
        [id]
      );
    } else {
      await p.execute(`UPDATE quizzes SET is_published = 0, published_at = NULL WHERE quiz_id = ?`, [id]);
    }
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      throw new Error("Column is_published is missing — restart the backend to migrate the DB.");
    }
    throw e;
  }
}

function quizRowIsPublished(row) {
  if (!row) return false;
  if (!Object.prototype.hasOwnProperty.call(row, "is_published")) return true;
  const v = row.is_published;
  return v === 1 || v === true || v === "1";
}

async function assertQuizExists(quizId, p = getPool()) {
  const [rows] = await p.execute("SELECT 1 FROM quizzes WHERE quiz_id = ? LIMIT 1", [quizId]);
  if (!rows.length) throw new Error("Quiz not found.");
}

/**
 * One "Take Quiz" attempt: insert on start (completed_at NULL, score = 0).
 * MySQL column completed_at must allow NULL.
 * Delete any open attempts (same quiz + user) before INSERT — avoids inflating attemptsCount
 * when Take Quiz is clicked repeatedly and only one row gets finished.
 */
async function startQuizAttempt({ quizId, userId }) {
  const p = getPool();
  const qid = Number(quizId);
  if (!Number.isFinite(qid)) throw new Error("Invalid quizId.");
  const uid = parseOptionalInt(userId);
  await assertQuizExists(qid, p);
  await p.execute(
    `DELETE FROM quiz_attempts WHERE quiz_id = ? AND (user_id <=> ?) AND completed_at IS NULL`,
    [qid, uid]
  );
  await p.execute(
    `INSERT INTO quiz_attempts (quiz_id, user_id, score, completed_at) VALUES (?,?,0,NULL)`,
    [qid, uid]
  );
}

/**
 * Update the open attempt (completed_at IS NULL) on submit.
 * If none exists (legacy API / edge case) → INSERT as before.
 */
async function finishQuizAttempt({ quizId, userId, score, completedAt = null, timeTakenSeconds = null }) {
  const p = getPool();
  const qid = Number(quizId);
  if (!Number.isFinite(qid)) throw new Error("Invalid quizId.");
  const sc = Number(score);
  if (!Number.isFinite(sc) || sc < 0) throw new Error("Invalid score.");
  const when = completedAt ? new Date(completedAt) : new Date();
  const uid = parseOptionalInt(userId);
  await assertQuizExists(qid, p);

  const [openRows] = await p.execute(
    `SELECT attempt_id FROM quiz_attempts
     WHERE quiz_id = ? AND (user_id <=> ?) AND completed_at IS NULL
     ORDER BY attempt_id DESC LIMIT 1`,
    [qid, uid]
  );
  const safeTimeTaken = Number.isFinite(Number(timeTakenSeconds))
    ? Math.max(0, Math.floor(Number(timeTakenSeconds)))
    : null;
  if (openRows.length) {
    await p.execute(
      `UPDATE quiz_attempts SET score = ?, completed_at = ?, time_taken_seconds = COALESCE(?, time_taken_seconds) WHERE attempt_id = ?`,
      [Math.round(sc), when, safeTimeTaken, openRows[0].attempt_id]
    );
    return;
  }
  await p.execute(
    `INSERT INTO quiz_attempts (quiz_id, user_id, score, completed_at, time_taken_seconds) VALUES (?,?,?,?,?)`,
    [qid, uid, Math.round(sc), when, safeTimeTaken]
  );
}

function optionLetterFromAnswer(answer) {
  const n = Number(answer);
  if (Number.isFinite(n) && n >= 0 && n <= 3) return ["A", "B", "C", "D"][n];
  const s = String(answer || "").trim().toUpperCase();
  return ["A", "B", "C", "D"].includes(s) ? s : null;
}

function optionIndexFromLetter(letter) {
  return ["A", "B", "C", "D"].indexOf(String(letter || "").trim().toUpperCase());
}

async function finishQuizAttemptWithAnswers({
  quizId,
  userId,
  score,
  completedAt = null,
  answers = [],
  timeTakenSeconds = null,
}) {
  const p = getPool();
  const qid = Number(quizId);
  if (!Number.isFinite(qid)) throw new Error("Invalid quizId.");
  const sc = Number(score);
  if (!Number.isFinite(sc) || sc < 0) throw new Error("Invalid score.");
  const when = completedAt ? new Date(completedAt) : new Date();
  const uid = parseOptionalInt(userId);
  await assertQuizExists(qid, p);

  const [openRows] = await p.execute(
    `SELECT attempt_id FROM quiz_attempts
     WHERE quiz_id = ? AND (user_id <=> ?) AND completed_at IS NULL
     ORDER BY attempt_id DESC LIMIT 1`,
    [qid, uid]
  );
  let attemptId;
  if (openRows.length) {
    attemptId = Number(openRows[0].attempt_id);
    await p.execute(
      `UPDATE quiz_attempts SET score = ?, completed_at = ?, time_taken_seconds = COALESCE(?, time_taken_seconds) WHERE attempt_id = ?`,
      [Math.round(sc), when, Number.isFinite(Number(timeTakenSeconds)) ? Math.max(0, Math.floor(Number(timeTakenSeconds))) : null, attemptId]
    );
  } else {
    const [hdr] = await p.execute(
      `INSERT INTO quiz_attempts (quiz_id, user_id, score, completed_at, time_taken_seconds) VALUES (?,?,?,?,?)`,
      [qid, uid, Math.round(sc), when, Number.isFinite(Number(timeTakenSeconds)) ? Math.max(0, Math.floor(Number(timeTakenSeconds))) : null]
    );
    attemptId = Number(hdr.insertId);
  }

  const answersPayload = Array.isArray(answers) ? answers : [];
  const answersJson = JSON.stringify(answersPayload);
  try {
    await p.execute(`UPDATE quiz_attempts SET answers_json = ? WHERE attempt_id = ?`, [
      answersJson,
      attemptId,
    ]);
  } catch {
    // answers_json may be absent in older schemas
  }

  await p.execute(`DELETE FROM quiz_answers WHERE attempt_id = ?`, [attemptId]);
  for (const a of answersPayload) {
    const questionId = Number(a?.questionId ?? a?.question_id);
    if (!Number.isFinite(questionId)) continue;
    const userLetter = optionLetterFromAnswer(a?.selectedAnswer ?? a?.user_answer);
    let isCorrect = 0;
    if (userLetter) {
      const [rows] = await p.execute(
        `SELECT correct_answer FROM quiz_questions WHERE question_id = ? AND quiz_id = ? LIMIT 1`,
        [questionId, qid]
      );
      const correct = String(rows?.[0]?.correct_answer || "").toUpperCase();
      isCorrect = correct && correct === userLetter ? 1 : 0;
    }
    await p.execute(
      `INSERT INTO quiz_answers (attempt_id, question_id, user_answer, is_correct) VALUES (?,?,?,?)`,
      [attemptId, questionId, userLetter, isCorrect]
    );
  }
  return attemptId;
}

async function listCompletedAttempts(limit = 200, userId = null) {
  const uid = parseOptionalInt(userId);
  if (uid == null) return [];
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const [rows] = await getPool().execute(
    `SELECT qa.attempt_id, qa.quiz_id, q.title, qa.score, qa.correct_count, qa.total_questions,
            qa.time_taken_seconds, qa.created_at, qa.completed_at,
            (SELECT COUNT(*) FROM quiz_answers qas WHERE qas.attempt_id = qa.attempt_id) AS answers_count,
            (SELECT COUNT(*) FROM quiz_answers qas WHERE qas.attempt_id = qa.attempt_id AND qas.is_correct = 1) AS answers_correct_count,
            (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = qa.quiz_id) AS quiz_questions_count
     FROM quiz_attempts qa
     INNER JOIN quizzes q ON q.quiz_id = qa.quiz_id
     WHERE qa.user_id = ? AND qa.completed_at IS NOT NULL
     ORDER BY qa.completed_at DESC, qa.attempt_id DESC
     LIMIT ${lim}`,
    [uid]
  );
  return rows.map((r) => {
    const answersCount = Number(r.answers_count || 0);
    const answersCorrect = Number(r.answers_correct_count || 0);
    const totalQuestions =
      (answersCount > 0 ? answersCount : 0) ||
      Number(r.total_questions || 0) ||
      Number(r.quiz_questions_count || 0) ||
      0;
    const correctCount =
      (answersCount > 0 ? answersCorrect : 0) ||
      Number(r.correct_count || 0) ||
      0;
    return {
    id: Number(r.attempt_id),
    quiz_id: Number(r.quiz_id),
    title: r.title,
    score: normalizeAttemptScorePercent(r.score, totalQuestions, correctCount),
    correct_count: correctCount,
    total_questions: totalQuestions,
    time_taken_seconds: Number.isFinite(Number(r.time_taken_seconds))
      ? Math.max(0, Math.floor(Number(r.time_taken_seconds)))
      : r.created_at && r.completed_at
        ? Math.max(0, Math.floor((new Date(r.completed_at).getTime() - new Date(r.created_at).getTime()) / 1000))
        : 0,
    created_at: r.completed_at || r.created_at || null,
  };
  });
}

async function getAttemptResultDetail(attemptId, userId = null) {
  const aid = Number(attemptId);
  const uid = parseOptionalInt(userId);
  if (!Number.isFinite(aid) || uid == null) return null;
  const p = getPool();
  const [attemptRows] = await p.execute(
    `SELECT attempt_id, quiz_id, score, correct_count, total_questions, answers_json, created_at, completed_at, time_taken_seconds
     FROM quiz_attempts
     WHERE attempt_id = ? AND user_id = ? AND completed_at IS NOT NULL
     LIMIT 1`,
    [aid, uid]
  );
  if (!attemptRows.length) return null;
  const att = attemptRows[0];
  const [[quizCountRow]] = await p.execute(
    `SELECT COUNT(*) AS n FROM quiz_questions WHERE quiz_id = ?`,
    [att.quiz_id]
  );
  const quizQuestionsCount = Number(quizCountRow?.n || 0);

  const [rows] = await p.execute(
    `SELECT qq.question_id, qq.question_text, qq.option_a, qq.option_b, qq.option_c, qq.option_d,
            qq.correct_answer, qa.user_answer, qa.is_correct
     FROM quiz_answers qa
     INNER JOIN quiz_questions qq ON qq.question_id = qa.question_id
     WHERE qa.attempt_id = ?
     ORDER BY qq.question_id ASC`,
    [aid]
  );

  let answers = rows.map((r) => ({
    questionId: Number(r.question_id),
    question_text: String(r.question_text || ""),
    user_answer: String(r.user_answer || ""),
    correct_answer: String(r.correct_answer || ""),
    is_correct: Number(r.is_correct || 0) === 1,
    options: [r.option_a, r.option_b, r.option_c, r.option_d].map((x) => String(x || "")),
    selectedAnswer: optionIndexFromLetter(r.user_answer),
    correctAnswer: optionIndexFromLetter(r.correct_answer),
  }));

  if (!answers.length && att.answers_json) {
    let parsed = [];
    try {
      parsed = JSON.parse(String(att.answers_json || "[]"));
    } catch {
      parsed = [];
    }
    const [qRows] = await p.execute(
      `SELECT question_id, question_text, option_a, option_b, option_c, option_d, correct_answer
       FROM quiz_questions WHERE quiz_id = ? ORDER BY question_id ASC`,
      [att.quiz_id]
    );
    const byId = new Map(qRows.map((q) => [Number(q.question_id), q]));
    answers = (Array.isArray(parsed) ? parsed : []).map((a, idx) => {
      const qid = Number(a?.questionId ?? a?.question_id);
      const q = Number.isFinite(qid) ? byId.get(qid) : qRows[idx];
      const userLetter = optionLetterFromAnswer(a?.selectedAnswer ?? a?.user_answer);
      const correctLetter = String(q?.correct_answer || "");
      return {
        questionId: Number(q?.question_id || qid || idx + 1),
        question_text: String(q?.question_text || `Question ${idx + 1}`),
        user_answer: String(userLetter || ""),
        correct_answer: correctLetter,
        is_correct: !!userLetter && userLetter === String(correctLetter).toUpperCase(),
        options: [q?.option_a, q?.option_b, q?.option_c, q?.option_d].map((x) => String(x || "")),
        selectedAnswer: optionIndexFromLetter(userLetter),
        correctAnswer: optionIndexFromLetter(correctLetter),
      };
    });
  }

  const derivedTotalQuestions =
    Number(att.total_questions || 0) ||
    quizQuestionsCount ||
    (Array.isArray(answers) && answers.length ? answers.length : 0);
  const derivedCorrectCount =
    Number(att.correct_count || 0) ||
    (Array.isArray(answers) ? answers.filter((a) => !!a.is_correct).length : 0);

  return {
    score: normalizeAttemptScorePercent(att.score, derivedTotalQuestions, derivedCorrectCount),
    correct_count: derivedCorrectCount,
    total_questions: derivedTotalQuestions,
    time_taken_seconds: Number.isFinite(Number(att.time_taken_seconds))
      ? Math.max(0, Math.floor(Number(att.time_taken_seconds)))
      : att.created_at && att.completed_at
        ? Math.max(0, Math.floor((new Date(att.completed_at).getTime() - new Date(att.created_at).getTime()) / 1000))
        : null,
    answers,
  };
}

async function recordQuizAttempt(opts) {
  return finishQuizAttempt(opts);
}

async function listDocumentsRecent(limit) {
  const [rows] = await getPool().execute(
    `SELECT d.document_id, d.title, d.file_url, d.course_id, d.uploader_id, d.created_at,
      (SELECT COUNT(*) FROM document_segments s WHERE s.document_id = d.document_id) AS chunk_count
     FROM documents d
     ORDER BY d.created_at DESC
     LIMIT ?`,
    [limit]
  );
  return rows;
}

function normalizeQuestionInput(q) {
  if (!q || typeof q !== "object") return null;
  const questionText = String(q.question ?? q.question_text ?? "").trim();
  if (!questionText) return null;
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
  let cor = q.correct_answer ?? q.correctAnswer;
  if (typeof cor === "number" && cor >= 0 && cor <= 3) {
    cor = ["A", "B", "C", "D"][cor];
  }
  const correct = String(cor || "A").toUpperCase().trim().slice(0, 1) || "A";
  return { question: questionText, options: opts, correct_answer: correct };
}

async function insertQuizQuestion(quizId, q) {
  const norm = normalizeQuestionInput(q);
  if (!norm) return;
  const opts = norm.options || {};
  const letters = ["A", "B", "C", "D"];
  const [a, b, c, d] = letters.map((L) => trunc255(opts[L]));
  const correct = String(norm.correct_answer || "A").toUpperCase().trim().slice(0, 1) || "A";
  await getPool().execute(
    `INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_answer)
     VALUES (?,?,?,?,?,?,?)`,
    [quizId, norm.question, a, b, c, d, correct]
  );
}

async function saveQuizWithQuestions({ title, courseId, createdBy, questions, sourceFileUrl, documentId }) {
  const p = getPool();
  const vals = [trunc255(title || "Quiz"), parseOptionalInt(courseId), parseOptionalInt(createdBy)];
  const src =
    sourceFileUrl != null && String(sourceFileUrl).trim()
      ? String(sourceFileUrl).trim().slice(0, 512)
      : null;
  const did = parseOptionalInt(documentId);

  const insertAttempts = [
    {
      sql: `INSERT INTO quizzes (title, course_id, created_by, is_published, source_file_url, document_id) VALUES (?,?,?,0,?,?)`,
      params: [...vals, src, did],
    },
    {
      sql: `INSERT INTO quizzes (title, course_id, created_by, is_published, source_file_url) VALUES (?,?,?,0,?)`,
      params: [...vals, src],
    },
    {
      sql: `INSERT INTO quizzes (title, course_id, created_by, is_published) VALUES (?,?,?,0)`,
      params: [...vals],
    },
    {
      sql: `INSERT INTO quizzes (title, course_id, created_by) VALUES (?,?,?)`,
      params: [...vals],
    },
  ];

  let hdr;
  let lastErr = null;
  for (const a of insertAttempts) {
    try {
      [hdr] = await p.execute(a.sql, a.params);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    }
  }
  if (!hdr) throw lastErr || new Error("Could not insert into quizzes.");
  const quizId = hdr.insertId;
  for (const q of questions) {
    await insertQuizQuestion(quizId, q);
  }
  return quizId;
}

async function getQuizWithQuestions(quizId) {
  const p = getPool();
  const id = Number(quizId);
  if (!Number.isFinite(id)) return null;
  const [quizzes] = await p.execute(`SELECT * FROM quizzes WHERE quiz_id = ? LIMIT 1`, [id]);
  if (!quizzes.length) return null;
  const [questions] = await p.execute(
    `SELECT question_id, question_text, option_a, option_b, option_c, option_d, correct_answer
     FROM quiz_questions WHERE quiz_id = ? ORDER BY question_id ASC`,
    [id]
  );
  return { ...quizzes[0], questions };
}

function rowsToMap(rows, keyField, valueField) {
  const m = new Map();
  for (const r of rows || []) {
    const k = Number(r[keyField]);
    if (Number.isFinite(k)) m.set(k, Number(r[valueField] || 0));
  }
  return m;
}

/**
 * Learning progress per course: documents + completed quiz_attempts.
 * A document counts as "done" when the user has at least one completed attempt for a quiz
 * linked via quiz.document_id or quiz.source_file_url = documents.file_url.
 */
async function getLearningProgressSummary(userId) {
  const p = getPool();
  let uid = parseOptionalUserId(userId);
  if (typeof uid === "string") {
    const [uRows] = await p.execute(
      `SELECT user_id FROM users
       WHERE user_code = ? OR LOWER(email) = LOWER(?) OR CAST(user_id AS CHAR) = ?
       LIMIT 1`,
      [uid, uid, uid]
    );
    if (Array.isArray(uRows) && uRows.length > 0) {
      const resolved = Number(uRows[0].user_id);
      if (Number.isFinite(resolved)) uid = resolved;
    }
  }

  const [[studyTimeRow]] = await p.execute(
    `SELECT
       SUM(
         CASE
           WHEN time_taken_seconds IS NOT NULL AND time_taken_seconds >= 0 THEN time_taken_seconds
           WHEN completed_at IS NOT NULL AND created_at IS NOT NULL THEN GREATEST(TIMESTAMPDIFF(SECOND, created_at, completed_at), 0)
           ELSE 0
         END
       ) AS total_seconds
     FROM quiz_attempts
     WHERE (user_id <=> ?)`,
    [uid]
  );
  const totalStudySeconds = Math.max(0, Number(studyTimeRow?.total_seconds || 0));
  const studyHoursLabel = (() => {
    if (totalStudySeconds <= 0) return null;
    const hours = Math.floor(totalStudySeconds / 3600);
    const mins = Math.floor((totalStudySeconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  })();

  const [courseIdRows] = await p.execute(
    `SELECT DISTINCT x.cid AS course_id FROM (
       SELECT course_id AS cid FROM documents WHERE course_id IS NOT NULL
       UNION
       SELECT course_id AS cid FROM quizzes WHERE course_id IS NOT NULL
     ) x
     WHERE x.cid IS NOT NULL
     ORDER BY x.cid ASC`
  );
  const courseIds = courseIdRows
    .map((r) => Number(r.course_id))
    .filter((n) => Number.isFinite(n));
  if (!courseIds.length) {
    const [streakRows] = await p.execute(
      `SELECT DISTINCT DATE_FORMAT(COALESCE(completed_at, created_at), '%Y-%m-%d') AS d
       FROM quiz_attempts
       WHERE COALESCE(completed_at, created_at) IS NOT NULL
         AND (user_id <=> ?)
       ORDER BY d DESC`,
      [uid]
    );
    const isoDates = streakRows.map((r) => String(r.d || "").slice(0, 10)).filter(Boolean);
    const dateSet = new Set(isoDates);
    const sortedAsc = [...isoDates].sort();
    const localYmd = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };
    const computeCurrentStreakLocal = (dates) => {
      const today = new Date();
      let d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const key = (dt) => localYmd(dt);
      if (!dates.has(key(d))) d.setDate(d.getDate() - 1);
      if (!dates.has(key(d))) return 0;
      let n = 0;
      while (dates.has(key(d))) {
        n += 1;
        d.setDate(d.getDate() - 1);
      }
      return n;
    };
    const computeLongestStreak = (datesAsc) => {
      if (!datesAsc.length) return 0;
      let best = 1;
      let run = 1;
      for (let i = 1; i < datesAsc.length; i += 1) {
        const prev = new Date(`${datesAsc[i - 1]}T12:00:00Z`);
        const cur = new Date(`${datesAsc[i]}T12:00:00Z`);
        const diff = (cur - prev) / 86400000;
        if (diff === 1) {
          run += 1;
          best = Math.max(best, run);
        } else if (diff > 1) {
          run = 1;
        }
      }
      return best;
    };
    const streak = {
      currentDays: computeCurrentStreakLocal(dateSet),
      longestDays: computeLongestStreak(sortedAsc),
    };
    return {
      overall: {
        progressPercent: 0,
        completedMaterials: 0,
        totalMaterials: 0,
        averageScorePercent: null,
        studyHoursLabel,
      },
      courses: [],
      streak,
    };
  }

  let courseMeta = new Map();
  try {
    const placeholders = courseIds.map(() => "?").join(",");
    const [metaRows] = await p.execute(
      `SELECT course_id, course_code FROM courses WHERE course_id IN (${placeholders})`,
      courseIds
    );
    for (const r of metaRows) {
      courseMeta.set(Number(r.course_id), {
        courseId: Number(r.course_id),
        code: String(r.course_code || "").trim() || `C${r.course_id}`,
        name: String(r.course_code || "").trim() || `Course ${r.course_id}`,
      });
    }
  } catch (e) {
    console.warn("getLearningProgressSummary courses:", e.message);
  }
  for (const cid of courseIds) {
    if (!courseMeta.has(cid)) {
      courseMeta.set(cid, { courseId: cid, code: `C${cid}`, name: `Course ${cid}` });
    }
  }

  const [docCountRows] = await p.execute(
    `SELECT course_id, COUNT(*) AS n FROM documents WHERE course_id IS NOT NULL GROUP BY course_id`
  );
  const docTotalByCourse = rowsToMap(docCountRows, "course_id", "n");

  let doneDocRows;
  try {
    [doneDocRows] = await p.execute(
      `SELECT d.course_id, COUNT(DISTINCT d.document_id) AS n
       FROM documents d
       INNER JOIN quizzes q ON (
         q.document_id = d.document_id
         OR (
           q.source_file_url IS NOT NULL
           AND TRIM(q.source_file_url) <> ''
           AND q.source_file_url = d.file_url
         )
       )
       INNER JOIN quiz_attempts qa ON qa.quiz_id = q.quiz_id
       WHERE d.course_id IS NOT NULL
         AND qa.completed_at IS NOT NULL
         AND (qa.user_id <=> ?)
       GROUP BY d.course_id`,
      [uid]
    );
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      [doneDocRows] = await p.execute(
        `SELECT d.course_id, COUNT(DISTINCT d.document_id) AS n
         FROM documents d
         INNER JOIN quizzes q ON q.document_id = d.document_id
         INNER JOIN quiz_attempts qa ON qa.quiz_id = q.quiz_id
         WHERE d.course_id IS NOT NULL
           AND qa.completed_at IS NOT NULL
           AND (qa.user_id <=> ?)
         GROUP BY d.course_id`,
        [uid]
      );
    } else {
      throw e;
    }
  }
  const docDoneByCourse = rowsToMap(doneDocRows, "course_id", "n");

  let pubQuizRows;
  try {
    [pubQuizRows] = await p.execute(
      `SELECT course_id, COUNT(*) AS n FROM quizzes
       WHERE course_id IS NOT NULL AND is_published = 1
       GROUP BY course_id`
    );
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      [pubQuizRows] = await p.execute(
        `SELECT course_id, COUNT(*) AS n FROM quizzes WHERE course_id IS NOT NULL GROUP BY course_id`
      );
    } else {
      throw e;
    }
  }
  const pubQuizTotalByCourse = rowsToMap(pubQuizRows, "course_id", "n");

  const [doneQuizRows] = await p.execute(
    `SELECT q.course_id, COUNT(DISTINCT qa.quiz_id) AS n
     FROM quiz_attempts qa
     INNER JOIN quizzes q ON q.quiz_id = qa.quiz_id
     WHERE q.course_id IS NOT NULL
       AND qa.completed_at IS NOT NULL
       AND (qa.user_id <=> ?)
     GROUP BY q.course_id`,
    [uid]
  );
  const quizDoneByCourse = rowsToMap(doneQuizRows, "course_id", "n");

  const [attemptRows] = await p.execute(
    `SELECT q.course_id, qa.score,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.quiz_id) AS question_count
     FROM quiz_attempts qa
     INNER JOIN quizzes q ON q.quiz_id = qa.quiz_id
     WHERE qa.completed_at IS NOT NULL AND (qa.user_id <=> ?)`,
    [uid]
  );

  const scorePercentsByCourse = new Map();
  const lastAtByCourse = new Map();
  for (const row of attemptRows) {
    const cid = Number(row.course_id);
    if (!Number.isFinite(cid)) continue;
    const pct = scoreToPercent(row.score, row.question_count);
    if (pct != null) {
      if (!scorePercentsByCourse.has(cid)) scorePercentsByCourse.set(cid, []);
      scorePercentsByCourse.get(cid).push(pct);
    }
  }

  const [lastRows] = await p.execute(
    `SELECT q.course_id, MAX(qa.completed_at) AS last_at
     FROM quiz_attempts qa
     INNER JOIN quizzes q ON q.quiz_id = qa.quiz_id
     WHERE qa.completed_at IS NOT NULL AND (qa.user_id <=> ?)
     GROUP BY q.course_id`,
    [uid]
  );
  for (const r of lastRows) {
    const cid = Number(r.course_id);
    if (Number.isFinite(cid)) lastAtByCourse.set(cid, r.last_at);
  }

  const allPercents = [];
  for (const arr of scorePercentsByCourse.values()) allPercents.push(...arr);

  let sumCompleted = 0;
  let sumTotal = 0;
  const courses = [];

  for (const cid of courseIds) {
    const meta = courseMeta.get(cid);
    const docTotal = docTotalByCourse.get(cid) || 0;
    const docDone = docDoneByCourse.get(cid) || 0;
    let totalMaterials;
    let completedMaterials;
    let progressPercent;
    if (docTotal > 0) {
      totalMaterials = docTotal;
      completedMaterials = Math.min(docDone, docTotal);
      progressPercent = Math.round((100 * completedMaterials) / totalMaterials);
    } else {
      totalMaterials = pubQuizTotalByCourse.get(cid) || 0;
      if (totalMaterials > 0) {
        completedMaterials = Math.min(quizDoneByCourse.get(cid) || 0, totalMaterials);
        progressPercent = Math.round((100 * completedMaterials) / totalMaterials);
      } else {
        completedMaterials = 0;
        progressPercent = 0;
      }
    }

    const pcts = scorePercentsByCourse.get(cid) || [];
    const quizScore =
      pcts.length > 0 ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;

    const lastAt = lastAtByCourse.get(cid) || null;

    sumCompleted += completedMaterials;
    sumTotal += totalMaterials;

    courses.push({
      courseId: cid,
      name: meta.name,
      code: meta.code,
      progressPercent,
      totalMaterials,
      completedMaterials,
      quizScorePercent: quizScore,
      lastActivityAt: lastAt ? new Date(lastAt).toISOString() : null,
    });
  }

  const overallProgress =
    sumTotal > 0 ? Math.round((100 * sumCompleted) / sumTotal) : 0;
  const averageScorePercent =
    allPercents.length > 0
      ? Math.round(allPercents.reduce((a, b) => a + b, 0) / allPercents.length)
      : null;

  const [dateRows] = await p.execute(
    `SELECT DISTINCT DATE_FORMAT(COALESCE(completed_at, created_at), '%Y-%m-%d') AS d
     FROM quiz_attempts
     WHERE COALESCE(completed_at, created_at) IS NOT NULL
       AND (user_id <=> ?)
     ORDER BY d DESC`,
    [uid]
  );
  function ymdLocalFromDate(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  const isoDates = dateRows.map((r) => {
    const x = r.d;
    if (x instanceof Date) return ymdLocalFromDate(x);
    const s = String(x);
    return s.length >= 10 ? s.slice(0, 10) : s;
  });

  function computeLongestStreak(sortedAsc) {
    if (!sortedAsc.length) return 0;
    let best = 1;
    let run = 1;
    for (let i = 1; i < sortedAsc.length; i += 1) {
      const prev = new Date(sortedAsc[i - 1] + "T12:00:00Z");
      const cur = new Date(sortedAsc[i] + "T12:00:00Z");
      const diff = (cur - prev) / 86400000;
      if (diff === 1) {
        run += 1;
        best = Math.max(best, run);
      } else if (diff > 1) {
        run = 1;
      }
    }
    return best;
  }

  function localYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /** Current streak uses local calendar days — avoids UTC skew from toISOString(). */
  function computeCurrentStreakLocal(datesSet) {
    const today = new Date();
    let d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const key = (dt) => localYmd(dt);
    if (!datesSet.has(key(d))) {
      d.setDate(d.getDate() - 1);
    }
    if (!datesSet.has(key(d))) return 0;
    let n = 0;
    while (datesSet.has(key(d))) {
      n += 1;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }

  const dateSet = new Set(isoDates);
  const sortedAsc = [...isoDates].sort();
  const streak = {
    currentDays: computeCurrentStreakLocal(dateSet),
    longestDays: computeLongestStreak(sortedAsc),
  };

  return {
    overall: {
      progressPercent: overallProgress,
      completedMaterials: sumCompleted,
      totalMaterials: sumTotal,
      averageScorePercent,
      studyHoursLabel,
    },
    courses,
    streak,
  };
}

module.exports = {
  isConfigured,
  initDb,
  getPool,
  upsertDocument,
  ensureDocumentStub,
  deleteChunksByDocumentId,
  insertSegment,
  insertChunk,
  getDocumentIdByS3Key,
  countAttemptsBySourceFileUrls,
  countChunksByS3Key,
  getConcatenatedChunksByS3Key,
  listSegmentsByS3Key,
  getDocumentById,
  listSegmentsByDocumentId,
  hasCompleteEmbeddingsForS3Key,
  getMetaMapForS3Keys,
  listDocumentsRecent,
  saveQuizWithQuestions,
  insertQuizQuestion,
  getQuizWithQuestions,
  listQuizHistory,
  listPublishedQuizzes,
  startQuizAttempt,
  finishQuizAttempt,
  finishQuizAttemptWithAnswers,
  listCompletedAttempts,
  getAttemptResultDetail,
  recordQuizAttempt,
  scoreToPercent,
  getUserRole,
  findUserByEmail,
  createUser,
  updateUserPassword,
  canUserManageQuiz,
  replaceQuizQuestions,
  updateQuizTitle,
  setQuizPublished,
  quizRowIsPublished,
  normalizeQuestionInput,
  getLearningProgressSummary,
};
