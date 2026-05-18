/**
 * Course code/name autocomplete for document upload.
 * Reads from MySQL `courses` (or `course`) when available; falls back to in-memory uploads + seeds.
 */

const SEED_COURSES = [
  { course_code: "CS101", course_name: "Introduction to Computer Science" },
  { course_code: "CS201", course_name: "Data Structures and Algorithms" },
  { course_code: "MATH201", course_name: "Discrete Mathematics" },
  { course_code: "SE301", course_name: "Software Engineering" },
  { course_code: "DB201", course_name: "Database Systems" },
  { course_code: "NET301", course_name: "Computer Networks" },
  { course_code: "AI401", course_name: "Artificial Intelligence" },
  { course_code: "WEB201", course_name: "Web Development" },
];

function normalizeRow(row) {
  const course_code = String(
    row?.course_code ?? row?.courseCode ?? row?.subject_code ?? row?.subjectCode ?? ""
  ).trim();
  const course_name = String(
    row?.course_name ?? row?.courseName ?? row?.subject_name ?? row?.subjectName ?? ""
  ).trim();
  if (!course_code && !course_name) return null;
  return {
    course_code: course_code || course_name,
    course_name: course_name || course_code,
  };
}

function parseCourseColumnValue(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const dash = s.match(/^([A-Za-z]{2,}\d{2,})\s*[-–—:]\s*(.+)$/);
  if (dash) {
    return { course_code: dash[1].trim().toUpperCase(), course_name: dash[2].trim() };
  }
  if (/^[A-Za-z]{2,}\d{2,}$/i.test(s)) {
    return { course_code: s.toUpperCase(), course_name: "" };
  }
  return { course_code: s.slice(0, 32), course_name: s };
}

function dedupeCourses(list) {
  const map = new Map();
  for (const item of list) {
    const n = normalizeRow(item);
    if (!n) continue;
    const key = n.course_code.toLowerCase();
    if (!map.has(key)) {
      map.set(key, n);
      continue;
    }
    const prev = map.get(key);
    if (!prev.course_name && n.course_name) map.set(key, n);
  }
  return Array.from(map.values());
}

function filterCourses(list, query, field) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  return list.filter((c) => {
    const code = c.course_code.toLowerCase();
    const name = c.course_name.toLowerCase();
    if (field === "code") return code.includes(q);
    if (field === "name") return name.includes(q);
    return code.includes(q) || name.includes(q);
  });
}

function coursesFromRecentUploads(recentUploads) {
  const out = [];
  for (const d of recentUploads || []) {
    const course_code = String(d?.subjectCode || d?.courseCode || "").trim();
    const course_name = String(d?.subjectName || d?.courseName || "").trim();
    if (!course_code && !course_name) continue;
    out.push({
      course_code: course_code || course_name,
      course_name: course_name || course_code,
    });
  }
  return out;
}

async function queryMysqlCourses(pool, query, limit) {
  const q = `%${String(query || "").trim()}%`;
  const attempts = [
    {
      sql: `SELECT DISTINCT course_code, course_name
            FROM courses
            WHERE course_code LIKE ? OR course_name LIKE ?
            ORDER BY course_code ASC
            LIMIT ?`,
      params: [q, q, limit],
    },
    {
      sql: `SELECT DISTINCT course_code, course_name
            FROM course
            WHERE course_code LIKE ? OR course_name LIKE ?
            ORDER BY course_code ASC
            LIMIT ?`,
      params: [q, q, limit],
    },
    {
      sql: `SELECT DISTINCT course AS course_raw
            FROM course
            WHERE course LIKE ?
            ORDER BY course ASC
            LIMIT ?`,
      params: [q, limit],
      map: (rows) => rows.map((r) => parseCourseColumnValue(r.course_raw)).filter(Boolean),
    },
    {
      sql: `SELECT DISTINCT course AS course_raw
            FROM documents
            WHERE course LIKE ?
            ORDER BY course ASC
            LIMIT ?`,
      params: [q, limit],
      map: (rows) => rows.map((r) => parseCourseColumnValue(r.course_raw)).filter(Boolean),
    },
    {
      sql: `SELECT DISTINCT subjectCode AS course_code, subjectName AS course_name
            FROM documents
            WHERE subjectCode LIKE ? OR subjectName LIKE ?
            ORDER BY subjectCode ASC
            LIMIT ?`,
      params: [q, q, limit],
    },
  ];

  for (const attempt of attempts) {
    try {
      const [rows] = await pool.query(attempt.sql, attempt.params);
      if (!Array.isArray(rows) || !rows.length) continue;
      if (attempt.map) return attempt.map(rows);
      return rows.map(normalizeRow).filter(Boolean);
    } catch {
      // try next shape
    }
  }
  return [];
}

/**
 * @param {{ getMysqlPool: () => import('mysql2/promise').Pool, recentUploads: object[], logApiError?: Function }} deps
 */
async function getCourseSuggestions(deps, query, fieldRaw) {
  const field = String(fieldRaw || "all").toLowerCase();
  const safeField = field === "code" || field === "name" ? field : "all";
  const q = String(query || "").trim();
  if (!q) return [];

  let mysqlRows = [];
  try {
    const pool = deps.getMysqlPool();
    mysqlRows = await queryMysqlCourses(pool, q, 15);
  } catch (err) {
    if (deps.logApiError) deps.logApiError(err, "course-suggestions mysql");
  }

  const merged = dedupeCourses([
    ...mysqlRows,
    ...coursesFromRecentUploads(deps.recentUploads),
    ...SEED_COURSES,
  ]);

  const filtered = filterCourses(merged, q, safeField);
  filtered.sort((a, b) => {
    const aCode = a.course_code.toLowerCase();
    const bCode = b.course_code.toLowerCase();
    const ql = q.toLowerCase();
    const aStarts = aCode.startsWith(ql) ? 0 : 1;
    const bStarts = bCode.startsWith(ql) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return aCode.localeCompare(bCode);
  });
  return filtered.slice(0, 12);
}

module.exports = {
  SEED_COURSES,
  getCourseSuggestions,
  normalizeRow,
};
