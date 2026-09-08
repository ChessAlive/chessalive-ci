import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import { createMonitorIssueReport, MONITOR_INTERVAL_MS, nextMonitorIncidentState } from "./monitor-policy.mjs";

const root = new URL("../", import.meta.url);
const unit = readFileSync(new URL("production/chessd.service", root), "utf8");
const deploy = readFileSync(new URL("release/deploy-chessd.sh", root), "utf8");
const buildTrigger = readFileSync(new URL("release/build-trigger.mjs", root), "utf8");

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
