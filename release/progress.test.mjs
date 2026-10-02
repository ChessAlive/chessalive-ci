import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const releaseDir = path.dirname(fileURLToPath(import.meta.url));
const progressScript = path.join(releaseDir, 'progress.sh');
const localRelease = path.join(releaseDir, 'local-release.sh');
const allSteps = ['prepare', 'install', 'typecheck', 'lint', 'tests', 'infra', 'audit', 'narration', 'browser', 'server', 'migrate', 'web', 'performance', 'bundle', 'assets', 'content', 'deploy', 'health'];
const marker = (id, status) => ({ id, status });
const events = result => result.stdout.split('\n').filter(line => line.startsWith('@@CHESSALIVE_STEP ')).map(line => JSON.parse(line.slice('@@CHESSALIVE_STEP '.length)));

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'chessalive-progress-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const source = path.join(root, 'source');
  mkdirSync(bin);
  mkdirSync(source);
  writeFileSync(path.join(source, '.source-commit'), 'a'.repeat(40));
  const commandLog = path.join(root, 'commands.log');
  const script = `#!/bin/sh
printf '%s %s\\n' "\${0##*/}" "$*" >> "$COMMAND_LOG"
if [ "$*" = "\${FAIL_COMMAND:-}" ]; then exit 37; fi
case "$*" in
  'run build:server:local') sleep 0.06 ;;
  'run build:migrate:local') sleep 0.01 ;;
  'run setup:web-browser') sleep 0.10 ;;
esac
exit 0
`;
  for (const name of ['node', 'npm', 'npx', 'go', 'file']) writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: commandLog, SOURCE_DIR: source, SOURCE_COMMIT_FILE: path.join(source, '.source-commit'), SYNC_SOURCE: 'no', BUILD_COMMIT_HASH: 'unknown', BUILD_ARCH: 'amd64', LOCAL_DEPLOY: 'yes', CHESSALIVE_PROGRESS: 'yes', SKIP_TESTS: 'no', SKIP_FULL_TESTS: 'no', SKIP_INSTALL: 'no', SKIP_WEB: 'no', SKIP_WEB_SETUP: 'no', SKIP_BUDGETS: 'no', SKIP_DEPLOY: 'yes', SKIP_ASSETS: 'yes', SKIP_CONTENT: 'yes', FAIL_COMMAND: '' };
  const run = (overrides = {}) => spawnSync('bash', [localRelease], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000 });
  return { root, bin, source, env, run, commandLog };
}

test('release emits every executed/skipped step and preserves independent parallel completion', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const observed = events(result);
  for (const id of allSteps) {
    const statuses = observed.filter(event => event.id === id).map(event => event.status);
    assert.deepEqual(statuses, ['assets', 'content', 'deploy', 'health'].includes(id) ? ['skipped'] : ['running', 'done'], id);
  }
  assert.ok(observed.findIndex(event => event.id === 'migrate' && event.status === 'done') < observed.findIndex(event => event.id === 'server' && event.status === 'done'));
  assert.ok(observed.findIndex(event => event.id === 'server' && event.status === 'done') < observed.findIndex(event => event.id === 'browser' && event.status === 'done'));
});

test('sequential command failure is explicit and retains its exit status', t => {
  const result = fixture(t).run({ FAIL_COMMAND: 'run typecheck' });
  assert.equal(result.status, 37);
  assert.deepEqual(events(result).filter(event => event.id === 'typecheck'), [marker('typecheck', 'running'), marker('typecheck', 'failed')]);
  assert.ok(!events(result).some(event => event.id === 'lint'));
});

test('parallel failure settles sibling jobs without successful markers for the failed step', t => {
  const result = fixture(t).run({ FAIL_COMMAND: 'run build:server:local' });
  assert.equal(result.status, 1, result.stderr);
  const observed = events(result);
  assert.deepEqual(observed.filter(event => event.id === 'server'), [marker('server', 'running'), marker('server', 'failed')]);
  assert.ok(observed.some(event => event.id === 'migrate' && event.status === 'done'));
  assert.ok(observed.some(event => event.id === 'browser' && event.status === 'done'));
  assert.ok(!observed.some(event => event.id === 'web'));
});

