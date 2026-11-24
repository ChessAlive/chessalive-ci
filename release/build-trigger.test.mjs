import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('authenticated console measures operations, serializes builds and rollbacks, and persists completed and interrupted runs', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-metrics-test-'));
  const production = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, version: { displayVersion: 'test', builtAt: '2026-01-01' } })); });
  production.listen(0, '127.0.0.1'); await once(production, 'listening');
  let child;
  let base;
  let cookie;
  const stateFile = join(root, '.state/latest-release.json');
  async function start() {
    child = spawn(process.execPath, [join(root, 'release/build-trigger.mjs')], {
      env: { PATH: process.env.PATH, BUILD_RESOURCE_MONITOR_ENABLED: 'no', BUILD_REQUIRE_EMAIL_OTP: 'no', BUILD_TRIGGER_HOST: '127.0.0.1', BUILD_TRIGGER_PORT: '0', BUILD_TRIGGER_TOKEN: 'test-only', PUBLIC_URL: `http://127.0.0.1:${production.address().port}`, SOURCE_DIR: root, BUILD_STATE_FILE: stateFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { text += chunk; });
    for (let i = 0; i < 100 && !/listening on http:\/\/127.0.0.1:\d+/.test(text); i++) await pause(30);
    base = text.match(/listening on (http:\/\/127.0.0.1:\d+)/)?.[1];
    assert.ok(base, 'test server started');
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-only' }) });
    assert.equal(login.status, 204);
    cookie = login.headers.get('set-cookie').split(';')[0];
  }
  async function stop() { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } }
  async function status() { return (await fetch(`${base}/api/status`, { headers: { cookie } })).json(); }
  try {
    await mkdir(join(root, 'release/branding'), { recursive: true });
    for (const file of ['chessalive-logo.png', 'favicon.png']) await copyFile(new URL('branding/' + file, import.meta.url), join(root, 'release/branding', file));
    for (const file of ['approvals.mjs', 'build-trigger.mjs', 'build-metrics.mjs', 'dashboard.mjs', 'monitor-policy.mjs', 'resource-monitor.mjs', 'resource-snapshot.py', 'cloud-resource-snapshot.py']) await copyFile(new URL(file, import.meta.url), join(root, 'release', file));
    await writeFile(join(root, 'release/local-release.sh'), `#!/usr/bin/env bash\nset -eu\nprintf 'content-policy=%s\\n' "$SKIP_CONTENT"\nprintf '@@CHESSALIVE_STEP {"id":"web","status":"running"}\\n'\nnode -e 'const bytes=Buffer.alloc(32*1024*1024, 1);setTimeout(()=>console.log(bytes.length),2200)'\nprintf '@@CHESSALIVE_STEP {"id":"web","status":"done"}\\n'\n`);
    await writeFile(join(root, 'rollback-status.json'), JSON.stringify({ available: false, reason: 'No complete fallback', current: { commitHash: 'aaaaaaa', commitMessage: 'Current release' } }));
    await writeFile(join(root, 'release/rollback-chessd.sh'), `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == --status ]]; then cat rollback-status.json; exit 0; fi
for step in rollback_prepare rollback_restore rollback_health; do
  printf '@@CHESSALIVE_STEP {"id":"%s","status":"running"}\\n' "$step"
  sleep 0.15
  printf '@@CHESSALIVE_STEP {"id":"%s","status":"done"}\\n' "$step"
done
printf '%s' '{"available":true,"current":{"commitHash":"bbbbbbb","commitMessage":"Restored release","version":"previous"},"previous":{"commitHash":"aaaaaaa"}}' > rollback-status.json
`);
    await writeFile(join(root, 'release/promote-chessd.sh'), `#!/usr/bin/env bash
set -eu
for step in promote_verify promote_handoff promote_health; do
  printf '@@CHESSALIVE_STEP {"id":"%s","status":"running"}\\n' "$step"
  sleep 0.1
  printf '@@CHESSALIVE_STEP {"id":"%s","status":"done"}\\n' "$step"
done
printf '%s' '{"available":true,"current":{"commitHash":"ccccccc","commitMessage":"Promoted release","version":"promoted"},"previous":{"commitHash":"bbbbbbb"},"preprod":{"releaseId":"release-20261120t120000z-cccccc","promotable":false,"inSyncWithProd":true,"healthy":true,"reason":"already_live","commitHash":"ccccccc","version":"promoted"}}' > rollback-status.json
`);
    await start();
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/promote`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/api/promote`, { method: 'POST', headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/rollback`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/api/rollback`, { method: 'POST', headers: { cookie } })).status, 409);
    assert.equal((await fetch(`${base}/branding/chessalive-logo.png`)).headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/build`, { method: 'POST', headers: { cookie } })).status, 202);
    assert.equal((await fetch(`${base}/api/build`, { method: 'POST', headers: { cookie } })).status, 409);
    assert.equal((await fetch(`${base}/api/rollback`, { method: 'POST', headers: { cookie } })).status, 409);
    let data;
    for (let i = 0; i < 100; i++) { data = await status(); if (data.release.status !== 'running') break; await pause(50); }
    assert.equal(data.release.status, 'succeeded');
    assert.ok(data.release.log.includes('content-policy=no'));
    assert.ok(data.release.durationMs >= 2100);
    assert.ok(data.release.metrics.peakRssBytes >= 32 * 1024 * 1024);
    assert.ok(data.release.metrics.samples.length >= 2);
    const web = data.release.steps.find(s => s.id === 'web');
    assert.equal(web.status, 'done'); assert.ok(web.durationMs >= 2100);
    assert.ok(web.peakRssBytes > 0);
    assert.equal(data.release.metrics.currentRssBytes, null);
    const duration = data.release.durationMs;
    await stop(); await start();
    data = await status(); assert.equal(data.release.durationMs, duration); assert.equal(data.release.runId, 1);
    await stop();
    await writeFile(stateFile, JSON.stringify({ ...data.release, status: 'running', finishedAt: null, savedAt: data.release.finishedAt, steps: [{ ...web, status: 'running', finishedAt: null }] }));
    await start(); data = await status();
    assert.equal(data.release.status, 'interrupted'); assert.equal(data.release.steps[0].status, 'failed');
    assert.equal(data.release.durationMs, duration);
    await writeFile(join(root, 'rollback-status.json'), JSON.stringify({ available: true, current: { commitHash: 'aaaaaaa' }, previous: { commitHash: 'bbbbbbb', version: 'previous' } }));
    assert.equal((await fetch(`${base}/api/rollback`, { method: 'POST', headers: { cookie } })).status, 202);
    assert.equal((await fetch(`${base}/api/build`, { method: 'POST', headers: { cookie } })).status, 409);
    assert.equal((await fetch(`${base}/api/rollback`, { method: 'POST', headers: { cookie } })).status, 409);
    for (let i = 0; i < 100; i++) { data = await status(); if (data.release.status !== 'running' && data.production.commitHash === 'bbbbbbb') break; await pause(30); }
    assert.equal(data.release.kind, 'rollback');
    assert.equal(data.release.status, 'succeeded');
    assert.deepEqual(data.release.steps.map(step => step.status), ['done', 'done', 'done']);
    assert.ok(data.release.steps.every(step => step.durationMs >= 100));
    assert.equal(data.production.commitHash, 'bbbbbbb', 'restored metadata wins over the checkout commit');
    assert.equal(data.production.commitMessage, 'Restored release');
    await stop(); await start();
    data = await status(); assert.equal(data.release.kind, 'rollback'); assert.equal(data.release.runId, 2);
    await writeFile(join(root, 'rollback-status.json'), JSON.stringify({
      available: true,
      current: { commitHash: 'bbbbbbb' },
      previous: { commitHash: 'aaaaaaa' },
      preprod: { releaseId: 'release-20261120t120000z-cccccc', promotable: true, inSyncWithProd: false, healthy: true, reason: 'ready_to_promote', commitHash: 'ccccccc', version: 'promoted' },
    }));
    // Password-only session without individual email OTP verification must never approve, veto, or promote.
    assert.equal((await fetch(`${base}/api/promote/approve`, { method: 'POST', headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/promote/veto`, { method: 'POST', headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/promote/unveto`, { method: 'POST', headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/promote`, { method: 'POST', headers: { cookie } })).status, 403);
  } finally { await stop(); production.close(); await rm(root, { recursive: true, force: true }); }
});

