export const desktopUpdateKind = (os: string) => os === 'darwin' ? 'macos-pkg-keep-daemon' : 'windows-edge-bundle';

export function desktopUpdateBytes(update: {
  id: string; version: string; os: string; arch: string; kind: string; size: number; sha256: string;
}) {
  const { id, version, os, arch, kind, size, sha256 } = update;
  return Buffer.from(`onex-desktop-update-v1\n${id}\n${version}\n${os}\n${arch}\n${kind}\n${size}\n${sha256}\n`);
}
