import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_REQUIRED_APPROVERS = Object.freeze([
  Object.freeze({
    id: "lakshmi",
    name: "Lakshmi",
    email: "lakshminathanlaky@gmail.com",
    aliases: Object.freeze(["lakshminathanlaky@gmail.com", "lakshmi@chessalive.com"]),
  }),
  Object.freeze({
    id: "vinoth",
    name: "Vinoth",
    email: "vinoth121022@gmail.com",
    aliases: Object.freeze(["vinoth121022@gmail.com", "vinoth@chessalive.com"]),
  }),
  Object.freeze({
    id: "avinash",
    name: "Avinash",
    email: "avinashr95@gmail.com",
    aliases: Object.freeze(["avinashr95@gmail.com", "avinash@chessalive.com"]),
  }),
]);

export function parseApproversConfig(raw) {
  if (!raw || !String(raw).trim()) return DEFAULT_REQUIRED_APPROVERS;
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed) || parsed.length < 3) return DEFAULT_REQUIRED_APPROVERS;
    const out = parsed.map(item => {
      const id = String(item?.id || "").trim().toLowerCase();
      const name = String(item?.name || id).trim();
      const email = String(item?.email || "").trim().toLowerCase();
      const aliases = Array.isArray(item?.aliases)
        ? [...new Set([email, ...item.aliases.map(a => String(a || "").trim().toLowerCase()).filter(Boolean)])]
        : [email];
      if (!/^[a-z0-9_-]{2,32}$/.test(id) || !email.includes("@")) {
        throw new Error("invalid approver entry");
      }
      return Object.freeze({ id, name, email, aliases: Object.freeze(aliases) });
    });
    const ids = new Set(out.map(a => a.id));
    if (ids.size !== out.length) return DEFAULT_REQUIRED_APPROVERS;
    return Object.freeze(out);
  } catch {
    return DEFAULT_REQUIRED_APPROVERS;
  }
}

function sha256Buf(value) {
  return createHash("sha256").update(String(value)).digest();
}

export function canonicalProofMessage(payload) {
  const approvers = [...(payload.approvers || [])]
    .map(a => `${a.id}:${a.email}:${a.approvedAt}`)
    .sort()
    .join("|");
  return `v1|${payload.releaseId}|${payload.commitHash || ""}|${payload.issuedAt}|${approvers}`;
}

export function signApprovalProof(payload, secret) {
  const key = String(secret || "").trim();
  if (key.length < 32) throw new Error("Approval signing secret must be at least 32 characters");
  const sig = createHmac("sha256", key).update(canonicalProofMessage(payload)).digest("hex");
  return Buffer.from(JSON.stringify({ ...payload, signature: sig }), "utf8").toString("base64");
}

