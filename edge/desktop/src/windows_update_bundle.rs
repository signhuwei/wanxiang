use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::{Result, ensure};

const HEADER_BYTES: u64 = 32;
const MEMBER_NAMES: [&str; 3] = ["onex-desktop.exe", "onex.exe", "onexd.exe"];

struct WindowsBundle {
    file: File,
    sizes: [u64; 3],
}

impl WindowsBundle {
    fn open(path: &Path) -> Result<Self> {
        let mut file = File::open(path)?;
        let mut header = [0_u8; HEADER_BYTES as usize];
        file.read_exact(&mut header)?;
        ensure!(&header[..8] == b"ONEXWUP1", "invalid Windows update bundle");
        let mut sizes = [0_u64; 3];
        for (length, encoded) in sizes.iter_mut().zip(header[8..].chunks_exact(8)) {
            *length = u64::from_le_bytes(encoded.try_into()?);
            ensure!(*length >= 88, "invalid Windows update member length");
        }
        let declared_size = sizes.iter().try_fold(HEADER_BYTES, |offset, length| offset.checked_add(*length));
        ensure!(declared_size == Some(file.metadata()?.len()), "Windows update bundle size changed");

        let mut offset = HEADER_BYTES;
        for length in sizes {
            file.seek(SeekFrom::Start(offset))?;
            let mut dos = [0_u8; 64];
            file.read_exact(&mut dos)?;
            let pe = u32::from_le_bytes(dos[60..64].try_into()?) as u64;
            ensure!(&dos[..2] == b"MZ" && pe >= 64 && pe + 24 <= length, "invalid Windows update image");
            file.seek(SeekFrom::Start(offset + pe))?;
            let mut signature = [0_u8; 6];
            file.read_exact(&mut signature)?;
            ensure!(&signature == b"PE\0\0\x64\x86", "expected a Windows x64 update image");
            offset += length;
        }
        Ok(Self { file, sizes })
    }

    fn extract(&mut self, index: usize, directory: &Path) -> Result<std::path::PathBuf> {
        let offset = HEADER_BYTES + self.sizes[..index].iter().sum::<u64>();
        self.file.seek(SeekFrom::Start(offset))?;
        let path = directory.join(MEMBER_NAMES[index]);
        let mut output = OpenOptions::new().write(true).create_new(true).open(&path)?;
        let length = self.sizes[index];
        let copied = std::io::copy(&mut (&mut self.file).take(length), &mut output)?;
        ensure!(copied == length, "Windows update image was truncated");
        output.sync_all()?;
        Ok(path)
    }
}

pub(crate) fn desktop(artifact: &Path, directory: &Path) -> Result<std::path::PathBuf> {
    WindowsBundle::open(artifact)?.extract(0, directory)
}

pub(crate) fn sidecars(artifact: &Path, directory: &Path) -> Result<(std::path::PathBuf, std::path::PathBuf)> {
    let mut bundle = WindowsBundle::open(artifact)?;
    Ok((bundle.extract(1, directory)?, bundle.extract(2, directory)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pe(value: u8) -> Vec<u8> {
        let mut image = vec![value; 96];
        image[..2].copy_from_slice(b"MZ");
        image[60..64].copy_from_slice(&64_u32.to_le_bytes());
        image[64..70].copy_from_slice(b"PE\0\0\x64\x86");
        image
    }

    #[test]
    fn unpacks_only_three_declared_x64_members() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("update.onex-update");
        let members = [pe(1), pe(2), pe(3)];
        let mut bytes = b"ONEXWUP1".to_vec();
        for member in &members {
            bytes.extend_from_slice(&(member.len() as u64).to_le_bytes());
        }
        for member in &members {
            bytes.extend_from_slice(member);
        }
        std::fs::write(&source, &bytes).unwrap();
        let ui = desktop(&source, dir.path()).unwrap();
        let (cli, daemon) = sidecars(&source, dir.path()).unwrap();
        assert_eq!(std::fs::read(ui).unwrap(), members[0]);
        assert_eq!(std::fs::read(cli).unwrap(), members[1]);
        assert_eq!(std::fs::read(daemon).unwrap(), members[2]);

        for corrupt in [0, 8, 16, 24, 32 + 96 + 68] {
            let mut malformed = bytes.clone();
            malformed[corrupt] ^= 0xff;
            std::fs::write(&source, malformed).unwrap();
            assert!(WindowsBundle::open(&source).is_err());
        }
        std::fs::write(&source, &bytes[..bytes.len() - 1]).unwrap();
        assert!(WindowsBundle::open(&source).is_err());
    }
}
