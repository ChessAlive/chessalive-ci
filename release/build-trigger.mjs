#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";

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
const commitHash = process.env.BUILD_COMMIT_HASH || "unknown";
const commitMessage = process.env.BUILD_COMMIT_MESSAGE || "Current release checkout";
const commitDate = process.env.BUILD_COMMIT_DATE || "";
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
const stepTemplate = () => [
  { id: "prepare", label: "Prepare release", detail: "Lock checkout and release settings", status: "pending" },
  { id: "server", label: "Build server", detail: "Cross-compile the ARM64 chess server", status: "pending" },
  { id: "web", label: "Build web app", detail: "Export and prerender the production web bundle", status: "pending" },
  { id: "verify", label: "Run release checks", detail: "Validate artifacts and release budgets", status: "pending" },
  { id: "deploy", label: "Deploy to Mumbai", detail: "Atomic upload and service installation", status: "pending" },
  { id: "health", label: "Verify production", detail: "Health-gate the live Mumbai service", status: "pending" },
  { id: "complete", label: "Release complete", detail: "Production release is live", status: "pending" },
];

const state = {
  release: { status: "idle", runId: 0, startedAt: null, finishedAt: null, exitCode: null, log: "", steps: stepTemplate(), child: null },
  monitor: { level: "unknown", checkedAt: null, latencyMs: null, summary: "Waiting for the first production check", checks: [], production: null, previousLevel: "unknown" },
};
const sessions = new Map();
const sessionCookie = "chessalive_ci_session";
const sessionTtlMs = 12 * 60 * 60 * 1000;

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

function step(id) { return state.release.steps.find(item => item.id === id); }
function setStep(id, status) { const item = step(id); if (item) item.status = status; }