export function createApprovalManager({
  stateFile,
  approvers = DEFAULT_REQUIRED_APPROVERS,
  otpTtlMs = 10 * 60 * 1000,
  otpMaxAttempts = 5,
  otpRateLimitCount = 5,
  otpIpRateLimitCount = 15,
  otpRateLimitWindowMs = 10 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  const byId = new Map();
  const byAlias = new Map();
  for (const approver of approvers) {
    byId.set(approver.id, approver);
    for (const alias of approver.aliases) {
      byAlias.set(alias.toLowerCase(), approver);
    }
    byAlias.set(approver.email.toLowerCase(), approver);
  }

  // Persisted map: { schemaVersion: 1, releases: { [releaseId]: { [adminId]: { id, name, email, approvedAt, commitHash, version } } } }
  let store = { schemaVersion: 1, releases: {} };

  function load() {
    if (!stateFile) return;
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
      if (parsed && parsed.schemaVersion === 1 && parsed.releases && typeof parsed.releases === "object") {
        store = parsed;
      }
    } catch {
      // First boot has no saved approvals yet.
    }
  }

  function persist() {
    if (!stateFile) return;
    mkdirSync(dirname(stateFile), { recursive: true });
    // Keep only the 20 most recent release entries so the file stays tiny and bounded.
    const keys = Object.keys(store.releases);
    if (keys.length > 20) {
      for (const oldKey of keys.slice(0, keys.length - 20)) {
        delete store.releases[oldKey];
      }
    }
    const tmp = `${stateFile}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, stateFile);
  }

  load();

  const otpChallenges = new Map(); // challengeId -> { approverId, email, codeHash, expiresAt, attempts }
  const otpRequests = new Map();   // key -> { count, resetAt }

  function resolveApprover(identifier) {
    const clean = String(identifier || "").trim().toLowerCase();
    if (!clean) return null;
    return byId.get(clean) || byAlias.get(clean) || null;
  }

  function pruneExpiredChallenges() {
    const t = now();
    for (const [id, entry] of otpChallenges.entries()) {
      if (t >= entry.expiresAt) otpChallenges.delete(id);
    }
  }

  function allowOtpRequest(key, limit) {
    const t = now();
    let rec = otpRequests.get(key);
    if (!rec || t >= rec.resetAt) {
      rec = { count: 0, resetAt: t + otpRateLimitWindowMs };
      otpRequests.set(key, rec);
    }
    rec.count += 1;
    return rec.count <= limit;
  }

  function issueOtp(identifier, clientKey = "unknown") {
    pruneExpiredChallenges();
    const approver = resolveApprover(identifier);
    if (!approver) return { ok: false, status: 403, error: "Only the 3 authorized admins (Lakshmi, Vinoth, Avinash) may sign in." };
    if (!allowOtpRequest(`admin:${approver.id}`, otpRateLimitCount) || !allowOtpRequest(`ip:${clientKey}`, otpIpRateLimitCount)) {
      return { ok: false, status: 429, error: "Too many login codes requested. Please wait a few minutes and try again." };
    }
    // Invalidate any prior active challenge for this admin so only the latest code works.
    for (const [id, entry] of otpChallenges.entries()) {
      if (entry.approverId === approver.id) otpChallenges.delete(id);
    }
    const challengeId = randomBytes(24).toString("hex");
    const code = String(randomInt(100000, 1000000));
    const expiresAt = now() + otpTtlMs;
    otpChallenges.set(challengeId, {
      approverId: approver.id,
      email: approver.email,
      codeHash: sha256Buf(`${challengeId}:${code}`),
      expiresAt,
      attempts: 0,
    });
    return { ok: true, challengeId, code, approver, expiresAt: new Date(expiresAt).toISOString() };
  }

  function verifyOtp(challengeId, identifier, code) {
    pruneExpiredChallenges();
    const id = String(challengeId || "").trim();
    const cleanCode = String(code || "").replace(/\s+/g, "");
    const approver = resolveApprover(identifier);
    const entry = otpChallenges.get(id);
    if (!entry || !approver || entry.approverId !== approver.id) {
      return { ok: false, status: 401, error: "Verification code expired or invalid. Request a new code." };
    }
    if (now() >= entry.expiresAt) {
      otpChallenges.delete(id);
      return { ok: false, status: 401, error: "Verification code expired. Request a new code." };
    }
    entry.attempts += 1;
    if (entry.attempts > otpMaxAttempts) {
      otpChallenges.delete(id);
      return { ok: false, status: 429, error: "Too many incorrect attempts. Request a new verification code." };
    }
    if (!/^\d{6}$/.test(cleanCode)) {
      return { ok: false, status: 401, error: "Enter the 6-digit verification code sent to your email." };
    }
    const candidateHash = sha256Buf(`${id}:${cleanCode}`);
    if (!timingSafeEqual(candidateHash, entry.codeHash)) {
      return { ok: false, status: 401, error: "Incorrect verification code. Please check your email and try again." };
    }
    otpChallenges.delete(id);
    return { ok: true, approver };
  }

  function getStatus(releaseId) {
    const rel = String(releaseId || "").trim();
    const map = (rel && store.releases[rel]) ? store.releases[rel] : {};
    const list = approvers.map(approver => {
      const record = map[approver.id] || null;
      return {
        id: approver.id,
        name: approver.name,
        email: approver.email,
        approved: Boolean(record),
        approvedAt: record?.approvedAt || null,
        commitHash: record?.commitHash || null,
        version: record?.version || null,
      };
    });
    const approvedBy = list.filter(item => item.approved);
    const pending = list.filter(item => !item.approved).map(({ id, name, email }) => ({ id, name, email }));
    return {
      releaseId: rel || null,
      requiredCount: approvers.length,
      approvedCount: approvedBy.length,
      allApproved: Boolean(rel) && approvedBy.length === approvers.length,
      approvedBy,
      pending,
      approvers: list,
    };
  }

  function approve(releaseId, approver, { commitHash = null, version = null } = {}) {
    const rel = String(releaseId || "").trim();
    if (!rel) throw new Error("No Pre-Prod release ID to approve");
    const canonical = resolveApprover(approver?.id || approver?.email);
    if (!canonical) throw new Error("Unauthorized approver");
    if (!store.releases[rel]) store.releases[rel] = {};
    store.releases[rel][canonical.id] = {
      id: canonical.id,
      name: canonical.name,
      email: canonical.email,
      approvedAt: new Date(now()).toISOString(),
      commitHash: commitHash || null,
      version: version || null,
    };
    persist();
    return getStatus(rel);
  }

  function revoke(releaseId, approver) {
    const rel = String(releaseId || "").trim();
    const canonical = resolveApprover(approver?.id || approver?.email);
    if (!rel || !canonical) return getStatus(rel);
    if (store.releases[rel] && store.releases[rel][canonical.id]) {
      delete store.releases[rel][canonical.id];
      persist();
    }
    return getStatus(rel);
  }

  function buildSignedProof(releaseId, secret, { commitHash = null } = {}) {
    const status = getStatus(releaseId);
    if (!status.allApproved) {
      const names = status.pending.map(p => p.name).join(", ");
      throw new Error(`All ${status.requiredCount} required admins must approve ${releaseId} before promoting (${status.approvedCount}/${status.requiredCount} approved; waiting for ${names})`);
    }
    const payload = {
      schemaVersion: 1,
      releaseId,
      commitHash: commitHash || status.approvedBy[0]?.commitHash || "",
      issuedAt: new Date(now()).toISOString(),
      approvers: status.approvedBy.map(item => ({
        id: item.id,
        name: item.name,
        email: item.email,
        approvedAt: item.approvedAt,
      })),
    };
    return signApprovalProof(payload, secret);
  }

  return {
    approvers,
    resolveApprover,
    issueOtp,
    verifyOtp,
    getStatus,
    approve,
    revoke,
    buildSignedProof,
  };
}
