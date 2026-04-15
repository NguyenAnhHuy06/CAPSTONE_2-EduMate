// File: s3Upload.js

const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
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

/**
 * Public URL for an object (public bucket or CDN). No presigned URL.
 */
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

function buildDocumentKey(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const base = path.basename(originalName, ext);
  const safe = base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "document";
  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  return `documents/${unique}-${safe}${ext}`;
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
      out.push({
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified,
      });
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken && out.length < maxKeys);
  return out;
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
    throw new Error("Invalid S3 key.");
  }
  const client = getClient();
  const bucket = getBucket();
  const resp = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
  const buffer = await streamToBuffer(resp.Body);
  return {
    buffer,
    contentType: resp.ContentType || "",
  };
}

async function putJsonObject({ key, value }) {
  if (!key || String(key).includes("..")) {
    throw new Error("Invalid S3 key.");
  }
  const client = getClient();
  const bucket = getBucket();
  const body = Buffer.from(JSON.stringify(value ?? null));
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
    })
  );
  return { bucket, key, url: buildObjectPublicUrl(key) };
}

/** Time-limited HTTPS URL for private buckets (GET object). */
async function getPresignedDownloadUrl(key, expiresInSeconds = 300) {
  if (!key || String(key).includes("..")) {
    throw new Error("Invalid S3 key.");
  }
  const client = getClient();
  const bucket = getBucket();
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: String(key).trim(),
  });
  return getSignedUrl(client, command, {
    expiresIn: Math.min(Math.max(Number(expiresInSeconds) || 300, 60), 3600),
  });
}

async function deleteObject(key) {
  if (!key || String(key).includes("..")) {
    throw new Error("Invalid S3 key.");
  }
  const client = getClient();
  const bucket = getBucket();
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: String(key).trim(),
    })
  );
  return true;
}

module.exports = {
  isS3Configured,
  uploadDocumentBuffer,
  buildObjectPublicUrl,
  buildDocumentKey,
  getBucket,
  listDocuments,
  getObjectBuffer,
  documentsPrefix,
  putJsonObject,
  getPresignedDownloadUrl,
  deleteObject,
};
