const crypto = require("crypto");

const JOB_TTL_MS = Number(process.env.ASYNC_JOB_TTL_MS || 15 * 60 * 1000);
const jobs = new Map();
let hooks = {
  onCompleted: null,
  onFailed: null,
};

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
}

function cleanupExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.updatedAtMs > JOB_TTL_MS) jobs.delete(id);
  }
}

function createAsyncJob({ type, metadata = {} }) {
  cleanupExpiredJobs();
  const jobId = randomId();
  const base = {
    jobId,
    type: String(type || "generic"),
    status: "queued",
    progress: 0,
    message: "Job created",
    metadata,
    result: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
  jobs.set(jobId, base);
  return base;
}

function updateAsyncJob(jobId, patch = {}) {
  const current = jobs.get(jobId);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    updatedAt: nowIso(),
    updatedAtMs: Date.now(),
  };
  jobs.set(jobId, next);
  return next;
}

function getAsyncJob(jobId) {
  cleanupExpiredJobs();
  return jobs.get(jobId) || null;
}

function runAsyncJob({ type, metadata = {}, runner }) {
  const created = createAsyncJob({ type, metadata });
  const jobId = created.jobId;

  setImmediate(async () => {
    try {
      updateAsyncJob(jobId, { status: "running", progress: 10, message: "Processing..." });
      const result = await runner({
        update: (patch = {}) => updateAsyncJob(jobId, patch),
        jobId,
      });
      updateAsyncJob(jobId, {
        status: "completed",
        progress: 100,
        message: "Completed",
        result: result ?? null,
      });
      try {
        if (typeof hooks.onCompleted === "function") {
          hooks.onCompleted(getAsyncJob(jobId));
        }
      } catch (_) {}
    } catch (err) {
      updateAsyncJob(jobId, {
        status: "failed",
        progress: 100,
        message: err?.message || "Job failed",
        error: {
          message: err?.message || "Unknown error",
          status: err?.status ?? err?.statusCode ?? null,
        },
      });
      try {
        if (typeof hooks.onFailed === "function") {
          hooks.onFailed(getAsyncJob(jobId));
        }
      } catch (_) {}
    }
  });

  return created;
}

function setAsyncJobHooks(nextHooks = {}) {
  hooks = {
    ...hooks,
    ...nextHooks,
  };
}

module.exports = {
  runAsyncJob,
  getAsyncJob,
  setAsyncJobHooks,
};
