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

async function ensureUserProfileColumns() {
  const p = getPool();
  const stmts = [
    "ALTER TABLE users ADD COLUMN department VARCHAR(255) NULL DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN bio TEXT NULL",
  ];
  for (const sql of stmts) {
    try {
      await p.execute(sql);
    } catch (e) {
      if (e.code !== "ER_DUP_FIELDNAME") {
        console.warn("ensureUserProfileColumns:", e.message);
      }
    }
  }
}

/** User-entered description at upload time; used e.g. for document preview UI. */
async function ensureDocumentDescriptionColumn() {
  const p = getPool();
  try {
    const [[row]] = await p.execute(
      `SELECT COUNT(*) AS c FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'documents'`
    );
    if (Number(row?.c) < 1) return;
    await p.execute(
      "ALTER TABLE documents ADD COLUMN description TEXT NULL DEFAULT NULL"
    );
  } catch (e) {
    if (e.code !== "ER_DUP_FIELDNAME") {
      console.warn("ensureDocumentDescriptionColumn:", e.message);
    }
  }
}

/** Upload form "Document Type" (e.g. general major, specialized) — filter list by this, not by course code. */
async function ensureDocumentCategoryColumn() {
  const p = getPool();
  try {
    const [[row]] = await p.execute(
      `SELECT COUNT(*) AS c FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'documents'`
    );
    if (Number(row?.c) < 1) return;
    await p.execute(
      "ALTER TABLE documents ADD COLUMN category VARCHAR(128) NULL DEFAULT NULL"
    );
  } catch (e) {
    if (e.code !== "ER_DUP_FIELDNAME") {
      console.warn("ensureDocumentCategoryColumn:", e.message);
    }
  }
}

async function ensureDocumentDownloadCountColumn() {
  const p = getPool();
  try {
    const [[row]] = await p.execute(
      `SELECT COUNT(*) AS c FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'documents'`
    );
    if (Number(row?.c) < 1) return;
    await p.execute(
      "ALTER TABLE documents ADD COLUMN download_count INT NOT NULL DEFAULT 0"
    );
  } catch (e) {
    if (e.code !== "ER_DUP_FIELDNAME") {
      console.warn("ensureDocumentDownloadCountColumn:", e.message);
    }
  }
}

