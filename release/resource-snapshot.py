#!/usr/bin/env python3
"""Read-only Linux host snapshot. Never reads environment values or process arguments."""
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.request


def read(path):
    try:
        return pathlib.Path(path).read_text()
    except (OSError, UnicodeError):
        return ""


def memory():
    values = {}
    for line in read('/proc/meminfo').splitlines():
        key, _, value = line.partition(':')
        try:
            values[key] = int(value.split()[0]) * 1024
        except (ValueError, IndexError):
            pass
    total, available = values.get('MemTotal'), values.get('MemAvailable')
    return {'totalBytes': total, 'availableBytes': available,
            'usedBytes': total - available if total is not None and available is not None else None,
            'swapTotalBytes': values.get('SwapTotal'), 'swapFreeBytes': values.get('SwapFree')}


def network():
    names = set()
    for line in read('/proc/net/route').splitlines()[1:]:
        fields = line.split()
        if len(fields) > 3 and fields[1] == '00000000':
            names.add(fields[0])
    # Include IPv6-only hosts, using physical/virtual NICs rather than loopback/bridge duplicates.
    if not names:
        names = {p.name for p in pathlib.Path('/sys/class/net').glob('*')
                 if p.name != 'lo' and not p.name.startswith(('veth', 'docker', 'br-'))}
    rows = []
    for line in read('/proc/net/dev').splitlines()[2:]:
        name, _, rest = line.partition(':')
        if name.strip() not in names:
            continue
        fields = rest.split()
        if len(fields) >= 16:
            rows.append({'name': name.strip(), 'receivedBytes': int(fields[0]), 'sentBytes': int(fields[8]),
                         'receiveErrors': int(fields[2]), 'sendErrors': int(fields[10])})
    return {'interfaces': rows,
            'receivedBytes': sum(i['receivedBytes'] for i in rows) if rows else None,
            'sentBytes': sum(i['sentBytes'] for i in rows) if rows else None,
            'counterScope': 'default-route interfaces since interface reset'}


def disks():
    rows, devices = [], set()
    paths = ['/', '/opt/chessalive', '/var/lib/postgresql', '/var/lib/mysql']
    mounts = read('/proc/self/mountinfo')
    if mounts:
        paths = []
        for line in mounts.splitlines():
            fields = line.split(' - ', 1)
            if len(fields) != 2:
                continue
            mount, filesystem = fields[0].split(), fields[1].split()
            if len(mount) < 6 or len(filesystem) < 3:
                continue
            if not filesystem[1].startswith('/dev/') or 'rw' not in mount[5].split(',') or 'rw' not in filesystem[2].split(','):
                continue
            # mountinfo encodes spaces, tabs, newlines and backslashes as octal.
            paths.append(re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), mount[4]))
        paths.sort(key=lambda path: (path != '/', path))
    for path in paths:
        try:
            device = os.stat(path).st_dev
            if device in devices:
                continue
            fs = os.statvfs(path)
            devices.add(device)
            rows.append({'path': path, 'totalBytes': fs.f_blocks * fs.f_frsize,
                         'availableBytes': fs.f_bavail * fs.f_frsize,
                         'usedBytes': (fs.f_blocks - fs.f_bfree) * fs.f_frsize})
        except OSError:
            continue
    return rows


def disk_layout():
    """Partition allocation is separate from filesystem usage and free space."""
    try:
        result = subprocess.run(['lsblk', '-b', '-J', '-o', 'NAME,SIZE,TYPE,MOUNTPOINTS'],
                                capture_output=True, text=True, timeout=2, check=True)
        block_devices = json.loads(result.stdout).get('blockdevices')
        if not isinstance(block_devices, list):
            return None
    except (OSError, subprocess.SubprocessError, ValueError, AttributeError):
        return None
    def size(value):
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
        return None
    rows, seen = [], set()
    for disk in block_devices:
        if not isinstance(disk, dict) or disk.get('type') != 'disk' or not disk.get('name') or disk['name'] in seen:
            continue
        seen.add(disk['name'])
        total = size(disk.get('size'))
        # Only direct partitions count. Their nested LVM volumes describe the same
        # bytes again and must not make the physical disk appear over-allocated.
        partitions = {child.get('name'): size(child.get('size')) for child in (disk.get('children') or [])
                      if isinstance(child, dict) and child.get('type') == 'part'}
        partitioned = sum(partitions.values()) if all(value is not None for value in partitions.values()) else None
        rows.append({'name': disk['name'], 'totalBytes': total, 'partitionedBytes': partitioned,
                     'unpartitionedBytes': max(0, total - partitioned) if total is not None and partitioned is not None else None})
    return rows


