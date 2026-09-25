import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMonitorIssueReport, MONITOR_INTERVAL_MS, nextMonitorIncidentState } from "./monitor-policy.mjs";

const root = new URL("../", import.meta.url);
const unit = readFileSync(new URL("production/chessd.service", root), "utf8");
const deploy = readFileSync(new URL("release/deploy-chessd.sh", root), "utf8");
const buildTrigger = readFileSync(new URL("release/build-trigger.mjs", root), "utf8");
const localRelease = readFileSync(new URL("release/local-release.sh", root), "utf8");

test("source sync fallback preserves the image cache while deleting stale files", (t) => {
  if (spawnSync("rsync", ["--version"]).error?.code === "ENOENT") {
    t.skip("rsync is unavailable on this test host");
    return;
  }

  const fallback = localRelease.match(/rsync -a --delete \\\n([\s\S]*?)"\$\{checkout\}\/repo\/" "\$\{SOURCE_DIR\}\/"/);
  assert.ok(fallback, "source sync fallback command must be present");
  const excludes = [...fallback[1].matchAll(/--exclude (?:'([^']+)'|([^\s\\]+))/g)]
    .flatMap(([, quoted, unquoted]) => ["--exclude", quoted || unquoted]);

  const scratch = mkdtempSync(join(tmpdir(), "chessalive-sync-cache-"));
  try {
    const source = join(scratch, "source");
    const destination = join(scratch, "destination");
    const cache = join(destination, ".cache/squoosh-webp-v1");
    mkdirSync(source);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "cached.webp"), "compressed-once");
    writeFileSync(join(destination, "stale-source.js"), "remove me");
    writeFileSync(join(destination, ".cache", "unrelated.tmp"), "remove me");

    const result = spawnSync("rsync", ["-a", "--delete", ...excludes, `${source}/`, `${destination}/`], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(cache, "cached.webp"), "utf8"), "compressed-once");
    assert.equal(existsSync(join(destination, "stale-source.js")), false);
    assert.equal(existsSync(join(destination, ".cache", "unrelated.tmp")), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("chessd starts Go collection before systemd memory pressure", () => {
  assert.ok(unit.includes("Environment=GOMEMLIMIT=5GiB"));
  assert.ok(unit.includes("MemoryHigh=6G"));
  assert.ok(unit.includes("MemoryMax=8G"));
  assert.ok(unit.indexOf("GOMEMLIMIT=5GiB") < unit.indexOf("MemoryHigh=6G"));
});

test("deploys and rolls back the service unit with the binary", () => {
  assert.ok(deploy.includes('UNIT_SRC="${CI_ROOT}/production/chessd.service"'));
  assert.ok(deploy.includes('copy_to_host "${UNIT_SRC}" "${STAGE}/chessd.service"'));
  assert.ok(deploy.includes('sudo cp -a "${UNIT_PATH}" "${UNIT_BACKUP}"'));
  assert.ok(deploy.includes('sudo install -o root -g root -m 0644 "${STAGE}/chessd.service" "${UNIT_PATH}"'));
  assert.ok(deploy.includes('sudo install -o root -g root -m 0644 "${UNIT_BACKUP}" "${UNIT_PATH}"'));
  assert.equal(deploy.match(/sudo systemctl daemon-reload/g)?.length, 2);
});

test("production monitoring runs hourly and sends one detailed email per incident", () => {
  assert.equal(MONITOR_INTERVAL_MS, 3_600_000);
  assert.deepEqual(nextMonitorIncidentState(false, "red"), { active: true, shouldNotify: true });
  assert.deepEqual(nextMonitorIncidentState(true, "orange"), { active: true, shouldNotify: false });
  assert.deepEqual(nextMonitorIncidentState(true, "green"), { active: false, shouldNotify: false });

  const issue = createMonitorIssueReport([
    { path: "/health", ok: false, status: 503, latencyMs: 412 },
    { path: "/coach", ok: false, status: 0, latencyMs: 8_001, error: "request timed out" },
  ]);
  assert.equal(issue.subject, "ChessAlive monitoring issue: /health, /coach");
  assert.match(issue.summary, /\/health: HTTP 503 after 412ms/);
  assert.match(issue.summary, /\/coach: request failed after 8001ms \(request timed out\)/);
  assert.ok(buildTrigger.includes("setInterval(() => void monitorProduction(), MONITOR_INTERVAL_MS)"));
  assert.ok(!buildTrigger.includes("ChessAlive monitoring: recovered"));
});
