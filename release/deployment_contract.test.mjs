import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMonitorIssueReport, MONITOR_INTERVAL_MS, nextMonitorIncidentState } from "./monitor-policy.mjs";

const root = new URL("../", import.meta.url);
const unit = readFileSync(new URL("production/chessd.service", root), "utf8");
const transaction = readFileSync(new URL("release/runtime_transaction.py", root), "utf8");
const gatewayUnit = readFileSync(new URL("production/chessgate.service", root), "utf8");
const slotUnit = readFileSync(new URL("production/chessd@.service", root), "utf8");
const deploy = readFileSync(new URL("release/deploy-chessd.sh", root), "utf8");
const buildTrigger = readFileSync(new URL("release/build-trigger.mjs", root), "utf8");
const localRelease = readFileSync(new URL("release/local-release.sh", root), "utf8");
const runtimeTransaction = readFileSync(new URL("release/runtime-transaction.sh", root), "utf8");

test("persistent source sync updates the checkout without leaking temporary directories", (t) => {
  if (spawnSync("rsync", ["--version"]).error?.code === "ENOENT") {
    t.skip("rsync is unavailable on this test host");
    return;
  }
  const sync = localRelease.match(/sync_source_checkout\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(sync, "source synchronization function must be present");
  const scratch = mkdtempSync(join(tmpdir(), "chessalive-persistent-sync-"));
  const remote = join(scratch, "remote");
  const source = join(scratch, "source");
  const git = (...args) => {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "--initial-branch=main", remote);
    git("-C", remote, "config", "user.name", "Release Test");
    git("-C", remote, "config", "user.email", "release-test@example.invalid");
    writeFileSync(join(remote, "version.txt"), "previous");
    git("-C", remote, "add", "version.txt");
    git("-C", remote, "-c", "commit.gpgsign=false", "commit", "-m", "Previous version");
    git("clone", remote, source);
    writeFileSync(join(remote, "version.txt"), "latest");
    git("-C", remote, "-c", "commit.gpgsign=false", "commit", "-am", "Latest version");
    const expected = git("-C", remote, "rev-parse", "HEAD");
    const result = spawnSync("bash", ["-c", `set -euo pipefail\nsay() { :; }\ndie() { exit 1; }\n${sync[0]}\nsync_source_checkout`], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: scratch, SOURCE_DIR: source, SOURCE_GIT_URL: remote, SOURCE_GIT_REF: "main", SOURCE_SSH_KEY: "",
        SOURCE_COMMIT_FILE: join(source, ".source-commit"), SOURCE_COMMIT_MESSAGE_FILE: join(source, ".source-message"),
        SOURCE_COMMIT_DATE_FILE: join(source, ".source-date") },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(source, "version.txt"), "utf8"), "latest");
    assert.equal(readFileSync(join(source, ".source-commit"), "utf8").trim(), expected);
    assert.deepEqual(readdirSync(scratch).filter(name => name.startsWith("chessalive-source.")), []);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("single-branch source sync builds the fetched non-main branch despite missing or stale tracking refs", (t) => {
  if (spawnSync("rsync", ["--version"]).error?.code === "ENOENT") {
    t.skip("rsync is unavailable on this test host");
    return;
  }
  const sync = localRelease.match(/sync_source_checkout\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(sync);
  const scratch = mkdtempSync(join(tmpdir(), "chessalive-selected-source-"));
  const remote = join(scratch, "remote");
  const source = join(scratch, "source");
  const branch = "codex/verified-release";
  const git = (...args) => {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const synchronize = () => {
    const result = spawnSync("bash", ["-c", `set -euo pipefail\nsay() { :; }\ndie() { exit 1; }\n${sync[0]}\nsync_source_checkout`], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: scratch, SOURCE_DIR: source, SOURCE_GIT_URL: remote, SOURCE_GIT_REF: branch, SOURCE_SSH_KEY: "",
        SOURCE_COMMIT_FILE: join(source, ".source-commit"), SOURCE_COMMIT_MESSAGE_FILE: join(source, ".source-message"),
        SOURCE_COMMIT_DATE_FILE: join(source, ".source-date") },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git("-C", source, "rev-parse", "HEAD"), git("-C", remote, "rev-parse", "HEAD"));
    assert.equal(readFileSync(join(source, ".source-commit"), "utf8").trim(), git("-C", remote, "rev-parse", "HEAD"));
    assert.equal(readFileSync(join(source, ".source-message"), "utf8").trim(), git("-C", remote, "log", "-1", "--format=%s"));
    assert.equal(readFileSync(join(source, ".source-date"), "utf8").trim(), git("-C", remote, "log", "-1", "--format=%aI"));
  };
  try {
    git("init", "--initial-branch=main", remote);
    git("-C", remote, "config", "user.name", "Release Test");
    git("-C", remote, "config", "user.email", "release-test@example.invalid");
    writeFileSync(join(remote, "version.txt"), "main");
    git("-C", remote, "add", "version.txt");
    git("-C", remote, "-c", "commit.gpgsign=false", "commit", "-m", "Main version");
    const main = git("-C", remote, "rev-parse", "HEAD");
    git("clone", "--single-branch", "--branch", "main", remote, source);
    assert.equal(git("-C", source, "config", "--get-all", "remote.origin.fetch"), "+refs/heads/main:refs/remotes/origin/main");
    git("-C", remote, "checkout", "-b", branch);
    writeFileSync(join(remote, "version.txt"), "selected first");
    git("-C", remote, "-c", "commit.gpgsign=false", "commit", "-am", "Selected first version");
    const first = git("-C", remote, "rev-parse", "HEAD");
    synchronize(); // origin/codex/verified-release does not exist.
    assert.equal(readFileSync(join(source, "version.txt"), "utf8"), "selected first");
    git("-C", source, "update-ref", `refs/remotes/origin/${branch}`, first);
    writeFileSync(join(remote, "version.txt"), "selected latest");
    git("-C", remote, "-c", "commit.gpgsign=false", "commit", "-am", "Selected latest version");
    synchronize(); // The main-only fetch mapping leaves the manually created ref stale.
    assert.equal(readFileSync(join(source, "version.txt"), "utf8"), "selected latest");
    assert.equal(git("-C", source, "rev-parse", `origin/${branch}`), first);
    assert.equal(git("-C", source, "rev-parse", "origin/main"), main);
    assert.deepEqual(readdirSync(scratch).filter(name => name.startsWith("chessalive-source.")), []);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("source sync fallback preserves image and compression caches while deleting stale files", (t) => {
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
    const compressionCache = join(destination, ".cache/web-compression-v1");
    mkdirSync(source);
    mkdirSync(cache, { recursive: true });
    mkdirSync(compressionCache, { recursive: true });
    writeFileSync(join(cache, "cached.webp"), "compressed-once");
    writeFileSync(join(compressionCache, "cached.br"), "compressed-once");
    writeFileSync(join(destination, "stale-source.js"), "remove me");
    writeFileSync(join(destination, ".cache", "unrelated.tmp"), "remove me");

    const result = spawnSync("rsync", ["-a", "--delete", ...excludes, `${source}/`, `${destination}/`], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(cache, "cached.webp"), "utf8"), "compressed-once");
    assert.equal(readFileSync(join(compressionCache, "cached.br"), "utf8"), "compressed-once");
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

test("application releases use isolated units while the connection gateway stays running", () => {
  assert.ok(deploy.includes('UNIT_SRC="${CI_ROOT}/production/chessd@.service"'));
  assert.ok(deploy.includes('copy_to_host "${UNIT_SRC}" "${STAGE}/chessd.service"'));
  assert.ok(deploy.includes('"${CI_ROOT}/release/runtime-transaction.sh"'));
  assert.ok(slotUnit.includes('WorkingDirectory=/opt/chessalive/slots/%i'));
  assert.ok(slotUnit.includes('EnvironmentFile=/etc/chessalive/slot-%i.env'));
  assert.ok(slotUnit.includes('ReadWritePaths=/opt/chessalive/data /run/chessalive'));
  assert.ok(gatewayUnit.includes('ExecStart=/opt/chessalive/bin/chessgate'));
  assert.ok(!transaction.includes('"restart", "chessgate"'));
});

test("the optional Coach V5 engine keeps the existing overridable runtime configuration", () => {
  assert.ok(slotUnit.includes("Environment=CHESSALIVE_COACH5_ENGINE=/usr/games/stockfish"));
  assert.ok(slotUnit.indexOf("CHESSALIVE_COACH5_ENGINE") < slotUnit.indexOf("EnvironmentFile=/etc/chessalive.env"));
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

// Coach V5 needs its engine on the production host. It is installed by every deploy (before the
// candidate slot starts), so a new host or a rewritten deploy can never silently lose it.
test("every deploy installs Coach V5's engine before the candidate starts, and the slots use it", () => {
  const install = runtimeTransaction.indexOf("apt-get install -y -q stockfish");
  assert.ok(install > 0, "runtime-transaction.sh installs the stockfish package");
  assert.ok(install > runtimeTransaction.indexOf('if [[ "${MODE}" == deploy ]]; then'), "in a deploy");
  assert.ok(install < runtimeTransaction.indexOf("exec systemd-run"), "before the transaction starts the candidate");
  assert.ok(runtimeTransaction.includes("if [[ ! -x /usr/games/stockfish ]]"), "only when missing");
  assert.ok(runtimeTransaction.includes("Coach V5 stays off"), "never fatal");
  assert.ok(deploy.includes("sudo -n env MODE=deploy"), "the transaction runs as root");
  assert.ok(slotUnit.includes("Environment=CHESSALIVE_COACH5_ENGINE=/usr/games/stockfish"));
});

// chessd runs the Coach V4 (beta) brain itself; the host only needs Node. The block runs against a
// scratch root with a fake download of a fixture build whose sha256 replaces the pinned one.
test("every deploy installs the pinned Node for the V4 brain, idempotently and never fatally", () => {
  const block = runtimeTransaction.match(/\n {2}NODE_VERSION=(v22\.\d+\.\d+)\n[\s\S]*?stays quiet until it is" >&2\n {2}fi\n/);
  assert.ok(block, "runtime-transaction.sh installs Node");
  assert.ok(block.index > runtimeTransaction.indexOf('if [[ "${MODE}" == deploy ]]; then'), "in a deploy");
  assert.ok(block.index < runtimeTransaction.indexOf("exec systemd-run"), "before the transaction starts the candidate");
  assert.match(block[0], /\n {6}aarch64\) arch=arm64 sum=[0-9a-f]{64} ;;\n/);
  assert.match(block[0], /\n {6}x86_64\) arch=x64 sum=[0-9a-f]{64} ;;\n/);
  assert.ok(block[0].includes('"https://nodejs.org/dist/${NODE_VERSION}/${name}.tar.gz"'));

  const version = block[1];
  const name = `node-${version}-linux-x64`;
  const scratch = mkdtempSync(join(tmpdir(), "chessalive-node-install-"));
  try {
    const root = join(scratch, "opt"); // Stands in for /opt/chessalive.
    const bin = join(scratch, "bin");
    const build = join(scratch, "build");
    const log = join(scratch, "downloads.log");
    mkdirSync(root);
    mkdirSync(bin);
    mkdirSync(join(build, name, "bin"), { recursive: true });
    writeFileSync(join(build, name, "bin", "node"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
    const fixture = join(scratch, `${name}.tar.gz`);
    const packed = spawnSync("tar", ["-czf", fixture, "-C", build, name], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const corrupt = join(scratch, "corrupt.tar.gz");
    writeFileSync(corrupt, "not the pinned build");
    writeFileSync(join(bin, "uname"), "#!/bin/sh\necho x86_64\n", { mode: 0o755 });
    // The fake download drains stdin first: the rest of the deploy script reaches the host on
    // stdin (bash -s), so the block must never hand that stream to a child.
    writeFileSync(join(bin, "curl"), [
      "#!/bin/sh", "cat >/dev/null", 'echo "$*" >> "$DOWNLOAD_LOG"', 'out=""',
      'while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done',
      '[ -n "$DOWNLOAD_FIXTURE" ] || exit 22', 'cp "$DOWNLOAD_FIXTURE" "$out"', "",
    ].join("\n"), { mode: 0o755 });
    const sum = createHash("sha256").update(readFileSync(fixture)).digest("hex");
    const script = block[0].replaceAll("/opt/chessalive", root).replace(/(x86_64\) arch=x64 sum=)[0-9a-f]{64}/, `$1${sum}`);
    const deployWith = (download) => spawnSync("bash", ["-s"], {
      encoding: "utf8",
      input: `set -euo pipefail\n${script}echo deploy continues\n`,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOWNLOAD_LOG: log, DOWNLOAD_FIXTURE: download },
    });
    const downloads = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
    const link = join(root, "node");
    const quietSuccess = (result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "deploy continues\n");
      assert.equal(result.stderr, "", "quiet on success");
      assert.equal(readlinkSync(link), join(root, name));
      assert.equal(spawnSync(join(link, "bin", "node"), ["--version"], { encoding: "utf8" }).stdout, `${version}\n`);
      assert.deepEqual(readdirSync(root).filter(entry => entry.startsWith(".node-install.")), []);
    };

    quietSuccess(deployWith(fixture));
    assert.deepEqual(downloads().map(line => line.split(" ").at(-1)), [`https://nodejs.org/dist/${version}/${name}.tar.gz`]);

    // Already that version: nothing is downloaded, even when a download would fail.
    quietSuccess(deployWith(""));
    assert.equal(downloads().length, 1);

    // An older Node behind the link is replaced; the older version stays on disk.
    const older = join(root, "node-v22.0.0-linux-x64");
    mkdirSync(join(older, "bin"), { recursive: true });
    writeFileSync(join(older, "bin", "node"), "#!/bin/sh\necho v22.0.0\n", { mode: 0o755 });
    rmSync(link);
    symlinkSync(older, link);
    quietSuccess(deployWith(fixture));
    assert.equal(downloads().length, 2);
    assert.ok(existsSync(join(older, "bin", "node")));

    // A failed download or a checksum mismatch prints one warning, installs nothing, and the
    // deploy continues under set -euo pipefail.
    for (const [download, problem] of [["", "download failed"], [corrupt, "checksum mismatch"]]) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root);
      const result = deployWith(download);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "deploy continues\n", "never fatal");
      assert.equal(result.stderr, `! Node ${version} could not be installed (${problem}); V4 (beta) stays quiet until it is\n`);
      assert.deepEqual(readdirSync(root), [], "nothing half-installed");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
