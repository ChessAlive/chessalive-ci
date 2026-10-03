import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { createResourceMonitor, deriveResourceRates } from './resource-monitor.mjs';

const snapshot = (overrides = {}) => ({
  sampledAtMs: 1000, bootId: 'boot-a', hostname: 'fixture-host', uptimeSeconds: 100,
  cpu: { logicalCores: 4, totalTicks: 1000, idleTicks: 600, loadAverage: [1, 0.5, 0.25] },
  memory: { totalBytes: 8192, usedBytes: 4096, availableBytes: 4096 },
  network: { receivedBytes: 1000, sentBytes: 2000, interfaces: [{ name: 'eth0' }] },
  disks: [{ path: '/', totalBytes: 10000, usedBytes: 2000, availableBytes: 7000 }],
  ...overrides,
});

const cloudSnapshot = (overrides = {}) => ({
  schemaVersion: 1, provider: 'oci', sampledAtMs: 1000, region: 'ap-hyderabad-1',
  auth: { status: 'available', method: 'instance_principal' },
  compute: { status: 'available', scope: 'instance compartment', items: [{ name: 'build-host', ocpus: 2, memoryGB: 12 }] },
  usage: { status: 'available', scope: 'tenancy', source: 'OCI Usage API', excludesCurrentDay: true, rows: [{ service: 'Compute', unit: 'OCPU HOURS', quantity: 12 }], truncated: false },
  database: { status: 'unavailable', reason: 'Not authorized for database metrics' },
  limits: { status: 'partial', note: 'Provisioning quotas are not free-tier entitlements.', items: [] },
  freeTier: { status: 'unavailable', remaining: null, reason: 'Exact entitlement not supplied by these APIs.' },
  ...overrides,
});

const rates = value => [value.cpu.usagePercent, value.network.ingressBytesPerSecond, value.network.egressBytesPerSecond];

test('CPU and network rates use real elapsed counter deltas independently', () => {
  const previous = snapshot();
  const next = snapshot({ sampledAtMs: 3000, cpu: { totalTicks: 1400, idleTicks: 700 }, network: { receivedBytes: 7000, sentBytes: 4000, interfaces: [{ name: 'eth0' }] } });
  assert.deepEqual(rates(deriveResourceRates(next, previous)), [75, 3000, 1000]);
  assert.equal(previous.cpu.usagePercent, undefined, 'previous raw sample must stay unchanged');
  assert.equal(next.memory.usedBytes, 4096, 'RAM is an instantaneous gauge, not a delta');
});

test('first sample, reboot, missing boot ID, and non-forward time never fabricate rates', () => {
  assert.deepEqual(rates(deriveResourceRates(snapshot(), null)), [null, null, null]);
  for (const overrides of [{ sampledAtMs: 3000, bootId: 'boot-b' }, { sampledAtMs: 3000, bootId: '' }, { sampledAtMs: 1000 }, { sampledAtMs: 999 }]) {
    assert.deepEqual(rates(deriveResourceRates(snapshot(overrides), snapshot())), [null, null, null]);
  }
});

test('interface order is immaterial, but interface replacement or missing NICs invalidates traffic rates', () => {
  const previous = snapshot({ network: { receivedBytes: 1000, sentBytes: 2000, interfaces: [{ name: 'eth0' }, { name: 'eth1' }] } });
  const network = { receivedBytes: 3000, sentBytes: 5000, interfaces: [{ name: 'eth1' }, { name: 'eth0' }] };
  const reordered = deriveResourceRates(snapshot({ sampledAtMs: 2000, network }), previous);
  assert.equal(reordered.network.ingressBytesPerSecond, 2000);
  assert.equal(reordered.network.egressBytesPerSecond, 3000);
  for (const interfaces of [[{ name: 'eth2' }], []]) {
    const result = deriveResourceRates(snapshot({ sampledAtMs: 2000, network: { ...network, interfaces } }), previous);
    assert.equal(result.network.ingressBytesPerSecond, null);
    assert.equal(result.network.egressBytesPerSecond, null);
  }
});

