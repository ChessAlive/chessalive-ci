import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { requiredContent, verifyContent } from './content-readiness.mjs';

const slice = {
  animationClips: [{ id: 'zap', name: 'RoyalZap', sourceGlbPath: '/uploads/king.v2.glb' }],
  pieceSets: [{ id: 'world', pieces: { wk: { glbPath: '/uploads/king.v2.glb' } } }],
  animationSets: [{ id: 'motions', ceremonies: { clipRolesByPiece: { wk: { strike: 'zap' } } } }],
};

test('deployed code with the old motion catalog is rejected', () => {
  const prod = structuredClone(slice);
  prod.animationClips = [];
  prod.pieceSets[0].pieces.wk.glbPath = '/uploads/king.v1.glb';
  assert.equal(requiredContent(prod, [slice]).issues.length, 2);
});

test('matching clip ids with wrong bodies and incorrect cast bindings are rejected', () => {
  const prod = structuredClone(slice);
  prod.animationClips[0].sourceGlbPath = '/uploads/king.v1.glb';
  prod.animationSets[0].ceremonies.clipRolesByPiece.wk.strike = 'old';
  assert.equal(requiredContent(prod, [slice]).issues.length, 2);
});

test('unowned records and production default choices are preserved', () => {
  const prod = structuredClone(slice);
  prod.animationClips.push({ id: 'studio-clip', name: 'Extra' });
  prod.pieceSets[0].isDefault = true;
  assert.deepEqual(requiredContent(prod, [slice]), { issues: [], uploads: ['/uploads/king.v2.glb'] });
});

async function fixture(t, assetResponse) {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'chessalive-content-gate-'));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await mkdir(join(sourceRoot, 'content/catalog'), { recursive: true });
  await writeFile(join(sourceRoot, 'content/catalog.config.json'), JSON.stringify({ sets: [{ animationSetId: 'motions' }] }));
  await writeFile(join(sourceRoot, 'content/catalog/motions.json'), JSON.stringify(slice));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([String(url), options.method ?? 'GET']);
    return url.pathname === '/catalog/state'
      ? new Response(JSON.stringify({ ...slice, appStateRevision: 22 }), { headers: { 'content-type': 'application/json' } })
      : assetResponse;
  };
  return { sourceRoot, publicUrl: 'https://example.test', fetchImpl, calls };
}

test('matching catalog with a missing model fails instead of passing the app health gate', async t => {
  const f = await fixture(t, new Response('', { status: 404 }));
  await assert.rejects(verifyContent(f), /Required model.*unavailable/);
});

test('HTML fallback masquerading as a successful model download is rejected', async t => {
  const f = await fixture(t, new Response('<html>', { headers: { 'content-type': 'text/html', 'content-length': '6' } }));
  await assert.rejects(verifyContent(f), /Required model.*unavailable/);
});

test('live catalog and accessible models pass with read-only requests', async t => {
  const f = await fixture(t, new Response(null, { headers: { 'content-type': 'model/gltf-binary', 'content-length': '64' } }));
  assert.deepEqual(await verifyContent(f), { revision: 22, worlds: 1, models: 1 });
  assert.deepEqual(f.calls.map(call => call[1]), ['GET', 'HEAD']);
});
