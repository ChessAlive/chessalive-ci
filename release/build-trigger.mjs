#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { createResourceMonitor } from "./resource-monitor.mjs";
import { dashboardHtml, loginHtml } from "./dashboard.mjs";
import { stepTemplate, emptyMetrics, elapsedMs, applyStepEvent, createLineDecoder, parseStepEvent, sampleProcessMemory, recordMemory, finishSteps } from "./build-metrics.mjs";
import { createApprovalManager, parseApproversConfig, parseQuorumConfig } from "./approvals.mjs";

import { createMonitorIssueReport, MONITOR_INTERVAL_MS, nextMonitorIncidentState } from "./monitor-policy.mjs";

let nodemailer = null;
try {
  nodemailer = (await import("nodemailer")).default;
} catch {
  // SMTP is optional; the original ChessAlive mail path uses Resend's HTTPS API.
}

const root = resolve(import.meta.dirname, "..");
const sourceDir = process.env.SOURCE_DIR || "/opt/chessalive";
const host = process.env.BUILD_TRIGGER_HOST || "0.0.0.0";
const port = Number(process.env.BUILD_TRIGGER_PORT || 8787);
const basicPassword = process.env.BUILD_TRIGGER_TOKEN || "";
const productionUrl = (process.env.PUBLIC_URL || "https://chessalive.com").replace(/\/$/, "");
const preprodUrl = (process.env.PREPROD_URL || "https://preprod.129-225-116-198.sslip.io").replace(/\/$/, "");
const defaultDeployTarget = (process.env.BUILD_DEPLOY_TARGET || "preprod").trim().toLowerCase() === "prod" ? "prod" : "preprod";
const gitUrl = (process.env.BUILD_GIT_URL || "https://github.com/ChessAlive/ChessAlive").replace(/\/$/, "");
let commitHash = process.env.BUILD_COMMIT_HASH || "unknown";
let commitMessage = process.env.BUILD_COMMIT_MESSAGE || "Current release checkout";
let commitDate = process.env.BUILD_COMMIT_DATE || "";
const sourceCommitFile = process.env.SOURCE_COMMIT_FILE || `${sourceDir}/.source-commit`;
const sourceCommitMessageFile = process.env.SOURCE_COMMIT_MESSAGE_FILE || `${sourceDir}/.source-commit-message`;
const sourceCommitDateFile = process.env.SOURCE_COMMIT_DATE_FILE || `${sourceDir}/.source-commit-date`;
const admins = (process.env.BUILD_ADMIN_EMAILS || [
  "lakshminathanlaky@gmail.com",
  "vinoth121022@gmail.com",
  "avinashr95@gmail.com",
].join(",")).split(",").map(value => value.trim()).filter(Boolean);
const stripQuotes = value => String(value ?? "").trim().replace(/^["']|["']$/g, "").trim();
const smtpUrl = stripQuotes(process.env.BUILD_SMTP_URL);
const smtpFrom = stripQuotes(process.env.BUILD_SMTP_FROM) || "ChessAlive Releases <no-reply@chessalive.com>";
const resendApiKey = stripQuotes(process.env.CHESSALIVE_RESEND_API_KEY);
const resendFrom = stripQuotes(process.env.CHESSALIVE_OTP_FROM) || smtpFrom;
const resendApiUrl = stripQuotes(process.env.RESEND_API_URL) || "https://api.resend.com/emails";
const requireEmailOtp = process.env.BUILD_REQUIRE_EMAIL_OTP === "no"
  ? false
  : (process.env.BUILD_REQUIRE_EMAIL_OTP === "yes" || Boolean(resendApiKey || (smtpUrl && nodemailer)));
const requiredApprovers = parseApproversConfig(process.env.PROMOTE_APPROVERS);
const requiredQuorum = parseQuorumConfig(process.env.PROMOTE_REQUIRED_APPROVALS, requiredApprovers.length);
const approvalStateFile = process.env.PROMOTE_APPROVAL_STATE_FILE || resolve(root, ".state/promote-approvals.json");
const approvalSecretFile = process.env.PROMOTE_APPROVAL_SECRET_FILE || "/etc/chessalive/promote-approval.key";
function loadApprovalSecret() {
  const fromEnv = stripQuotes(process.env.PROMOTE_APPROVAL_SECRET);
  if (fromEnv.length >= 32) return fromEnv;
  try {
    const fromFile = readFileSync(approvalSecretFile, "utf8").trim();
    if (fromFile.length >= 32) return fromFile;
  } catch { /* fail closed when promote is attempted */ }
  return "";
}
const approvals = createApprovalManager({ stateFile: approvalStateFile, approvers: requiredApprovers, requiredCount: requiredQuorum });
const monitorPaths = (process.env.MONITOR_PATHS || "/,/health,/version,/play,/tactics,/coach")
  .split(",").map(value => value.trim()).filter(Boolean);
const maxLogBytes = 120_000;
const execFileAsync = promisify(execFile);
const rollbackSteps = () => [
  ['rollback_prepare', 'Check fallback', 'Verify the complete previous release'],
  ['rollback_restore', 'Restore previous release', 'Restore the app, server, data and service settings together'],
  ['rollback_health', 'Verify production', 'Check health and recover the current release if needed'],
].map(([id, label, detail]) => ({ id, label, detail, status: 'pending', startedAt: null, finishedAt: null, durationMs: null, peakRssBytes: null }));
const promoteSteps = () => [
  ['promote_verify', 'Verify Pre-Prod build', 'Confirm SHA-256 manifest, route shells, and compatibility archive'],
  ['promote_handoff', 'Promote to Production', 'Zero-disruption chessgate handoff to the free production slot'],
  ['promote_health', 'Verify production', 'Check gateway health, switch active slot, and retain rollback'],
].map(([id, label, detail]) => ({ id, label, detail, status: 'pending', startedAt: null, finishedAt: null, durationMs: null, peakRssBytes: null }));
let rollback = { available: false, checkedAt: null, reason: 'Checking the previous release' };
let rollbackRefresh = null;
function derivePodTrafficRates(topology, previousTopology) {
  if (!topology || !Array.isArray(topology.pods)) return topology || null;
  const elapsed = previousTopology && typeof topology.sampledAtMs === 'number' && typeof previousTopology.sampledAtMs === 'number'
    ? (topology.sampledAtMs - previousTopology.sampledAtMs) / 1000
    : 0;
  const prevPods = new Map((previousTopology?.pods || []).map(pod => [pod.id, pod]));
  for (const pod of topology.pods) {
    const prev = prevPods.get(pod.id);
    const sameRelease = prev && pod.releaseId && pod.releaseId === prev.releaseId;
    const reqCurr = pod.traffic?.httpRequestsTotal;
    const reqPrev = prev?.traffic?.httpRequestsTotal;
    const bytesCurr = pod.traffic?.httpResponseBytesTotal;
    const bytesPrev = prev?.traffic?.httpResponseBytesTotal;
    if (!pod.traffic) pod.traffic = {};
    pod.traffic.requestsPerSecond = sameRelease && elapsed > 0 && typeof reqCurr === 'number' && typeof reqPrev === 'number' && reqCurr >= reqPrev
      ? (reqCurr - reqPrev) / elapsed
      : null;
    pod.traffic.responseBytesPerSecond = sameRelease && elapsed > 0 && typeof bytesCurr === 'number' && typeof bytesPrev === 'number' && bytesCurr >= bytesPrev
      ? (bytesCurr - bytesPrev) / elapsed
      : null;
  }
  return topology;
}
function refreshRollback() {
  if (rollbackRefresh) return rollbackRefresh;
  rollbackRefresh = (async () => {
    try {
      const { stdout } = await execFileAsync('bash', ['./release/rollback-chessd.sh', '--status'], {
        cwd: root, timeout: 15000, maxBuffer: 250000,
        env: { ...process.env, CI_ROOT: root, SOURCE_ROOT: sourceDir, PUBLIC_URL: productionUrl },
      });
      const result = JSON.parse(stdout);
      if (typeof result.available !== 'boolean') throw new Error('Invalid rollback status');
      if (result.topology) result.topology = derivePodTrafficRates(result.topology, rollback?.topology);
      rollback = { ...result, checkedAt: new Date().toISOString() };
    } catch { rollback = { ...rollback, available: false, checkedAt: new Date().toISOString(), reason: 'The previous release could not be verified' }; }
    finally { rollbackRefresh = null; }
  })();
  return rollbackRefresh;
}

const state = {
  release: { status: "idle", runId: 0, startedAt: null, finishedAt: null, exitCode: null, log: "", steps: stepTemplate(), metrics: emptyMetrics(), child: null },
  monitor: { level: "unknown", checkedAt: null, latencyMs: null, summary: "Waiting for the first production check", checks: [], production: null, previousLevel: "unknown" },
};
const resources = createResourceMonitor({
  enabled: process.env.BUILD_RESOURCE_MONITOR_ENABLED !== 'no',
  remoteHost: process.env.DEPLOY_HOST || '161.118.175.12',
  remoteUser: process.env.DEPLOY_USER || 'ubuntu',
  remoteKey: process.env.DEPLOY_SSH_KEY || undefined,
  intervalMs: process.env.BUILD_RESOURCE_MONITOR_INTERVAL_MS,
  cloudEnabled: process.env.BUILD_CLOUD_MONITOR_ENABLED !== 'no',
  cloudIntervalMs: process.env.BUILD_CLOUD_MONITOR_INTERVAL_MS,
});
const sessions = new Map();
let monitorIncidentActive = false;
const sessionCookie = "chessalive_ci_session";
const sessionTtlMs = 12 * 60 * 60 * 1000;

function refreshCommitMetadata() {
  try {
    const sourceHash = readFileSync(sourceCommitFile, "utf8").trim();
    if (/^[0-9a-f]{7,64}$/i.test(sourceHash)) commitHash = sourceHash;
    const sourceMessage = readFileSync(sourceCommitMessageFile, "utf8").trim();
    if (sourceMessage) commitMessage = sourceMessage;
    const sourceDate = readFileSync(sourceCommitDateFile, "utf8").trim();
    if (sourceDate) commitDate = sourceDate;
  } catch {
    // The source marker is written by the release lane after a successful source sync.
  }
}

refreshCommitMetadata();

function hash(value) { return createHash("sha256").update(String(value)).digest(); }
function safeEqual(left, right) { return timingSafeEqual(hash(left), hash(right)); }

function cookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map(value => {
    const separator = value.indexOf("=");
    return separator < 0 ? ["", ""] : [value.slice(0, separator).trim(), decodeURIComponent(value.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function getSession(request) {
  if (!basicPassword) return null;
  const token = cookies(request)[sessionCookie];
  const entry = token ? sessions.get(token) : undefined;
  if (!entry) return null;
  const issuedAt = typeof entry === "number" ? entry : entry.issuedAt;
  if (Date.now() - issuedAt > sessionTtlMs) { sessions.delete(token); return null; }
  const updated = typeof entry === "number" ? { issuedAt: Date.now(), admin: null, otpVerified: false } : { ...entry, issuedAt: Date.now() };
  sessions.set(token, updated);
  return { token, ...updated };
}

function authorized(request) {
  return Boolean(getSession(request));
}

function requireAuth(request, response) {
  const session = getSession(request);
  if (session) return session;
  response.writeHead(401, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Authentication required" }));
  return null;
}

function clientAddress(request) {
  const cf = String(request.headers["cf-connecting-ip"] || "").trim();
  if (cf) return cf;
  const xff = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (xff) return xff;
  return request.socket?.remoteAddress || "unknown";
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.on("data", chunk => { body += chunk; if (body.length > 8_000) reject(new Error("request too large")); });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

const releaseStateFile = process.env.BUILD_STATE_FILE || resolve(root, '.state/latest-release.json');
function persistRelease() {
  try {
    const { child, ...release } = state.release;
    mkdirSync(dirname(releaseStateFile), { recursive: true });
    writeFileSync(`${releaseStateFile}.tmp`, JSON.stringify({ ...release, savedAt: new Date().toISOString() }), { mode: 0o600 });
    renameSync(`${releaseStateFile}.tmp`, releaseStateFile);
  } catch (error) { console.error(`Could not save release metrics: ${error.message}`); }
}
try {
  const saved = JSON.parse(readFileSync(releaseStateFile, 'utf8'));
  if (Array.isArray(saved.steps) && saved.metrics && Number.isSafeInteger(saved.runId)) {
    state.release = { ...saved, child: null };
    if (saved.status === 'running') {
      state.release.status = 'interrupted';
      state.release.finishedAt = saved.savedAt || saved.startedAt;
      finishSteps(state.release.steps, false, Date.parse(state.release.finishedAt));
      state.release.log += '\nConsole restarted before this release reported completion. Timings stop at the last saved observation.\n';
    }
    state.release.metrics.currentRssBytes = null;
    state.release.metrics.available = false;
  }
} catch { /* First run has no saved metrics. */ }

function appendLog(chunk) {
  state.release.log = `${state.release.log}${chunk}`.slice(-maxLogBytes);
}

function updateStepFromLine(line) {
  const event = parseStepEvent(line);
  if (event && applyStepEvent(state.release.steps, event)) persistRelease();
}

function publicState(session = null) {
  const production = state.monitor.production || {};
  const deployedCommit = rollback.current ? (rollback.current.commitHash || 'unknown') : (state.release.kind === 'rollback' ? 'unknown' : commitHash);
  const pp = rollback.preprod || {};
  const ppCommit = pp.commitHash || 'unknown';
  const approvalStatus = approvals.getStatus(pp.releaseId);
  const artifactPromotable = Boolean(pp.promotable);
  const fullyPromotable = Boolean(artifactPromotable && !approvalStatus.vetoed && approvalStatus.quorumMet);
  const userCanVeto = Boolean(session?.admin && approvals.canVeto(session.admin));
  const userCanOverride = Boolean(session?.admin && approvals.canOverride(session.admin));
  const canOverridePromote = Boolean(artifactPromotable && !approvalStatus.vetoed && !approvalStatus.quorumMet && session?.otpVerified && userCanOverride);
  return {
    serverTime: new Date().toISOString(),
    currentUser: session?.admin ? { ...session.admin, otpVerified: Boolean(session.otpVerified), canVeto: userCanVeto, canOverride: userCanOverride } : null,
    requireEmailOtp,
    resources: resources.publicState(),
    rollback,
    preprod: {
      url: preprodUrl,
      enabled: defaultDeployTarget === 'preprod',
      releaseId: pp.releaseId || null,
      version: pp.version || null,
      healthy: Boolean(pp.healthy),
      systemdState: pp.systemdState || 'inactive',
      complete: Boolean(pp.complete),
      artifactPromotable,
      vetoed: Boolean(approvalStatus.vetoed),
      promotable: fullyPromotable,
      canOverridePromote,
      inSyncWithProd: Boolean(pp.inSyncWithProd),
      reason: !artifactPromotable
        ? (pp.reason || 'no_preprod_release')
        : approvalStatus.vetoed
          ? 'vetoed'
          : approvalStatus.quorumMet
            ? 'ready_to_promote'
            : 'awaiting_approvals',
      approvals: approvalStatus,
      commitHash: ppCommit,
      commitMessage: pp.commitMessage || (pp.releaseId ? 'Staged pre-prod release' : 'No pre-prod build deployed yet'),
      commitDate: pp.commitDate || null,
      gitLink: ppCommit !== 'unknown' ? `${gitUrl}/commit/${ppCommit}` : gitUrl,
      traffic: pp.traffic || null,
      resources: pp.resources || null,
    },
    topology: rollback.topology || null,
    release: { kind: state.release.kind || 'build', status: state.release.status, runId: state.release.runId, startedAt: state.release.startedAt, finishedAt: state.release.finishedAt, exitCode: state.release.exitCode, durationMs: elapsedMs(state.release.startedAt, state.release.finishedAt), metrics: state.release.metrics, steps: state.release.steps.map(item => ({ ...item, durationMs: item.startedAt ? elapsedMs(item.startedAt, item.finishedAt) : item.durationMs })), log: state.release.log.slice(-14_000) },
    production: { url: productionUrl, version: production.version || null, builtAt: production.builtAt || null, commitHash: deployedCommit, commitMessage: rollback.current?.commitMessage || (deployedCommit === 'unknown' ? 'Deployed source metadata unavailable' : commitMessage), commitDate: rollback.current ? rollback.current.commitDate : commitDate, gitLink: deployedCommit !== "unknown" ? `${gitUrl}/commit/${deployedCommit}` : gitUrl },
    monitor: { level: state.monitor.level, checkedAt: state.monitor.checkedAt, latencyMs: state.monitor.latencyMs, summary: state.monitor.summary, checks: state.monitor.checks },
    admins,
    notifications: {
      configured: Boolean(resendApiKey || (smtpUrl && nodemailer)),
      provider: resendApiKey ? "Resend" : (smtpUrl && nodemailer ? "SMTP" : null),
      resendConfigured: Boolean(resendApiKey),
      smtpConfigured: Boolean(smtpUrl && nodemailer),
      smtpAvailable: Boolean(nodemailer),
    },
  };
}

function releaseStepsHtml() {
  return state.release.steps.map(item => `<li><strong>${item.status === "done" ? "✓" : item.status === "failed" ? "!" : "•"} ${item.label}</strong><span>${item.detail}</span></li>`).join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

function releaseCommitHtml(succeeded) {
  const hash = commitHash !== "unknown" ? commitHash : "Source commit unavailable";
  const hashText = escapeHtml(hash.slice(0, 12));
  const commitLink = commitHash !== "unknown"
    ? `<a href="${escapeHtml(`${gitUrl}/commit/${commitHash}`)}" style="color:#8cc2ff">${hashText}</a>`
    : hashText;
  const message = escapeHtml(commitMessage);
  const date = commitDate ? `<br>Committed: ${escapeHtml(commitDate)}` : "";
  return `<li><strong>${succeeded ? "Commit deployed" : "Commit attempted"}</strong><span>${commitLink} — ${message}${date}</span></li>`;
}

function releaseCommitSummary() {
  if (commitHash === "unknown") return "Source commit metadata is unavailable.";
  return `Commit ${commitHash} — ${commitMessage}${commitDate ? ` (${commitDate})` : ""}.`;
}

async function sendOtpEmail(approver, code) {
  const subject = `ChessAlive Release Console sign-in code: ${code}`;
  const html = `<!doctype html><html><body style="margin:0;background:#08111f;font-family:Arial,sans-serif;color:#eaf1ff"><div style="max-width:540px;margin:24px auto;padding:30px;background:#111e33;border:1px solid #29415f;border-radius:16px"><div style="font-size:12px;letter-spacing:2px;color:#6ea8ff">CHESSALIVE RELEASE CONSOLE</div><h1 style="margin:14px 0 8px;color:#fff;font-size:22px">Hi ${escapeHtml(approver.name)}, here is your sign-in code</h1><p style="color:#b8c9e5;line-height:1.6">Use this 6-digit one-time code to verify your admin identity and approve Pre-Prod → Production releases. It expires in 10 minutes.</p><div style="margin:22px 0;padding:18px;border-radius:10px;background:#0b1627;border:1px solid #2a4668;text-align:center;font-size:34px;font-weight:700;letter-spacing:8px;color:#c8f1db;font-family:monospace">${escapeHtml(code)}</div><p style="color:#8da6c8;font-size:12px;line-height:1.6">Never share this code with anyone. Any 2 of 3 authorized admins (Lakshmi, Vinoth, Avinash) must verify individually before promoting to Production (Lakshmi also holds release veto &amp; override power).</p></div></body></html>`;
  const text = `Hi ${approver.name},\n\nYour ChessAlive Release Console sign-in code is: ${code}\n\nIt expires in 10 minutes. Never share this code.`;
  if (resendApiKey) {
    const response = await fetch(resendApiUrl, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: resendFrom, to: [approver.email], subject, html, text }),
    });
    if (!response.ok) throw new Error(`Email delivery failed (Resend ${response.status})`);
    return true;
  }
  if (smtpUrl && nodemailer) {
    const transporter = nodemailer.createTransport(smtpUrl);
    await transporter.sendMail({ from: smtpFrom, to: approver.email, subject, text, html });
    return true;
  }
  throw new Error("No email provider is configured to deliver admin verification codes.");
}

async function sendAdminEmail(subject, title, summary, extraHtml = "") {
  try {
    const safeTitle = escapeHtml(title);
    const safeSummary = escapeHtml(summary).replaceAll("\n", "<br>");
    const html = `<!doctype html><html><body style="margin:0;background:#08111f;font-family:Arial,sans-serif;color:#eaf1ff"><div style="max-width:680px;margin:24px auto;padding:30px;background:#111e33;border:1px solid #29415f;border-radius:18px"><div style="font-size:13px;letter-spacing:2px;color:#6ea8ff">CHESSALIVE RELEASE CONSOLE</div><h1 style="margin:14px 0 8px;color:#fff">${safeTitle}</h1><p style="color:#b8c9e5;line-height:1.6">${safeSummary}</p><ul style="padding-left:20px;line-height:1.9">${extraHtml || releaseStepsHtml()}</ul><p style="margin-top:24px"><a href="${escapeHtml(productionUrl)}" style="color:#8cc2ff">Open production</a></p></div></body></html>`;
    const text = `${title}\n\n${summary}\n\n${productionUrl}`;
    if (resendApiKey) {
      const response = await fetch(resendApiUrl, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: resendFrom, to: admins, subject, html, text }),
      });
      if (!response.ok) throw new Error(`Resend ${response.status}: ${(await response.text()).slice(0, 240)}`);
      appendLog(`[notify] Admin email sent via Resend to ${admins.length} recipients.\n`); return true;
    }
    if (!smtpUrl || !nodemailer) { appendLog("[notify] No email provider is configured; admin email was not sent.\n"); return false; }
    const transporter = nodemailer.createTransport(smtpUrl);
    await transporter.sendMail({
      from: smtpFrom, to: admins.join(","), subject,
      text, html,
    });
    appendLog(`[notify] Admin email sent via SMTP to ${admins.length} recipients.\n`); return true;
  } catch (error) { appendLog(`[notify] Admin email failed: ${error.message}\n`); return false; }
}

function startBuild(kind = 'build', options = {}) {
  if (state.release.child) return false;
  refreshCommitMetadata();
  const isRollback = kind === 'rollback';
  const isPromote = kind === 'promote';
  const targetEnv = defaultDeployTarget;
  const script = isRollback ? './release/rollback-chessd.sh' : isPromote ? './release/promote-chessd.sh' : './release/local-release.sh';
  const actorLine = options.actor ? `Triggered by ${options.actor.name} (${options.actor.email})\n` : '';
  const approvalLine = isPromote && options.approversSummary
    ? (options.overrideUsed
      ? `Authorized via Lakshmi unilateral release override: ${options.approversSummary}\n`
      : `Verified 2-of-3 admin approval quorum: ${options.approversSummary}\n`)
    : '';
  const initialLog = isRollback
    ? `${actorLine}Restoring the previous retained release on Mumbai\n`
    : isPromote
      ? `${actorLine}${approvalLine}Promoting verified Pre-Prod release to Mumbai production (zero-disruption handoff)\n`
      : `${actorLine}Starting full release #${state.release.runId + 1} from ${sourceDir} (target: ${targetEnv})\n`;
  state.release = { kind, status: 'running', runId: state.release.runId + 1, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, log: initialLog, steps: isRollback ? rollbackSteps() : isPromote ? promoteSteps() : stepTemplate(), metrics: emptyMetrics(), child: null };
  const extraEnv = isPromote && options.approvalProof ? { CHESSALIVE_APPROVAL_PROOF: options.approvalProof } : {};
  const child = spawn("bash", [script], {
    cwd: root,
    detached: true,
    env: { ...process.env, ...extraEnv, CHESSALIVE_PROGRESS: "yes", SOURCE_DIR: sourceDir, SOURCE_ROOT: sourceDir, CI_ROOT: root, LOCAL_DEPLOY: (isRollback || isPromote) ? 'no' : 'yes', PUBLIC_URL: productionUrl, PREPROD_URL: preprodUrl, DEPLOY_TARGET: targetEnv, SKIP_INSTALL: "no", SKIP_TESTS: "no", SKIP_FULL_TESTS: process.env.BUILD_SKIP_FULL_TESTS || "no", SKIP_WEB_SETUP: "yes", SKIP_BUDGETS: process.env.BUILD_SKIP_BUDGETS || "no", SKIP_ASSETS: "yes", SKIP_CONTENT: (isRollback || isPromote) ? "yes" : "no", SKIP_DEPLOY: "no" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.release.child = child;
  const decoders = [child.stdout, child.stderr].map(stream => {
    const decoder = createLineDecoder(updateStepFromLine);
    stream.setEncoding('utf8');
    stream.on('data', data => { appendLog(data); decoder.write(data); });
    return decoder;
  });
  let sampling = false;
  let lastSave = 0;
  async function sample() {
    if (sampling || state.release.child !== child || !child.pid) return;
    sampling = true;
    try {
      const rss = await sampleProcessMemory(child.pid);
      if (state.release.child === child) recordMemory(state.release, rss);
    } catch { if (state.release.child === child) recordMemory(state.release, null); }
    finally { sampling = false; }
    if (state.release.child === child && Date.now() - lastSave >= 5000) { persistRelease(); lastSave = Date.now(); }
  }
  const timer = setInterval(() => void sample(), 1000);
  void sample();
  persistRelease();
  child.on('error', error => appendLog(`\nprocess error: ${error.message}\n`));
  child.on('close', (code, signal) => {
    clearInterval(timer);
    decoders.forEach(decoder => decoder.end());
    refreshCommitMetadata();
    state.release.exitCode = code;
    state.release.status = code === 0 ? 'succeeded' : 'failed';
    state.release.finishedAt = new Date().toISOString();
    state.release.child = null;
    state.release.metrics.currentRssBytes = null;
    state.release.metrics.available = false;
    finishSteps(state.release.steps, code === 0);
    appendLog(`\nFinished with ${signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`}.\n`);
    persistRelease();
    void refreshRollback();
    void monitorProduction();
    if (isRollback) void sendAdminEmail(code === 0 ? 'ChessAlive rollback completed' : 'ChessAlive rollback needs attention', code === 0 ? 'Previous release restored' : 'Rollback did not complete', code === 0 ? 'The retained previous release is live on Mumbai and passed the health check.' : `Rollback did not complete. Review the operation log. Exit code: ${code ?? 'unknown'}.`);
    else if (isPromote) void sendAdminEmail(code === 0 ? `ChessAlive Pre-Prod promoted to Production (#${state.release.runId})` : `ChessAlive production promotion #${state.release.runId} failed`, code === 0 ? 'Pre-Prod promoted to Production' : 'Production promotion needs attention', code === 0 ? `The tested Pre-Prod release is now live on Mumbai production with zero-disruption handoff. ${releaseCommitSummary()}` : `Promotion did not complete; production remained on its prior release. Exit code: ${code ?? 'unknown'}.`);
    else if (targetEnv === 'preprod') void sendAdminEmail(code === 0 ? `ChessAlive Pre-Prod #${state.release.runId} ready for testing` : `ChessAlive Pre-Prod build #${state.release.runId} failed`, code === 0 ? 'Pre-Prod build ready for admin testing' : 'Pre-Prod build needs attention', code === 0 ? `The requested source commit is live on Pre-Prod (${preprodUrl}). Production was not touched. Test thoroughly, then click "Promote to Production" in the Release Console. ${releaseCommitSummary()}` : `The Pre-Prod build did not complete; production was untouched. Exit code: ${code ?? 'unknown'}. ${releaseCommitSummary()}`, releaseCommitHtml(code === 0));
    else void sendAdminEmail(code === 0 ? `ChessAlive release #${state.release.runId} deployed` : `ChessAlive release #${state.release.runId} failed`, code === 0 ? "Release deployed successfully" : "Release needs attention", code === 0 ? `The requested source commit is live on Mumbai production. ${releaseCommitSummary()}` : `The release did not complete, so the requested source commit was not deployed. Exit code: ${code ?? "unknown"}. ${releaseCommitSummary()}`, releaseCommitHtml(code === 0));
  });
  return true;
}

async function checkPath(path) {
  const started = Date.now(); const url = `${productionUrl}${path.startsWith("/") ? path : `/${path}`}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "follow" });
    const contentType = response.headers.get("content-type") || "";
    if (response.ok && contentType.includes("text/html")) {
      const html = await response.text();
      if (html.includes("data-ca-resumable-loader") || html.includes("/_expo/static/js/web/")) {
        const shellVersion = html.match(/__caShellVersion\s*=\s*["']([^"']+)["']/)?.[1] || null;
        const scripts = [...html.matchAll(/\/_expo\/static\/js\/web\/[^"'?\s\\]+\.js(?:\?v=([^"'\s\\]+))?/g)];
        if (!html.includes("data-ca-resumable-loader") || !scripts.length) {
          return { path, ok: false, status: response.status, latencyMs: Date.now() - started, error: "route shell missing resumable loader or entry scripts" };
        }
        for (const match of scripts) {
          if (shellVersion && match[1] && match[1] !== shellVersion) {
            return { path, ok: false, status: response.status, latencyMs: Date.now() - started, error: `entry script version ${match[1]} != ${shellVersion}` };
          }
        }
        const indexScript = (scripts.find(m => m[0].includes("/index-")) || scripts[scripts.length - 1])[0];
        const scriptRes = await fetch(`${productionUrl}${indexScript}`, { method: "HEAD", signal: AbortSignal.timeout(8_000) });
        if (!scriptRes.ok) {
          return { path, ok: false, status: scriptRes.status, latencyMs: Date.now() - started, error: `entry script ${indexScript} HTTP ${scriptRes.status}` };
        }
        return { path, ok: true, status: response.status, latencyMs: Date.now() - started, shellVersion };
      }
    }
    return { path, ok: response.ok, status: response.status, latencyMs: Date.now() - started };
  }
  catch (error) { return { path, ok: false, status: 0, latencyMs: Date.now() - started, error: error.message }; }
}

async function monitorProduction() {
  const checks = await Promise.all(monitorPaths.map(checkPath));
  const rootShellVersion = checks.find(item => item.path === "/" && item.shellVersion)?.shellVersion || null;
  if (rootShellVersion) {
    for (const item of checks) {
      if (item.ok && item.shellVersion && item.shellVersion !== rootShellVersion) {
        item.ok = false;
        item.error = `shellVersion ${item.shellVersion} != root ${rootShellVersion}`;
      }
    }
  }
  const versionCheck = checks.find(item => item.path === "/version"); let version = null;
  if (versionCheck?.ok) { try { const response = await fetch(`${productionUrl}/version`, { signal: AbortSignal.timeout(8_000) }); const body = await response.json(); version = body.version || body; } catch { /* metadata refreshes on the next sweep */ } }
  const criticalFailure = checks.some(item => (item.path === "/" || item.path === "/health" || item.path === "/version") && !item.ok);
  const anyFailure = checks.some(item => !item.ok); const slow = checks.some(item => item.latencyMs > 3_000); const level = criticalFailure ? "red" : (anyFailure || slow ? "orange" : "green"); const previousLevel = state.monitor.level;
  state.monitor = { level, previousLevel, checkedAt: new Date().toISOString(), latencyMs: checks.length ? Math.max(...checks.map(item => item.latencyMs)) : null, summary: level === "green" ? "All production checks are healthy" : level === "orange" ? "Some checks need attention" : "Production availability is down", checks, production: version ? { version, builtAt: version.builtAt || null } : state.monitor.production };
  const incident = nextMonitorIncidentState(monitorIncidentActive, level);
  monitorIncidentActive = incident.active;
  if (incident.shouldNotify) {
    const issue = createMonitorIssueReport(checks);
    const issueHtml = issue.details.map(detail => `<li>${escapeHtml(detail)}</li>`).join("");
    void sendAdminEmail(issue.subject, "Production monitoring found an issue", issue.summary, issueHtml);
  }
}

const branding = new Map([
  ['/branding/chessalive-logo.png', readFileSync(new URL('./branding/chessalive-logo.png', import.meta.url))],
  ['/branding/favicon.png', readFileSync(new URL('./branding/favicon.png', import.meta.url))],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === 'GET' && branding.has(url.pathname)) {
    response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    return response.end(branding.get(url.pathname));
  }
  if (url.pathname === "/health" && request.method === "GET") return sendJson(response, 200, { ok: true, build: state.release.status, monitor: state.monitor.level });
  if (url.pathname === "/api/login/config" && request.method === "GET") {
    return sendJson(response, 200, {
      requireEmailOtp,
      requiredCount: approvals.requiredCount,
      approvers: requiredApprovers.map(a => ({ id: a.id, name: a.name, email: a.email, canVeto: Boolean(a.canVeto), canOverride: Boolean(a.canOverride) })),
    });
  }
  if (url.pathname === "/api/login/request-otp" && request.method === "POST") {
    try {
      const body = JSON.parse(await readBody(request));
      if (!basicPassword || typeof body.password !== "string" || !safeEqual(body.password, basicPassword)) {
        return sendJson(response, 401, { error: "Incorrect console password" });
      }
      const issued = approvals.issueOtp(body.email, clientAddress(request));
      if (!issued.ok) return sendJson(response, issued.status, { error: issued.error });
      await sendOtpEmail(issued.approver, issued.code);
      return sendJson(response, 200, {
        challengeId: issued.challengeId,
        name: issued.approver.name,
        email: issued.approver.email,
        expiresAt: issued.expiresAt,
      });
    } catch (error) {
      return sendJson(response, 400, { error: error.message === "request too large" ? error.message : (error.message || "Unable to send verification code") });
    }
  }
  if (url.pathname === "/api/login/verify-otp" && request.method === "POST") {
    try {
      const body = JSON.parse(await readBody(request));
      const verified = approvals.verifyOtp(body.challengeId, body.email, body.code);
      if (!verified.ok) return sendJson(response, verified.status, { error: verified.error });
      const token = randomBytes(32).toString("hex");
      const admin = { id: verified.approver.id, name: verified.approver.name, email: verified.approver.email };
      sessions.set(token, { issuedAt: Date.now(), admin, otpVerified: true });
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTtlMs / 1000}`,
        "Cache-Control": "no-store",
      });
      return response.end(JSON.stringify({ ok: true, admin }));
    } catch (error) {
      return sendJson(response, 400, { error: error.message === "request too large" ? error.message : "Invalid verification request" });
    }
  }
  if (url.pathname === "/api/login" && request.method === "POST") {
    if (requireEmailOtp) {
      return sendJson(response, 400, { error: "Individual admin email OTP verification is required. Select your admin account to receive a 6-digit login code." });
    }
    try {
      const body = JSON.parse(await readBody(request));
      if (!basicPassword || typeof body.password !== "string" || !safeEqual(body.password, basicPassword))
        return sendJson(response, 401, { error: "Incorrect password" });
      const token = randomBytes(32).toString("hex");
      const resolved = body.email ? approvals.resolveApprover(body.email) : null;
      sessions.set(token, {
        issuedAt: Date.now(),
        admin: resolved ? { id: resolved.id, name: resolved.name, email: resolved.email } : null,
        otpVerified: false,
      });
      response.writeHead(204, { "Set-Cookie": `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTtlMs / 1000}`, "Cache-Control": "no-store" });
      return response.end();
    } catch (error) {
      return sendJson(response, 400, { error: error.message === "request too large" ? error.message : "Invalid request" });
    }
  }
  if (url.pathname === "/api/logout" && request.method === "POST") {
    const token = cookies(request)[sessionCookie];
    if (token) sessions.delete(token);
    response.writeHead(204, {
      "Set-Cookie": `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      "Cache-Control": "no-store",
    });
    return response.end();
  }
  if (url.pathname === "/" && request.method === "GET" && !authorized(request)) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return response.end(loginHtml);
  }
  const session = requireAuth(request, response);
  if (!session) return;
  if (url.pathname === "/" && request.method === "GET") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return response.end(dashboardHtml); }
  if (url.pathname === "/api/status" && request.method === "GET") return sendJson(response, 200, publicState(session));
  if (url.pathname === "/api/build" && request.method === "POST") { if (!startBuild('build', { actor: session.admin })) return sendJson(response, 409, { error: "a release is already running", ...publicState(session) }); return sendJson(response, 202, publicState(session)); }
  if (url.pathname === "/api/promote/approve" && request.method === "POST") {
    if (!session.admin?.id || !session.otpVerified) {
      return sendJson(response, 403, { error: "Sign in individually with your personal admin email verification code to approve a build.", ...publicState(session) });
    }
    if (state.release.child) return sendJson(response, 409, { error: "a release is already running", ...publicState(session) });
    await refreshRollback();
    const pp = rollback.preprod;
    if (!pp?.promotable || !pp.releaseId) {
      const reason = pp?.reason === "already_live"
        ? "This Pre-Prod build is already live in production."
        : "No verified Pre-Prod build is waiting for approval.";
      return sendJson(response, 409, { error: reason, ...publicState(session) });
    }
    const existingStatus = approvals.getStatus(pp.releaseId);
    if (existingStatus.vetoed && existingStatus.veto?.id === session.admin.id) {
      return sendJson(response, 409, {
        error: "This Pre-Prod release is currently vetoed by you. Lift the veto first before approving.",
        ...publicState(session),
      });
    }
    const updated = approvals.approve(pp.releaseId, session.admin, { commitHash: pp.commitHash, version: pp.version });
    const pendingNames = updated.pending.map(p => p.name).join(", ");
    const approvedNames = updated.approvedBy.map(a => a.name).join(", ");
    const vetoReason = updated.veto?.reason ? ` (${updated.veto.reason})` : "";
    const subject = updated.vetoed
      ? `ChessAlive Pre-Prod approval ${updated.approvedCount}/${updated.totalApprovers} (${session.admin.name}) — VETOED by ${updated.veto.name}`
      : updated.quorumMet
        ? `ChessAlive Pre-Prod APPROVED (${updated.approvedCount}/${updated.totalApprovers} quorum) — Ready to Promote`
        : `ChessAlive Pre-Prod approval ${updated.approvedCount}/${updated.requiredCount} (${session.admin.name})`;
    const title = updated.vetoed
      ? `Approval recorded — promotion still blocked by ${updated.veto.name}'s veto`
      : updated.quorumMet
        ? `Quorum met (${updated.approvedCount} of ${updated.totalApprovers} admins approved)`
        : `Approval ${updated.approvedCount} of ${updated.requiredCount} recorded`;
    const summary = updated.vetoed
      ? `${session.admin.name} approved Pre-Prod release ${pp.releaseId} (${updated.approvedCount}/${updated.totalApprovers}: ${approvedNames}), but promotion remains BLOCKED by ${updated.veto.name}'s veto${vetoReason}.`
      : updated.quorumMet
        ? `${session.admin.name} approved Pre-Prod release ${pp.releaseId} (${updated.approvedCount}/${updated.totalApprovers}: ${approvedNames}). Quorum of ${updated.requiredCount} met — Ready to Promote to Production!`
        : `${session.admin.name} approved Pre-Prod release ${pp.releaseId} (${updated.approvedCount}/${updated.requiredCount} needed). Waiting for ${updated.requiredCount - updated.approvedCount} more approval from: ${pendingNames} (or Lakshmi override).`;
    void sendAdminEmail(subject, title, `${summary}\nPre-Prod URL: ${preprodUrl}`);
    return sendJson(response, 200, publicState(session));
  }
  if (url.pathname === "/api/promote/revoke" && request.method === "POST") {
    if (!session.admin?.id || !session.otpVerified) {
      return sendJson(response, 403, { error: "Individual admin email sign-in is required.", ...publicState(session) });
    }
    await refreshRollback();
    const pp = rollback.preprod;
    if (pp?.releaseId) {
      approvals.revoke(pp.releaseId, session.admin);
    }
    return sendJson(response, 200, publicState(session));
  }
  if (url.pathname === "/api/promote/veto" && request.method === "POST") {
    if (!session.admin?.id || !session.otpVerified) {
      return sendJson(response, 403, { error: "Individual admin email sign-in is required.", ...publicState(session) });
    }
    if (!approvals.canVeto(session.admin)) {
      return sendJson(response, 403, { error: "Only Lakshmi has release veto power.", ...publicState(session) });
    }
    if (state.release.child) return sendJson(response, 409, { error: "a release is already running", ...publicState(session) });
    let body = {};
    try {
      const raw = await readBody(request);
      if (raw.trim()) body = JSON.parse(raw);
    } catch (error) {
      return sendJson(response, 400, { error: error.message === "request too large" ? error.message : "Invalid veto request", ...publicState(session) });
    }
    await refreshRollback();
    const pp = rollback.preprod;
    if (!pp?.promotable || !pp.releaseId) {
      const reason = pp?.reason === "already_live"
        ? "This Pre-Prod build is already live in production."
        : "No verified Pre-Prod build is waiting for promotion.";
      return sendJson(response, 409, { error: reason, ...publicState(session) });
    }
    const updated = approvals.veto(pp.releaseId, session.admin, {
      reason: typeof body?.reason === "string" ? body.reason : "",
      commitHash: pp.commitHash,
      version: pp.version,
    });
    const reasonText = updated.veto?.reason ? `\nReason: ${updated.veto.reason}` : "";
    void sendAdminEmail(
      `ChessAlive Pre-Prod VETOED by ${session.admin.name} (${pp.releaseId})`,
      `Pre-Prod release vetoed by ${session.admin.name}`,
      `${session.admin.name} vetoed Pre-Prod release ${pp.releaseId}.${reasonText}\nPromotion to Production is blocked (even if other admins approve) until ${session.admin.name} lifts the veto or a newer Pre-Prod build is deployed.\nPre-Prod URL: ${preprodUrl}`
    );
    return sendJson(response, 200, publicState(session));
  }
  if (url.pathname === "/api/promote/unveto" && request.method === "POST") {
    if (!session.admin?.id || !session.otpVerified) {
      return sendJson(response, 403, { error: "Individual admin email sign-in is required.", ...publicState(session) });
    }
    if (!approvals.canVeto(session.admin)) {
      return sendJson(response, 403, { error: "Only Lakshmi has release veto power.", ...publicState(session) });
    }
    if (state.release.child) return sendJson(response, 409, { error: "a release is already running", ...publicState(session) });
    await refreshRollback();
    const pp = rollback.preprod;
    if (pp?.releaseId) {
      const result = approvals.unveto(pp.releaseId, session.admin);
      if (result.changed) {
        const st = result.status;
        const readiness = st.quorumMet
          ? `Quorum is met (${st.approvedCount}/${st.totalApprovers}) — Ready to Promote to Production.`
          : `Currently ${st.approvedCount}/${st.requiredCount} approvals recorded.`;
        void sendAdminEmail(
          `ChessAlive Pre-Prod veto lifted by ${session.admin.name} (${pp.releaseId})`,
          `Release veto lifted by ${session.admin.name}`,
          `${session.admin.name} lifted the veto on Pre-Prod release ${pp.releaseId}. ${readiness}\nPre-Prod URL: ${preprodUrl}`
        );
      }
    }
    return sendJson(response, 200, publicState(session));
  }
  if (url.pathname === '/api/promote' && request.method === 'POST') {
    if (!session.admin?.id || !session.otpVerified) {
      return sendJson(response, 403, { error: 'Individual admin email sign-in is required to promote to production.', ...publicState(session) });
    }
    if (state.release.child) return sendJson(response, 409, { error: 'a release is already running', ...publicState(session) });
    let body = {};
    try {
      const raw = await readBody(request);
      if (raw.trim()) body = JSON.parse(raw);
    } catch (error) {
      return sendJson(response, 400, { error: error.message === 'request too large' ? error.message : 'Invalid promote request', ...publicState(session) });
    }
    const overrideRequested = body?.override === true;
    await refreshRollback();
    const pp = rollback.preprod;
    if (!pp?.promotable || !pp.releaseId) {
      const reason = pp?.reason === 'already_live'
        ? 'The Pre-Prod build is already live in production'
        : 'No verified Pre-Prod build is ready to promote';
      return sendJson(response, 409, { error: reason, ...publicState(session) });
    }
    const approvalStatus = approvals.getStatus(pp.releaseId);
    if (approvalStatus.vetoed) {
      const reasonSuffix = approvalStatus.veto?.reason ? ` (${approvalStatus.veto.reason})` : '';
      return sendJson(response, 403, {
        error: `Promotion blocked: Pre-Prod release ${pp.releaseId} was vetoed by ${approvalStatus.veto.name}${reasonSuffix}. Lift the veto before promoting.`,
        ...publicState(session),
      });
    }
    let useOverride = false;
    if (!approvalStatus.quorumMet) {
      if (overrideRequested) {
        if (!approvals.canOverride(session.admin)) {
          return sendJson(response, 403, {
            error: `Only Lakshmi has unilateral release override power. At least ${approvalStatus.requiredCount} of ${approvalStatus.totalApprovers} admins must approve ${pp.releaseId} before promoting.`,
            ...publicState(session),
          });
        }
        useOverride = true;
      } else {
        const missingNames = approvalStatus.pending.map(p => p.name).join(', ');
        const overrideHint = approvals.canOverride(session.admin)
          ? ' Or use Override & Promote (Lakshmi) to promote unilaterally.'
          : '';
        return sendJson(response, 403, {
          error: `At least ${approvalStatus.requiredCount} of ${approvalStatus.totalApprovers} admins (Lakshmi, Vinoth, Avinash) must approve ${pp.releaseId} before promoting to production (${approvalStatus.approvedCount}/${approvalStatus.requiredCount} approved; pending: ${missingNames}).${overrideHint}`,
          ...publicState(session),
        });
      }
    }
    const secret = loadApprovalSecret();
    if (!secret) {
      return sendJson(response, 500, { error: 'Approval signing key is not configured on the build host.', ...publicState(session) });
    }
    const approvalProof = approvals.buildSignedProof(pp.releaseId, secret, {
      commitHash: pp.commitHash,
      version: pp.version,
      overrideBy: useOverride ? session.admin : null,
    });
    const finalStatus = approvals.getStatus(pp.releaseId);
    const approversSummary = finalStatus.approvedBy.map(a => `${a.name} (${a.email})`).join(', ');
    if (!startBuild('promote', { actor: session.admin, approvalProof, approversSummary, overrideUsed: useOverride })) return sendJson(response, 409, { error: 'a release is already running', ...publicState(session) });
    return sendJson(response, 202, publicState(session));
  }
  if (url.pathname === '/api/rollback' && request.method === 'POST') {
    if (state.release.child) return sendJson(response, 409, { error: 'a release is already running', ...publicState(session) });
    await refreshRollback();
    if (!rollback.available) return sendJson(response, 409, { error: rollback.reason || 'No complete previous release is available', ...publicState(session) });
    if (!startBuild('rollback', { actor: session.admin })) return sendJson(response, 409, { error: 'a release is already running', ...publicState(session) });
    return sendJson(response, 202, publicState(session));
  }
  sendJson(response, 404, { error: "not found" });
});

if (!basicPassword) console.error("BUILD_TRIGGER_TOKEN is not configured; console access is disabled");
server.listen(port, host, () => console.log(`ChessAlive release console listening on http://${host}:${server.address().port}`));
resources.start();
const topologyIntervalMs = Math.max(3000, Math.min(60000, Number(process.env.BUILD_TOPOLOGY_INTERVAL_MS) || 5000));
void refreshRollback(); setInterval(() => void refreshRollback(), topologyIntervalMs).unref();
void monitorProduction(); setInterval(() => void monitorProduction(), MONITOR_INTERVAL_MS);
