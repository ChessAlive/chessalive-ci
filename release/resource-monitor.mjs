import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const collectorPath = fileURLToPath(new URL('./resource-snapshot.py', import.meta.url));
const collector = readFileSync(collectorPath, 'utf8');
const cloudCollectorPath = fileURLToPath(new URL('./cloud-resource-snapshot.py', import.meta.url));
const cloudCollector = readFileSync(cloudCollectorPath, 'utf8');
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function deriveResourceRates(snapshot, previous) {
  const elapsed = previous ? (snapshot.sampledAtMs - previous.sampledAtMs) / 1000 : 0;
  const sameBoot = previous && snapshot.bootId && snapshot.bootId === previous.bootId;
  const delta = (current, old) => sameBoot && elapsed > 0 && finite(current) && finite(old) && current >= old ? current - old : null;
  const total = delta(snapshot.cpu?.totalTicks, previous?.cpu?.totalTicks);
  const idle = delta(snapshot.cpu?.idleTicks, previous?.cpu?.idleTicks);
  snapshot.cpu.usagePercent = total > 0 && idle !== null ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : null;
  const interfaces = value => (value?.network?.interfaces || []).map(item => item.name).sort().join(',');
  const sameInterfaces = interfaces(snapshot) && interfaces(snapshot) === interfaces(previous);
  const received = sameInterfaces ? delta(snapshot.network.receivedBytes, previous?.network?.receivedBytes) : null;
  const sent = sameInterfaces ? delta(snapshot.network.sentBytes, previous?.network?.sentBytes) : null;
  snapshot.network.ingressBytesPerSecond = received === null ? null : received / elapsed;
  snapshot.network.egressBytesPerSecond = sent === null ? null : sent / elapsed;
  return snapshot;
}

function runCollector(command, args, input, { timeoutMs = 8000, cloud = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', expired = false;
    const timeout = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1_000_000) { expired = true; child.kill('SIGKILL'); } });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Host metrics collector could not start')); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || expired) return reject(new Error(expired ? 'Host metrics request timed out' : `Host metrics unavailable (connection or collector exit ${code})`));
      try {
        const data = JSON.parse(output);
        if (!finite(data.sampledAtMs)) throw new Error();
        if (cloud ? data.schemaVersion !== 1 || data.provider !== 'oci' : !data.cpu || !data.memory || !data.network || !Array.isArray(data.disks)) throw new Error();
        resolve(data);
      } catch { reject(new Error('Host returned an invalid metrics snapshot')); }
    });
  });
}

export function createResourceMonitor({ enabled = true, remoteHost, remoteUser = 'ubuntu', remoteKey, intervalMs = 10000, cloudEnabled = true, cloudIntervalMs = 300000 } = {}) {
  const sampleIntervalMs = Math.max(5000, Math.min(60000, Number(intervalMs) || 10000));
  const hosts = [
    { id: 'hyderabad', label: 'Hyderabad', role: 'Build host', status: 'loading', checkedAt: null, error: null, snapshot: null },
    { id: 'mumbai', label: 'Mumbai', role: 'Production host', status: 'loading', checkedAt: null, error: null, snapshot: null },
  ];
  const providerIntervalMs = Math.max(60000, Math.min(3600000, Number(cloudIntervalMs) || 300000));
  const providerHosts = hosts.map(({ id, label }) => ({ id, label, status: 'loading', checkedAt: null, error: null, snapshot: null }));
  function remoteArgs(command) {
    if (!remoteHost) throw new Error('Production host is not configured');
    if (!/^[a-zA-Z0-9.:-]+$/.test(remoteHost) || !/^[a-zA-Z0-9_-]+$/.test(remoteUser)) throw new Error('Invalid production monitoring host configuration');
    const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes'];
    if (remoteKey) args.push('-i', remoteKey, '-o', 'IdentitiesOnly=yes');
    return [...args, `${remoteUser}@${remoteHost}`, command];
  }
  let refreshing = false, timer = null;
  let cloudRefreshing = false, cloudTimer = null;
  async function refreshCloud() {
    if (!enabled || !cloudEnabled || cloudRefreshing) return;
    cloudRefreshing = true;
    try {
      await Promise.all(providerHosts.map(async host => {
        try {
          const options = { timeoutMs: 45000, cloud: true };
          host.snapshot = host.id === 'hyderabad'
            ? await runCollector('python3', [cloudCollectorPath], undefined, options)
            : await runCollector('ssh', remoteArgs('/opt/oci-cli-venv/bin/python3 -'), cloudCollector, options);
          host.checkedAt = new Date().toISOString(); host.status = 'available'; host.error = null;
        } catch (error) { host.status = 'unavailable'; host.error = error.message; }
      }));
    } finally { cloudRefreshing = false; }
  }
  async function refresh() {
    if (!enabled || refreshing) return;
    refreshing = true;
    try {
      await Promise.all(hosts.map(async host => {
        try {
          let snapshot;
          if (host.id === 'hyderabad') snapshot = await runCollector('python3', [collectorPath]);
          else {
            // Arguments are passed directly, never through a local shell. Host/user values are
            // configuration, and the only remote command is the fixed read-only Python collector.
            snapshot = await runCollector('ssh', remoteArgs('python3 -'), collector);
          }
          host.snapshot = deriveResourceRates(snapshot, host.snapshot);
          host.checkedAt = new Date().toISOString(); host.status = 'available'; host.error = null;
        } catch (error) { host.status = 'unavailable'; host.error = error.message; }
      }));
    } finally { refreshing = false; }
  }
  return {
    start() {
      if (enabled && !timer) { void refresh(); timer = setInterval(() => void refresh(), sampleIntervalMs); timer.unref(); }
      if (enabled && cloudEnabled && !cloudTimer) { void refreshCloud(); cloudTimer = setInterval(() => void refreshCloud(), providerIntervalMs); cloudTimer.unref(); }
    },
    stop() { clearInterval(timer); timer = null; clearInterval(cloudTimer); cloudTimer = null; },
    refresh, refreshCloud,
    publicState() { return { sampleIntervalMs, hosts, providerUsage: { sampleIntervalMs: providerIntervalMs, hosts: providerHosts } }; },
  };
}
