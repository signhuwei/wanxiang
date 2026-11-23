//! Hold an OS-managed lock while the terminal launcher owns a child Agent.
//! A restarted daemon can recognize the older launch until its terminal exits.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

const NAME: &str = "launcher.lock";

pub fn claim(run: &Path) -> io::Result<File> {
    let file = open(run, true)?;
    lock(&file)?;
    Ok(file)
}

pub fn is_active(run: &Path) -> bool {
    match open(run, false) {
        Ok(file) => lock(&file).is_err(),
        Err(error) => error.kind() != io::ErrorKind::NotFound,
    }
}

fn open(run: &Path, create: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(run.join(NAME))?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid Agent launcher lock"));
    }
    Ok(file)
}

#[cfg(unix)]
fn lock(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: the open File owns this descriptor throughout the call.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(windows)]
fn lock(file: &File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx};
    use windows_sys::Win32::System::IO::OVERLAPPED;
    // SAFETY: an all-zero OVERLAPPED describes offset zero with no event.
    let mut offset: OVERLAPPED = unsafe { std::mem::zeroed() };
    // SAFETY: the file handle and synchronous byte range descriptor remain live during the call.
    let result = unsafe {
        LockFileEx(file.as_raw_handle(), LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &mut offset)
    };
    if result != 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}
