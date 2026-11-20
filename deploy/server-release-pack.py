"""Pack the tracked OneX runtime and pinned production dependencies deterministically."""
import gzip
import sys
import tarfile
from pathlib import Path

root, archive, timestamp = sys.argv[1:]
tree = Path(root)
with open(archive, "xb") as target, gzip.GzipFile(filename="", fileobj=target, mode="wb", mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as bundle:
        for folder in (tree / "deploy", tree / "server"):
            for path in sorted([folder, *folder.rglob("*")]):
                if path.is_symlink() or not (path.is_dir() or path.is_file()):
                    raise ValueError(f"Unsupported runtime entry: {path.relative_to(tree)}")
                item = bundle.gettarinfo(str(path), arcname=path.relative_to(tree).as_posix())
                item.mtime = int(timestamp)
                item.uid = item.gid = 0
                item.uname = item.gname = ""
                item.mode = 0o700 if item.isdir() or item.mode & 0o111 else 0o600
                if item.isfile():
                    with path.open("rb") as source:
                        bundle.addfile(item, source)
                else:
                    bundle.addfile(item)
