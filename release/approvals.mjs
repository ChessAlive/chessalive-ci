import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_REQUIRED_APPROVERS = Object.freeze([
  Object.freeze({
    id: "lakshmi",
    name: "Lakshmi",
    email: "lakshminathanlaky@gmail.com",
    aliases: Object.freeze(["lakshminathanlaky@gmail.com", "lakshmi@chessalive.com"]),
    canVeto: true,
    canOverride: true,
  }),
  Object.freeze({
    id: "vinoth",
    name: "Vinoth",
    email: "vinoth121022@gmail.com",
    aliases: Object.freeze(["vinoth121022@gmail.com", "vinoth@chessalive.com"]),
    canVeto: false,
    canOverride: false,
  }),
  Object.freeze({
    id: "avinash",
    name: "Avinash",
    email: "avinashr95@gmail.com",
    aliases: Object.freeze(["avinashr95@gmail.com", "avinash@chessalive.com"]),
    canVeto: false,
    canOverride: false,
  }),
]);

export const DEFAULT_QUORUM_COUNT = 2;

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
      const canVeto = typeof item?.canVeto === "boolean" ? item.canVeto : id === "lakshmi";
      const canOverride = typeof item?.canOverride === "boolean"
        ? item.canOverride
        : (typeof item?.canVeto === "boolean" ? item.canVeto : id === "lakshmi");
      if (!/^[a-z0-9_-]{2,32}$/.test(id) || !email.includes("@")) {
        throw new Error("invalid approver entry");
      }
      return Object.freeze({ id, name, email, aliases: Object.freeze(aliases), canVeto, canOverride });
    });
    const ids = new Set(out.map(a => a.id));
    if (ids.size !== out.length) return DEFAULT_REQUIRED_APPROVERS;
    return Object.freeze(out);
  } catch {
    return DEFAULT_REQUIRED_APPROVERS;
  }
}

export function parseQuorumConfig(raw, totalApprovers = DEFAULT_REQUIRED_APPROVERS.length) {
  const max = Math.max(2, Number(totalApprovers) || DEFAULT_REQUIRED_APPROVERS.length);
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return Math.min(DEFAULT_QUORUM_COUNT, max);
  return Math.max(2, Math.min(max, parsed));
}

function sha256Buf(value) {
  return createHash("sha256").update(String(value)).digest();
}

export function canonicalProofMessage(payload) {
  const mode = String(payload.mode || "quorum").trim().toLowerCase();
  const overrideBy = payload.overrideBy;
  const overridePart = overrideBy
    ? `${String(overrideBy.id || "").trim().toLowerCase()}:${String(overrideBy.email || "").trim().toLowerCase()}:${String(overrideBy.overriddenAt || "").trim()}`
    : "";
  const approvers = [...(payload.approvers || [])]
    .map(a => `${String(a.id || "").trim().toLowerCase()}:${String(a.email || "").trim().toLowerCase()}:${String(a.approvedAt || "").trim()}`)
    .sort()
    .join("|");
  return `v2|${payload.releaseId}|${payload.commitHash || ""}|${payload.issuedAt}|${mode}|${overridePart}|${approvers}`;
}

export function signApprovalProof(payload, secret) {
  const key = String(secret || "").trim();
  if (key.length < 32) throw new Error("Approval signing secret must be at least 32 characters");
  const sig = createHmac("sha256", key).update(canonicalProofMessage(payload)).digest("hex");
  return Buffer.from(JSON.stringify({ ...payload, signature: sig }), "utf8").toString("base64");
}

function normalizeReleaseRecord(raw) {
  if (!raw || typeof raw !== "object") return { approvals: {}, veto: null };
  if (raw.approvals && typeof raw.approvals === "object") {
    return {
      approvals: { ...raw.approvals },
      veto: raw.veto && typeof raw.veto === "object" ? { ...raw.veto } : null,
    };
  }
  // Legacy schemaVersion 1 stored { [adminId]: record } directly under releases[releaseId].
  return { approvals: { ...raw }, veto: null };
}

