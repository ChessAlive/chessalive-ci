#!/usr/bin/env python3
"""Download Jenkins plugins plus their transitive dependencies into a plugins directory.

    resolve-plugins.py --jenkins-version 2.568.3 --plugins-dir /var/lib/jenkins/plugins git timestamper ...

Why this exists: Jenkins does not resolve dependencies for plugin archives dropped into
JENKINS_HOME/plugins. A plugin whose dependency is missing fails to load — quietly, in the log —
and every job that uses it disappears. jenkins-plugin-cli solves that but is a separate jar to
fetch and trust; the update center already publishes the whole graph as JSON, and python3 is on
every Debian box, so the walk is done here in ~80 lines.

Uses the update center that matches the installed core (dynamic-stable-<version>) so no plugin
newer than the core allows is chosen. Each archive's sha256 is checked against the update center
before it is written. Already-present plugins (.jpi or .hpi) are left alone, so re-running is
free and never downgrades a plugin Jenkins has since updated.

Only stdlib. Exit status is non-zero, with the plugin named, on any failure.
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import tempfile
import urllib.request

UC_BASE = "https://updates.jenkins.io"


def fetch(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": "chessalive-ci/resolve-plugins"})
    with urllib.request.urlopen(req, timeout=120) as resp:  # follows redirects (307 → mirror)
        data = resp.read()
    return data if binary else data.decode("utf-8")


def load_update_center(version):
    # dynamic-stable-<exact> lags a fresh LTS point release by a few days (2.568.3 was 404 the
    # week it shipped); "stable" is the LTS line and is always there. "current" is the weekly
    # line and is a last resort — its plugins may require a newer core, which the requiredCore
    # check below turns into a named failure instead of a plugin that silently does not load.
    candidates = [
        f"{UC_BASE}/dynamic-stable-{version}/update-center.actual.json",
        f"{UC_BASE}/stable/update-center.actual.json",
        f"{UC_BASE}/current/update-center.actual.json",
    ]
    last = None
    for url in candidates:
        try:
            doc = json.loads(fetch(url))
            print(f"  update center: {url} (core {doc.get('core', {}).get('version', '?')})")
            return doc
        except Exception as exc:  # noqa: BLE001 — report and try the next tier
            last = exc
            print(f"  ! {url}: {exc}")
    sys.exit(f"could not load any update center: {last}")


def closure(plugins, wanted):
    ordered, seen = [], set()

    def visit(pid, via):
        if pid in seen:
            return
        meta = plugins.get(pid)
        if meta is None:
            sys.exit(f"plugin '{pid}' (needed by {via}) is not in the update center")
        seen.add(pid)
        for dep in meta.get("dependencies", []):
            if dep.get("optional"):
                continue
            visit(dep["name"], pid)
        ordered.append(pid)

    for pid in wanted:
        visit(pid, "plugins.txt")
    return ordered


def version_tuple(v):
    parts = []
    for piece in str(v).split("."):
        digits = "".join(ch for ch in piece if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def check_core(plugins, order, jenkins_version):
    have = version_tuple(jenkins_version)
    for pid in order:
        need = plugins[pid].get("requiredCore")
        if need and version_tuple(need) > have:
            sys.exit(f"{pid} {plugins[pid].get('version')} requires Jenkins core {need} but {jenkins_version} is installed — "
                     "the update center tier in use is newer than this LTS; upgrade Jenkins or pin the plugin")


def present(plugins_dir, pid):
    return any(os.path.exists(os.path.join(plugins_dir, f"{pid}{ext}")) for ext in (".jpi", ".hpi"))


def install(plugins_dir, pid, meta):
    url, want = meta["url"], meta.get("sha256")
    data = fetch(url, binary=True)
    if want:
        got = base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")
        if got != want:
            sys.exit(f"sha256 mismatch for {pid} from {url}: update center {want}, archive {got}")
    fd, tmp = tempfile.mkstemp(dir=plugins_dir, prefix=f".{pid}.", suffix=".part")
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    os.chmod(tmp, 0o644)
    os.replace(tmp, os.path.join(plugins_dir, f"{pid}.jpi"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jenkins-version", required=True)
    ap.add_argument("--plugins-dir", required=True)
    ap.add_argument("plugins", nargs="+")
    args = ap.parse_args()

    os.makedirs(args.plugins_dir, exist_ok=True)
    uc = load_update_center(args.jenkins_version)
    plugins = uc["plugins"]
    order = closure(plugins, args.plugins)
    check_core(plugins, order, args.jenkins_version)
    print(f"  {len(args.plugins)} requested → {len(order)} with dependencies")

    fetched = 0
    for pid in order:
        if present(args.plugins_dir, pid):
            continue
        meta = plugins[pid]
        print(f"  ↓ {pid} {meta.get('version', '?')}")
        install(args.plugins_dir, pid, meta)
        fetched += 1
    print(f"  ✓ {fetched} downloaded, {len(order) - fetched} already present")


if __name__ == "__main__":
    main()
