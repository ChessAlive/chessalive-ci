import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('first adoption preserves an uncertain committed writer and requires fresh idle observations', () => {
  const result = spawnSync('python3', ['-m', 'unittest', '-v', 'bootstrap_test.py'], {
    cwd: new URL('.', import.meta.url), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
