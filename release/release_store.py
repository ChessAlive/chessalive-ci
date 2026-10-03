"""Immutable releases and deduplicated browser assets; no runtime or cloud mutations."""
import hashlib
import json
import os
import posixpath
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
from urllib.parse import parse_qs, unquote, urlsplit


def atomic_json(path, value, mode=0o600):
    atomic_bytes(path, (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode(), mode)


def atomic_bytes(path, value, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), mode)
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_json(path):
    try:
        value = json.loads(Path(path).read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def inventory(root):
    root = Path(root)
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Release files must not contain symbolic links")
        if path.is_file() and path != root / "manifest.json":
            files[path.relative_to(root).as_posix()] = digest(path)
    return files


def public_info(value):
    result = {key: value.get(key) if isinstance(value.get(key), str) else None
              for key in ("commitHash", "commitMessage", "commitDate", "version")}
    if not re.fullmatch(r"[a-fA-F0-9]{40,64}", result["commitHash"] or ""):
        result["commitHash"] = None
    return result


def manifest(root, metadata):
    root = Path(root)
    value = dict(public_info(metadata), schemaVersion=1, complete=True, files=inventory(root))
    value["version"] = str(read_json(root / "web/version.json").get("version") or "")
    required = ("chessd", "chessd-migrate", "chessd.service", "web/index.html", "packages/data/puzzles.json")
    if not all(name in value["files"] for name in required):
        raise ValueError("Release is incomplete")
    atomic_json(root / "manifest.json", value, 0o644)
    return value


def verify(root):
    root = Path(root)
    value = read_json(root / "manifest.json")
    if value.get("schemaVersion") != 1 or value.get("complete") is not True:
        raise ValueError("Release has no complete manifest")
    if inventory(root) != value.get("files"):
        raise ValueError("Release checksum verification failed")
    return value


def extract(archive, destination):
    """Accept ordinary build files/directories only; never links or traversal."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as source:
        for item in source:
            target = destination / item.name
            if not target.resolve().is_relative_to(destination.resolve()):
                raise ValueError("Unsafe archive path")
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif item.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(item) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                target.chmod(0o644)
            else:
                raise ValueError("Build archives cannot contain links or special files")


_CONTENT_HASH_NAME = re.compile(r"(?:^|[./_-])[a-f0-9]{16,}(?:[./_-]|$)", re.I)


def _gateway_asset_path(path):
    """Match the gateway's static namespaces; HTML and control files never qualify."""
    if not path.startswith("/") or posixpath.normpath(path) != path or "\\" in path or "\0" in path:
        return False
    extension = posixpath.splitext(path)[1].lower()
    if extension in ("", ".html", ".htm", ".xhtml"):
        return False
    if path.startswith(("/_expo/static/", "/assets/", "/perf-assets/", "/fonts/", "/vault/", "/stockfish/")):
        return True
    return path.startswith("/.route-shells/") and extension in (".json", ".png", ".jpg", ".jpeg", ".webp", ".avif")


def immutable_client_files(root):
    """Fingerprint only files the immutable gateway can actually return.

    The build version intentionally excludes the worker, its control metadata,
    and post-hash HTML injection. Those may change without invalidating already
    open tabs. Keep the manifest's *routing authorization* in the comparison,
    however, along with all allowed payload bytes and compressed sidecars.
    """
    root = Path(root)
    files = read_json(root / "manifest.json").get("files", {})
    version = read_json(root / "web/version.json").get("version")
    manifest_path = root / "web/asset-manifest.json"
    allowed = {}
    if manifest_path.exists():
        client = read_json(manifest_path)
        if client.get("version") != version or not isinstance(client.get("assets"), list):
            raise ValueError("Invalid immutable client asset manifest")
        for entry in client["assets"]:
            if not isinstance(entry, str):
                raise ValueError("Invalid immutable client asset URL")
            parsed = urlsplit(entry)
            if parsed.scheme or parsed.netloc or parsed.fragment or re.search(r"%(?![a-fA-F0-9]{2})", parsed.path):
                continue
            path = unquote(parsed.path)
            if not _gateway_asset_path(path):
                continue
            query = parse_qs(parsed.query, keep_blank_values=True)
            if query == {"v": [version]}:
                mode = "versioned"
            elif not parsed.query and path.startswith(("/assets/", "/fonts/", "/perf-assets/")) and _CONTENT_HASH_NAME.search(posixpath.basename(path)):
                mode = "content-addressed"
            else:
                continue
            allowed[(mode, "web" + path)] = True
    else:
        # Early archives may predate the URL manifest. Conservatively protect
        # every eligible static path; never treat unknown JS bytes as compatible.
        for name in files:
            if name.startswith("web/") and _gateway_asset_path(name[3:]):
                allowed[("legacy", name)] = True
    immutable = {}
    for mode, name in allowed:
        if name not in files:
            raise ValueError("Immutable client asset missing from release")
        immutable[mode + ":" + name] = files[name]
        for suffix in (".br", ".gz"):
            if name + suffix in files:
                immutable[mode + ":" + name + suffix] = files[name + suffix]
    return immutable


def archive_client(release, archive_root):
    """Keep exact versioned assets, sharing identical bytes across versions by hard link.

    These are browser compatibility files, not additional runnable build fallbacks.
    No previous version is evicted: tabs may remain open across multiple deployments.
    """
    release, archive_root = Path(release), Path(archive_root)
    version = read_json(release / "web/version.json").get("version")
    if not isinstance(version, str) or not re.fullmatch(r"[a-fA-F0-9]{16}", version):
        raise ValueError("Client release must have a valid immutable version")
    destination = archive_root / version
    if destination.exists():
        if immutable_client_files(destination) != immutable_client_files(release):
            raise ValueError("Refusing to overwrite an immutable client version")
        return version
    archive_root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".client-", dir=archive_root))
    blobs = archive_root / ".objects"
    blobs.mkdir(exist_ok=True)
    try:
        kept = {key.split(":", 1)[1] for key in immutable_client_files(release)}
        kept.update(("web/version.json", "web/asset-manifest.json"))
        archived_files = {}
        for name, checksum in read_json(release / "manifest.json")["files"].items():
            if name not in kept:
                continue
            archived_files[name] = checksum
            source = release / name
            blob = blobs / checksum
            if not blob.exists():
                # Immutable release and archive live on the same disk. Linking also avoids
                # a second full copy on the first rollout; cross-device hosts use copyfile.
                try:
                    os.link(source, blob)
                except OSError:
                    shutil.copyfile(source, blob)
                blob.chmod(0o444)
            elif digest(blob) != checksum:
                raise ValueError("Browser asset archive checksum mismatch")
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True)
            os.link(blob, target)
        atomic_json(staging / "manifest.json", {"schemaVersion": 1, "purpose": "browser-assets", "version": version, "files": archived_files}, 0o444)
        staging.chmod(0o755)
        os.replace(staging, destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return version