def processes():
    groups = {'postgres': {'count': 0, 'rssBytes': 0}, 'mysql': {'count': 0, 'rssBytes': 0},
              'redis': {'count': 0, 'rssBytes': 0}, 'chessd': {'count': 0, 'rssBytes': 0}}
    try:
        result = subprocess.run(['ps', '-eo', 'comm=,rss='], capture_output=True, text=True, timeout=2, check=True)
        for line in result.stdout.splitlines():
            fields = line.split()
            if len(fields) != 2:
                continue
            command, kib = fields
            name = 'postgres' if command.startswith('postgres') else 'mysql' if command in ('mysqld', 'mariadbd') else 'redis' if command in ('redis-server', 'valkey-server') else 'chessd' if command == 'chessd' else None
            if name and kib.isdigit():
                groups[name]['count'] += 1
                groups[name]['rssBytes'] += int(kib) * 1024
    except (OSError, subprocess.SubprocessError):
        return None
    return {name: value for name, value in groups.items() if value['count']}


def services():
    """Cgroup memory is a service measurement; RSS sums can count shared pages twice."""
    try:
        result = subprocess.run(['systemctl', 'show', 'chessd', 'chessalive-build-trigger',
                                 '--property=Id,LoadState,ActiveState,MemoryCurrent,MemoryPeak,MemoryMax,CPUUsageNSec'],
                                capture_output=True, text=True, timeout=2, check=True)
    except (OSError, subprocess.SubprocessError):
        return None
    rows = []
    for block in result.stdout.strip().split('\n\n'):
        values = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
        if values.get('LoadState') != 'loaded':
            continue
        def measured(key):
            value = values.get(key, '')
            return int(value) if value.isdigit() and int(value) < 2**63 else None
        rows.append({'name': values.get('Id'), 'status': values.get('ActiveState'),
                     'memoryBytes': measured('MemoryCurrent'), 'peakMemoryBytes': measured('MemoryPeak'),
                     'memoryLimitBytes': measured('MemoryMax'), 'cpuUsageNanoseconds': measured('CPUUsageNSec')})
    return rows


def instance():
    """Expose selected capacity fields only, never metadata IDs or custom metadata."""
    try:
        request = urllib.request.Request('http://169.254.169.254/opc/v2/instance/',
                                         headers={'Authorization': 'Bearer Oracle'})
        with urllib.request.urlopen(request, timeout=1) as response:
            data = json.load(response)
        capacity = data.get('shapeConfig', {})
        return {'shape': data.get('shape'), 'region': data.get('canonicalRegionName') or data.get('region'),
                'ocpus': capacity.get('ocpus'), 'memoryGB': capacity.get('memoryInGBs'),
                'networkBandwidthGbps': capacity.get('networkingBandwidthInGbps')}
    except (OSError, ValueError):
        return None


cpu = read('/proc/stat').splitlines()
values = [int(value) for value in cpu[0].split()[1:9]] if cpu and cpu[0].startswith('cpu ') else []
try:
    load = list(os.getloadavg())
except OSError:
    load = None
uptime = read('/proc/uptime').split()
print(json.dumps({'sampledAtMs': int(time.time() * 1000), 'hostname': os.uname().nodename,
                  'bootId': read('/proc/sys/kernel/random/boot_id').strip(),
                  'uptimeSeconds': float(uptime[0]) if uptime else None,
                  'cpu': {'logicalCores': os.cpu_count(), 'totalTicks': sum(values) if values else None,
                          'idleTicks': values[3] + values[4] if len(values) > 4 else None, 'loadAverage': load},
                  'memory': memory(), 'disks': disks(), 'diskLayout': disk_layout(), 'network': network(), 'processes': processes(),
                  'services': services(), 'instance': instance()}))