/** Threaded discussion on course materials (by document_id or S3 key). */
async function ensureDocumentCommentsTable() {
  const p = getPool();
  try {
    const [[row]] = await p.execute(
      `SELECT COUNT(*) AS c FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'documents'`
    );
    if (Number(row?.c) < 1) return;
    await p.execute(
      `CREATE TABLE IF NOT EXISTS document_comments (
        comment_id INT AUTO_INCREMENT PRIMARY KEY,
        document_id INT NULL DEFAULT NULL,
        file_url VARCHAR(512) NULL DEFAULT NULL,
        user_id INT NOT NULL,
        body TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_document_comments_doc (document_id),
        KEY idx_document_comments_file (file_url(191)),
        KEY idx_document_comments_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    );
  } catch (e) {
    console.warn("ensureDocumentCommentsTable:", e.message);
  }
}

/** Minimal `courses` table so uploads can resolve `documents.course_id` from course code. */
async function ensureCoursesTable() {
  const p = getPool();
  try {
    await p.execute(
      `CREATE TABLE IF NOT EXISTS courses (
        course_id INT AUTO_INCREMENT PRIMARY KEY,
        course_code VARCHAR(64) NOT NULL,
        course_name VARCHAR(255) NULL DEFAULT NULL,
        UNIQUE KEY uk_courses_code (course_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    );
  } catch (e) {
    console.warn("ensureCoursesTable:", e.message);
  }
}

async function initDb() {
  const p = getPool();
  await p.execute("SELECT 1");
  try {
    await ensureCoursesTable();
  } catch (e) {
    console.warn("ensureCoursesTable (init):", e.message);
  }
  try {
    await ensureQuizLifecycleColumns();
  } catch (e) {
    console.warn("ensureQuizLifecycleColumns (init):", e.message);
  }
  try {
    await ensureUserProfileColumns();
  } catch (e) {
    console.warn("ensureUserProfileColumns (init):", e.message);
  }
  try {
    await ensureDocumentDescriptionColumn();
  } catch (e) {
    console.warn("ensureDocumentDescriptionColumn (init):", e.message);
  }
  try {
    await ensureDocumentCategoryColumn();
  } catch (e) {
    console.warn("ensureDocumentCategoryColumn (init):", e.message);
  }
  try {
    await ensureDocumentDownloadCountColumn();
  } catch (e) {
    console.warn("ensureDocumentDownloadCountColumn (init):", e.message);
  }
  try {
    await ensureDocumentCommentsTable();
  } catch (e) {
    console.warn("ensureDocumentCommentsTable (init):", e.message);
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

function trunc128(s) {
  const t = String(s ?? "").trim();
  if (t.length <= 128) return t;
  return `${t.slice(0, 125)}...`;
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
 * Resolve `courses.course_id` from an upload "course code" (subjectCode). Creates a row if missing.
 * @param {string} courseCode
 * @param {string} [courseName]
 * @returns {Promise<number|null>}
 */
async function findOrCreateCourseIdByCode(courseCode, courseName) {
  const code = String(courseCode || "").trim();
  if (!code) return null;
  const p = getPool();
  const norm = code.toUpperCase();

  const selectId = async () => {
    const [rows] = await p.execute(
      "SELECT course_id FROM courses WHERE UPPER(TRIM(course_code)) = ? LIMIT 1",
      [norm]
    );
    return rows.length ? rows[0].course_id : null;
  };

  let id = await selectId();
  if (id != null) return id;

  const name = String(courseName || "").trim() || code;
  try {
    const [hdr] = await p.execute("INSERT INTO courses (course_code, course_name) VALUES (?, ?)", [code, name]);
    return hdr.insertId;
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) {
      id = await selectId();
      if (id != null) return id;
    }
    if (e.code === "ER_BAD_FIELD_ERROR") {
      try {
        const [hdr] = await p.execute("INSERT INTO courses (course_code) VALUES (?)", [code]);
        return hdr.insertId;
      } catch (e2) {
        if (e2.code === "ER_DUP_ENTRY" || e2.errno === 1062) {
          id = await selectId();
          if (id != null) return id;
        }
        throw e2;
      }
    } else {
      throw e;
    }
  }
  return null;
}

/**
 * @param {object} row
 * @param {string} row.s3Key - stored in documents.file_url
 * @param {string} row.title
 * @param {number|string|null} [row.courseId]
 * @param {number|string|null} [row.uploaderId]
 * @param {string|null|undefined} [row.description] - optional user description (upload form)
 * @param {string|null|undefined} [row.category] - document type from upload (e.g. general major, specialized)
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
  const descRaw = row.description != null ? String(row.description).trim() : null;
  const description = descRaw === "" ? null : descRaw;
  const catRaw = row.category != null ? trunc128(String(row.category)) : null;
  const category = catRaw === "" || catRaw == null ? null : catRaw;

  if (existing.length) {
    const id = existing[0].document_id;
    try {
      await p.execute(
        `UPDATE documents SET title = ?, version = IFNULL(version, 0) + 1,
          course_id = COALESCE(?, course_id), uploader_id = COALESCE(?, uploader_id),
          description = ?, category = ?
         WHERE document_id = ?`,
        [title, courseId, uploaderId, description, category, id]
      );
    } catch (e) {
      if (e.code === "ER_BAD_FIELD_ERROR") {
        try {
          await p.execute(
            `UPDATE documents SET title = ?, version = IFNULL(version, 0) + 1,
              course_id = COALESCE(?, course_id), uploader_id = COALESCE(?, uploader_id),
              description = ?
             WHERE document_id = ?`,
            [title, courseId, uploaderId, description, id]
          );
        } catch (e2) {
          if (e2.code === "ER_BAD_FIELD_ERROR") {
            await p.execute(
              `UPDATE documents SET title = ?, version = IFNULL(version, 0) + 1,
                course_id = COALESCE(?, course_id), uploader_id = COALESCE(?, uploader_id)
               WHERE document_id = ?`,
              [title, courseId, uploaderId, id]
            );
          } else {
            throw e2;
          }
        }
      } else {
        throw e;
      }
    }
    return id;
  }

  try {
    const [hdr] = await p.execute(
      `INSERT INTO documents (title, course_id, uploader_id, file_url, version, description, category)
       VALUES (?,?,?,?,1,?,?)`,
      [title, courseId, uploaderId, key, description, category]
    );
    return hdr.insertId;
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      try {
        const [hdr] = await p.execute(
          `INSERT INTO documents (title, course_id, uploader_id, file_url, version, description)
           VALUES (?,?,?,?,1,?)`,
          [title, courseId, uploaderId, key, description]
        );
        return hdr.insertId;
      } catch (e2) {
        if (e2.code === "ER_BAD_FIELD_ERROR") {
          const [hdr] = await p.execute(
            `INSERT INTO documents (title, course_id, uploader_id, file_url, version)
             VALUES (?,?,?,?,1)`,
            [title, courseId, uploaderId, key]
          );
          return hdr.insertId;
        }
        throw e2;
      }
    }
    throw e;
  }
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

async function listDocumentComments({ documentId, s3Key }) {
  let pid = parseOptionalInt(documentId);
  const key = String(s3Key || "").trim();
  if (pid == null && key) {
    pid = await getDocumentIdByS3Key(key);
  }
  const p = getPool();
  try {
    if (pid != null) {
      const [rows] = await p.execute(
        `SELECT c.comment_id, c.body, c.created_at, u.name AS author_name, u.role AS author_role
         FROM document_comments c
         INNER JOIN users u ON u.user_id = c.user_id
         WHERE c.document_id = ?
         ORDER BY c.created_at ASC`,
        [pid]
      );
      return rows;
    }
    if (key) {
      const [rows] = await p.execute(
        `SELECT c.comment_id, c.body, c.created_at, u.name AS author_name, u.role AS author_role
         FROM document_comments c
         INNER JOIN users u ON u.user_id = c.user_id
         WHERE c.file_url = ?
         ORDER BY c.created_at ASC`,
        [key]
      );
      return rows;
    }
    return [];
  } catch (e) {
    if (e.code === "ER_NO_SUCH_TABLE") return [];
    throw e;
  }
}

async function insertDocumentComment({ documentId, s3Key, userId, body }) {
  const uid = parseOptionalInt(userId);
  if (uid == null) throw new Error("Invalid user id.");
  const text = String(body || "").trim();
  if (!text) throw new Error("Empty comment.");
  let docId = parseOptionalInt(documentId);
  const key = String(s3Key || "").trim();
  if (docId == null && key) {
    docId = await getDocumentIdByS3Key(key);
  }
  const fileUrlVal = docId != null ? null : key || null;
  if (docId == null && !fileUrlVal) {
    throw new Error("Missing document reference.");
  }
  await getPool().execute(
    `INSERT INTO document_comments (document_id, file_url, user_id, body) VALUES (?,?,?,?)`,
    [docId, fileUrlVal, uid, text]
  );
}

/**
 * Canonical S3 object key for matching `documents.file_url` to ListObjects keys.
 * Strips `https://bucket.s3.../` so DB full URLs still match relative keys.
 */
function normalizeDocumentKeyForLookup(stored) {
  const s = String(stored || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    } catch {
      return s;
    }
  }
  return s;
}

/** Duplicate map entries under normalized keys so lookups by path or URL both work. */
function expandMapWithNormalizedKeys(m) {
  if (!(m instanceof Map)) return m;
  const out = new Map(m);
  for (const [k, v] of m) {
    const nk = normalizeDocumentKeyForLookup(k);
    if (nk && nk !== k && !out.has(nk)) out.set(nk, v);
  }
  return out;
}

async function incrementDocumentDownloadCountByDocumentId(documentId) {
  const id = parseOptionalInt(documentId);
  if (id == null) return;
  try {
    await getPool().execute(
      `UPDATE documents SET download_count = IFNULL(download_count, 0) + 1 WHERE document_id = ?`,
      [id]
    );
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR" || e.code === "ER_NO_SUCH_TABLE") return;
    throw e;
  }
}

async function incrementDocumentDownloadCountByS3Key(s3Key) {
  const k = String(s3Key || "").trim();
  if (!k) return;
  let id = await getDocumentIdByS3Key(k);
  if (id == null) {
    const nk = normalizeDocumentKeyForLookup(k);
    if (nk && nk !== k) id = await getDocumentIdByS3Key(nk);
  }
  if (id != null) await incrementDocumentDownloadCountByDocumentId(id);
}

/**
 * Comment counts per S3 list key. Matches by normalized path (DB may store full S3 URL, list uses object key).
 * Posts with `document_id` store `comment.file_url` as NULL — must join `documents`, not filter only IN (?).
 */
async function countCommentsByDocumentFileUrls(s3Keys) {
  const uniq = [...new Set((s3Keys || []).map((k) => String(k || "").trim()).filter(Boolean))];
  if (!uniq.length) return new Map();
  const p = getPool();
  const m = new Map();

  const matchKeyToUniq = (storedUrlOrKey, count) => {
    const k = storedUrlOrKey != null ? String(storedUrlOrKey).trim() : "";
    if (!k) return;
    const nk = normalizeDocumentKeyForLookup(k);
    const n = Number(count || 0);
    for (const key of uniq) {
      if (k === key || nk === normalizeDocumentKeyForLookup(key)) {
        m.set(key, (m.get(key) || 0) + n);
        return;
      }
    }
  };

  try {
    const [rows] = await p.execute(
      `SELECT d.file_url AS k, COUNT(DISTINCT c.comment_id) AS n
       FROM document_comments c
       INNER JOIN documents d ON d.document_id = c.document_id
       WHERE c.document_id IS NOT NULL
       GROUP BY d.document_id, d.file_url`
    );
    for (const r of rows) {
      if (r.k == null || r.k === "") continue;
      matchKeyToUniq(String(r.k), Number(r.n || 0));
    }
  } catch (e) {
    if (e.code !== "ER_NO_SUCH_TABLE") console.warn("countCommentsByDocumentFileUrls (join):", e.message);
  }

  try {
    const [rows2] = await p.execute(
      `SELECT c.file_url AS k, COUNT(*) AS n
       FROM document_comments c
       WHERE c.document_id IS NULL AND c.file_url IS NOT NULL AND TRIM(c.file_url) <> ''
       GROUP BY c.file_url`
    );
    for (const r of rows2) {
      if (!r.k) continue;
      matchKeyToUniq(String(r.k), Number(r.n || 0));
    }
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR" && e.code !== "ER_NO_SUCH_TABLE") {
      console.warn("countCommentsByDocumentFileUrls (file_url):", e.message);
    }
  }

  return expandMapWithNormalizedKeys(m);
}

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
    return expandMapWithNormalizedKeys(m);
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
        return expandMapWithNormalizedKeys(m);
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
  const p = getPool();
  try {
    const [rows] = await p.execute(
      `SELECT document_id, title, file_url, course_id, uploader_id, created_at, description, category
       FROM documents WHERE document_id = ? LIMIT 1`,
      [id]
    );
    return rows.length ? rows[0] : null;
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      try {
        const [rows] = await p.execute(
          `SELECT document_id, title, file_url, course_id, uploader_id, created_at, description
           FROM documents WHERE document_id = ? LIMIT 1`,
          [id]
        );
        return rows.length ? rows[0] : null;
      } catch (e2) {
        if (e2.code === "ER_BAD_FIELD_ERROR") {
          const [rows] = await p.execute(
            `SELECT document_id, title, file_url, course_id, uploader_id, created_at
             FROM documents WHERE document_id = ? LIMIT 1`,
            [id]
          );
          return rows.length ? rows[0] : null;
        }
        throw e2;
      }
    }
    throw e;
  }
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
  let docs;
  try {
    const [r] = await p.execute(
      `SELECT d.document_id, d.title, d.file_url, d.course_id, d.uploader_id, d.created_at,
        IFNULL(d.download_count, 0) AS download_count,
        d.description, d.category,
        c.course_code,
        u.name AS uploader_name,
        u.role AS uploader_role,
        (SELECT COUNT(*) FROM document_segments s WHERE s.document_id = d.document_id) AS chunk_count
       FROM documents d
       LEFT JOIN courses c ON c.course_id = d.course_id
       LEFT JOIN users u ON u.user_id = d.uploader_id
       WHERE d.file_url IN (${placeholders})`,
      keys
    );
    docs = r;
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      try {
        const [r] = await p.execute(
          `SELECT d.document_id, d.title, d.file_url, d.course_id, d.uploader_id, d.created_at,
            IFNULL(d.download_count, 0) AS download_count,
            d.description,
            c.course_code,
            u.name AS uploader_name,
            u.role AS uploader_role,
            (SELECT COUNT(*) FROM document_segments s WHERE s.document_id = d.document_id) AS chunk_count
           FROM documents d
           LEFT JOIN courses c ON c.course_id = d.course_id
           LEFT JOIN users u ON u.user_id = d.uploader_id
           WHERE d.file_url IN (${placeholders})`,
          keys
        );
        docs = r;
      } catch (e2) {
        if (e2.code === "ER_BAD_FIELD_ERROR") {
          const [r] = await p.execute(
            `SELECT d.document_id, d.title, d.file_url, d.course_id, d.uploader_id, d.created_at,
              IFNULL(d.download_count, 0) AS download_count,
              c.course_code,
              u.name AS uploader_name,
              u.role AS uploader_role,
              (SELECT COUNT(*) FROM document_segments s WHERE s.document_id = d.document_id) AS chunk_count
             FROM documents d
             LEFT JOIN courses c ON c.course_id = d.course_id
             LEFT JOIN users u ON u.user_id = d.uploader_id
             WHERE d.file_url IN (${placeholders})`,
            keys
          );
          docs = r;
        } else {
          throw e2;
        }
      }
    } else {
      throw e;
    }
  }
  const m = new Map();
  for (const d of docs) {
    m.set(d.file_url, d);
    const nk0 = normalizeDocumentKeyForLookup(d.file_url);
    if (nk0 && nk0 !== d.file_url) m.set(nk0, d);
  }
  const missing = keys.filter((k) => k && !m.has(k) && !m.has(normalizeDocumentKeyForLookup(k)));
  if (missing.length) {
    try {
      let extra;
      try {
        const [r] = await p.execute(
          `SELECT d.document_id, d.title, d.file_url, d.course_id, d.uploader_id, d.created_at,
            IFNULL(d.download_count, 0) AS download_count,
            d.description, d.category,
            c.course_code,
            u.name AS uploader_name,
            u.role AS uploader_role,
            (SELECT COUNT(*) FROM document_segments s WHERE s.document_id = d.document_id) AS chunk_count
           FROM documents d
           LEFT JOIN courses c ON c.course_id = d.course_id
           LEFT JOIN users u ON u.user_id = d.uploader_id
           WHERE EXISTS (SELECT 1 FROM document_segments s WHERE s.document_id = d.document_id)
           ORDER BY d.document_id DESC
           LIMIT 4000`
        );
        extra = r;
      } catch (e0) {
        if (e0.code === "ER_BAD_FIELD_ERROR") {
          const [r] = await p.execute(
            `SELECT d.document_id, d.title, d.file_url, d.course_id, d.uploader_id, d.created_at,
              IFNULL(d.download_count, 0) AS download_count,
              c.course_code,
              u.name AS uploader_name,
              u.role AS uploader_role,
              (SELECT COUNT(*) FROM document_segments s WHERE s.document_id = d.document_id) AS chunk_count
             FROM documents d
             LEFT JOIN courses c ON c.course_id = d.course_id
             LEFT JOIN users u ON u.user_id = d.uploader_id
             WHERE EXISTS (SELECT 1 FROM document_segments s WHERE s.document_id = d.document_id)
             ORDER BY d.document_id DESC
             LIMIT 4000`
          );
          extra = r;
        } else {
          throw e0;
        }
      }
      const byNorm = new Map();
      for (const d of extra) {
        const n = normalizeDocumentKeyForLookup(d.file_url);
        if (n && !byNorm.has(n)) byNorm.set(n, d);
      }
      for (const k of missing) {
        const nk = normalizeDocumentKeyForLookup(k);
        const d = byNorm.get(nk) || byNorm.get(k);
        if (d) {
          m.set(k, d);
          m.set(d.file_url, d);
          m.set(nk, d);
        }
      }
    } catch (e) {
      console.warn("getMetaMapForS3Keys gap-fill:", e.message);
    }
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

async function listQuizHistory(limit = 20, userId = null, ownerOnly = false) {
  const p = getPool();
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const uid = parseOptionalInt(userId);

  const docCategoryLine = `      (SELECT dcat.category FROM documents dcat WHERE dcat.document_id = q.document_id LIMIT 1) AS document_category,
`;
  let sql = `
    SELECT q.quiz_id, q.title, q.created_at, q.published_at, q.is_published, q.source_file_url, q.document_id,
      c.course_code,
${docCategoryLine}      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.quiz_id) AS question_count,
      (SELECT COUNT(*) FROM quiz_attempts qa0 WHERE qa0.quiz_id = q.quiz_id) AS attempts_count,
      (SELECT qa.score FROM quiz_attempts qa WHERE qa.quiz_id = q.quiz_id AND qa.completed_at IS NOT NULL
       ORDER BY qa.completed_at DESC, qa.attempt_id DESC LIMIT 1) AS last_score,
      (SELECT qa.completed_at FROM quiz_attempts qa WHERE qa.quiz_id = q.quiz_id AND qa.completed_at IS NOT NULL
       ORDER BY qa.completed_at DESC, qa.attempt_id DESC LIMIT 1) AS last_completed_at
    FROM quizzes q
    LEFT JOIN courses c ON c.course_id = q.course_id
    WHERE (q.source_file_url IS NULL OR q.source_file_url NOT LIKE 'question-bank://%')
  `;
  const params = [];
  if (uid != null) {
    if (ownerOnly) {
      sql += ` AND q.created_by = ?`;
      params.push(uid);
    } else {
      sql += ` AND (q.created_by = ? OR EXISTS (
        SELECT 1 FROM quiz_attempts qa2 WHERE qa2.quiz_id = q.quiz_id AND qa2.user_id = ?)`;
      sql += `)`;
      params.push(uid, uid);
    }
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
    if (e.code === "ER_BAD_FIELD_ERROR" && String(e.sqlMessage || e.message).includes("category")) {
      const sqlNoCat = sql.replace(docCategoryLine, "");
      try {
        [rows] = await p.execute(sqlNoCat, params);
      } catch (e2) {
        if (e2.code === "ER_BAD_FIELD_ERROR" && String(e2.sqlMessage || e2.message).includes("is_published")) {
          const sqlLegacy = sqlNoCat.replace("q.created_at, q.is_published,", "q.created_at,");
          [rows] = await p.execute(sqlLegacy, params);
        } else throw e2;
      }
    } else if (e.code === "ER_BAD_FIELD_ERROR" && String(e.sqlMessage || e.message).includes("is_published")) {
      const sqlLegacy = sql.replace("q.created_at, q.is_published,", "q.created_at,");
      try {
        [rows] = await p.execute(sqlLegacy, params);
      } catch (e2) {
        if (e2.code === "ER_BAD_FIELD_ERROR" && String(e2.sqlMessage || e2.message).includes("category")) {
          const sqlLegacyNoCat = sqlLegacy.replace(docCategoryLine, "");
          [rows] = await p.execute(sqlLegacyNoCat, params);
        } else throw e2;
      }
    } else throw e;
  }
  return rows.map((row) => ({
    quizId: row.quiz_id,
    title: row.title,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    courseCode: row.course_code,
    documentCategory:
      row.document_category != null && String(row.document_category).trim() !== ""
        ? String(row.document_category).trim()
        : null,
    s3Key: row.source_file_url || "",
    documentId: row.document_id != null ? Number(row.document_id) : null,
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
  try {
    const [rows] = await p.execute(
      `SELECT user_id, email, role, user_code,
        COALESCE(NULLIF(name,''), NULLIF(full_name,''), '') AS display_name,
        password
       FROM users
       WHERE LOWER(email) = ?
       LIMIT 1`,
      [em]
    );
    return rows.length ? rows[0] : null;
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR" && String(e.sqlMessage || e.message).includes("full_name")) {
      const [rows] = await p.execute(
        `SELECT user_id, email, role, user_code,
          COALESCE(NULLIF(name,''), '') AS display_name,
          password
         FROM users
         WHERE LOWER(email) = ?
         LIMIT 1`,
        [em]
      );
      return rows.length ? rows[0] : null;
    }
    if (e.code === "ER_BAD_FIELD_ERROR" && String(e.sqlMessage || e.message).includes("user_code")) {
      const [rows] = await p.execute(
        `SELECT user_id, email, role,
          COALESCE(NULLIF(name,''), NULLIF(full_name,''), '') AS display_name,
          password
         FROM users
         WHERE LOWER(email) = ?
         LIMIT 1`,
        [em]
      );
      return rows.length ? rows[0] : null;
    }
    throw e;
  }
}

async function getUserById(userId) {
  const uid = parseOptionalInt(userId);
  if (uid == null) return null;
  const p = getPool();
  try {
    const [rows] = await p.execute(
      `SELECT user_id, email, role, user_code, name, created_at, department, bio
       FROM users WHERE user_id = ? LIMIT 1`,
      [uid]
    );
    return rows.length ? rows[0] : null;
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      const [rows] = await p.execute(
        `SELECT user_id, email, role, user_code, name, created_at FROM users WHERE user_id = ? LIMIT 1`,
        [uid]
      );
      return rows.length ? rows[0] : null;
    }
    throw e;
  }
}

async function updateUserProfile(userId, fields) {
  const uid = parseOptionalInt(userId);
  if (uid == null) throw new Error("Invalid user id.");
  /** Full name in UI maps only to `users.name` (no separate full_name column required). */
  const name = fields.name != null ? String(fields.name).trim() : null;
  const department = fields.department != null ? String(fields.department).trim() : null;
  const bio = fields.bio != null ? String(fields.bio) : null;

  const p = getPool();
  try {
    await p.execute(
      `UPDATE users SET name = COALESCE(?, name), department = ?, bio = ? WHERE user_id = ?`,
      [name, department, bio, uid]
    );
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      try {
        await p.execute(`UPDATE users SET name = COALESCE(?, name) WHERE user_id = ?`, [name, uid]);
      } catch (e2) {
        throw e2;
      }
    } else {
      throw e;
    }
  }
}

async function createUser({ name, fullName, email, password, role, userCode }) {
  const em = String(email || "").trim().toLowerCase();
  if (!em) throw new Error("Invalid email.");
  const r = String(role || "STUDENT").trim().toUpperCase() || "STUDENT";
  // Registration: fullName (when provided) maps to users.name / full_name when present.
  const normalizedFullName = String(fullName || name || "").trim() || null;
  const nm = normalizedFullName;
  const fn = normalizedFullName;
  const code = userCode != null && String(userCode).trim() ? String(userCode).trim().slice(0, 64) : null;
  const p = getPool();
  let hdr;
  try {
    [hdr] = await p.execute(
      `INSERT INTO users (email, password, role, full_name, name, user_code)
       VALUES (?,?,?,?,?,?)`,
      [em, String(password || ""), r, fn, nm, code]
    );
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR" && String(e.sqlMessage || e.message).includes("full_name")) {
      [hdr] = await p.execute(
        `INSERT INTO users (email, password, role, name, user_code)
         VALUES (?,?,?,?,?)`,
        [em, String(password || ""), r, nm, code]
      );
    } else {
      throw e;
    }
  }
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
  const allowed = String(
    process.env.LECTURER_ROLES ||
      "lecturer,teacher,instructor,faculty,admin,lecture,Lecturer,Teacher,Instructor,LECTURER"
  )
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const r = String(role || "")
    .trim()
    .toLowerCase();
  if (!r) return false;
  if (allowed.includes(r)) return true;
  if (r === "student") return false;
  if (r.includes("lectur") || r.includes("instruct")) return true;
  return false;
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

async function ensureQuestionBankQuizForUser(userId) {
  const uid = parseOptionalInt(userId);
  if (uid == null) throw new Error("Invalid userId.");
  const p = getPool();
  const marker = `question-bank://user/${uid}`;
  const [rows] = await p.execute(
    `SELECT quiz_id FROM quizzes
     WHERE created_by = ? AND source_file_url = ?
     ORDER BY quiz_id ASC
     LIMIT 1`,
    [uid, marker]
  );
  if (rows.length) return Number(rows[0].quiz_id);
  const vals = ["Question Bank", null, uid];
  const insertAttempts = [
    {
      sql: `INSERT INTO quizzes (title, course_id, created_by, is_published, source_file_url) VALUES (?,?,?,0,?)`,
      params: [...vals, marker],
    },
    {
      sql: `INSERT INTO quizzes (title, course_id, created_by, source_file_url) VALUES (?,?,?,?)`,
      params: [...vals, marker],
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
  if (!hdr) throw lastErr || new Error("Could not create question bank quiz.");
  return Number(hdr.insertId);
}

async function ensureQuestionBankTables() {
  const p = getPool();
  await p.execute(
    `CREATE TABLE IF NOT EXISTS question_bank (
      bank_id BIGINT PRIMARY KEY AUTO_INCREMENT,
      owner_user_id INT NOT NULL,
      title VARCHAR(255) NOT NULL DEFAULT 'Question Bank',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_question_bank_owner (owner_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await p.execute(
    `CREATE TABLE IF NOT EXISTS question_bank_items (
      item_id BIGINT PRIMARY KEY AUTO_INCREMENT,
      bank_id BIGINT NOT NULL,
      question_text TEXT NOT NULL,
      option_a VARCHAR(255) NOT NULL,
      option_b VARCHAR(255) NOT NULL,
      option_c VARCHAR(255) NOT NULL,
      option_d VARCHAR(255) NOT NULL,
      correct_answer CHAR(1) NOT NULL,
      question_type VARCHAR(32) NOT NULL DEFAULT 'multiple-choice',
      topic VARCHAR(255) NOT NULL DEFAULT 'General',
      difficulty VARCHAR(32) NOT NULL DEFAULT 'medium',
      version INT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_qb_items_bank FOREIGN KEY (bank_id) REFERENCES question_bank(bank_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await p.execute(
    `CREATE TABLE IF NOT EXISTS quiz_bank_items (
      quiz_id INT NOT NULL,
      bank_item_id BIGINT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      PRIMARY KEY (quiz_id, bank_item_id),
      KEY idx_quiz_bank_items_bank_item (bank_item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  const itemAlterStmts = [
    "ALTER TABLE question_bank_items ADD COLUMN question_type VARCHAR(32) NOT NULL DEFAULT 'multiple-choice'",
    "ALTER TABLE question_bank_items ADD COLUMN topic VARCHAR(255) NOT NULL DEFAULT 'General'",
    "ALTER TABLE question_bank_items ADD COLUMN difficulty VARCHAR(32) NOT NULL DEFAULT 'medium'",
    "ALTER TABLE question_bank_items ADD COLUMN version INT NOT NULL DEFAULT 1",
  ];
  for (const sql of itemAlterStmts) {
    try {
      await p.execute(sql);
    } catch (e) {
      if (e.code !== "ER_DUP_FIELDNAME") {
        console.warn("ensureQuestionBankTables alter items:", e.message);
      }
    }
  }
  try {
    await p.execute(
      "ALTER TABLE question_bank_items ADD COLUMN category VARCHAR(128) NULL DEFAULT NULL"
    );
  } catch (e) {
    if (e.code !== "ER_DUP_FIELDNAME") {
      console.warn("ensureQuestionBankTables category:", e.message);
    }
  }
}

async function ensureQuestionBankForUser(userId) {
  const uid = parseOptionalInt(userId);
  if (uid == null) throw new Error("Invalid userId.");
  await ensureQuestionBankTables();
  const p = getPool();
  const [rows] = await p.execute(
    `SELECT bank_id FROM question_bank WHERE owner_user_id = ? LIMIT 1`,
    [uid]
  );
  if (rows.length) return Number(rows[0].bank_id);
  const [hdr] = await p.execute(
    `INSERT INTO question_bank (owner_user_id, title) VALUES (?, ?)`,
    [uid, "Question Bank"]
  );
  return Number(hdr.insertId);
}

async function migrateLegacyQuestionBankQuizToTable(userId, bankId) {
  const uid = parseOptionalInt(userId);
  const bid = Number(bankId);
  if (uid == null || !Number.isFinite(bid)) return;
  const marker = `question-bank://user/${uid}`;
  const p = getPool();
  const [legacyRows] = await p.execute(
    `SELECT qq.question_text, qq.option_a, qq.option_b, qq.option_c, qq.option_d, qq.correct_answer
     FROM quiz_questions qq
     INNER JOIN quizzes q ON q.quiz_id = qq.quiz_id
     WHERE q.created_by = ? AND q.source_file_url = ?`,
    [uid, marker]
  );
  for (const r of legacyRows) {
    const question = String(r.question_text || "").trim();
    if (!question) continue;
    const a = trunc255(r.option_a);
    const b = trunc255(r.option_b);
    const c = trunc255(r.option_c);
    const d = trunc255(r.option_d);
    const correct = String(r.correct_answer || "A").trim().toUpperCase().slice(0, 1) || "A";
    const [exist] = await p.execute(
      `SELECT item_id FROM question_bank_items
       WHERE bank_id = ? AND question_text = ? AND option_a = ? AND option_b = ? AND option_c = ? AND option_d = ? AND correct_answer = ?
       LIMIT 1`,
      [bid, question, a, b, c, d, correct]
    );
    if (exist.length) continue;
    await p.execute(
      `INSERT INTO question_bank_items
       (bank_id, owner_user_id, question_text, option_a, option_b, option_c, option_d, correct_answer, question_type, topic, difficulty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'multiple-choice', 'General', 'medium')`,
      [bid, uid, question, a, b, c, d, correct]
    );
  }
}

async function listQuestionBank(limit = 2000, userId = null) {
  const uid = parseOptionalInt(userId);
  if (uid == null) return [];
  const lim = Math.min(Math.max(Number(limit) || 2000, 1), 5000);
  const bankId = await ensureQuestionBankForUser(uid);
  await migrateLegacyQuestionBankQuizToTable(uid, bankId);
  const [rows] = await getPool().execute(
    `SELECT qbi.item_id, qbi.bank_id, qbi.question_text, qbi.option_a, qbi.option_b, qbi.option_c, qbi.option_d,
            qbi.correct_answer, qbi.question_type, qbi.topic, qbi.difficulty, qbi.category, qb.title AS bank_title
     FROM question_bank_items qbi
     INNER JOIN question_bank qb ON qb.bank_id = qbi.bank_id
     WHERE qb.owner_user_id = ?
     ORDER BY qbi.item_id DESC
     LIMIT ${lim}`,
    [uid]
  );
  return rows.map((r) => ({
    id: Number(r.item_id),
    quizId: Number(r.bank_id),
    quizTitle: String(r.bank_title || "Question Bank"),
    question: String(r.question_text || ""),
    type: String(r.question_type || "multiple-choice"),
    topic: String(r.topic || "General"),
    difficulty: String(r.difficulty || "medium"),
    category: r.category != null && String(r.category).trim() ? String(r.category).trim() : "",
    options: [r.option_a, r.option_b, r.option_c, r.option_d].map((x) => String(x || "")),
    correctAnswer: String(r.correct_answer || ""),
  }));
}

async function createQuestionBankItem(userId, payload) {
  const uid = parseOptionalInt(userId);
  if (uid == null) throw new Error("Invalid userId.");
  const bankId = await ensureQuestionBankForUser(uid);
  await migrateLegacyQuestionBankQuizToTable(uid, bankId);
  const norm = normalizeQuestionInput(payload);
  if (!norm) throw new Error("Invalid question payload.");
  const opts = norm.options || {};
  const [a, b, c, d] = ["A", "B", "C", "D"].map((L) => trunc255(opts[L]));
  const correct = String(norm.correct_answer || "A").toUpperCase().trim().slice(0, 1) || "A";
  const type = String(payload?.type || "multiple-choice").trim() || "multiple-choice";
  const topic = trunc255(payload?.topic || "General") || "General";
  const difficulty = String(payload?.difficulty || "medium").trim() || "medium";
  const catRaw = payload?.category != null ? String(payload.category).trim() : "";
  const category = catRaw ? trunc255(catRaw) : null;
  const [hdr] = await getPool().execute(
    `INSERT INTO question_bank_items
      (bank_id, owner_user_id, question_text, option_a, option_b, option_c, option_d, correct_answer, question_type, topic, difficulty, category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bankId, uid, norm.question, a, b, c, d, correct, type, topic, difficulty, category]
  );
  return Number(hdr.insertId || 0);
}

async function updateQuestionBankItem(questionId, userId, payload) {
  const qid = Number(questionId);
  const uid = parseOptionalInt(userId);
  if (!Number.isFinite(qid) || uid == null) throw new Error("Invalid request.");
  const bankId = await ensureQuestionBankForUser(uid);
  await migrateLegacyQuestionBankQuizToTable(uid, bankId);
  const norm = normalizeQuestionInput(payload);
  if (!norm) throw new Error("Invalid question payload.");
  const opts = norm.options || {};
  const letters = ["A", "B", "C", "D"];
  const [a, b, c, d] = letters.map((L) => trunc255(opts[L]));
  const correct = String(norm.correct_answer || "A").toUpperCase().trim().slice(0, 1) || "A";
  const type = String(payload?.type || "multiple-choice").trim() || "multiple-choice";
  const topic = trunc255(payload?.topic || "General") || "General";
  const difficulty = String(payload?.difficulty || "medium").trim() || "medium";
  const catRaw = payload?.category != null ? String(payload.category).trim() : "";
  const category = catRaw ? trunc255(catRaw) : null;
  const [rows] = await getPool().execute(
    `SELECT qbi.item_id
     FROM question_bank_items qbi
     INNER JOIN question_bank qb ON qb.bank_id = qbi.bank_id
     WHERE qbi.item_id = ? AND qb.owner_user_id = ?
     LIMIT 1`,
    [qid, uid]
  );
  if (!rows.length) return false;
  await getPool().execute(
    `UPDATE question_bank_items
     SET question_text = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, correct_answer = ?,
         question_type = ?, topic = ?, difficulty = ?, category = ?, version = version + 1
     WHERE item_id = ?`,
    [norm.question, a, b, c, d, correct, type, topic, difficulty, category, qid]
  );
  return true;
}

async function deleteQuestionBankItem(questionId, userId) {
  const qid = Number(questionId);
  const uid = parseOptionalInt(userId);
  if (!Number.isFinite(qid) || uid == null) throw new Error("Invalid request.");
  const bankId = await ensureQuestionBankForUser(uid);
  await migrateLegacyQuestionBankQuizToTable(uid, bankId);
  const [rows] = await getPool().execute(
    `SELECT qbi.item_id
     FROM question_bank_items qbi
     INNER JOIN question_bank qb ON qb.bank_id = qbi.bank_id
     WHERE qbi.item_id = ? AND qb.owner_user_id = ?
     LIMIT 1`,
    [qid, uid]
  );
  if (!rows.length) return false;
  await getPool().execute(`DELETE FROM question_bank_items WHERE item_id = ?`, [qid]);
  return true;
}

async function deleteQuizById(quizId) {
  const p = getPool();
  const id = Number(quizId);
  if (!Number.isFinite(id)) throw new Error("Invalid quizId.");
  await p.execute(`DELETE FROM quiz_answers WHERE attempt_id IN (SELECT attempt_id FROM quiz_attempts WHERE quiz_id = ?)`, [id]);
  await p.execute(`DELETE FROM quiz_attempts WHERE quiz_id = ?`, [id]);
  await p.execute(`DELETE FROM quiz_questions WHERE quiz_id = ?`, [id]);
  await p.execute(`DELETE FROM quizzes WHERE quiz_id = ?`, [id]);
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
  const p = getPool();
  try {
    const [rows] = await p.execute(
      `SELECT d.document_id, d.title, d.file_url, d.course_id, d.uploader_id, d.created_at,
        IFNULL(d.download_count, 0) AS download_count,
        d.description, d.category,
        u.role AS uploader_role,
        (SELECT COUNT(*) FROM document_segments s WHERE s.document_id = d.document_id) AS chunk_count
       FROM documents d
       LEFT JOIN users u ON u.user_id = d.uploader_id
       ORDER BY d.created_at DESC
       LIMIT ?`,
      [limit]
    );
    return rows;
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      try {
        const [rows] = await p.execute(
          `SELECT d.document_id, d.title, d.file_url, d.course_id, d.uploader_id, d.created_at,
            IFNULL(d.download_count, 0) AS download_count,
            d.description,
            (SELECT COUNT(*) FROM document_segments s WHERE s.document_id = d.document_id) AS chunk_count
           FROM documents d
           ORDER BY d.created_at DESC
           LIMIT ?`,
          [limit]
        );
        return rows;
      } catch (e2) {
        if (e2.code === "ER_BAD_FIELD_ERROR") {
          const [rows] = await p.execute(
            `SELECT d.document_id, d.title, d.file_url, d.course_id, d.uploader_id, d.created_at,
              IFNULL(d.download_count, 0) AS download_count,
              (SELECT COUNT(*) FROM document_segments s WHERE s.document_id = d.document_id) AS chunk_count
             FROM documents d
             ORDER BY d.created_at DESC
             LIMIT ?`,
            [limit]
          );
          return rows;
        }
        throw e2;
      }
    }
    throw e;
  }
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
  let correct = String(cor || "A").toUpperCase().trim().slice(0, 1) || "A";
  if (!["A", "B", "C", "D"].includes(correct)) {
    const rawCor = String(cor || "").trim();
    const entries = [
      ["A", String(opts.A || "").trim()],
      ["B", String(opts.B || "").trim()],
      ["C", String(opts.C || "").trim()],
      ["D", String(opts.D || "").trim()],
    ];
    const matched = entries.find(([, text]) => text && text === rawCor);
    correct = matched ? matched[0] : "A";
  }
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
  const sqlWithDoc = `
    SELECT q.*,
      COALESCE(cq.course_code, cd.course_code) AS course_code_joined
    FROM quizzes q
    LEFT JOIN courses cq ON cq.course_id = q.course_id
    LEFT JOIN documents d ON d.document_id = q.document_id
    LEFT JOIN courses cd ON cd.course_id = d.course_id
    WHERE q.quiz_id = ? LIMIT 1`;
  const sqlQuizOnly = `
    SELECT q.*, cq.course_code AS course_code_joined
    FROM quizzes q
    LEFT JOIN courses cq ON cq.course_id = q.course_id
    WHERE q.quiz_id = ? LIMIT 1`;
  let quizzes;
  try {
    [quizzes] = await p.execute(sqlWithDoc, [id]);
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      [quizzes] = await p.execute(sqlQuizOnly, [id]);
    } else {
      throw e;
    }
  }
  if (!quizzes.length) return null;
  const [questions] = await p.execute(
    `SELECT question_id, question_text, option_a, option_b, option_c, option_d, correct_answer
     FROM quiz_questions WHERE quiz_id = ? ORDER BY question_id ASC`,
    [id]
  );
  const raw = quizzes[0];
  const { course_code_joined: joined, ...quizRest } = raw;
  const mergedCode =
    joined != null && String(joined).trim() !== "" ? String(joined).trim() : raw.course_code;
  return { ...quizRest, course_code: mergedCode, questions };
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

async function getLecturerQuizAnalytics(userId, { topQuestions = 5 } = {}) {
  const uid = parseOptionalInt(userId);
  if (uid == null) {
    return {
      summary: {
        totalQuizzes: 0,
        totalParticipants: 0,
        averageScorePercent: 0,
        completionRatePercent: 0,
      },
      performance: [],
      challengingQuestions: [],
    };
  }
  const p = getPool();
  const tq = Math.min(Math.max(Number(topQuestions) || 5, 1), 20);

  const [perfRows] = await p.execute(
    `SELECT q.quiz_id, q.title, q.is_published,
            COUNT(DISTINCT qa.attempt_id) AS attempts_count,
            COUNT(DISTINCT CASE WHEN qa.user_id IS NOT NULL THEN qa.user_id END) AS participants_count,
            AVG(CASE WHEN qa.completed_at IS NOT NULL THEN qa.score END) AS avg_score,
            AVG(CASE WHEN qa.completed_at IS NOT NULL AND qa.score >= 70 THEN 100 ELSE 0 END) AS pass_rate
     FROM quizzes q
     LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.quiz_id
     WHERE q.created_by = ?
       AND (q.source_file_url IS NULL OR q.source_file_url NOT LIKE 'question-bank://%')
     GROUP BY q.quiz_id, q.title, q.is_published
     ORDER BY q.quiz_id DESC`,
    [uid]
  );

  const performance = perfRows.map((r) => ({
    quizId: Number(r.quiz_id),
    title: String(r.title || "Quiz"),
    isPublished: Number(r.is_published || 0) === 1,
    participants: Math.max(0, Number(r.participants_count || 0)),
    attempts: Math.max(0, Number(r.attempts_count || 0)),
    averageScorePercent: Math.max(0, Math.min(100, Number(r.avg_score || 0))),
    passRatePercent: Math.max(0, Math.min(100, Number(r.pass_rate || 0))),
    difficulty: "Medium",
  }));

  const totalQuizzes = performance.length;
  const totalParticipants = performance.reduce((s, x) => s + Number(x.participants || 0), 0);
  const avgRows = performance.filter((x) => Number(x.attempts || 0) > 0);
  const averageScorePercent = avgRows.length
    ? avgRows.reduce((s, x) => s + Number(x.averageScorePercent || 0), 0) / avgRows.length
    : 0;
  const completionRatePercent = totalQuizzes > 0
    ? (performance.filter((x) => Number(x.attempts || 0) > 0).length / totalQuizzes) * 100
    : 0;

  const [challengingRows] = await p.execute(
    `SELECT qq.question_id, qq.question_text,
            COUNT(qa2.attempt_id) AS attempts_count,
            SUM(CASE WHEN qa2.is_correct = 1 THEN 1 ELSE 0 END) AS correct_hits
     FROM quizzes q
     INNER JOIN quiz_questions qq ON qq.quiz_id = q.quiz_id
     LEFT JOIN quiz_answers qa2 ON qa2.question_id = qq.question_id
     LEFT JOIN quiz_attempts atp ON atp.attempt_id = qa2.attempt_id AND atp.completed_at IS NOT NULL
     WHERE q.created_by = ?
       AND (q.source_file_url IS NULL OR q.source_file_url NOT LIKE 'question-bank://%')
     GROUP BY qq.question_id, qq.question_text
     HAVING attempts_count > 0
     ORDER BY
       (SUM(CASE WHEN qa2.is_correct = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(qa2.attempt_id), 0)) ASC,
       attempts_count DESC
     LIMIT ${tq}`,
    [uid]
  );

  const challengingQuestions = challengingRows.map((r) => {
    const attempts = Math.max(0, Number(r.attempts_count || 0));
    const correct = Math.max(0, Number(r.correct_hits || 0));
    const rate = attempts > 0 ? (correct * 100) / attempts : 0;
    return {
      questionId: Number(r.question_id),
      question: String(r.question_text || ""),
      attempts,
      correctRatePercent: Math.max(0, Math.min(100, rate)),
    };
  });

  return {
    summary: {
      totalQuizzes,
      totalParticipants,
      averageScorePercent,
      completionRatePercent,
    },
    performance,
    challengingQuestions,
  };
}

module.exports = {
  isConfigured,
  initDb,
  getPool,
  upsertDocument,
  findOrCreateCourseIdByCode,
  ensureDocumentStub,
  deleteChunksByDocumentId,
  insertSegment,
  insertChunk,
  getDocumentIdByS3Key,
  incrementDocumentDownloadCountByDocumentId,
  incrementDocumentDownloadCountByS3Key,
  countAttemptsBySourceFileUrls,
  countChunksByS3Key,
  getConcatenatedChunksByS3Key,
  listSegmentsByS3Key,
  getDocumentById,
  listSegmentsByDocumentId,
  hasCompleteEmbeddingsForS3Key,
  getMetaMapForS3Keys,
  normalizeDocumentKeyForLookup,
  countCommentsByDocumentFileUrls,
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
  getUserById,
  updateUserProfile,
  createUser,
  updateUserPassword,
  canUserManageQuiz,
  replaceQuizQuestions,
  updateQuizTitle,
  setQuizPublished,
  deleteQuizById,
  listQuestionBank,
  createQuestionBankItem,
  updateQuestionBankItem,
  deleteQuestionBankItem,
  quizRowIsPublished,
  normalizeQuestionInput,
  getLearningProgressSummary,
  getLecturerQuizAnalytics,
  listDocumentComments,
  insertDocumentComment,
};
