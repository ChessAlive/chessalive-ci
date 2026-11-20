import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

test('pre-prod staging preserves production and one-button promote keeps rollback', () => {
  const result = spawnSync('python3', ['-B', 'release/preprod_promote_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
