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
      env: { PATH: process.env.PATH, BUILD_RESOURCE_MONITOR_ENABLED: 'no', BUILD_TRIGGER_HOST: '127.0.0.1', BUILD_TRIGGER_PORT: '0', BUILD_TRIGGER_TOKEN: 'test-only', PUBLIC_URL: `http://127.0.0.1:${production.address().port}`, SOURCE_DIR: root, BUILD_STATE_FILE: stateFile },
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
    for (const file of ['build-trigger.mjs', 'build-metrics.mjs', 'dashboard.mjs', 'monitor-policy.mjs', 'resource-monitor.mjs', 'resource-snapshot.py', 'cloud-resource-snapshot.py']) await copyFile(new URL(file, import.meta.url), join(root, 'release', file));
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
    await start();
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
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
  } finally { await stop(); production.close(); await rm(root, { recursive: true, force: true }); }
});
