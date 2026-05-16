const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

function isS3Configured() {
  return !!(
    process.env.AWS_REGION &&
    String(process.env.AWS_REGION).trim() &&
    process.env.AWS_ACCESS_KEY_ID &&
    String(process.env.AWS_ACCESS_KEY_ID).trim() &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    String(process.env.AWS_SECRET_ACCESS_KEY).trim() &&
    process.env.S3_BUCKET &&
    String(process.env.S3_BUCKET).trim()
  );
}

function getBucket() {
  return String(process.env.S3_BUCKET).trim();
}

function getClient() {
  return new S3Client({
    region: String(process.env.AWS_REGION).trim(),
    credentials: {
      accessKeyId: String(process.env.AWS_ACCESS_KEY_ID).trim(),
      secretAccessKey: String(process.env.AWS_SECRET_ACCESS_KEY).trim(),
    },
  });
}

function buildObjectPublicUrl(key) {
  if (!key) return null;
  const custom = process.env.S3_PUBLIC_BASE_URL;
  if (custom && String(custom).trim()) {
    const base = String(custom).trim().replace(/\/+$/, "");
    return `${base}/${String(key).replace(/^\/+/, "")}`;
  }
  const bucket = getBucket();
  const region = String(process.env.AWS_REGION).trim();
  const encoded = String(key)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `https://${bucket}.s3.${region}.amazonaws.com/${encoded}`;
}

async function buildSignedUrl(key, expiresSeconds = 3600) {
  if (!key) return null;
  try {
    const client = getClient();
    const command = new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    });
    return await getSignedUrl(client, command, { expiresIn: expiresSeconds });
  } catch (err) {
    console.error("Lỗi tạo signed URL:", err);
    return buildObjectPublicUrl(key);
  }
}

async function buildInlineSignedUrl(key, expiresSeconds = 3600) {
  if (!key) return null;
  try {
    const client = getClient();
    const command = new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
      ResponseContentDisposition: 'inline',
    });
    return await getSignedUrl(client, command, { expiresIn: expiresSeconds });
  } catch (err) {
    console.error("Lỗi tạo inline signed URL:", err);
    return null;
  }
}

