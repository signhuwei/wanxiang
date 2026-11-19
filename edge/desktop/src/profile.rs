//! Persist only the display fields needed to reopen an authenticated Desktop session.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub(crate) struct StoredProfile {
    pub device_id: String,
    pub tenant_id: String,
    pub tenant_name: String,
    pub user_name: String,
}

fn profile_path(socket: &Path) -> PathBuf {
    socket.with_file_name("desktop-profile.json")
}

pub(crate) fn load(socket: &Path) -> Option<StoredProfile> {
    serde_json::from_reader(File::open(profile_path(socket)).ok()?.take(16 * 1024)).ok()
}

pub(crate) fn store(socket: &Path, profile: &StoredProfile) -> io::Result<()> {
    let path = profile_path(socket);
    let tmp = socket.with_file_name(format!(".desktop-profile.{}.tmp", std::process::id()));
    let mut file = OpenOptions::new().create_new(true).write(true).mode(0o600).open(&tmp)?;
    let result = (|| {
        serde_json::to_writer(&mut file, profile)?;
        file.flush()?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

pub(crate) fn clear(socket: &Path) -> io::Result<()> {
    fs::remove_file(profile_path(socket))
}
