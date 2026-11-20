//! 自有状态文件的读写，参照 Magpie `internal/lastgood`。
//!
//! 写：当前文件有效就先存为 `.bak`，无效就另存 `.bad-<毫秒>` 留证；然后同目录 temp → fsync → rename → fsync 目录。
//! 读：当前文件有效用当前；无效时尝试 `.bak`；都不行是 `Unreadable`，不当作空。
//! 当前文件不存在时返回 `Missing`，不看 `.bak`，避免用户有意删除后复活旧状态。

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};

#[derive(Debug, PartialEq, Eq)]
pub enum Read<T> {
    Missing,
    Valid(T),
    /// 当前文件损坏，用的是 `.bak`。
    Recovered(T),
    Unreadable,
}

pub fn read<T>(path: &Path, parse: impl Fn(&[u8]) -> Option<T>) -> Result<Read<T>> {
    let cur = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Read::Missing),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    if let Some(v) = parse(&cur) {
        return Ok(Read::Valid(v));
    }
    match fs::read(bak(path)) {
        Ok(b) => Ok(parse(&b).map_or(Read::Unreadable, Read::Recovered)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Read::Unreadable),
        Err(e) => Err(e).with_context(|| format!("read {}", bak(path).display())),
    }
}

/// 写入 `data`，权限 0600。`valid` 判断当前文件是否值得存为 `.bak`。
pub fn write(path: &Path, data: &[u8], valid: impl Fn(&[u8]) -> bool) -> Result<()> {
    match fs::read(path) {
        Ok(cur) if cur == data => return Ok(()),
        Ok(cur) if valid(&cur) => {
            if fs::read(bak(path)).ok().as_deref() != Some(&cur[..]) {
                replace(&bak(path), &cur)?;
            }
        }
        Ok(cur) => keep_bad(path, &cur)?,
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    }
    replace(path, data)
}

fn bak(path: &Path) -> PathBuf {
    with_suffix(path, ".bak")
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

fn private_open() -> OpenOptions {
    let mut o = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o
}

fn keep_bad(path: &Path, cur: &[u8]) -> Result<()> {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    for n in 0..100 {
        let p = with_suffix(path, &format!(".bad-{ms}-{n}"));
        match private_open().write(true).create_new(true).open(&p) {
            Ok(mut f) => {
                f.write_all(cur)?;
                f.sync_all()?;
                return Ok(());
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e).with_context(|| format!("keep bad copy {}", p.display())),
        }
    }
    anyhow::bail!("too many bad copies of {}", path.display())
}

fn replace(path: &Path, data: &[u8]) -> Result<()> {
    let dir = path.parent().context("state file has no parent dir")?;
    let tmp = with_suffix(path, &format!(".tmp-{}", std::process::id()));
    let r = (|| -> std::io::Result<()> {
        let mut f = private_open().write(true).create(true).truncate(true).open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        fs::rename(&tmp, path)?;
        // 目录本身的 fsync 只是 Unix 下"确保 rename 元数据落盘"的惯用法（NTFS 不允许用
        // `File::open` 打开目录再 `sync_all`，`rename` 在 Windows 上本身就是元数据级原子操作，
        // 不需要额外这一步）。
        #[cfg(unix)]
        std::fs::File::open(dir)?.sync_all()?;
        #[cfg(windows)]
        let _ = dir;
        Ok(())
    })();
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r.with_context(|| format!("write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(b: &[u8]) -> Option<u32> {
        std::str::from_utf8(b).ok()?.parse().ok()
    }
    fn valid(b: &[u8]) -> bool {
        parse(b).is_some()
    }

    #[test]
    fn missing_then_valid_then_bak() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s");
        assert_eq!(read(&p, parse).unwrap(), Read::Missing);
        write(&p, b"1", valid).unwrap();
        assert_eq!(read(&p, parse).unwrap(), Read::Valid(1));
        assert!(!bak(&p).exists());
        write(&p, b"2", valid).unwrap();
        assert_eq!(fs::read(bak(&p)).unwrap(), b"1");
        assert_eq!(read(&p, parse).unwrap(), Read::Valid(2));
    }

    #[test]
    fn corrupt_current_recovers_from_bak_and_is_kept_as_bad() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s");
        write(&p, b"1", valid).unwrap();
        write(&p, b"2", valid).unwrap();
        fs::write(&p, b"garbage").unwrap();
        assert_eq!(read(&p, parse).unwrap(), Read::Recovered(1));
        // 坏文件不污染 .bak，另存一份
        write(&p, b"3", valid).unwrap();
        assert_eq!(fs::read(bak(&p)).unwrap(), b"1");
        let bad: Vec<_> = fs::read_dir(d.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("s.bad-"))
            .collect();
        assert_eq!(bad.len(), 1);
        assert_eq!(fs::read(bad[0].path()).unwrap(), b"garbage");
    }

    #[test]
    fn both_bad_is_unreadable_and_truncated_file_counts_as_bad() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s");
        fs::write(&p, b"").unwrap();
        assert_eq!(read(&p, parse).unwrap(), Read::Unreadable);
        fs::write(bak(&p), b"x").unwrap();
        assert_eq!(read(&p, parse).unwrap(), Read::Unreadable);
    }

    #[test]
    fn deleted_current_does_not_resurrect_bak() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s");
        write(&p, b"1", valid).unwrap();
        write(&p, b"2", valid).unwrap();
        fs::remove_file(&p).unwrap();
        assert_eq!(read(&p, parse).unwrap(), Read::Missing);
    }

    #[test]
    fn failed_write_leaves_original() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("sub").join("s");
        // 父目录不存在，写入失败
        assert!(write(&p, b"1", valid).is_err());
        let p = d.path().join("s");
        write(&p, b"1", valid).unwrap();
        // temp 名被目录占住，写入失败，原文件不变
        fs::create_dir(with_suffix(&p, &format!(".tmp-{}", std::process::id()))).unwrap();
        assert!(write(&p, b"2", valid).is_err());
        assert_eq!(read(&p, parse).unwrap(), Read::Valid(1));
    }
}