function safeFolderName(value, fallback = "GENERAL") {
  const s = String(value || "").trim();
  if (!s) return fallback;

  return s
    .replace(/[\\]/g, "/")
    .replace(/\.\./g, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/[<>:"|?*]/g, "")
    .trim() || fallback;
}

/**
 * capstoneedumate bucket layout (see S3 console):
 *   DATA / YEAR 1 / SEMESTER 1 / {course folder} / file.pdf
 */
const DEFAULT_YEAR_FOLDER_MAP = {
  "YEAR 1": "YEAR 1",
  "YEAR 2": "YEAR 2",
  "YEAR 3": "YEAR 3",
  "YEAR 4": "YEAR 4",
  "1": "YEAR 1",
  "2": "YEAR 2",
  "3": "YEAR 3",
  "4": "YEAR 4",
  // Legacy / alternate labels → same English folders
  "NAM 1": "YEAR 1",
  "NAM 2": "YEAR 2",
  "NAM 3": "YEAR 3",
  "NAM 4": "YEAR 4",
  "NAM 1 (2024-2025)": "YEAR 1",
  "NĂM 1": "YEAR 1",
  "NĂM 2": "YEAR 2",
  "NĂM 3": "YEAR 3",
  "NĂM 4": "YEAR 4",
};

const DEFAULT_SEMESTER_FOLDER_MAP = {
  "SEMESTER 1": "SEMESTER 1",
  "SEMESTER 2": "SEMESTER 2",
  "1": "SEMESTER 1",
  "2": "SEMESTER 2",
  "HOC KI 1": "SEMESTER 1",
  "HOC KI 2": "SEMESTER 2",
  "HỌC KÌ 1": "SEMESTER 1",
  "HỌC KÌ 2": "SEMESTER 2",
};

function normalizeFolderKey(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function mapYearToS3Folder(year) {
  const raw = String(year || "").trim();
  if (!raw) return safeFolderName("", "YEAR 1");
  const key = normalizeFolderKey(raw);
  const fromEnv = process.env.S3_YEAR_FOLDER_MAP;
  if (fromEnv) {
    try {
      const parsed = JSON.parse(fromEnv);
      if (parsed && typeof parsed === "object" && parsed[key]) {
        return safeFolderName(parsed[key], parsed[key]);
      }
    } catch (_) {
      /* ignore invalid JSON */
    }
  }
  if (DEFAULT_YEAR_FOLDER_MAP[key]) {
    return safeFolderName(DEFAULT_YEAR_FOLDER_MAP[key]);
  }
  const yearNum = key.match(/^YEAR\s*(\d+)$/) || key.match(/^(\d+)$/);
  if (yearNum) {
    return safeFolderName(`YEAR ${yearNum[1]}`);
  }
  return safeFolderName(raw, "YEAR 1");
}

function mapSemesterToS3Folder(semester) {
  const raw = String(semester || "").trim();
  if (!raw) return safeFolderName("", "SEMESTER 1");
  const key = normalizeFolderKey(raw);
  const fromEnv = process.env.S3_SEMESTER_FOLDER_MAP;
  if (fromEnv) {
    try {
      const parsed = JSON.parse(fromEnv);
      if (parsed && typeof parsed === "object" && parsed[key]) {
        return safeFolderName(parsed[key], parsed[key]);
      }
    } catch (_) {
      /* ignore invalid JSON */
    }
  }
  if (DEFAULT_SEMESTER_FOLDER_MAP[key]) {
    return safeFolderName(DEFAULT_SEMESTER_FOLDER_MAP[key]);
  }
  const semNum = key.match(/^SEMESTER\s*(\d+)$/) || key.match(/^(\d+)$/);
  if (semNum) {
    return safeFolderName(`SEMESTER ${semNum[1]}`);
  }
  return safeFolderName(raw, "SEMESTER 1");
}

function buildSubjectFolder(subjectCode, subjectName) {
  const codeRaw = String(subjectCode || "").trim();
  const nameRaw = String(subjectName || "").trim();
  if (/^\d+\.\s/.test(codeRaw)) {
    return safeFolderName(codeRaw, "GENERAL");
  }
  const code = safeFolderName(codeRaw, "GENERAL");
  const name = safeFolderName(nameRaw, "");
  if (name && name !== "Course" && name !== code) {
    return `${code} - ${name}`;
  }
  return code;
}

function safeFileBaseName(originalName, displayName = "") {
  const ext = path.extname(originalName).toLowerCase();

  // Ưu tiên dùng Course Name làm tên file.
  // Nếu Course Name rỗng thì mới fallback về tên file gốc.
  const rawBase = String(displayName || "").trim()
    || path.basename(originalName, ext);

  const safe = rawBase
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "document";

  return { safe, ext };
}

function buildDocumentKey(originalName, meta = {}) {
  const { safe, ext } = safeFileBaseName(originalName, meta.fileDisplayName);

  const year = mapYearToS3Folder(meta.year);
  const semester = mapSemesterToS3Folder(meta.semester);

  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

  // AWS layout: DATA / YEAR n / SEMESTER n / file.pdf (no per-course subfolders)
  return `DATA/${year}/${semester}/${unique}-${safe}${ext}`;
}

async function uploadDocumentBuffer({ buffer, key, contentType }) {
  const client = getClient();
  const bucket = getBucket();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType || "application/octet-stream",
    })
  );
  return { bucket, key, url: buildObjectPublicUrl(key) };
}

function documentsPrefix() {
  const p = process.env.S3_DOCUMENTS_PREFIX;
  if (p && String(p).trim()) {
    const s = String(p).trim();
    return s.endsWith("/") ? s : `${s}/`;
  }
  return "documents/";
}

async function listDocuments({ prefix, maxKeys = 5000 } = {}) {
  const client = getClient();
  const bucket = getBucket();
  const pref = prefix != null ? prefix : documentsPrefix();
  const out = [];
  let continuationToken;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: pref,
        ContinuationToken: continuationToken,
        MaxKeys: Math.min(1000, maxKeys - out.length),
      })
    );
    for (const obj of resp.Contents || []) {
      if (!obj.Key || obj.Key.endsWith("/")) continue;
      out.push({ key: obj.Key, size: obj.Size, lastModified: obj.LastModified });
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken && out.length < maxKeys);
  return out;
}

async function listLogArchives() {
  return listDocuments({ prefix: "LOGS/archive/", maxKeys: 1000 });
}

async function streamToBuffer(body) {
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function getObjectBuffer(key) {
  if (!key || String(key).includes("..")) {
    throw new Error("S3 key không hợp lệ.");
  }
  const client = getClient();
  const bucket = getBucket();
  const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const buffer = await streamToBuffer(resp.Body);
  return { buffer, contentType: resp.ContentType || "" };
}

module.exports = {
  isS3Configured,
  uploadDocumentBuffer,
  buildObjectPublicUrl,
  buildDocumentKey,
  mapYearToS3Folder,
  mapSemesterToS3Folder,
  buildSubjectFolder,
  getBucket,
  listDocuments,
  listLogArchives,
  getObjectBuffer,
  documentsPrefix,
  buildSignedUrl,
  buildInlineSignedUrl,
};
