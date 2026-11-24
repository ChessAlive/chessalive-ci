#!/usr/bin/env node
// Isolated admin-only HTTP + WebSocket reverse-proxy gate for ChessAlive Pre-Prod.
// Never shares state, ports, or sessions with production (chessgate :8079 / subdomain-gate :8078).
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = Number(process.env.PREPROD_GATE_PORT || 8084);
const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.PREPROD_UPSTREAM_PORT || 8083);

const COOKIE_NAME = "chessalive_preprod_gate";
const SESSION_TTL_SEC = 7 * 24 * 3600;
const ROBOTS_TAG = "noindex, nofollow, noarchive, nosnippet";
const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
const KEY_FILE = process.env.PREPROD_GATE_KEY_FILE || "/etc/chessalive/preprod-gate.key";

// Self-unregistering service worker served on Pre-Prod (including unauthenticated requests)
// so offline cache-first shells never mask gate redirects, fresh test builds, or mobile logins.
const UNREGISTER_SW_JS = `// ChessAlive Pre-Prod: disable offline cache-first SW and purge stale caches.
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {}
    try {
      await self.registration.unregister();
    } catch {}
    try {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        try {
          const u = new URL(client.url);
          if (!u.pathname.startsWith("/_preprod/") && "navigate" in client) {
            await client.navigate(client.url);
          }
        } catch {}
      }
    } catch {}
  })());
});
`;

function loadSigningKey() {
  try {
    const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (raw.length >= 32) return crypto.createHash("sha256").update(raw).digest();
  } catch {
    // Fall back to ephemeral per-boot key if key file is absent.
  }
  return crypto.randomBytes(32);
}
const SIGNING_KEY = loadSigningKey();

const DEFAULT_ADMINS = [
  "lakshminathanlaky@gmail.com",
  "lakshmi@chessalive.com",
  "vinoth121022@gmail.com",
  "vinoth@chessalive.com",
  "avinash@chessalive.com",
  "avinashr95@gmail.com",
  "contact@chessalive.com",
];

function getAdminSet() {
  const set = new Set(DEFAULT_ADMINS);
  for (const raw of [process.env.CHESSALIVE_ADMIN_EMAILS, process.env.PREPROD_ADMIN_EMAILS]) {
    for (const part of String(raw || "").split(",")) {
      const clean = part.trim().toLowerCase();
      if (clean) set.add(clean);
    }
  }
  return set;
}

function getAcceptedPasswords() {
  const values = [
    process.env.PREPROD_GATE_PASSWORD,
    process.env.BUILD_TRIGGER_TOKEN,
    process.env.CHESSALIVE_OPS_PASSWORD,
    process.env.CHESSALIVE_INFO_PASSWORD,
  ].map(v => String(v || "").trim()).filter(Boolean);
  return [...new Set(values)];
}

function passwordMatches(supplied) {
  if (!supplied) return false;
  const candidates = [String(supplied)];
  const trimmed = candidates[0].trim();
  if (trimmed && trimmed !== candidates[0]) candidates.push(trimmed);
  const accepted = getAcceptedPasswords();
  for (const candidate of candidates) {
    const suppliedHash = crypto.createHash("sha256").update(candidate).digest();
    for (const want of accepted) {
      const wantHash = crypto.createHash("sha256").update(want).digest();
      if (crypto.timingSafeEqual(suppliedHash, wantHash)) return true;
    }
  }
  return false;
}

function isAdminEmail(email) {
  const clean = String(email || "").trim().toLowerCase();
  return Boolean(clean) && getAdminSet().has(clean);
}

const loginAttempts = new Map();
function allowLoginAttempt(ip) {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  let rec = loginAttempts.get(ip);
  if (!rec || now >= rec.resetAt) {
    rec = { count: 0, resetAt: now + windowMs };
    loginAttempts.set(ip, rec);
  }
  rec.count += 1;
  return rec.count <= 15;
}

const revokedSessions = new Set();