export function createApprovalManager({
  stateFile,
  approvers = DEFAULT_REQUIRED_APPROVERS,
  requiredCount = DEFAULT_QUORUM_COUNT,
  otpTtlMs = 10 * 60 * 1000,
  otpMaxAttempts = 5,
  otpRateLimitCount = 5,
  otpIpRateLimitCount = 15,
  otpRateLimitWindowMs = 10 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  const quorum = parseQuorumConfig(requiredCount, approvers.length);
  const byId = new Map();
  const byAlias = new Map();
  for (const approver of approvers) {
    byId.set(approver.id, approver);
    for (const alias of approver.aliases) {
      byAlias.set(alias.toLowerCase(), approver);
    }
    byAlias.set(approver.email.toLowerCase(), approver);
  }

  // Persisted map: { schemaVersion: 2, releases: { [releaseId]: { approvals: { [adminId]: ... }, veto: null | {...} } } }
  let store = { schemaVersion: 2, releases: {} };

  function load() {
    if (!stateFile) return;
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
      if (parsed && (parsed.schemaVersion === 1 || parsed.schemaVersion === 2) && parsed.releases && typeof parsed.releases === "object") {
        const migrated = {};
        for (const [rel, entry] of Object.entries(parsed.releases)) {
          migrated[rel] = normalizeReleaseRecord(entry);
        }
        store = { schemaVersion: 2, releases: migrated };
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
    const raw = typeof identifier === "object" && identifier !== null
      ? (identifier.id || identifier.email)
      : identifier;
    const clean = String(raw || "").trim().toLowerCase();
    if (!clean) return null;
    return byId.get(clean) || byAlias.get(clean) || null;
  }

  function canVeto(identifier) {
    return Boolean(resolveApprover(identifier)?.canVeto);
  }

  function canOverride(identifier) {
    return Boolean(resolveApprover(identifier)?.canOverride);
  }

  function ensureRelease(rel) {
    if (!store.releases[rel]) {
      store.releases[rel] = { approvals: {}, veto: null };
    } else {
      store.releases[rel] = normalizeReleaseRecord(store.releases[rel]);
    }
    return store.releases[rel];
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
    const record = (rel && store.releases[rel]) ? normalizeReleaseRecord(store.releases[rel]) : { approvals: {}, veto: null };
    const map = record.approvals;
    const veto = rel && record.veto ? { ...record.veto } : null;
    const list = approvers.map(approver => {
      const vote = map[approver.id] || null;
      return {
        id: approver.id,
        name: approver.name,
        email: approver.email,
        canVeto: Boolean(approver.canVeto),
        canOverride: Boolean(approver.canOverride),
        approved: Boolean(vote),
        approvedAt: vote?.approvedAt || null,
        commitHash: vote?.commitHash || null,
        version: vote?.version || null,
      };
    });
    const approvedBy = list.filter(item => item.approved);
    const pending = list.filter(item => !item.approved).map(({ id, name, email }) => ({ id, name, email }));
    const quorumMet = Boolean(rel) && approvedBy.length >= quorum;
    const vetoed = Boolean(veto);
    return {
      releaseId: rel || null,
      requiredCount: quorum,
      totalApprovers: approvers.length,
      approvedCount: approvedBy.length,
      quorumMet,
      allApproved: Boolean(quorumMet && !vetoed),
      vetoed,
      veto,
      vetoHolders: approvers.filter(a => a.canVeto).map(({ id, name, email }) => ({ id, name, email })),
      approvedBy,
      pending,
      approvers: list,
    };
  }

  function approve(releaseId, approver, { commitHash = null, version = null } = {}) {
    const rel = String(releaseId || "").trim();
    if (!rel) throw new Error("No Pre-Prod release ID to approve");
    const canonical = resolveApprover(approver);
    if (!canonical) throw new Error("Unauthorized approver");
    const entry = ensureRelease(rel);
    if (entry.veto && entry.veto.id === canonical.id) {
      throw new Error("This release is currently vetoed by you. Lift the veto first before approving.");
    }
    entry.approvals[canonical.id] = {
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
    const canonical = resolveApprover(approver);
    if (!rel || !canonical) return getStatus(rel);
    const entry = store.releases[rel] ? normalizeReleaseRecord(store.releases[rel]) : null;
    if (entry && entry.approvals[canonical.id]) {
      delete entry.approvals[canonical.id];
      store.releases[rel] = entry;
      persist();
    }
    return getStatus(rel);
  }

  function veto(releaseId, actor, { reason = "", commitHash = null, version = null } = {}) {
    const rel = String(releaseId || "").trim();
    if (!rel) throw new Error("No Pre-Prod release ID to veto");
    const canonical = resolveApprover(actor);
    if (!canonical || !canonical.canVeto) throw new Error("Only Lakshmi has release veto power");
    const entry = ensureRelease(rel);
    // Clear the veto holder's own approval if they previously approved this release.
    if (entry.approvals[canonical.id]) delete entry.approvals[canonical.id];
    const cleanReason = String(reason || "").replace(/\s+/g, " ").trim().slice(0, 240);
    entry.veto = {
      id: canonical.id,
      name: canonical.name,
      email: canonical.email,
      vetoedAt: new Date(now()).toISOString(),
      reason: cleanReason || null,
      commitHash: commitHash || null,
      version: version || null,
    };
    persist();
    return getStatus(rel);
  }

  function unveto(releaseId, actor) {
    const rel = String(releaseId || "").trim();
    const canonical = resolveApprover(actor);
    if (!canonical || !canonical.canVeto) throw new Error("Only Lakshmi has release veto power");
    if (!rel || !store.releases[rel]) return { changed: false, status: getStatus(rel) };
    const entry = normalizeReleaseRecord(store.releases[rel]);
    if (!entry.veto) return { changed: false, status: getStatus(rel) };
    entry.veto = null;
    store.releases[rel] = entry;
    persist();
    return { changed: true, status: getStatus(rel) };
  }

  function buildSignedProof(releaseId, secret, { commitHash = null, version = null, overrideBy = null } = {}) {
    const rel = String(releaseId || "").trim();
    if (!rel) throw new Error("No Pre-Prod release ID to promote");
    let status = getStatus(rel);
    if (status.vetoed) {
      const reasonSuffix = status.veto?.reason ? ` (${status.veto.reason})` : "";
      throw new Error(`Release ${rel} is vetoed by ${status.veto.name}${reasonSuffix}; lift the veto before promoting`);
    }
    const issuedAt = new Date(now()).toISOString();
    if (overrideBy) {
      const canonical = resolveApprover(overrideBy);
      if (!canonical || !canonical.canOverride) {
        throw new Error("Only Lakshmi has unilateral release override power");
      }
      if (!status.approvedBy.some(a => a.id === canonical.id)) {
        status = approve(rel, canonical, { commitHash, version });
      }
      const payload = {
        schemaVersion: 2,
        releaseId: rel,
        commitHash: commitHash || status.approvedBy[0]?.commitHash || "",
        issuedAt,
        mode: "veto_override",
        overrideBy: {
          id: canonical.id,
          name: canonical.name,
          email: canonical.email,
          overriddenAt: issuedAt,
        },
        approvers: status.approvedBy.map(item => ({
          id: item.id,
          name: item.name,
          email: item.email,
          approvedAt: item.approvedAt,
        })),
      };
      return signApprovalProof(payload, secret);
    }
    if (!status.quorumMet) {
      const needed = Math.max(0, status.requiredCount - status.approvedCount);
      const names = status.pending.map(p => p.name).join(", ");
      throw new Error(`At least ${status.requiredCount} of ${status.totalApprovers} admins must approve ${rel} before promoting (${status.approvedCount}/${status.requiredCount} approved; need ${needed} more from ${names})`);
    }
    const payload = {
      schemaVersion: 2,
      releaseId: rel,
      commitHash: commitHash || status.approvedBy[0]?.commitHash || "",
      issuedAt,
      mode: "quorum",
      overrideBy: null,
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
    requiredCount: quorum,
    resolveApprover,
    canVeto,
    canOverride,
    issueOtp,
    verifyOtp,
    getStatus,
    approve,
    revoke,
    veto,
    unveto,
    buildSignedProof,
  };
}
