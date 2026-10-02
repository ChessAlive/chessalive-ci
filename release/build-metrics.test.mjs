import assert from 'node:assert/strict';
import test from 'node:test';
import { stepTemplate, emptyMetrics, elapsedMs, applyStepEvent, createLineDecoder, parseStepEvent, processTreeRss, recordMemory, finishSteps } from './build-metrics.mjs';

test('parallel steps keep independent clocks and terminal events are idempotent', () => {
  const steps = stepTemplate();
  applyStepEvent(steps, { id: 'server', status: 'running' }, 1000);
  applyStepEvent(steps, { id: 'migrate', status: 'running' }, 1100);
  applyStepEvent(steps, { id: 'server', status: 'running' }, 1200);
  applyStepEvent(steps, { id: 'migrate', status: 'done' }, 1500);
  applyStepEvent(steps, { id: 'server', status: 'done' }, 2000);
  applyStepEvent(steps, { id: 'server', status: 'failed' }, 3000);
  assert.equal(steps.find(s => s.id === 'server').durationMs, 1000);
  assert.equal(steps.find(s => s.id === 'server').status, 'done');
  assert.equal(steps.find(s => s.id === 'migrate').durationMs, 400);
  assert.equal(elapsedMs(new Date(1000).toISOString(), new Date(2000).toISOString(), 9000), 1000);
});

test('chunk boundaries and ordinary test output cannot manufacture step transitions', () => {
  const events = [];
  const lines = createLineDecoder(line => { const event = parseStepEvent(line); if (event) events.push(event); });
  lines.write('passing test: failed builds recover\n@@CHESS');
  lines.write('ALIVE_STEP {"id":"web","status":"run');
  lines.write('ning"}\r\n@@CHESSALIVE_STEP malformed\n');
  lines.write('@@CHESSALIVE_STEP {"id":"web","status":"done"}');
  lines.end();
  assert.deepEqual(events, [{ id: 'web', status: 'running' }, { id: 'web', status: 'done' }]);
});

test('RSS includes descendants and reparented build group members, excludes unrelated jobs', () => {
  const ps = '10 1 10 100\n11 10 10 200\n12 11 12 300\n13 1 10 50\n20 1 20 9999';
  assert.equal(processTreeRss(ps, 10, true), 650 * 1024);
  assert.equal(processTreeRss(ps, 10, false), 600 * 1024);
  assert.equal(processTreeRss(ps, 98, true), null);
  assert.equal(processTreeRss('13 1 10 50', 10, true), 50 * 1024);
});

test('missing samples remain unavailable and peak RAM survives chart compaction', () => {
  const release = { startedAt: new Date(0).toISOString(), steps: stepTemplate(), metrics: emptyMetrics() };
  applyStepEvent(release.steps, { id: 'web', status: 'running' }, 0);
  for (let i = 0; i < 1300; i++) recordMemory(release, i === 51 ? 500000 : 1024, i * 1000);
  assert.equal(release.metrics.peakRssBytes, 500000);
  assert.ok(release.metrics.samples.length <= 600);
  assert.ok(release.metrics.samples.some(s => s.rssBytes === 500000));
  assert.equal(release.steps.find(s => s.id === 'web').peakRssBytes, 500000);
  recordMemory(release, null);
  assert.equal(release.metrics.available, false);
  assert.equal(release.metrics.currentRssBytes, null);
  assert.equal(release.metrics.peakRssBytes, 500000);
});

test('failure freezes running steps without claiming unstarted steps ran', () => {
  const steps = stepTemplate();
  applyStepEvent(steps, { id: 'install', status: 'running' }, 1000);
  applyStepEvent(steps, { id: 'browser', status: 'skipped' }, 1000);
  finishSteps(steps, false, 4500);
  assert.equal(steps.find(s => s.id === 'install').durationMs, 3500);
  assert.equal(steps.find(s => s.id === 'install').status, 'failed');
  assert.equal(steps.find(s => s.id === 'browser').durationMs, null);
  assert.equal(steps.find(s => s.id === 'deploy').status, 'pending');
});