function mintToken(email) {
  const sid = crypto.randomBytes(16).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const emailHex = Buffer.from(email.trim().toLowerCase(), "utf8").toString("hex");
  const payload = `v1.${sid}.${exp}.${emailHex}`;
  const sig = crypto.createHmac("sha256", SIGNING_KEY).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") return null;
  const [ver, sid, expStr, emailHex, sig] = parts;
  if (!sid || revokedSessions.has(sid)) return null;
  const payload = `${ver}.${sid}.${expStr}.${emailHex}`;
  const wantSig = crypto.createHmac("sha256", SIGNING_KEY).update(payload).digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(wantSig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Math.floor(Date.now() / 1000) >= exp) return null;
  const email = Buffer.from(emailHex, "hex").toString("utf8");
  if (!isAdminEmail(email)) return null;
  return { sid, exp, email };
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of String(cookieHeader).split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function stripGateCookie(cookieHeader) {
  if (!cookieHeader) return undefined;
  const kept = String(cookieHeader)
    .split(";")
    .map(p => p.trim())
    .filter(p => p && !p.startsWith(`${COOKIE_NAME}=`));
  return kept.length ? kept.join("; ") : undefined;
}

function clientIP(req) {
  const cf = String(req.headers["cf-connecting-ip"] || "").trim();
  if (cf) return cf;
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (xff) return xff;
  return req.socket.remoteAddress || "unknown";
}

function isHttps(req) {
  return String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() === "https";
}

function safeNextPath(raw) {
  const value = String(raw || "/").trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/_preprod/")) return "/";
  return value;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderLogin(res, status, errorMessage = "", emailValue = "", nextPath = "/") {
  const nonce = crypto.randomBytes(16).toString("base64");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>ChessAlive Pre-Prod · Admin Sign In</title>
<style>
:root{color-scheme:light;--bg:#f5f5f0;--card:#fff;--ink:#152c37;--muted:#63747c;--line:#dce3df;--accent:#007e66;--warn-bg:#fff5e4;--warn-ink:#8c540b;--err:#b13243}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:16px;background:radial-gradient(ellipse at 50% 10%,#e6f1eb,transparent 55%),var(--bg);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink)}
main{width:100%;max-width:430px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;box-shadow:0 16px 48px rgba(21,44,55,.08)}
.pill{display:inline-flex;align-items:center;gap:8px;padding:5px 10px;border-radius:999px;background:var(--warn-bg);color:var(--warn-ink);font-size:11px;font-weight:700;letter-spacing:.9px;text-transform:uppercase}
.dot{width:7px;height:7px;border-radius:50%;background:#d79032}
h1{margin:12px 0 6px;font-size:22px;letter-spacing:-.5px}
.sub{margin:0 0 16px;font-size:13px;line-height:1.5;color:var(--muted)}
label{display:block;font-size:12px;font-weight:650;margin:12px 0 6px}
input{width:100%;padding:12px 13px;border:1px solid #d5ded9;border-radius:8px;font-size:16px;background:#fafbf8;color:var(--ink)}
input:focus{outline:2px solid #09a68a;border-color:#09a68a}
button{margin-top:18px;width:100%;padding:13px 16px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-size:15px;font-weight:700;cursor:pointer}
button:hover{background:#006854}
.err{margin:12px 0 0;color:var(--err);font-size:13px;font-weight:600}
.foot{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-size:11px;line-height:1.6;color:var(--muted)}
</style>
</head>
<body>
<main>
  <span class="pill"><span class="dot"></span>Pre-Prod Testing Environment</span>
  <h1>ChessAlive Pre-Prod</h1>
  <p class="sub">Sign in with your admin email and console password to enter Pre-Prod (shared live DB <strong>chessalive-adb</strong>, production untouched).</p>
  <form method="POST" action="/_preprod/login">
    <input type="hidden" name="next" value="${escapeHtml(safeNextPath(nextPath))}">
    <label for="email">Admin email</label>
    <input id="email" name="email" type="email" autocomplete="username" spellcheck="false" autocapitalize="none" autocorrect="off" enterkeyhint="next" required autofocus value="${escapeHtml(emailValue)}" placeholder="admin@chessalive.com">
    <label for="password">Operations / Release Console password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" enterkeyhint="done" required placeholder="Enter admin password">
    <button type="submit">Sign In to Pre-Prod →</button>
    ${errorMessage ? `<p class="err" role="alert">${escapeHtml(errorMessage)}</p>` : ""}
  </form>
  <div class="foot">After entering Pre-Prod, sign in with your ChessAlive account to test live profile &amp; gameplay. To promote to Production, <strong>all 3 admins (Lakshmi, Vinoth, Avinash)</strong> must approve in the <a href="http://129.225.116.198:8787" target="_blank" rel="noopener noreferrer" style="color:#007e66;font-weight:650">Release Command Center</a>.</div>
</main>
<script nonce="${nonce}">
(function(){
  try {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then(function(regs){
        regs.forEach(function(r){ r.unregister().catch(function(){}); });
      }).catch(function(){});
    }
    if ("caches" in window) {
      caches.keys().then(function(keys){
        keys.forEach(function(k){ caches.delete(k).catch(function(){}); });
      }).catch(function(){});
    }
  } catch (e) {}
})();
</script>
</body>
</html>`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    "X-Robots-Tag": ROBOTS_TAG,
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  res.end(html);
}

function readFormBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 8192) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function hasValidGateAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (verifyToken(cookies[COOKIE_NAME])) return true;
  const headerToken = String(req.headers["x-preprod-gate-password"] || "").trim();
  if (headerToken && passwordMatches(headerToken)) return true;
  return false;
}

function buildGateCookie(token, maxAgeSec, secure) {
  const expires = new Date(Date.now() + maxAgeSec * 1000).toUTCString();
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}; Expires=${expires}${secure ? "; Secure" : ""}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "https://preprod.chessalive.com");
  const pathname = url.pathname;

  if (pathname === "/robots.txt") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": ROBOTS_TAG,
    });
    res.end(ROBOTS_TXT);
    return;
  }

  if (pathname === "/sw.js" && (req.method === "GET" || req.method === "HEAD")) {
    console.log(`[preprod-gate] sw-unregister 200 ${req.method} /sw.js`);
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache",
      "Service-Worker-Allowed": "/",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": ROBOTS_TAG,
      "X-ChessAlive-Env": "preprod",
    });
    res.end(req.method === "HEAD" ? "" : UNREGISTER_SW_JS);
    return;
  }

  if (pathname === "/_preprod/health" && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": ROBOTS_TAG,
    });
    res.end(JSON.stringify({ ok: true, gate: "preprod" }));
    return;
  }

  if (pathname === "/_preprod/logout" && req.method === "POST") {
    const cookies = parseCookies(req.headers.cookie);
    const session = verifyToken(cookies[COOKIE_NAME]);
    if (session) revokedSessions.add(session.sid);
    console.log(`[preprod-gate] logout email=${session ? session.email : "unknown"}`);
    res.writeHead(303, {
      "Set-Cookie": buildGateCookie("", 0, isHttps(req)),
      "Clear-Site-Data": '"cookies", "storage", "cache"',
      Location: "/_preprod/login",
      "Cache-Control": "no-store",
      "X-Robots-Tag": ROBOTS_TAG,
    });
    res.end();
    return;
  }

  if (pathname === "/_preprod/login") {
    const nextPath = safeNextPath(url.searchParams.get("next") || "/");
    if (req.method === "GET" || req.method === "HEAD") {
      if (hasValidGateAuth(req)) {
        res.writeHead(302, { Location: nextPath, "Cache-Control": "no-store", "X-Robots-Tag": ROBOTS_TAG });
        res.end();
        return;
      }
      renderLogin(res, 200, "", "", nextPath);
      return;
    }
    if (req.method === "POST") {
      const ip = clientIP(req);
      if (!allowLoginAttempt(ip)) {
        console.log(`[preprod-gate] login rate-limited ip=${ip}`);
        renderLogin(res, 429, "Too many sign-in attempts. Please wait 5 minutes and try again.", "", nextPath);
        return;
      }
      try {
        const raw = await readFormBody(req);
        const params = new URLSearchParams(raw);
        const email = String(params.get("email") || "").trim();
        const password = String(params.get("password") || "");
        const target = safeNextPath(params.get("next") || "/");
        if (!isAdminEmail(email) || !passwordMatches(password)) {
          console.log(`[preprod-gate] login denied email=${email.toLowerCase()}`);
          renderLogin(res, 401, "Invalid admin email or password.", email, target);
          return;
        }
        const token = mintToken(email);
        const https = isHttps(req);
        console.log(`[preprod-gate] login ok email=${email.toLowerCase()} next=${target} https=${https}`);
        res.writeHead(303, {
          "Set-Cookie": buildGateCookie(token, SESSION_TTL_SEC, https),
          Location: target,
          "Cache-Control": "no-store, max-age=0",
          "X-Robots-Tag": ROBOTS_TAG,
        });
        res.end();
        return;
      } catch {
        renderLogin(res, 400, "Invalid login submission.", "", nextPath);
        return;
      }
    }
    res.writeHead(405, { "X-Robots-Tag": ROBOTS_TAG });
    res.end("Method not allowed");
    return;
  }

  if (!hasValidGateAuth(req)) {
    const accept = String(req.headers.accept || "");
    if ((req.method === "GET" || req.method === "HEAD") && accept.includes("text/html") && !pathname.startsWith("/api/")) {
      const target = encodeURIComponent(safeNextPath(pathname + url.search));
      console.log(`[preprod-gate] gate-redirect 302 ${req.method} ${pathname}`);
      res.writeHead(302, {
        Location: `/_preprod/login?next=${target}`,
        "Cache-Control": "no-store, max-age=0",
        "X-Robots-Tag": ROBOTS_TAG,
      });
      res.end();
      return;
    }
    if (!pathname.startsWith("/api/telemetry")) {
      console.log(`[preprod-gate] gate-denied 401 ${req.method} ${pathname}`);
    }
    res.writeHead(401, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Preprod-Gate-Auth-Required": "1",
      "X-Robots-Tag": ROBOTS_TAG,
    });
    res.end(JSON.stringify({
      error: "Pre-prod admin authentication required",
      gate: "preprod",
      loginUrl: "/_preprod/login",
    }));
    return;
  }

  const headers = { ...req.headers };
  delete headers["x-preprod-gate-password"];
  const cleanedCookie = stripGateCookie(headers.cookie);
  if (cleanedCookie) headers.cookie = cleanedCookie;
  else delete headers.cookie;

  const proxyReq = http.request(
    {
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers,
    },
    proxyRes => {
      const resHeaders = { ...proxyRes.headers };
      resHeaders["x-robots-tag"] = ROBOTS_TAG;
      resHeaders["x-chessalive-env"] = "preprod";
      const contentType = String(resHeaders["content-type"] || "").toLowerCase();
      if (contentType.startsWith("text/html")) {
        // Never allow browser HTTP caches or legacy SWs to store Pre-Prod HTML shells.
        resHeaders["cache-control"] = "no-store, max-age=0";
        resHeaders["pragma"] = "no-cache";
        delete resHeaders["x-chessalive-cache-scope"];
        delete resHeaders["etag"];
      }
      if (pathname.startsWith("/api/auth/")) {
        console.log(`[preprod-gate] auth ${req.method} ${pathname} -> ${proxyRes.statusCode}`);
      }
      res.writeHead(proxyRes.statusCode || 200, resHeaders);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": ROBOTS_TAG,
      });
    }
    res.end("Pre-prod upstream (chessd-preprod) is starting or unavailable. Retry in a few seconds.");
  });
  req.pipe(proxyReq);
});

server.on("upgrade", (req, clientSocket, head) => {
  if (!hasValidGateAuth(req)) {
    clientSocket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = req.rawHeaders[i + 1];
      const lower = name.toLowerCase();
      if (lower === "x-preprod-gate-password") continue;
      if (lower === "cookie") {
        const cleaned = stripGateCookie(value);
        if (cleaned) lines.push(`${name}: ${cleaned}`);
        continue;
      }
      lines.push(`${name}: ${value}`);
    }
    lines.push("\r\n");
    upstream.write(lines.join("\r\n"));
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on("error", () => {
    try {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    } catch { /* ignore */ }
    clientSocket.destroy();
  });
  clientSocket.on("error", () => upstream.destroy());
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`chessalive-preprod-gate listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
