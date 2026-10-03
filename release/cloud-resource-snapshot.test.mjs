import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('OCI provider adapter preserves scope, reporting windows, access failures and bounded reads', () => {
  execFileSync('python3', ['-B', fileURLToPath(new URL('./cloud_resource_snapshot_test.py', import.meta.url))], {
    encoding: 'utf8', timeout: 10000,
  });
});
