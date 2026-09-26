#!/usr/bin/env python3
"""Stage only the index Dockerfile inputs, refusing unsafe build inputs."""

from pathlib import Path
import json
import shutil
import sys

FIXED = {
    "service/Dockerfile", "service/docker-entrypoint.sh",
    "service/package.json", "service/package-lock.json", "service/tsconfig.json",
    "indexer/package.json", "indexer/package-lock.json", "indexer/idl/veto.json",
}
TREES = ("service/src", "indexer/src")


def validate(path, relative):
    names = [part.lower() for part in relative.parts]
    if (path.is_symlink() or not (path.is_dir() or path.is_file())
            or any(name in {"keys", "key", "logs", "log", ".local"}
                   or name.startswith(".env") or "credential" in name
                   or name.endswith((".p8", ".p12", ".key", ".pem", ".log"))
                   for name in names)):
        raise ValueError(f"unsafe build input: {relative}")
    if path.is_dir():
        return
    if relative.as_posix() not in FIXED and path.suffix not in {".ts", ".sql"}:
        raise ValueError(f"unexpected build input: {relative}")
    data = path.read_bytes()
    if b"PRIVATE KEY" in data:
        raise ValueError(f"private key in build input: {relative}")
    if path.suffix == ".json":
        document = json.loads(data)
        if not isinstance(document, dict):
            raise ValueError(f"unexpected JSON build input: {relative}")

        def has_credentials(value):
            if isinstance(value, dict):
                return any(key.lower() in {"private_key", "private_key_id", "client_secret",
                                           "refresh_token", "credentials"}
                           or has_credentials(child) for key, child in value.items())
            return isinstance(value, list) and any(map(has_credentials, value))

        if has_credentials(document):
            raise ValueError(f"credentials in JSON build input: {relative}")


def stage(root, destination):
    if destination.exists():
        raise ValueError("build context destination must not exist")
    selected = set(FIXED)
    # Check parents explicitly: a symlinked source root must never be traversed.
    for name in sorted(FIXED | set(TREES)):
        relative = Path(name)
        for parent in reversed(relative.parents):
            validate(root / parent, parent)
        validate(root / relative, relative)
    for name in TREES:
        for path in (root / name).rglob("*"):
            relative = path.relative_to(root)
            validate(path, relative)
            if path.is_file() and not path.name.endswith(".test.ts"):
                selected.add(relative.as_posix())
    destination.mkdir(mode=0o700)
    for name in sorted(selected):
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / name, target, follow_symlinks=False)
    # Inspect the resulting context before the caller can submit it.
    for path in destination.rglob("*"):
        validate(path, path.relative_to(destination))


if __name__ == "__main__":
    try:
        stage(Path(sys.argv[1]), Path(sys.argv[2]))
    except (OSError, ValueError) as error:
        sys.exit(f"error: {error}")