function updateStepsFromLine(line) {
  if (!line.trim()) return;
  if (/Starting local release/.test(line)) setStep("prepare", "running");
  if (/Building linux\//.test(line)) { setStep("prepare", "done"); setStep("server", "running"); }
  if (/build:web|Starting Metro Bundler/.test(line)) { setStep("server", "done"); setStep("web", "running"); }
  if (/Exported: dist|web export complete/i.test(line)) { setStep("web", "done"); setStep("verify", "running"); }
  if (/Preflight|Performance\/bundle budgets|release checks/i.test(line)) setStep("verify", "running");
  if (/Deploying from this build host|Staging deployment/.test(line)) { setStep("verify", "done"); setStep("deploy", "running"); }
  if (/Installing and restarting/.test(line)) { setStep("deploy", "done"); setStep("health", "running"); }
  if (/health ok/.test(line)) setStep("health", "done");
  if (/▶ Deployed/.test(line)) setStep("deploy", "done");
  if (/Local release complete/.test(line)) { for (const item of state.release.steps) if (item.status === "pending" || item.status === "running") item.status = "done"; setStep("complete", "done"); }
  // Test output contains ordinary words such as “failed” in passing test names and diagnostics.
  // Only the release lane's explicit failure marker or non-zero process exit should fail a step.
  if (/✖|^\s*FAILED\b|exit code [1-9]/.test(line)) { const current = state.release.steps.find(item => item.status === "running") || step("complete"); if (current) current.status = "failed"; }
}

function appendLog(chunk) {
  state.release.log = `${state.release.log}${chunk}`.slice(-maxLogBytes);
  String(chunk).split("\n").forEach(updateStepsFromLine);
}

function publicState() {
  const production = state.monitor.production || {};
  return {
    release: { status: state.release.status, runId: state.release.runId, startedAt: state.release.startedAt, finishedAt: state.release.finishedAt, exitCode: state.release.exitCode, steps: state.release.steps, log: state.release.log.slice(-14_000) },
    production: { url: productionUrl, version: production.version || null, builtAt: production.builtAt || null, commitHash, commitMessage, commitDate, gitLink: commitHash !== "unknown" ? `${gitUrl}/commit/${commitHash}` : gitUrl },
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

function startBuild() {
  if (state.release.child) return false;
  state.release.runId += 1; state.release.status = "running"; state.release.startedAt = new Date().toISOString(); state.release.finishedAt = null; state.release.exitCode = null; state.release.log = `Starting full release #${state.release.runId} from ${sourceDir}\n`; state.release.steps = stepTemplate(); setStep("prepare", "running");
  const child = spawn("bash", ["./release/local-release.sh"], {
    cwd: root,
    env: { ...process.env, SOURCE_DIR: sourceDir, LOCAL_DEPLOY: "yes", PUBLIC_URL: productionUrl, SKIP_INSTALL: "no", SKIP_TESTS: "no", SKIP_FULL_TESTS: process.env.BUILD_SKIP_FULL_TESTS || "no", SKIP_WEB_SETUP: "yes", SKIP_BUDGETS: process.env.BUILD_SKIP_BUDGETS || "no", SKIP_ASSETS: "yes", SKIP_CONTENT: "yes", SKIP_DEPLOY: "no" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.release.child = child;
  child.stdout.on("data", data => appendLog(data.toString())); child.stderr.on("data", data => appendLog(data.toString())); child.on("error", error => appendLog(`\nprocess error: ${error.message}\n`));
  child.on("close", code => {
    state.release.exitCode = code; state.release.status = code === 0 ? "succeeded" : "failed"; state.release.finishedAt = new Date().toISOString(); state.release.child = null;
    if (code === 0) { for (const item of state.release.steps) if (item.status === "pending" || item.status === "running") item.status = "done"; setStep("complete", "done"); }
    else { const current = state.release.steps.find(item => item.status === "running") || step("complete"); if (current) current.status = "failed"; }
    appendLog(`\nFinished with exit code ${code ?? "unknown"}.\n`);
    void sendAdminEmail(code === 0 ? `ChessAlive release #${state.release.runId} deployed` : `ChessAlive release #${state.release.runId} failed`, code === 0 ? "Release deployed successfully" : "Release needs attention", code === 0 ? `The requested source commit is live on Mumbai production. ${releaseCommitSummary()}` : `The release did not complete, so the requested source commit was not deployed. Exit code: ${code ?? "unknown"}. ${releaseCommitSummary()}`, releaseCommitHtml(code === 0));
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
  if (previousLevel !== "unknown" && previousLevel !== level) {
    if (level === "red" || level === "orange") void sendAdminEmail(`ChessAlive monitoring: ${level.toUpperCase()}`, `Production monitoring is ${level}`, `${state.monitor.summary}. The console has the failing endpoint details.`);
    else if (level === "green" && (previousLevel === "red" || previousLevel === "orange")) void sendAdminEmail("ChessAlive monitoring: recovered", "Production has recovered", "All configured chessalive.com checks are healthy again.");
  }
}

const loginHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ChessAlive Operations</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#07111f;color:#eef5ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:22px;background:radial-gradient(circle at 20% 0%,#183763 0,#0b1930 38%,#07111f 75%)}main{width:min(440px,100%);padding:34px;border:1px solid #2a4567;border-radius:26px;background:linear-gradient(145deg,#152d4bea,#102039ea);box-shadow:0 28px 80px #02081488}.mark{display:grid;place-items:center;width:52px;height:52px;border-radius:16px;background:linear-gradient(135deg,#65a9ff,#8368ff);font-size:26px;box-shadow:0 12px 32px #2f65bb55}.eyebrow{margin:22px 0 6px;color:#8eb9f5;font-size:11px;letter-spacing:2px;text-transform:uppercase}.title{margin:0;font-size:30px;letter-spacing:-1px}.copy{color:#a9bfde;line-height:1.55;margin:12px 0 25px}label{display:block;color:#a9bfde;font-size:12px;margin-bottom:8px}input{width:100%;padding:14px 15px;border:1px solid #355273;border-radius:13px;background:#091727;color:#fff;font-size:16px;outline:none}input:focus{border-color:#82b9ff;box-shadow:0 0 0 3px #5a9bff22}button{width:100%;margin-top:15px;padding:14px;border:0;border-radius:13px;color:#fff;background:linear-gradient(135deg,#5a9bff,#7d63f6);font-size:15px;font-weight:800;cursor:pointer}button:disabled{opacity:.65;cursor:wait}.error{min-height:18px;margin:11px 0 0;color:#ff9eb0;font-size:12px}.foot{margin:22px 0 0;color:#6e8bad;font-size:11px}
</style></head><body><main><div class="mark">♞</div><p class="eyebrow">Hyderabad operations</p><h1 class="title">ChessAlive Release Console</h1><p class="copy">Enter the console password to access release controls, Mumbai deployment status, and live production monitoring.</p><form id="login"><label for="password">Console password</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus required><button id="submit" type="submit">Unlock console <span>→</span></button><p id="error" class="error" role="alert"></p></form><p class="foot">Access is protected by a short-lived secure session. No username is required.</p></main><script>const form=document.getElementById('login'),password=document.getElementById('password'),button=document.getElementById('submit'),error=document.getElementById('error');form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;error.textContent='';try{const response=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:password.value})});if(!response.ok)throw new Error('Incorrect password');location.reload()}catch(reason){error.textContent=reason.message;password.select();button.disabled=false}});</script></body></html>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ChessAlive Release Console</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#07111f;color:#eef5ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 0%,#183763 0,#0b1930 34%,#07111f 72%)}.shell{max-width:1180px;margin:auto;padding:28px 20px 52px}.top{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:26px}.brand{display:flex;align-items:center;gap:13px}.mark{display:grid;place-items:center;width:44px;height:44px;border-radius:14px;background:linear-gradient(135deg,#65a9ff,#8368ff);font-size:22px;box-shadow:0 10px 30px #2f65bb55}.eyebrow{margin:0 0 3px;color:#8eb9f5;font-size:11px;letter-spacing:2px;text-transform:uppercase}.brand h1{margin:0;font-size:21px;letter-spacing:-.4px}.live-pill,.status{display:inline-flex;align-items:center;gap:8px;border:1px solid #355273;background:#11243d;padding:8px 12px;border-radius:999px;font-size:12px;color:#cfe2ff}.dot{width:8px;height:8px;border-radius:50%;background:#7d8da4}.green .dot{background:#4ade80;box-shadow:0 0 14px #4ade80}.orange .dot{background:#fbbf24;box-shadow:0 0 14px #fbbf24}.red .dot{background:#fb7185;box-shadow:0 0 14px #fb7185}.hero{display:flex;align-items:center;justify-content:space-between;gap:28px;padding:32px;border:1px solid #2a4567;border-radius:24px;background:linear-gradient(135deg,#152d4bdb,#102039db);box-shadow:0 24px 70px #02081466}.hero h2{margin:0 0 9px;font-size:clamp(28px,4vw,43px);letter-spacing:-1.7px}.hero p{margin:0;color:#a9bfde;max-width:660px;line-height:1.6}.release-btn{border:0;border-radius:14px;padding:16px 24px;color:#fff;font-weight:800;font-size:16px;white-space:nowrap;cursor:pointer;background:linear-gradient(135deg,#5a9bff,#7d63f6);box-shadow:0 12px 30px #527cff4d;transition:transform .2s,filter .2s}.release-btn:hover{transform:translateY(-2px);filter:brightness(1.08)}.release-btn:disabled{cursor:wait;opacity:.6;transform:none}.subline{margin-top:16px!important;font-size:12px;color:#7898bd!important}.grid{display:grid;grid-template-columns:1.08fr .92fr;gap:18px;margin-top:18px}.card{border:1px solid #223b5b;border-radius:20px;background:#0f2036d9;padding:22px;box-shadow:0 18px 50px #02081440}.card h3{margin:0 0 18px;font-size:16px;letter-spacing:-.2px}.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:17px}.card-head h3{margin:0}.meta-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.meta{padding:14px;border:1px solid #23415f;border-radius:13px;background:#0b192b}.meta label{display:block;color:#7695b8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:7px}.meta strong,.meta a{display:block;color:#eff6ff;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta a{color:#8dc0ff;text-decoration:none}.meta a:hover{text-decoration:underline}.small{color:#89a6c9;font-size:12px}.timeline{list-style:none;padding:0;margin:0}.timeline li{display:flex;gap:14px;padding:12px 0;border-bottom:1px solid #1d3550}.timeline li:last-child{border-bottom:0;padding-bottom:0}.icon{display:grid;place-items:center;width:28px;height:28px;flex:0 0 28px;border-radius:50%;background:#1a314e;color:#8da9cb;font-size:14px}.done .icon{background:#103e32;color:#52e39a}.running .icon{background:#17375c;color:#7fb8ff}.failed .icon{background:#4b1c2d;color:#ff8ba3}.spinner{width:13px;height:13px;border:2px solid #4d7099;border-top-color:#9bc6ff;border-radius:50%;animation:spin .75s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.timeline strong{display:block;font-size:13px}.timeline span{display:block;color:#7e9bbb;font-size:12px;margin-top:3px;line-height:1.4}.checks{display:grid;gap:9px}.check{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 12px;border-radius:11px;background:#0b192b;border:1px solid #1b3857}.check-name{font-size:13px}.check-right{display:flex;align-items:center;gap:9px;color:#86a5c9;font-size:12px}.check-ok{color:#55e19a}.check-bad{color:#ff8aa0}.monitor-note{margin:0 0 14px;color:#a6bddc;font-size:13px}.log{margin-top:18px}.log summary{cursor:pointer;color:#8bb8ed;font-size:12px}.log pre{max-height:190px;overflow:auto;white-space:pre-wrap;color:#9ab2d1;background:#091321;border:1px solid #1a3552;border-radius:12px;padding:13px;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.admins{display:flex;flex-wrap:wrap;gap:7px}.admin{padding:7px 9px;border-radius:999px;background:#172e4a;color:#a9c7ea;font-size:11px}.notice{margin-top:16px;color:#f4c96c;font-size:12px;line-height:1.5}.footer{margin-top:20px;color:#6382a8;font-size:11px;text-align:center}@media(max-width:850px){.grid{grid-template-columns:1fr}.hero{align-items:flex-start;flex-direction:column}.release-btn{width:100%}.top{align-items:flex-start;flex-direction:column}.live-pill{align-self:flex-start}}
</style></head><body><main class="shell"><header class="top"><div class="brand"><div class="mark">♞</div><div><p class="eyebrow">Operations</p><h1>ChessAlive Release Console</h1></div></div><div id="globalStatus" class="live-pill"><span class="dot"></span><span>Checking production…</span></div></header><section class="hero"><div><p class="eyebrow">Hyderabad → Mumbai</p><h2>Ship with confidence.</h2><p>Run a complete code release from this console. The build happens on Hyderabad, then the production service and web bundle are deployed atomically to Mumbai.</p><p class="subline">No Jenkins · No Cloud Build · No database migrations</p></div><button class="release-btn" id="release">Release Now <span>→</span></button></section><div class="grid"><section class="card"><div class="card-head"><h3>Production snapshot</h3><span id="prodStatus" class="status"><span class="dot"></span><span>Loading</span></span></div><div class="meta-grid"><div class="meta"><label>Current version</label><strong id="version">—</strong></div><div class="meta"><label>Deployed date</label><strong id="deployed">—</strong></div><div class="meta"><label>Commit hash</label><strong id="commit">—</strong></div><div class="meta"><label>Last commit</label><a id="git" href="#" target="_blank" rel="noreferrer">Open GitHub ↗</a></div></div><p id="commitMessage" class="small" style="margin:14px 0 0">—</p></section><section class="card"><div class="card-head"><h3>Live monitoring</h3><span id="monitorTime" class="small">Every 10 seconds</span></div><p id="monitorSummary" class="monitor-note">Starting checks…</p><div id="checks" class="checks"></div></section><section class="card"><div class="card-head"><h3>Release progress</h3><span id="releaseState" class="small">Ready</span></div><ul id="timeline" class="timeline"></ul><details class="log"><summary>Show release log</summary><pre id="log">No release has run yet.</pre></details></section><section class="card"><div class="card-head"><h3>Admin notifications</h3><span id="mailStatus" class="status"><span class="dot"></span><span>Checking</span></span></div><p class="monitor-note">Release completion, failures, availability changes, and recovery alerts are addressed to:</p><div id="admins" class="admins"></div><p id="mailNote" class="notice"></p></section></div><p class="footer">The console refreshes release status every 2 seconds and production checks every 10 seconds.</p></main><script>
const $ = id => document.getElementById(id); const formatDate = value => value ? new Date(value).toLocaleString() : '—'; const icon = status => status === 'done' ? '✓' : status === 'failed' ? '!' : status === 'running' ? '<span class="spinner"></span>' : '•';
function timeline(steps){ $('timeline').innerHTML=steps.map(step=>'<li class="'+step.status+'"><div class="icon">'+icon(step.status)+'</div><div><strong>'+step.label+'</strong><span>'+step.detail+'</span></div></li>').join(''); }
function statusPill(element,level,text){ element.className='status '+level; element.innerHTML='<span class="dot"></span><span>'+text+'</span>'; }
function render(data){ const monitor=data.monitor,prod=data.production,release=data.release; const label=monitor.level==='green'?'Production healthy':monitor.level==='orange'?'Needs attention':monitor.level==='red'?'Production down':'Checking production…'; statusPill($('globalStatus'),monitor.level,label); statusPill($('prodStatus'),monitor.level,monitor.level==='unknown'?'Checking':monitor.level); $('monitorSummary').textContent=monitor.summary+(monitor.checkedAt?' · '+formatDate(monitor.checkedAt):''); $('monitorTime').textContent=monitor.latencyMs==null?'Every 10 seconds':'Last sweep '+monitor.latencyMs+'ms'; $('checks').innerHTML=monitor.checks.map(check=>'<div class="check"><span class="check-name">'+check.path+'</span><span class="check-right '+(check.ok?'check-ok':'check-bad')+'">'+(check.ok?'✓ '+check.status:'✕ '+(check.status||'offline'))+' · '+check.latencyMs+'ms</span></div>').join('')||'<div class="small">Waiting for the first sweep…</div>'; $('version').textContent=prod.version?.displayVersion||prod.version?.version||'—'; $('deployed').textContent=formatDate(prod.builtAt); $('commit').textContent=prod.commitHash==='unknown'?'Not available':prod.commitHash.slice(0,12); $('git').href=prod.gitLink; $('commitMessage').textContent=prod.commitMessage+(prod.commitDate?' · '+formatDate(prod.commitDate):''); timeline(release.steps); $('releaseState').textContent=release.status==='running'?'Release in progress':release.status==='succeeded'?'Last release succeeded':release.status==='failed'?'Last release failed':'Ready to release'; $('release').disabled=release.status==='running'; $('release').innerHTML=release.status==='running'?'Releasing… <span class="spinner"></span>':'Release Now <span>→</span>'; $('log').textContent=release.log||'No release has run yet.'; $('admins').innerHTML=data.admins.map(email=>'<span class="admin">'+email+'</span>').join(''); const mailReady=data.notifications.configured; statusPill($('mailStatus'),mailReady?'green':'orange',mailReady?(data.notifications.provider+' ready'):'Email needed'); $('mailNote').textContent=mailReady?(data.notifications.provider+' notifications are enabled.'):'Email delivery is not active until the original Resend credentials or BUILD_SMTP_URL are configured on the Hyderabad host.'; }
async function refresh(){ try{ const response=await fetch('/api/status',{cache:'no-store'}); if(response.ok) render(await response.json()); }catch(error){ $('monitorSummary').textContent='Console connection lost: '+error.message; } }
$('release').addEventListener('click',async()=>{ if($('release').disabled)return; if(!confirm('Start the full release now?'))return; $('release').disabled=true; const response=await fetch('/api/build',{method:'POST'}); if(!response.ok) await refresh(); else await refresh(); }); refresh(); setInterval(refresh,2000);
</script></body></html>`;

const dashboardHtml = html
  .replace('.release-btn:disabled{cursor:wait;opacity:.6;transform:none}', '.release-btn:disabled{cursor:wait;opacity:.6;transform:none;pointer-events:none}')
  .replace('<section class="card"><div class="card-head"><h3>Release progress', '<section class="card release-card"><div class="card-head"><h3>Release progress')
  .replace('.small{color:#89a6c9;font-size:12px}', '.small{color:#89a6c9;font-size:12px}.release-card{min-height:420px}');

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
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
  sendJson(response, 404, { error: "not found" });
});

if (!basicPassword) console.error("BUILD_TRIGGER_TOKEN is not configured; console access is disabled");
server.listen(port, host, () => console.log(`ChessAlive release console listening on http://${host}:${port}`));
void monitorProduction(); setInterval(() => void monitorProduction(), 10_000);
