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



_SHELL_VERSION_RE = re.compile(r'__caShellVersion\s*=\s*["\']([^"\']+)["\']')
_ENTRY_SCRIPT_RE = re.compile(r'/_expo/static/js/web/[^"\'?\s\\]+\.js(?:\?v=([^"\'\s\\]+))?')


def _parse_shell_html(html):
    if "data-ca-resumable-loader" not in html and "/_expo/static/js/web/" not in html:
        return None
    version_match = _SHELL_VERSION_RE.search(html)
    version = version_match.group(1) if version_match else ""
    scripts = []
    seen = set()
    for match in _ENTRY_SCRIPT_RE.finditer(html):
        full = match.group(0)
        script_path = full.split("?", 1)[0]
        query_version = match.group(1) or ""
        if query_version and version and query_version != version:
            raise ValueError(f"Route shell script {full} version mismatch with {version}")
        if script_path not in seen:
            seen.add(script_path)
            scripts.append(script_path)
    if not scripts:
        raise ValueError("Route shell is missing entry scripts")
    return {"version": version, "scripts": scripts}


def _is_core_entry_script(script_path):
    clean = script_path.split("?", 1)[0]
    return (
        "/__expo-metro-runtime-" in clean
        or "/__common-" in clean
        or "/index-" in clean
    )


def _core_entry_scripts(scripts):
    core = [s for s in scripts if _is_core_entry_script(s)]
    return core or list(scripts)


def verify_route_shells(web_root):
    web_root = Path(web_root)
    index_path = web_root / "index.html"
    if not index_path.is_file():
        return
    index_info = _parse_shell_html(index_path.read_text(encoding="utf-8", errors="replace"))
    if index_info is None:
        return
    if "data-ca-resumable-loader" not in index_path.read_text(encoding="utf-8", errors="replace"):
        raise ValueError("index.html is missing data-ca-resumable-loader")
    expected_version = str(read_json(web_root / "version.json").get("version") or "")
    if expected_version and index_info["version"] and index_info["version"] != expected_version:
        raise ValueError("index.html shell version does not match version.json")
    for script_path in index_info["scripts"]:
        if not (web_root / script_path.lstrip("/")).is_file():
            raise ValueError(f"Missing entry script {script_path} referenced by index.html")
    shells_dir = web_root / ".route-shells"
    routes_file = shells_dir / "routes.json"
    if not routes_file.is_file():
        raise ValueError("Release is missing web/.route-shells/routes.json")
    routes_meta = read_json(routes_file)
    routes = routes_meta.get("routes")
    if not isinstance(routes, list) or not routes:
        raise ValueError("Release web/.route-shells/routes.json has no routes list")
    shell_files = {p.name for p in shells_dir.glob("*.html") if p.is_file()}
    for route in routes:
        if not isinstance(route, str):
            continue
        slug = "home" if route == "/" else re.sub(r"[^a-zA-Z0-9-]+", "-", route.strip("/"))
        filename = f"{slug}.html"
        if filename not in shell_files:
            raise ValueError(f"Missing route shell {filename} for {route}")
    web_root_resolved = web_root.resolve()
    index_core_scripts = _core_entry_scripts(index_info["scripts"])
    for filename in sorted(shell_files):
        shell_path = shells_dir / filename
        shell_html = shell_path.read_text(encoding="utf-8", errors="replace")
        if "data-ca-resumable-loader" not in shell_html:
            raise ValueError(f"Route shell {filename} is missing resumable loader")
        shell_info = _parse_shell_html(shell_html)
        if shell_info is None:
            raise ValueError(f"Route shell {filename} is missing entry scripts")
        if shell_info["version"] != index_info["version"]:
            raise ValueError(f"Route shell {filename} version {shell_info['version']} does not match index.html {index_info['version']}")
        for script_path in shell_info["scripts"]:
            candidate = (web_root / script_path.lstrip("/")).resolve()
            if not candidate.is_relative_to(web_root_resolved) or not candidate.is_file():
                raise ValueError(f"Missing script {script_path} referenced by route shell {filename}")
        if _core_entry_scripts(shell_info["scripts"]) != index_core_scripts:
            raise ValueError(f"Route shell {filename} entry scripts do not match index.html")


def manifest(root, metadata):
    root = Path(root)
    verify_route_shells(root / "web")
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
    verify_route_shells(root / "web")
    return value


def extract(archive, destination):
    """Accept ordinary build files/directories only; never links or traversal."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as source:
        first = source.next()
        if first and first.name == ".chessalive-web-delta.json":
            _extract_web_delta(source, first, destination)
            return
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


def _delta_files(value):
    if not isinstance(value, dict):
        raise ValueError("Invalid web transfer file inventory")
    for name, checksum in value.items():
        if (not isinstance(name, str) or not name or name.startswith("/") or
                posixpath.normpath(name) != name or ".." in name.split("/") or
                "\\" in name or "\0" in name or name == ".chessalive-web-delta.json" or
                not isinstance(checksum, str) or not re.fullmatch(r"[a-f0-9]{64}", checksum)):
            raise ValueError("Invalid web transfer file inventory")
    return value


def _extract_web_delta(source, first, destination):
    # Resolve only a retained release beside this new release. No caller-selected
    # absolute path, active symlink, or copy of the old tree is trusted as a baseline.
    if not first.isfile() or first.size > 32 * 1024 * 1024:
        raise ValueError("Invalid web transfer index")
    plan = json.load(source.extractfile(first))
    if not isinstance(plan, dict):
        raise ValueError("Invalid web transfer index")
    base_id = plan.get("baseRelease", "")
    if plan.get("schemaVersion") != 1 or not isinstance(base_id, str) or not re.fullmatch(r"release-[a-z0-9-]+", base_id):
        raise ValueError("Invalid web transfer baseline")
    if destination.name != "web" or destination.parent.parent.name != "releases" or any(destination.iterdir()):
        raise ValueError("Web transfer requires an empty isolated release directory")
    base = destination.parent.parent / base_id
    if base.is_symlink() or (base / "web").is_symlink() or base.resolve() == destination.parent.resolve():
        raise ValueError("Invalid web transfer baseline")
    metadata = read_json(base / "manifest.json")
    if metadata.get("schemaVersion") != 1 or metadata.get("complete") is not True or not isinstance(metadata.get("files"), dict):
        raise ValueError("Web transfer baseline is unavailable")
    files = _delta_files(plan.get("files"))
    reused = _delta_files(plan.get("reused"))
    for name, checksum in reused.items():
        original = base / "web" / name
        if (files.get(name) != checksum or metadata.get("files", {}).get("web/" + name) != checksum or
                not original.resolve().is_relative_to((base / "web").resolve()) or original.is_symlink() or
                not original.is_file() or digest(original) != checksum):
            raise ValueError("Web transfer baseline checksum mismatch")
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(original, target)
        except OSError:
            shutil.copyfile(original, target)
    received = set()
    for item in source:
        # tarfile iteration includes the already-read first member.
        if item is first:
            continue
        name = item.name
        if not item.isfile() or name not in files or name in reused or name in received:
            raise ValueError("Unexpected web transfer archive entry")
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.extractfile(item) as src, target.open("wb") as dst:
            shutil.copyfileobj(src, dst)
        target.chmod(0o644)
        if digest(target) != files[name]:
            raise ValueError("Web transfer payload checksum mismatch")
        received.add(name)
    if received != files.keys() - reused.keys():
        raise ValueError("Web transfer payload is incomplete")


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
