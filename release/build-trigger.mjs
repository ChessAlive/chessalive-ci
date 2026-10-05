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
const smtpUrl = process.env.BUILD_SMTP_URL || "";
const smtpFrom = process.env.BUILD_SMTP_FROM || "ChessAlive Releases <no-reply@chessalive.com>";
const resendApiKey = process.env.CHESSALIVE_RESEND_API_KEY || "";
const resendFrom = process.env.CHESSALIVE_OTP_FROM || smtpFrom;
const monitorPaths = (process.env.MONITOR_PATHS || "/,/health,/version,/play,/tactics,/coach")
  .split(",").map(value => value.trim()).filter(Boolean);
const maxLogBytes = 120_000;
const execFileAsync = promisify(execFile);
const rollbackSteps = () => [
  ['rollback_prepare', 'Check fallback', 'Verify the complete previous release'],
  ['rollback_restore', 'Restore previous release', 'Restore the app, server, data and service settings together'],
  ['rollback_health', 'Verify production', 'Check health and recover the current release if needed'],
].map(([id, label, detail]) => ({ id, label, detail, status: 'pending', startedAt: null, finishedAt: null, durationMs: null, peakRssBytes: null }));
let rollback = { available: false, checkedAt: null, reason: 'Checking the previous release' };
let rollbackRefresh = null;
function refreshRollback() {
  if (rollbackRefresh) return rollbackRefresh;
  rollbackRefresh = (async () => {
    try {
      const { stdout } = await execFileAsync('bash', ['./release/rollback-chessd.sh', '--status'], {
        cwd: root, timeout: 15000, maxBuffer: 100000,
        env: { ...process.env, CI_ROOT: root, SOURCE_ROOT: sourceDir, PUBLIC_URL: productionUrl },
      });
      const result = JSON.parse(stdout);
      if (typeof result.available !== 'boolean') throw new Error('Invalid rollback status');
      rollback = { ...result, checkedAt: new Date().toISOString() };
    } catch { rollback = { available: false, checkedAt: new Date().toISOString(), reason: 'The previous release could not be verified' }; }
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
  remoteHost: process.env.DEPLOY_HOST || '144.24.117.171',
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

function authorized(request) {
  if (!basicPassword) return false;
  const token = cookies(request)[sessionCookie];
  const issuedAt = token ? sessions.get(token) : undefined;
  if (!issuedAt) return false;
  if (Date.now() - issuedAt > sessionTtlMs) { sessions.delete(token); return false; }
  sessions.set(token, Date.now());
  return true;
}

function requireAuth(request, response) {
  if (authorized(request)) return true;
  response.writeHead(401, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Authentication required" }));
  return false;
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

function publicState() {
  const production = state.monitor.production || {};
  const deployedCommit = rollback.current ? (rollback.current.commitHash || 'unknown') : (state.release.kind === 'rollback' ? 'unknown' : commitHash);
  return {
    serverTime: new Date().toISOString(),
    resources: resources.publicState(),
    rollback,
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

async function sendAdminEmail(subject, title, summary, extraHtml = "") {
  try {
    const safeTitle = escapeHtml(title);
    const safeSummary = escapeHtml(summary).replaceAll("\n", "<br>");
    const html = `<!doctype html><html><body style="margin:0;background:#08111f;font-family:Arial,sans-serif;color:#eaf1ff"><div style="max-width:680px;margin:24px auto;padding:30px;background:#111e33;border:1px solid #29415f;border-radius:18px"><div style="font-size:13px;letter-spacing:2px;color:#6ea8ff">CHESSALIVE RELEASE CONSOLE</div><h1 style="margin:14px 0 8px;color:#fff">${safeTitle}</h1><p style="color:#b8c9e5;line-height:1.6">${safeSummary}</p><ul style="padding-left:20px;line-height:1.9">${extraHtml || releaseStepsHtml()}</ul><p style="margin-top:24px"><a href="${escapeHtml(productionUrl)}" style="color:#8cc2ff">Open production</a></p></div></body></html>`;
    const text = `${title}\n\n${summary}\n\n${productionUrl}`;
    if (resendApiKey) {
      const response = await fetch("https://api.resend.com/emails", {
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

function startBuild(kind = 'build') {
  if (state.release.child) return false;
  refreshCommitMetadata();
  const isRollback = kind === 'rollback';
  state.release = { kind, status: 'running', runId: state.release.runId + 1, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, log: isRollback ? `Restoring the previous retained release on Mumbai\n` : `Starting full release #${state.release.runId + 1} from ${sourceDir}\n`, steps: isRollback ? rollbackSteps() : stepTemplate(), metrics: emptyMetrics(), child: null };
  const child = spawn("bash", [isRollback ? './release/rollback-chessd.sh' : './release/local-release.sh'], {
    cwd: root,
    detached: true,
    env: { ...process.env, CHESSALIVE_PROGRESS: "yes", SOURCE_DIR: sourceDir, SOURCE_ROOT: sourceDir, CI_ROOT: root, LOCAL_DEPLOY: isRollback ? 'no' : 'yes', PUBLIC_URL: productionUrl, SKIP_INSTALL: "no", SKIP_TESTS: "no", SKIP_FULL_TESTS: process.env.BUILD_SKIP_FULL_TESTS || "no", SKIP_WEB_SETUP: "yes", SKIP_BUDGETS: process.env.BUILD_SKIP_BUDGETS || "no", SKIP_ASSETS: "yes", SKIP_CONTENT: isRollback ? "yes" : "no", SKIP_DEPLOY: "no" },
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
    else void sendAdminEmail(code === 0 ? `ChessAlive release #${state.release.runId} deployed` : `ChessAlive release #${state.release.runId} failed`, code === 0 ? "Release deployed successfully" : "Release needs attention", code === 0 ? `The requested source commit is live on Mumbai production. ${releaseCommitSummary()}` : `The release did not complete, so the requested source commit was not deployed. Exit code: ${code ?? "unknown"}. ${releaseCommitSummary()}`, releaseCommitHtml(code === 0));
  });
  return true;
}

async function checkPath(path) {
  const started = Date.now(); const url = `${productionUrl}${path.startsWith("/") ? path : `/${path}`}`;
  try { const response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "follow" }); return { path, ok: response.ok, status: response.status, latencyMs: Date.now() - started }; }
  catch (error) { return { path, ok: false, status: 0, latencyMs: Date.now() - started, error: error.message }; }
}

async function monitorProduction() {
  const checks = await Promise.all(monitorPaths.map(checkPath));
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
  if (url.pathname === "/api/login" && request.method === "POST") {
    try {
      const body = JSON.parse(await readBody(request));
      if (!basicPassword || typeof body.password !== "string" || !safeEqual(body.password, basicPassword))
        return sendJson(response, 401, { error: "Incorrect password" });
      const token = randomBytes(32).toString("hex");
      sessions.set(token, Date.now());
      response.writeHead(204, { "Set-Cookie": `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTtlMs / 1000}`, "Cache-Control": "no-store" });
      return response.end();
    } catch (error) {
      return sendJson(response, 400, { error: error.message === "request too large" ? error.message : "Invalid request" });
    }
  }
  if (url.pathname === "/" && request.method === "GET" && !authorized(request)) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return response.end(loginHtml);
  }
  if (!requireAuth(request, response)) return;
  if (url.pathname === "/" && request.method === "GET") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return response.end(dashboardHtml); }
  if (url.pathname === "/api/status" && request.method === "GET") return sendJson(response, 200, publicState());
  if (url.pathname === "/api/build" && request.method === "POST") { if (!startBuild()) return sendJson(response, 409, { error: "a release is already running", ...publicState() }); return sendJson(response, 202, publicState()); }
  if (url.pathname === '/api/rollback' && request.method === 'POST') {
    if (state.release.child) return sendJson(response, 409, { error: 'a release is already running', ...publicState() });
    await refreshRollback();
    if (!rollback.available) return sendJson(response, 409, { error: rollback.reason || 'No complete previous release is available', ...publicState() });
    if (!startBuild('rollback')) return sendJson(response, 409, { error: 'a release is already running', ...publicState() });
    return sendJson(response, 202, publicState());
  }
  sendJson(response, 404, { error: "not found" });
});

if (!basicPassword) console.error("BUILD_TRIGGER_TOKEN is not configured; console access is disabled");
server.listen(port, host, () => console.log(`ChessAlive release console listening on http://${host}:${server.address().port}`));
resources.start();
void refreshRollback(); setInterval(() => void refreshRollback(), 60000).unref();
void monitorProduction(); setInterval(() => void monitorProduction(), MONITOR_INTERVAL_MS);