test('counter resets invalidate only affected measurements and recover from the next baseline', () => {
  const reset = deriveResourceRates(snapshot({ sampledAtMs: 2000, cpu: { totalTicks: 10, idleTicks: 5 }, network: { receivedBytes: 100, sentBytes: 4000, interfaces: [{ name: 'eth0' }] } }), snapshot());
  assert.deepEqual(rates(reset), [null, null, 2000]);
  const recovered = deriveResourceRates(snapshot({ sampledAtMs: 4000, cpu: { totalTicks: 210, idleTicks: 105 }, network: { receivedBytes: 1100, sentBytes: 5000, interfaces: [{ name: 'eth0' }] } }), reset);
  assert.deepEqual(rates(recovered), [50, 500, 500]);
});

test('missing or nonfinite counters stay unavailable, while a measured idle interval is zero', () => {
  for (const missing of [undefined, null, NaN, Infinity, '123']) {
    const next = snapshot({ sampledAtMs: 2000, cpu: { totalTicks: missing, idleTicks: 700 }, network: { receivedBytes: missing, sentBytes: missing, interfaces: [{ name: 'eth0' }] } });
    assert.deepEqual(rates(deriveResourceRates(next, snapshot())), [null, null, null]);
  }
  const idle = snapshot({ sampledAtMs: 2000, cpu: { totalTicks: 1100, idleTicks: 700 } });
  assert.deepEqual(rates(deriveResourceRates(idle, snapshot())), [0, 0, 0]);
  assert.equal(deriveResourceRates(snapshot({ sampledAtMs: 2000 }), snapshot()).cpu.usagePercent, null, 'zero CPU tick delta is unknown, not idle');
});

