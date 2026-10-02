import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const STEP_DEFINITIONS = [
  ['prepare', 'Prepare source', 'Sync the release checkout and verify toolchains'],
  ['install', 'Install dependencies', 'Install the pinned application dependencies'],
  ['typecheck', 'Type checks', 'Validate application types'],
  ['lint', 'Code quality', 'Run scoped lint checks'],
  ['tests', 'Application tests', 'Run the complete application test suite'],
  ['infra', 'Infrastructure tests', 'Check release and content safeguards'],
  ['audit', 'Dependency audit', 'Check production dependency security'],
  ['narration', 'Narration coverage', 'Validate existing recording coverage'],
  ['browser', 'Browser setup', 'Prepare the web rendering browser'],
  ['server', 'Build server', 'Compile the target-architecture chess server'],
  ['migrate', 'Build migration tool', 'Compile the companion tool; no migrations are run'],
  ['web', 'Build web app', 'Export and prerender the production web bundle'],
  ['performance', 'Performance checks', 'Validate entry-point performance'],
  ['bundle', 'Bundle checks', 'Validate production bundle size'],
  ['assets', 'Asset publishing', 'Optional asset lane'],
  ['content', 'Content publishing', 'Optional content lane'],
  ['deploy', 'Deploy to Mumbai', 'Upload and atomically install the release'],
  ['health', 'Verify production', 'Check the service and roll back if unhealthy'],
];
export const stepTemplate = () => STEP_DEFINITIONS.map(([id, label, detail]) => ({
  id, label, detail, status: 'pending', startedAt: null, finishedAt: null, durationMs: null, peakRssBytes: null,
}));
export const emptyMetrics = () => ({ currentRssBytes: null, peakRssBytes: null, sampledAt: null, sampleIntervalMs: 1000, available: false, samples: [], scope: 'build-process-tree' });
export const elapsedMs = (startedAt, finishedAt, now = Date.now()) => startedAt ? Math.max(0, (finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt)) : null;

export function applyStepEvent(steps, event, now = Date.now()) {
  const item = steps.find(candidate => candidate.id === event?.id);
  if (!item || !['running', 'done', 'failed', 'skipped'].includes(event.status)) return false;
  if (['done', 'failed', 'skipped'].includes(item.status)) return false;
  const timestamp = new Date(now).toISOString();
  if (event.status === 'running') {
    if (item.status === 'running') return false;
    item.startedAt = timestamp;
  } else {
    item.finishedAt = timestamp;
    item.durationMs = elapsedMs(item.startedAt, timestamp, now);
  }
  item.status = event.status;
  return true;
}

// stdout/stderr chunks can split UTF-8 characters and markers at arbitrary boundaries.
export function createLineDecoder(onLine) {
  let pending = '';
  return {
    write(chunk) {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        onLine(pending.slice(0, newline).replace(/\r$/, ''));
        pending = pending.slice(newline + 1);
      }
      // A broken tool must not grow an unbounded line buffer.
      if (pending.length > 120_000) pending = pending.slice(-120_000);
    },
    end() { if (pending) onLine(pending); pending = ''; },
  };
}

export function parseStepEvent(line) {
  const prefix = '@@CHESSALIVE_STEP ';
  if (!line.startsWith(prefix)) return null;
  try { return JSON.parse(line.slice(prefix.length)); } catch { return null; }
}

export function processTreeRss(output, rootPid, processGroup = false) {
  const rows = String(output).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
    .filter(row => row.length === 4 && row.every(Number.isFinite));
  if (!rows.some(([pid, , pgid]) => pid === rootPid || (processGroup && pgid === rootPid))) return null;
  const ids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid, pgid] of rows) if (!ids.has(pid) && (ids.has(ppid) || (processGroup && pgid === rootPid))) { ids.add(pid); changed = true; }
  }
  return rows.reduce((total, [pid, , , kib]) => total + (ids.has(pid) ? Math.max(0, kib) * 1024 : 0), 0);
}

export async function sampleProcessMemory(pid) {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,pgid=,rss='], { timeout: 2500, maxBuffer: 4 * 1024 * 1024 });
  return processTreeRss(stdout, pid, true);
}

export function recordMemory(release, rssBytes, now = Date.now()) {
  const metrics = release.metrics;
  if (!Number.isFinite(rssBytes) || rssBytes < 0) { metrics.available = false; metrics.currentRssBytes = null; return; }
  metrics.available = true;
  metrics.currentRssBytes = rssBytes;
  metrics.peakRssBytes = Math.max(metrics.peakRssBytes ?? 0, rssBytes);
  metrics.sampledAt = new Date(now).toISOString();
  metrics.samples.push({ elapsedMs: elapsedMs(release.startedAt, null, now), rssBytes });
  // Compact long runs by retaining the largest sample in each pair, preserving visible peaks.
  if (metrics.samples.length > 600) metrics.samples = metrics.samples.filter((sample, i, all) => i % 2 === 0 ? (!all[i + 1] || sample.rssBytes >= all[i + 1].rssBytes) : sample.rssBytes > all[i - 1].rssBytes);
  for (const item of release.steps) if (item.status === 'running') item.peakRssBytes = Math.max(item.peakRssBytes ?? 0, rssBytes);
}

export function finishSteps(steps, success, now = Date.now()) {
  for (const item of steps) if (item.status === 'running') applyStepEvent(steps, { id: item.id, status: success ? 'done' : 'failed' }, now);
}
