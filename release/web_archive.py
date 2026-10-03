"""Stream changed web files; the installer verifies and links unchanged release bytes."""
import argparse
import gzip
import io
import json
from pathlib import Path
import re
import sys
import tarfile
import time

from release_store import digest, inventory

DELTA_INDEX = ".chessalive-web-delta.json"


def write_archive(root, baseline, output):
    root = Path(root)
    started = time.monotonic()
    files = inventory(root)
    # inventory() reserves manifest.json for release metadata. A web export can have
    # its own manifest.json and must ship it just like every other public file.
    if (root / "manifest.json").is_file():
        files["manifest.json"] = digest(root / "manifest.json")
    if DELTA_INDEX in files:
        raise ValueError("Web export contains a reserved transfer filename")
    base_id = baseline.get("releaseId", "")
    base = baseline.get("manifest", {})
    reusable = (re.fullmatch(r"release-[a-z0-9-]+", base_id) and
                base.get("schemaVersion") == 1 and base.get("complete") is True and
                isinstance(base.get("files"), dict))
    reused = {name: checksum for name, checksum in files.items()
              if reusable and base["files"].get("web/" + name) == checksum}
    changed = sorted(set(files) - reused.keys())
    # Python 3.9 on the build host cannot pass compresslevel to tar's stream
    # mode. Wrap the stream explicitly, keeping the same fast gzip settings.
    with gzip.GzipFile(fileobj=output, mode="wb", compresslevel=1, mtime=0) as compressed, \
            tarfile.open(fileobj=compressed, mode="w|") as archive:
        if reused:
            data = json.dumps({"schemaVersion": 1, "baseRelease": base_id,
                               "files": files, "reused": reused}, separators=(",", ":")).encode()
            item = tarfile.TarInfo(DELTA_INDEX)
            item.size, item.mode = len(data), 0o644
            archive.addfile(item, io.BytesIO(data))
        for name in changed:
            archive.add(root / name, arcname=name, recursive=False)
    print(f"[web-transfer] {len(changed)} changed files, {len(reused)} reused; "
          f"{sum((root / name).stat().st_size for name in changed) / 1048576:.1f} MiB payload; "
          f"prepared in {time.monotonic() - started:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("baseline", "pack"))
    parser.add_argument("root", type=Path)
    parser.add_argument("baseline", type=Path, nargs="?")
    args = parser.parse_args()
    if args.operation == "baseline":
        release = (args.root / "web").resolve().parent
        value = {}
        if release.parent == (args.root / "releases").resolve() and re.fullmatch(r"release-[a-z0-9-]+", release.name):
            try:
                value = {"releaseId": release.name, "manifest": json.loads((release / "manifest.json").read_text())}
            except (OSError, ValueError):
                pass
        print(json.dumps(value, separators=(",", ":")))
    else:
        if not args.baseline:
            parser.error("pack requires a baseline JSON file")
        write_archive(args.root, json.loads(args.baseline.read_text()), sys.stdout.buffer)