// Real subprocess boundaries, but fake python3/ssh executables: tests never SSH to a host or
// collect the machine running this suite. Each fixture controls output, failure, and argv.
async function fakeCollectors(t) {
  const root = await mkdtemp(join(tmpdir(), 'ci-resource-test-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const oldPath = process.env.PATH;
  const oldRoot = process.env.CI_RESOURCE_TEST_ROOT;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.CI_RESOURCE_TEST_ROOT = root;
  t.after(async () => {
    process.env.PATH = oldPath;
    if (oldRoot === undefined) delete process.env.CI_RESOURCE_TEST_ROOT;
    else process.env.CI_RESOURCE_TEST_ROOT = oldRoot;
    await rm(root, { recursive: true, force: true });
  });
  const executable = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.CI_RESOURCE_TEST_ROOT;
const kind = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const cloud = args.some(value => value.includes('cloud-resource-snapshot.py') || value.includes('oci-cli-venv'));
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({kind, cloud, args})+'\\n');
const fixture = JSON.parse(fs.readFileSync(path.join(root, kind+(cloud ? '-cloud' : '')+'.json'), 'utf8'));
process.stdin.resume();
process.stdin.on('end', () => {
  if (fixture.exit) process.exit(fixture.exit);
  process.stdout.write(fixture.raw ?? JSON.stringify(fixture.snapshot));
});
`;
  for (const name of ['python3', 'ssh']) await writeFile(join(bin, name), executable, { mode: 0o755 });
  const set = async (kind, fixture) => writeFile(join(root, `${kind}.json`), JSON.stringify(fixture));
  await set('python3', { snapshot: snapshot() });
  await set('ssh', { snapshot: snapshot({ hostname: 'fixture-production' }) });
  await set('python3-cloud', { snapshot: cloudSnapshot() });
  await set('ssh-cloud', { snapshot: cloudSnapshot({ region: 'ap-mumbai-1' }) });
  const calls = async () => { try { return (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { root, set, calls };
}

test('monitor keeps stale last-known data explicit after failure, then recovers from real deltas', async t => {
  const fixture = await fakeCollectors(t);
  const monitor = createResourceMonitor({ remoteHost: '127.0.0.2', remoteKey: '/fake key' });
  t.after(() => monitor.stop());
  await monitor.refresh();
  const previous = structuredClone(monitor.publicState());
  assert.ok(previous.hosts.every(host => host.status === 'available' && host.checkedAt));
  await fixture.set('python3', { exit: 23 });
  await fixture.set('ssh', { raw: 'not JSON' });
  await monitor.refresh();
  const failed = monitor.publicState();
  for (const host of failed.hosts) {
    const old = previous.hosts.find(candidate => candidate.id === host.id);
    assert.equal(host.status, 'unavailable');
    assert.deepEqual(host.snapshot, old.snapshot, 'last-known capacity remains distinguishable from a fresh sample');
    assert.equal(host.checkedAt, old.checkedAt, 'failure must not relabel an old snapshot as freshly checked');
    assert.ok(host.error);
  }
  await fixture.set('python3', { snapshot: snapshot({ sampledAtMs: 5000, cpu: { totalTicks: 1400, idleTicks: 800 }, network: { receivedBytes: 5000, sentBytes: 4000, interfaces: [{ name: 'eth0' }] } }) });
  await fixture.set('ssh', { snapshot: snapshot({ sampledAtMs: 5000, bootId: 'rebooted-production' }) });
  await monitor.refresh();
  assert.deepEqual(rates(monitor.publicState().hosts[0].snapshot), [50, 1000, 500]);
  assert.deepEqual(rates(monitor.publicState().hosts[1].snapshot), [null, null, null]);
  assert.ok(monitor.publicState().hosts.every(host => host.status === 'available' && host.error === null));
  const ssh = (await fixture.calls()).find(call => call.kind === 'ssh');
  assert.ok(ssh.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(ssh.args.includes('BatchMode=yes'));
  assert.ok(ssh.args.includes('/fake key'));
  assert.deepEqual(ssh.args.slice(-2), ['ubuntu@127.0.0.2', 'python3 -']);
});

test('invalid or failed first samples are unavailable without fictional capacity', async t => {
  const fixture = await fakeCollectors(t);
  await fixture.set('python3', { snapshot: { sampledAtMs: 1000, cpu: {}, memory: {}, disks: [] } });
  await fixture.set('ssh', { exit: 255 });
  const monitor = createResourceMonitor({ remoteHost: '127.0.0.2' });
  await monitor.refresh();
  assert.ok(monitor.publicState().hosts.every(host => host.status === 'unavailable' && host.snapshot === null && host.checkedAt === null));
  assert.match(monitor.publicState().hosts[0].error, /invalid metrics snapshot/);
});

test('remote misconfiguration is isolated from local capacity and never becomes an SSH argument', async t => {
  const fixture = await fakeCollectors(t);
  for (const config of [{}, { remoteHost: 'host; touch /tmp/invalid' }, { remoteHost: '127.0.0.2', remoteUser: 'user name' }]) {
    const monitor = createResourceMonitor(config);
    await monitor.refresh();
    const [local, remote] = monitor.publicState().hosts;
    assert.equal(local.status, 'available');
    assert.equal(remote.status, 'unavailable');
    assert.equal(remote.snapshot, null);
  }
  assert.ok((await fixture.calls()).every(call => call.kind === 'python3'));
});

test('disabled monitors perform no collection and clamp polling intervals', async t => {
  const fixture = await fakeCollectors(t);
  for (const [intervalMs, expected] of [[1, 5000], [90000, 60000], ['invalid', 10000]]) {
    const monitor = createResourceMonitor({ enabled: false, intervalMs });
    monitor.start();
    await monitor.refresh();
    monitor.stop();
    assert.equal(monitor.publicState().sampleIntervalMs, expected);
    assert.ok(monitor.publicState().hosts.every(host => host.snapshot === null));
  }
  assert.deepEqual(await fixture.calls(), []);
});

test('overlapping refresh requests share one collection pass', async t => {
  const fixture = await fakeCollectors(t);
  const monitor = createResourceMonitor({ remoteHost: '127.0.0.2' });
  await Promise.all([monitor.refresh(), monitor.refresh(), monitor.refresh()]);
  const calls = await fixture.calls();
  assert.equal(calls.filter(call => call.kind === 'python3').length, 1);
  assert.equal(calls.filter(call => call.kind === 'ssh').length, 1);
});

test('provider snapshots remain separate from capacity and retain host, tenancy, and entitlement semantics', async t => {
  const fixture = await fakeCollectors(t);
  const monitor = createResourceMonitor({ remoteHost: '127.0.0.2', remoteKey: '/fake cloud key' });
  await monitor.refresh();
  assert.ok((await fixture.calls()).every(call => !call.cloud));
  assert.ok(monitor.publicState().providerUsage.hosts.every(host => host.snapshot === null));
  const capacity = structuredClone(monitor.publicState().hosts);
  await monitor.refreshCloud();
  const state = monitor.publicState();
  assert.deepEqual(state.hosts, capacity, 'provider collection must not replace host capacity timestamps or values');
  assert.equal(state.sampleIntervalMs, 10000);
  assert.equal(state.providerUsage.sampleIntervalMs, 300000);
  assert.deepEqual(state.providerUsage.hosts.map(host => [host.id, host.status, host.snapshot.region]), [
    ['hyderabad', 'available', 'ap-hyderabad-1'], ['mumbai', 'available', 'ap-mumbai-1'],
  ]);
  for (const host of state.providerUsage.hosts) {
    assert.equal(host.snapshot.usage.scope, 'tenancy');
    assert.equal(host.snapshot.compute.scope, 'instance compartment');
    assert.equal(host.snapshot.usage.rows[0].quantity, 12, 'same-tenancy reports are not added together');
    assert.equal(host.snapshot.freeTier.remaining, null, 'CPU/RAM/NIC measurements must never create an allowance');
    assert.equal(host.snapshot.database.status, 'unavailable');
  }
  const remote = (await fixture.calls()).find(call => call.kind === 'ssh' && call.cloud);
  assert.deepEqual(remote.args.slice(-2), ['ubuntu@127.0.0.2', '/opt/oci-cli-venv/bin/python3 -']);
  assert.ok(remote.args.includes('/fake cloud key'));
  assert.ok(remote.args.includes('StrictHostKeyChecking=yes'));
});

test('failed cloud collection preserves old data and timestamp while marking that host unavailable', async t => {
  const fixture = await fakeCollectors(t);
  const monitor = createResourceMonitor({ remoteHost: '127.0.0.2' });
  await Promise.all([monitor.refresh(), monitor.refreshCloud()]);
  const before = structuredClone(monitor.publicState());
  await fixture.set('python3-cloud', { exit: 23 });
  await fixture.set('ssh-cloud', { raw: 'not cloud JSON' });
  await monitor.refreshCloud();
  for (const [index, host] of monitor.publicState().providerUsage.hosts.entries()) {
    assert.equal(host.status, 'unavailable');
    assert.deepEqual(host.snapshot, before.providerUsage.hosts[index].snapshot);
    assert.equal(host.checkedAt, before.providerUsage.hosts[index].checkedAt);
    assert.ok(host.error);
  }
  assert.deepEqual(monitor.publicState().hosts, before.hosts, 'cloud outage cannot hide live machine capacity');
  await fixture.set('python3-cloud', { snapshot: cloudSnapshot({ sampledAtMs: 5000 }) });
  await fixture.set('ssh-cloud', { snapshot: cloudSnapshot({ sampledAtMs: 5000, region: 'ap-mumbai-1' }) });
  await monitor.refreshCloud();
  assert.ok(monitor.publicState().providerUsage.hosts.every(host => host.status === 'available' && host.error === null && host.snapshot.sampledAtMs === 5000));
});

test('cloud transport success does not overwrite provider-reported permission and metric failures', async t => {
  const fixture = await fakeCollectors(t);
  const denied = { status: 'unavailable', reason: 'Provider access is not authorized for this data.' };
  const unavailable = cloudSnapshot({ auth: denied, compute: denied, database: denied, usage: denied, limits: denied });
  await fixture.set('python3-cloud', { snapshot: unavailable });
  const monitor = createResourceMonitor({ remoteHost: '127.0.0.2' });
  await monitor.refreshCloud();
  const local = monitor.publicState().providerUsage.hosts[0];
  assert.equal(local.status, 'available', 'delivery succeeded; each provider section retains its own status');
  assert.deepEqual(local.snapshot, unavailable);
  assert.equal(local.snapshot.freeTier.remaining, null);
});

test('cloud rejects malformed JSON, wrong provider/version and missing collection timestamps', async t => {
  const fixture = await fakeCollectors(t);
  for (const invalid of [cloudSnapshot({ schemaVersion: 2 }), cloudSnapshot({ provider: 'other' }), cloudSnapshot({ sampledAtMs: null })]) {
    await fixture.set('python3-cloud', { snapshot: invalid });
    const monitor = createResourceMonitor({ remoteHost: '127.0.0.2' });
    await monitor.refreshCloud();
    const host = monitor.publicState().providerUsage.hosts[0];
    assert.equal(host.status, 'unavailable');
    assert.equal(host.snapshot, null);
    assert.match(host.error, /invalid metrics snapshot/);
    assert.equal(monitor.publicState().providerUsage.hosts[1].status, 'available', 'one bad region cannot hide the other');
  }
});

test('cloud can be disabled while regular capacity polling starts, and provider cadence is bounded separately', async t => {
  const fixture = await fakeCollectors(t);
  const monitor = createResourceMonitor({ remoteHost: '127.0.0.2', cloudEnabled: false, intervalMs: 5000, cloudIntervalMs: 1 });
  t.after(() => monitor.stop());
  await monitor.refreshCloud();
  assert.deepEqual(await fixture.calls(), []);
  monitor.start();
  monitor.start();
  for (let attempt = 0; attempt < 100 && monitor.publicState().hosts.some(host => host.status === 'loading'); attempt += 1) await wait(10);
  monitor.stop();
  assert.ok(monitor.publicState().hosts.every(host => host.status === 'available'));
  assert.equal((await fixture.calls()).length, 2, 'start is idempotent and starts only the two capacity collectors');
  assert.ok((await fixture.calls()).every(call => !call.cloud));
  assert.ok(monitor.publicState().providerUsage.hosts.every(host => host.snapshot === null));
  assert.equal(monitor.publicState().providerUsage.sampleIntervalMs, 60000);
  assert.equal(createResourceMonitor({ cloudIntervalMs: 999999999 }).publicState().providerUsage.sampleIntervalMs, 3600000);
  assert.equal(createResourceMonitor({ cloudIntervalMs: 'invalid' }).publicState().providerUsage.sampleIntervalMs, 300000);
});

test('cloud refresh overlap is suppressed independently while capacity refresh remains live', async t => {
  const fixture = await fakeCollectors(t);
  const monitor = createResourceMonitor({ remoteHost: '127.0.0.2' });
  await Promise.all([monitor.refreshCloud(), monitor.refreshCloud(), monitor.refresh(), monitor.refreshCloud()]);
  const calls = await fixture.calls();
  assert.equal(calls.filter(call => call.cloud).length, 2);
  assert.equal(calls.filter(call => !call.cloud).length, 2);
  assert.ok(monitor.publicState().hosts.every(host => host.status === 'available'));
  assert.ok(monitor.publicState().providerUsage.hosts.every(host => host.status === 'available'));
});

test('cloud collectors have a 45-second bound and surface timeout without inventing a snapshot', async t => {
  await fakeCollectors(t);
  const realSetTimeout = globalThis.setTimeout;
  const budgets = [];
  t.mock.method(globalThis, 'setTimeout', (callback, timeoutMs, ...args) => {
    budgets.push(timeoutMs);
    // Exercise the real kill/close/error path promptly instead of sleeping for 45 seconds.
    return realSetTimeout(callback, timeoutMs === 45000 ? 1 : timeoutMs, ...args);
  });
  const monitor = createResourceMonitor({ remoteHost: '127.0.0.2' });
  await monitor.refreshCloud();
  assert.equal(budgets.filter(value => value === 45000).length, 2);
  assert.ok(monitor.publicState().providerUsage.hosts.every(host => host.status === 'unavailable' && host.snapshot === null && /timed out/.test(host.error)));
});

const pythonHarness = String.raw`
import contextlib, io, json, os, pathlib, subprocess, sys, time, urllib.request
from types import SimpleNamespace
from unittest.mock import patch
payload = json.load(sys.stdin)
files = payload.get('files', {})
def read_text(path, *args, **kwargs):
    if str(path) not in files: raise OSError('fixture unavailable')
    return files[str(path)]
def disk_stat(path, *args, **kwargs):
    devices = {'/': 1, '/opt/chessalive': 1, '/var/lib/postgresql': 2}
    devices.update(payload.get('diskDevices', {}))
    if str(path) not in devices: raise OSError('fixture missing directory')
    return SimpleNamespace(st_dev=devices[str(path)])
def disk_vfs(path):
    return SimpleNamespace(f_blocks=100, f_frsize=1024, f_bavail=30, f_bfree=40)
def ps(*args, **kwargs):
    command = args[0]
    if command == ['lsblk', '-b', '-J', '-o', 'NAME,SIZE,TYPE,MOUNTPOINTS']:
        assert kwargs['timeout'] == 2
        if payload.get('lsblkFailure'): raise subprocess.TimeoutExpired('lsblk', 2)
        return SimpleNamespace(stdout=payload.get('lsblkRaw', json.dumps(payload.get('lsblk', {'blockdevices': []}))))
    if command == ['ps', '-eo', 'comm=,rss=']:
        assert kwargs['timeout'] == 2
        if payload.get('psFailure'): raise subprocess.TimeoutExpired('ps', 2)
        return SimpleNamespace(stdout=payload.get('ps', ''))
    assert command == ['systemctl', 'show', 'chessd', 'chessd@blue', 'chessd@green', 'chessgate', 'chessalive-build-trigger', '--property=Id,LoadState,ActiveState,MemoryCurrent,MemoryPeak,MemoryMax,CPUUsageNSec'], 'unexpected system inspection'
    if payload.get('servicesFailure'): raise subprocess.CalledProcessError(1, command)
    return SimpleNamespace(stdout=payload.get('services', ''))
def metadata(request, timeout):
    assert request.full_url == 'http://169.254.169.254/opc/v2/instance/'
    assert request.get_header('Authorization') == 'Bearer Oracle'
    assert timeout == 1
    if 'instance' not in payload: raise OSError('metadata unavailable')
    return io.StringIO(json.dumps(payload['instance']))
output = io.StringIO()
with patch.object(pathlib.Path, 'read_text', read_text), \
     patch.object(pathlib.Path, 'glob', lambda *_: [pathlib.Path('/sys/class/net/'+name) for name in payload.get('nics', [])]), \
     patch.object(os, 'stat', disk_stat), patch.object(os, 'statvfs', disk_vfs), \
     patch.object(os, 'cpu_count', lambda: 4), patch.object(os, 'getloadavg', lambda: (1, .5, .25)), \
     patch.object(time, 'time', lambda: 1234), patch.object(subprocess, 'run', ps), \
     patch.object(urllib.request, 'urlopen', metadata), contextlib.redirect_stdout(output):
    exec(compile(payload['source'], 'resource-snapshot.py', 'exec'), {'__name__': '__main__'})
print(output.getvalue().strip())
`;

async function pythonSnapshot(payload = {}) {
  const source = await readFile(new URL('./resource-snapshot.py', import.meta.url), 'utf8');
  const result = spawnSync('python3', ['-c', pythonHarness], { input: JSON.stringify({ ...payload, source }), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const netHeader = 'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast |bytes packets errs drop fifo colls carrier compressed\n';
const netRow = (name, received, sent) => `${name}: ${received} 1 2 0 0 0 0 0 ${sent} 1 3 0 0 0 0 0\n`;

test('Linux collector distinguishes CPU ticks, available memory, reserved disk space and default-route traffic', async () => {
  const data = await pythonSnapshot({ files: {
    '/proc/stat': 'cpu 100 20 30 400 50 6 7 8 9999 9999\ncpu0 1 2 3\n',
    '/proc/meminfo': 'MemTotal: 8000 kB\nMemFree: 1000 kB\nMemAvailable: 3000 kB\nSwapTotal: 2000 kB\nSwapFree: 500 kB\nMalformed: nope\n',
    '/proc/net/route': 'Iface Destination Gateway Flags\neth0 00000000 01020304 0003\neth1 01020304 00000000 0001\n',
    '/proc/net/dev': netHeader + netRow('eth0', 1000, 2000) + netRow('eth1', 100000, 200000) + netRow('lo', 900000, 900000),
    '/proc/uptime': '123.5 400.0\n', '/proc/sys/kernel/random/boot_id': 'fixture-boot\n',
  }, ps: 'postgres 10\npostgres 20\nmysqld 30\nmariadbd 40\nredis-server 50\nvalkey-server 60\nchessd 70\nnode 99999\n' });
  assert.equal(data.sampledAtMs, 1234000);
  assert.equal(data.cpu.totalTicks, 621, 'guest ticks are already included in user/nice and must not be double counted');
  assert.equal(data.cpu.idleTicks, 450, 'iowait is idle capacity');
  assert.equal(data.memory.usedBytes, 5000 * 1024, 'use MemAvailable, not merely MemFree');
  assert.equal(data.memory.swapFreeBytes, 500 * 1024);
  assert.equal(data.network.receivedBytes, 1000);
  assert.equal(data.network.sentBytes, 2000);
  assert.equal(data.network.interfaces[0].receiveErrors, 2);
  assert.equal(data.network.interfaces[0].sendErrors, 3);
  assert.deepEqual(data.disks.map(disk => disk.path), ['/', '/var/lib/postgresql'], 'same filesystem is counted once');
  assert.deepEqual(data.disks[0], { path: '/', totalBytes: 102400, availableBytes: 30720, usedBytes: 61440 });
  assert.deepEqual(data.processes.postgres, { count: 2, rssBytes: 30 * 1024 });
  assert.deepEqual(data.processes.mysql, { count: 2, rssBytes: 70 * 1024 });
  assert.deepEqual(data.processes.redis, { count: 2, rssBytes: 110 * 1024 });
  assert.deepEqual(data.processes.chessd, { count: 1, rssBytes: 70 * 1024 });
});

test('Linux collector falls back to IPv6 NICs without counting loopback or container bridges', async () => {
  const data = await pythonSnapshot({ nics: ['lo', 'docker0', 'veth123', 'br-abc', 'enp0s1'], files: {
    '/proc/net/dev': netHeader + netRow('lo', 9000, 9000) + netRow('docker0', 8000, 8000) + netRow('veth123', 7000, 7000) + netRow('br-abc', 6000, 6000) + netRow('enp0s1', 50, 70),
  } });
  assert.deepEqual(data.network.interfaces.map(nic => nic.name), ['enp0s1']);
  assert.equal(data.network.receivedBytes, 50);
  assert.equal(data.network.sentBytes, 70);
});

test('Linux disk layout counts physical partitions once and lists all writable local filesystems', async () => {
  const data = await pythonSnapshot({
    files: { '/proc/self/mountinfo': [
      '25 1 253:0 / / rw,relatime - xfs /dev/mapper/ocivolume-root rw,attr2',
      '26 25 253:0 /opt/chessalive /opt/chessalive rw - xfs /dev/mapper/ocivolume-root rw',
      '27 25 253:1 / /var/oled rw,relatime - xfs /dev/mapper/ocivolume-oled rw',
      '28 25 8:2 / /boot rw,relatime - xfs /dev/sda2 rw',
      '29 28 8:1 / /boot/efi rw,relatime - vfat /dev/sda1 rw',
      '30 25 8:9 / /readonly ro - ext4 /dev/sdz9 ro',
      '31 25 0:5 / /network rw - nfs server:/share rw',
      '32 25 0:6 / /tmp rw - tmpfs tmpfs rw',
      '33 25 8:10 / /read-only-super rw - ext4 /dev/sdz10 ro',
    ].join('\n') },
    diskDevices: { '/boot': 3, '/boot/efi': 4, '/var/oled': 5, '/readonly': 6, '/network': 7, '/tmp': 8, '/read-only-super': 9 },
    lsblk: { blockdevices: [
      { name: 'sda', size: 107374182400, type: 'disk', children: [
        { name: 'sda1', size: 104857600, type: 'part', mountpoints: ['/boot/efi'] },
        { name: 'sda2', size: 2147483648, type: 'part', mountpoints: ['/boot'] },
        { name: 'sda3', size: 47782559744, type: 'part', children: [
          { name: 'ocivolume-root', size: 31675383808, type: 'lvm', mountpoints: ['/'] },
          { name: 'ocivolume-oled', size: 16106127360, type: 'lvm', mountpoints: ['/var/oled'] },
        ] },
      ] },
      { name: 'loop0', size: 512000, type: 'loop' },
    ] },
  });
  assert.deepEqual(data.disks.map(disk => disk.path), ['/', '/boot', '/boot/efi', '/var/oled']);
  assert.deepEqual(data.diskLayout, [{ name: 'sda', totalBytes: 107374182400, partitionedBytes: 50034900992, unpartitionedBytes: 57339281408 }]);
});

test('Linux disks decode mount paths, deduplicate device aliases and preserve independent whole disks', async () => {
  const data = await pythonSnapshot({
    files: { '/proc/self/mountinfo': '25 1 8:1 / / rw - ext4 /dev/sda1 rw\n26 25 8:17 / /data\\040volume rw - ext4 /dev/sdb1 rw\n27 25 8:17 / /z-alias rw - ext4 /dev/sdb1 rw\n' },
    diskDevices: { '/data volume': 3, '/z-alias': 3 },
    lsblk: { blockdevices: [
      { name: 'sda', size: '1000', type: 'disk', children: [{ name: 'sda1', size: '900', type: 'part' }] },
      { name: 'sdb', size: 2000, type: 'disk', children: [{ name: 'sdb1', size: 1800, type: 'part' }, { name: 'sdb1', size: 1800, type: 'part' }] },
      { name: 'sdb', size: 2000, type: 'disk' },
    ] },
  });
  assert.deepEqual(data.disks.map(disk => disk.path), ['/', '/data volume']);
  assert.deepEqual(data.diskLayout, [
    { name: 'sda', totalBytes: 1000, partitionedBytes: 900, unpartitionedBytes: 100 },
    { name: 'sdb', totalBytes: 2000, partitionedBytes: 1800, unpartitionedBytes: 200 },
  ]);
});

test('unavailable disk layout is distinct from a measured empty layout and does not hide filesystems', async () => {
  for (const fixture of [{ lsblkFailure: true }, { lsblkRaw: 'not JSON' }, { lsblk: {} }]) {
    const data = await pythonSnapshot(fixture);
    assert.equal(data.diskLayout, null);
    assert.equal(data.disks[0].path, '/', 'filesystem collection survives a block-device inspection failure');
  }
  assert.deepEqual((await pythonSnapshot()).diskLayout, []);
  const invalid = await pythonSnapshot({ lsblk: { blockdevices: [{ name: 'sda', size: 1000, type: 'disk', children: [{ name: 'sda1', type: 'part' }] }] } });
  assert.deepEqual(invalid.diskLayout, [{ name: 'sda', totalBytes: 1000, partitionedBytes: null, unpartitionedBytes: null }]);
});

test('missing Linux counters and failed process sampling remain unknown, not fictional zero capacity', async () => {
  const data = await pythonSnapshot({ psFailure: true, servicesFailure: true });
  assert.equal(data.cpu.totalTicks, null);
  assert.equal(data.cpu.idleTicks, null);
  assert.equal(data.memory.totalBytes, null);
  assert.equal(data.memory.availableBytes, null);
  assert.equal(data.memory.usedBytes, null);
  assert.equal(data.network.receivedBytes, null);
  assert.equal(data.network.sentBytes, null);
  assert.equal(data.uptimeSeconds, null);
  assert.equal(data.processes, null);
  assert.equal(data.services, null);
  assert.equal(data.instance, null);
});


test('service cgroup usage and OCI capacity preserve unknown limits and expose only allowed metadata', async () => {
  const data = await pythonSnapshot({
    services: 'Id=chessd.service\nLoadState=loaded\nActiveState=active\nMemoryCurrent=2048\nMemoryPeak=4096\nMemoryMax=infinity\nCPUUsageNSec=7000000\n\nId=chessalive-build-trigger.service\nLoadState=loaded\nActiveState=active\nMemoryCurrent=[not set]\nMemoryPeak=18446744073709551615\nMemoryMax=8192\nCPUUsageNSec=[not set]\n\nId=absent.service\nLoadState=not-found\n',
    instance: { shape: 'VM.Standard.A1.Flex', canonicalRegionName: 'ap-hyderabad-1', id: 'private-instance-id', metadata: { customSecret: 'must-not-escape' }, shapeConfig: { ocpus: 2, memoryInGBs: 12, networkingBandwidthInGbps: 2, unsupported: 'private' } },
  });
  assert.deepEqual(data.services, [
    { name: 'chessd.service', status: 'active', memoryBytes: 2048, peakMemoryBytes: 4096, memoryLimitBytes: null, cpuUsageNanoseconds: 7000000 },
    { name: 'chessalive-build-trigger.service', status: 'active', memoryBytes: null, peakMemoryBytes: null, memoryLimitBytes: 8192, cpuUsageNanoseconds: null },
  ]);
  assert.deepEqual(data.instance, { shape: 'VM.Standard.A1.Flex', region: 'ap-hyderabad-1', ocpus: 2, memoryGB: 12, networkBandwidthGbps: 2 });
  assert.ok(!JSON.stringify(data).includes('private-instance-id'));
  assert.ok(!JSON.stringify(data).includes('must-not-escape'));
});