test('enforces individual email OTP login, any 2-of-3 quorum, and Lakshmi veto & unilateral override power before promoting Pre-Prod to Production', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-approvals-test-'));
  const sentEmails = [];
  const resendMock = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    sentEmails.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `email_${sentEmails.length}` }));
  });
  resendMock.listen(0, '127.0.0.1'); await once(resendMock, 'listening');
  const production = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, version: { displayVersion: 'prod-1', builtAt: '2026-01-01' } })); });
  production.listen(0, '127.0.0.1'); await once(production, 'listening');
  const approvalSecret = 'f'.repeat(64);
  const approvalSecretFile = join(root, 'promote-approval.key');
  const approvalStateFile = join(root, '.state/promote-approvals.json');
  let child;
  let base;
  async function start() {
    child = spawn(process.execPath, [join(root, 'release/build-trigger.mjs')], {
      env: {
        PATH: process.env.PATH,
        BUILD_RESOURCE_MONITOR_ENABLED: 'no',
        BUILD_REQUIRE_EMAIL_OTP: 'yes',
        BUILD_TRIGGER_HOST: '127.0.0.1',
        BUILD_TRIGGER_PORT: '0',
        BUILD_TRIGGER_TOKEN: 'shared-console-pass',
        CHESSALIVE_RESEND_API_KEY: 're_test_mock_key',
        CHESSALIVE_OTP_FROM: '"ChessAlive <contact@chessalive.com>"',
        RESEND_API_URL: `http://127.0.0.1:${resendMock.address().port}/emails`,
        PROMOTE_APPROVAL_SECRET_FILE: approvalSecretFile,
        PROMOTE_APPROVAL_STATE_FILE: approvalStateFile,
        PUBLIC_URL: `http://127.0.0.1:${production.address().port}`,
        SOURCE_DIR: root,
        BUILD_STATE_FILE: join(root, '.state/latest-release.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { text += chunk; });
    for (let i = 0; i < 100 && !/listening on http:\/\/127.0.0.1:\d+/.test(text); i++) await pause(30);
    base = text.match(/listening on (http:\/\/127.0.0.1:\d+)/)?.[1];
    assert.ok(base, 'approval-gated server started');
  }
  async function stop() { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } }
  async function loginAs(email) {
    const beforeCount = sentEmails.length;
    const reqRes = await fetch(`${base}/api/login/request-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'shared-console-pass' }),
    });
    assert.equal(reqRes.status, 200);
    const reqBody = await reqRes.json();
    assert.ok(reqBody.challengeId);
    const mail = sentEmails.slice(beforeCount).find(item => item.to.includes(reqBody.email) && /sign-in code/i.test(item.subject));
    assert.ok(mail, `OTP email delivered exclusively to ${reqBody.email}`);
    assert.deepEqual(mail.to, [reqBody.email]);
    const code = mail.subject.match(/(\d{6})/)?.[1];
    assert.ok(code, '6-digit code present in OTP email');
    const badVerify = await fetch(`${base}/api/login/verify-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: reqBody.challengeId, email, code: code === '000000' ? '111111' : '000000' }),
    });
    assert.equal(badVerify.status, 401);
    const okVerify = await fetch(`${base}/api/login/verify-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: reqBody.challengeId, email, code }),
    });
    assert.equal(okVerify.status, 200);
    return okVerify.headers.get('set-cookie').split(';')[0];
  }

  try {
    await mkdir(join(root, 'release/branding'), { recursive: true });
    for (const file of ['chessalive-logo.png', 'favicon.png']) await copyFile(new URL('branding/' + file, import.meta.url), join(root, 'release/branding', file));
    for (const file of ['approvals.mjs', 'build-trigger.mjs', 'build-metrics.mjs', 'dashboard.mjs', 'monitor-policy.mjs', 'resource-monitor.mjs', 'resource-snapshot.py', 'cloud-resource-snapshot.py', 'runtime_transaction.py', 'release_store.py', 'handoff.py']) {
      await copyFile(new URL(file, import.meta.url), join(root, 'release', file));
    }
    await writeFile(approvalSecretFile, `${approvalSecret}\n`, { mode: 0o600 });
    const releaseA = 'release-20261120t120000z-cccccc';
    const releaseB = 'release-20261120t130000z-dddddd';
    const statusFor = (relId, commitHash) => JSON.stringify({
      available: true,
      current: { commitHash: 'bbbbbbb' },
      previous: { commitHash: 'aaaaaaa' },
      preprod: { releaseId: relId, promotable: true, inSyncWithProd: false, healthy: true, reason: 'ready_to_promote', commitHash, version: 'candidate' },
    });
    await writeFile(join(root, 'rollback-status.json'), statusFor(releaseA, 'ccccccc'));
    await writeFile(join(root, 'release/rollback-chessd.sh'), `#!/usr/bin/env bash\nset -eu\nif [[ "\${1:-}" == --status ]]; then cat rollback-status.json; exit 0; fi\n`);
    // Mock promote script verifies the Node-signed v2 proof via Python runtime_transaction.verify_promote_approval!
    await writeFile(join(root, 'release/promote-chessd.sh'), `#!/usr/bin/env bash
set -eu
test -n "\${CHESSALIVE_APPROVAL_PROOF:-}"
python3 - <<'PY'
import json, os, sys
sys.path.insert(0, os.path.join(os.environ['CI_ROOT'], 'release'))
import runtime_transaction
with open(os.path.join(os.environ['SOURCE_DIR'], 'rollback-status.json'), 'r', encoding='utf-8') as f:
    rel_id = json.load(f)['preprod']['releaseId']
verified = runtime_transaction.verify_promote_approval(
    rel_id,
    os.environ['CHESSALIVE_APPROVAL_PROOF'],
    key_file=os.environ['PROMOTE_APPROVAL_SECRET_FILE'],
)
with open(os.path.join(os.environ['SOURCE_DIR'], 'last-verified-approvers.json'), 'w', encoding='utf-8') as out:
    json.dump({'releaseId': rel_id, 'verified': verified}, out)
PY
for step in promote_verify promote_handoff promote_health; do
  printf '@@CHESSALIVE_STEP {"id":"%s","status":"running"}\\n' "$step"
  sleep 0.05
  printf '@@CHESSALIVE_STEP {"id":"%s","status":"done"}\\n' "$step"
done
python3 - <<'PY'
import json, os
path = os.path.join(os.environ['SOURCE_DIR'], 'rollback-status.json')
with open(path, 'r', encoding='utf-8') as f:
    st = json.load(f)
pp = st['preprod']
st['current'] = {'commitHash': pp['commitHash'], 'commitMessage': 'Promoted release', 'version': 'promoted'}
st['preprod'] = {**pp, 'promotable': False, 'inSyncWithProd': True, 'reason': 'already_live', 'version': 'promoted'}
with open(path, 'w', encoding='utf-8') as f:
    json.dump(st, f)
PY
`);
    await start();

    // 1. Login config lists all 3 authorized approvers, quorum 2, and Lakshmi's veto/override flags.
    const cfg = await (await fetch(`${base}/api/login/config`)).json();
    assert.equal(cfg.requireEmailOtp, true);
    assert.equal(cfg.requiredCount, 2);
    assert.deepEqual(cfg.approvers.map(a => ({ id: a.id, canVeto: a.canVeto, canOverride: a.canOverride })), [
      { id: 'lakshmi', canVeto: true, canOverride: true },
      { id: 'vinoth', canVeto: false, canOverride: false },
      { id: 'avinash', canVeto: false, canOverride: false },
    ]);

    // 2. Password-only login is rejected; unknown email and wrong password are rejected.
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'shared-console-pass' }) })).status, 400);
    assert.equal((await fetch(`${base}/api/login/request-otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'lakshmi@chessalive.com', password: 'wrong' }) })).status, 401);
    assert.equal((await fetch(`${base}/api/login/request-otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'stranger@example.com', password: 'shared-console-pass' }) })).status, 403);

    // 3. Vinoth logs in via OTP -> 1/2 -> cannot promote, cannot override, cannot veto.
    const vinothCookie = await loginAs('vinoth121022@gmail.com');
    let res = await fetch(`${base}/api/promote`, { method: 'POST', headers: { cookie: vinothCookie } });
    assert.equal(res.status, 403);
    res = await fetch(`${base}/api/promote/approve`, { method: 'POST', headers: { cookie: vinothCookie } });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.currentUser.canVeto, false);
    assert.equal(body.currentUser.canOverride, false);
    assert.equal(body.preprod.approvals.requiredCount, 2);
    assert.equal(body.preprod.approvals.approvedCount, 1);
    assert.equal(body.preprod.approvals.quorumMet, false);
    assert.equal(body.preprod.promotable, false);
    assert.equal(body.preprod.canOverridePromote, false);
    assert.equal(body.preprod.reason, 'awaiting_approvals');
    // Duplicate approval by Vinoth stays at 1/2.
    body = await (await fetch(`${base}/api/promote/approve`, { method: 'POST', headers: { cookie: vinothCookie } })).json();
    assert.equal(body.preprod.approvals.approvedCount, 1);
    assert.equal((await fetch(`${base}/api/promote`, { method: 'POST', headers: { cookie: vinothCookie, 'content-type': 'application/json' }, body: JSON.stringify({ override: true }) })).status, 403);
    assert.equal((await fetch(`${base}/api/promote/veto`, { method: 'POST', headers: { cookie: vinothCookie, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'nope' }) })).status, 403);

    // 4. Avinash logs in via OTP -> 2/2 quorum met WITHOUT Lakshmi -> revoke drops to 1/2 -> re-approve restores 2/2.
    const avinashCookie = await loginAs('avinashr95@gmail.com');
    body = await (await fetch(`${base}/api/promote/approve`, { method: 'POST', headers: { cookie: avinashCookie } })).json();
    assert.equal(body.preprod.approvals.approvedCount, 2);
    assert.equal(body.preprod.approvals.quorumMet, true);
    assert.equal(body.preprod.promotable, true);
    assert.equal(body.preprod.reason, 'ready_to_promote');
    body = await (await fetch(`${base}/api/promote/revoke`, { method: 'POST', headers: { cookie: avinashCookie } })).json();
    assert.equal(body.preprod.approvals.approvedCount, 1);
    assert.equal(body.preprod.promotable, false);
    assert.equal((await fetch(`${base}/api/promote`, { method: 'POST', headers: { cookie: avinashCookie } })).status, 403);
    body = await (await fetch(`${base}/api/promote/approve`, { method: 'POST', headers: { cookie: avinashCookie } })).json();
    assert.equal(body.preprod.promotable, true);

    // 5. Lakshmi logs in via OTP and VETOES releaseA -> blocks promotion even though Vinoth + Avinash approved (2/3)!
    const lakshmiCookie = await loginAs('lakshmi@chessalive.com');
    res = await fetch(`${base}/api/promote/veto`, {
      method: 'POST',
      headers: { cookie: lakshmiCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Lobby regression spotted on mobile' }),
    });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.currentUser.canVeto, true);
    assert.equal(body.currentUser.canOverride, true);
    assert.equal(body.preprod.vetoed, true);
    assert.equal(body.preprod.promotable, false);
    assert.equal(body.preprod.canOverridePromote, false);
    assert.equal(body.preprod.reason, 'vetoed');
    assert.equal(body.preprod.approvals.veto.reason, 'Lobby regression spotted on mobile');
    // Neither Vinoth, Avinash, nor Lakshmi (even with override: true!) can promote while vetoed.
    assert.equal((await fetch(`${base}/api/promote`, { method: 'POST', headers: { cookie: vinothCookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/promote`, { method: 'POST', headers: { cookie: avinashCookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/promote`, { method: 'POST', headers: { cookie: lakshmiCookie, 'content-type': 'application/json' }, body: JSON.stringify({ override: true }) })).status, 403);
    // Lakshmi must lift veto before approving.
    assert.equal((await fetch(`${base}/api/promote/approve`, { method: 'POST', headers: { cookie: lakshmiCookie } })).status, 409);
    // Vinoth/Avinash cannot lift Lakshmi's veto.
    assert.equal((await fetch(`${base}/api/promote/unveto`, { method: 'POST', headers: { cookie: vinothCookie } })).status, 403);

    // 6. New Pre-Prod releaseB resets approvals to 0/2 and clears veto (no carryover across builds).
    await writeFile(join(root, 'rollback-status.json'), statusFor(releaseB, 'ddddddd'));
    // Plain promote without override flag refreshes status, detects releaseB (0/2, not vetoed), and is rejected even for Lakshmi.
    const plainBRes = await fetch(`${base}/api/promote`, { method: 'POST', headers: { cookie: lakshmiCookie } });
    assert.equal(plainBRes.status, 403);
    const statusB = await plainBRes.json();
    assert.equal(statusB.preprod.releaseId, releaseB);
    assert.equal(statusB.preprod.approvals.approvedCount, 0);
    assert.equal(statusB.preprod.vetoed, false);
    assert.equal(statusB.preprod.promotable, false);
    assert.equal(statusB.preprod.canOverridePromote, true);
    // Vinoth cannot use override.
    assert.equal((await fetch(`${base}/api/promote`, { method: 'POST', headers: { cookie: vinothCookie, 'content-type': 'application/json' }, body: JSON.stringify({ override: true }) })).status, 403);
    // Lakshmi unilateral override promotes releaseB solo (0 prior approvals) and passes Python Layer 2 verification!
    const overrideRes = await fetch(`${base}/api/promote`, {
      method: 'POST',
      headers: { cookie: lakshmiCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ override: true }),
    });
    assert.equal(overrideRes.status, 202);
    let data;
    for (let i = 0; i < 100; i++) {
      data = await (await fetch(`${base}/api/status`, { headers: { cookie: lakshmiCookie } })).json();
      if (data.release.status !== 'running' && data.production.commitHash === 'ddddddd') break;
      await pause(30);
    }
    assert.equal(data.release.kind, 'promote');
    assert.equal(data.release.status, 'succeeded');
    assert.equal(data.production.commitHash, 'ddddddd');
    assert.match(data.release.log, /Lakshmi unilateral release override/);
    const verifiedOverride = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'last-verified-approvers.json'), 'utf8'));
    assert.deepEqual(verifiedOverride, { releaseId: releaseB, verified: ['lakshmi'] });

    // 7. Restore releaseA, restart console -> veto & 2/2 approvals survive restart -> Lakshmi lifts veto -> Vinoth promotes with 2/3 quorum (Vinoth + Avinash)!
    await writeFile(join(root, 'rollback-status.json'), statusFor(releaseA, 'ccccccc'));
    await stop();
    await start();
    const lakshmiCookie2 = await loginAs('lakshminathanlaky@gmail.com');
    const vinothCookie2 = await loginAs('vinoth121022@gmail.com');
    const blockedAfterRestart = await fetch(`${base}/api/promote`, { method: 'POST', headers: { cookie: vinothCookie2 } });
    assert.equal(blockedAfterRestart.status, 403);
    const afterRestart = await blockedAfterRestart.json();
    assert.equal(afterRestart.preprod.vetoed, true);
    assert.equal(afterRestart.preprod.approvals.approvedCount, 2);

    const unvetoRes = await fetch(`${base}/api/promote/unveto`, { method: 'POST', headers: { cookie: lakshmiCookie2 } });
    assert.equal(unvetoRes.status, 200);
    const unvetoed = await unvetoRes.json();
    assert.equal(unvetoed.preprod.vetoed, false);
    assert.equal(unvetoed.preprod.promotable, true);

    const promoteRes = await fetch(`${base}/api/promote`, { method: 'POST', headers: { cookie: vinothCookie2 } });
    assert.equal(promoteRes.status, 202);
    for (let i = 0; i < 100; i++) {
      data = await (await fetch(`${base}/api/status`, { headers: { cookie: vinothCookie2 } })).json();
      if (data.release.status !== 'running' && data.production.commitHash === 'ccccccc') break;
      await pause(30);
    }
    assert.equal(data.release.kind, 'promote');
    assert.equal(data.release.status, 'succeeded');
    assert.equal(data.production.commitHash, 'ccccccc');
    assert.equal(data.preprod.inSyncWithProd, true);
    assert.equal(data.preprod.promotable, false);
    const verifiedQuorum = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'last-verified-approvers.json'), 'utf8'));
    assert.deepEqual(verifiedQuorum, { releaseId: releaseA, verified: ['avinash', 'vinoth'] });
  } finally {
    await stop();
    resendMock.close();
    production.close();
    await rm(root, { recursive: true, force: true });
  }
});
