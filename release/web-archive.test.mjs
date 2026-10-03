import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("web transfer verifies changed and reused bytes and reconstructs exact releases", () => {
  const result = spawnSync("python3", ["-m", "unittest", "-v", "web_archive_test.py"], {
    cwd: new URL(".", import.meta.url), encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
