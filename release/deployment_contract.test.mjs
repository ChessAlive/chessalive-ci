import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);
const unit = readFileSync(new URL("production/chessd.service", root), "utf8");
const deploy = readFileSync(new URL("release/deploy-chessd.sh", root), "utf8");

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