test('optional gates emit skipped exactly once and never run their commands', t => {
  const f = fixture(t);
  const result = f.run({ SKIP_INSTALL: 'yes', SKIP_TESTS: 'yes', SKIP_WEB: 'yes' });
  assert.equal(result.status, 0, result.stderr);
  for (const id of allSteps.filter(id => !['prepare', 'server', 'migrate'].includes(id))) {
    assert.deepEqual(events(result).filter(event => event.id === id), [marker(id, 'skipped')]);
  }
  assert.deepEqual(readFileSync(f.commandLog, 'utf8').trim().split('\n').sort(), ['npm run build:migrate:local', 'npm run build:server:local']);
});

test('progress markers are opt-in', t => {
  const result = fixture(t).run({ CHESSALIVE_PROGRESS: 'no' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events(result), []);
});

test('EXIT trap fails active preparation and preserves nonzero exit', () => {
  const result = spawnSync('bash', ['-c', 'set -euo pipefail; source "$1"; trap \'progress_on_exit "$?"\' EXIT; progress_mark prepare running; exit 23', 'test', progressScript], { env: { ...process.env, CHESSALIVE_PROGRESS: 'yes' }, encoding: 'utf8' });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(events(result), [marker('prepare', 'running'), marker('prepare', 'failed')]);
});

test('remote reconciliation fails health after transport loss without rewriting completed install', t => {
  const f = fixture(t);
  const log = path.join(f.root, 'remote.log');
  writeFileSync(log, '@@CHESSALIVE_STEP {"id":"deploy","status":"done"}\n@@CHESSALIVE_STEP {"id":"health","status":"running"}\n');
  const result = spawnSync('bash', ['-c', 'set -euo pipefail; source "$1"; trap \'progress_on_exit "$?"\' EXIT; progress_mark deploy running; progress_adopt_log "$2"; exit 255', 'test', progressScript, log], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 255, result.stderr);
  assert.deepEqual(events(result), [marker('deploy', 'running'), marker('health', 'failed')]);
});

const deployScript = readFileSync(path.join(releaseDir, 'deploy-chessd.sh'), 'utf8');
const remoteScript = deployScript.split("<<'REMOTE_SCRIPT' | tee \"${DEPLOY_PROGRESS_LOG}\"\n")[1].split('\nREMOTE_SCRIPT\n')[0];

function runRemote(t, overrides = {}) {
  const f = fixture(t);
  writeFileSync(path.join(f.bin, 'sudo'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$COMMAND_LOG"\ncase "$*" in *chessd.new*) if [ "\${FAIL_INSTALL:-}" = yes ]; then exit 19; fi ;; esac\nexit 0\n`, { mode: 0o755 });
  writeFileSync(path.join(f.bin, 'curl'), `#!/bin/sh\nif [ "\${FAIL_HEALTH:-}" = yes ]; then exit 22; fi\nprintf '{"ok":true}'\n`, { mode: 0o755 });
  writeFileSync(path.join(f.bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const stage = path.join(f.root, 'stage');
  mkdirSync(stage);
  const result = spawnSync('bash', ['-s'], { input: remoteScript, encoding: 'utf8', timeout: 10000, env: { ...f.env, STAGE: stage, REMOTE_ROOT: path.join(f.root, 'remote'), SERVICE: 'chessd-progress-test', HEALTH_URL: 'http://unused.invalid/health', HEALTH_RETRIES: '2', HEALTH_INTERVAL: '0', SKIP_WEB: 'no', FAIL_INSTALL: '', FAIL_HEALTH: '', ...overrides } });
  return { ...f, result };
}

test('remote transaction reports install then actual health gate', t => {
  const { result } = runRemote(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events(result), [marker('deploy', 'done'), marker('health', 'running'), marker('health', 'done')]);
});

test('remote install failure does not start health and keeps its failure status', t => {
  const { result } = runRemote(t, { FAIL_INSTALL: 'yes' });
  assert.equal(result.status, 19, result.stderr);
  assert.deepEqual(events(result), [marker('deploy', 'failed')]);
});

test('failed health gate rolls back and never rewrites installation as failed', t => {
  const { result, commandLog } = runRemote(t, { FAIL_HEALTH: 'yes' });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(events(result), [marker('deploy', 'done'), marker('health', 'running'), marker('health', 'failed')]);
  assert.match(result.stderr, /rolled back to the previous binary and service unit/);
  assert.match(readFileSync(commandLog, 'utf8'), /chessd\.prev.*chessd/);
});
