"""Validate a signed OneX runtime archive before extracting into an empty private directory."""
import sys
import tarfile
from pathlib import PurePosixPath

archive, target = sys.argv[1:]
required = {
    "server/src/index.ts", "server/src/server-releases.ts", "server/package.json",
    "server/node_modules/hono/package.json", "deploy/onex.sh", "deploy/server-release-worker.sh",
}
with tarfile.open(archive, "r:gz") as bundle:
    names = set()
    files = set()
    members = []
    size = 0
    for member in bundle:
        name = member.name
        path = PurePosixPath(name)
        if name == "." and member.isdir():
            continue
        if path.is_absolute() or not path.parts or path.parts[0] not in ("server", "deploy") or ".." in path.parts:
            raise ValueError("archive path outside OneX runtime")
        key = path.as_posix()
        if key in names or len(names) >= 30000 or not (member.isfile() or member.isdir()) or getattr(member, "sparse", None):
            raise ValueError("unsupported archive entry")
        names.add(key)
        if member.isfile():
            size += member.size
            files.add(key)
        if size > 512 * 1024 * 1024:
            raise ValueError("expanded package exceeds limit")
        member.name = key
        member.mode = 0o700 if member.isdir() or member.mode & 0o111 else 0o600
        member.uid = member.gid = 0
        member.uname = member.gname = ""
        members.append(member)
    if not required <= files:
        raise ValueError("missing OneX runtime files")
    bundle.extractall(target, members)
