import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('handoff preserves the latest state across failures and immutable releases remain verifiable', () => {
  const result = spawnSync('python3', ['-m', 'unittest', '-v', 'handoff_test.py', 'release_store_test.py'], {
    cwd: new URL('.', import.meta.url), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
