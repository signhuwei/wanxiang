//! Preserve the Windows user's `dsh://` handler for the original DeepSeek GUI.

use std::ffi::OsString;
use std::io;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::ptr::null;

use anyhow::{Context, Result, bail};
use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, ERROR_SUCCESS, GetLastError, SetLastError};
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::Shell::{SHCNE_ASSOCCHANGED, SHCNF_IDLIST, SHChangeNotify};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_CREATED_NEW_KEY, REG_SZ};
use winreg::transaction::Transaction;
use winreg::types::{FromRegValue, ToRegValue};
use winreg::{RegKey, RegValue};

const DSH_KEY: &str = r"Software\Classes\dsh";
const OPEN_COMMAND: &str = r"shell\open\command";
const PATHS: [&str; 4] = ["", "shell", r"shell\open", OPEN_COMMAND];
const URL_PROTOCOL: &str = "URL Protocol";
const RECOVERY_KEY: &str = r"Software\OneX\DeepSeekProtocolRecoveryV1";
const RECOVERY_VALUES: [&str; 3] = ["Protocol", "Description", "Command"];

pub(crate) struct DshProtocolGuard {
    pending: bool,
    _exclusive: OwnedHandle,
}

impl DshProtocolGuard {
    pub(crate) fn acquire(executable: &Path) -> Result<Self> {
        let exclusive = exclusive_launch()?.context("another managed DeepSeek Desktop launch owns the dsh protocol")?;
        let hive = RegKey::predef(HKEY_CURRENT_USER);
        restore_and_notify(&hive)?;
        let executable = executable.canonicalize().context("resolve the managed DeepSeek executable")?;
        let backup = Snapshot::read(&hive, DSH_KEY)?;
        backup.record(&hive, RECOVERY_KEY, &executable)?;
        Ok(Self { pending: true, _exclusive: exclusive })
    }

    /// Call after the GUI and its children have stopped writing the registration.
    pub(crate) fn restore(&mut self) -> Result<()> {
        if self.pending {
            restore_and_notify(&RegKey::predef(HKEY_CURRENT_USER))?;
            self.pending = false;
        }
        Ok(())
    }
}

impl Drop for DshProtocolGuard {
    fn drop(&mut self) {
        if let Err(error) = self.restore() {
            tracing::warn!(%error, "could not restore the dsh protocol registration");
        }
    }
}

/// Repair a registration left by an interrupted daemon. A live guard owns its own cleanup.
pub fn recover() -> Result<()> {
    let Some(_exclusive) = exclusive_launch()? else { return Ok(()) };
    restore_and_notify(&RegKey::predef(HKEY_CURRENT_USER))
}

fn restore_and_notify(hive: &RegKey) -> Result<()> {
    if restore_record(hive, DSH_KEY, RECOVERY_KEY)? {
        // Invalidate any association data cached while the original GUI was running.
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED as i32, SHCNF_IDLIST, null(), null()) };
    }
    Ok(())
}

fn exclusive_launch() -> Result<Option<OwnedHandle>> {
    let name: Vec<u16> = "Local\\OneX-DeepSeek-DshProtocol-v1".encode_utf16().chain([0]).collect();
    // The name stays live while the guard holds the handle. No thread owns the mutex.
    let raw = unsafe {
        SetLastError(ERROR_SUCCESS);
        CreateMutexW(null(), 0, name.as_ptr())
    };
    let status = unsafe { GetLastError() };
    if raw.is_null() {
        return Err(io::Error::from_raw_os_error(status as i32)).context("reserve the dsh protocol registration");
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    if status == ERROR_ALREADY_EXISTS {
        return Ok(None);
    }
    Ok(Some(handle))
}

struct Snapshot {
    keys: [bool; PATHS.len()],
    protocol: Option<RegValue>,
    description: Option<RegValue>,
    command: Option<RegValue>,
}

impl Snapshot {
    fn read(hive: &RegKey, base: &str) -> io::Result<Self> {
        let mut keys = [false; PATHS.len()];
        for (present, path) in keys.iter_mut().zip(PATHS) {
            *present = optional(hive.open_subkey(join(base, path)))?.is_some();
        }
        let root = optional(hive.open_subkey(base))?;
        let command = optional(hive.open_subkey(join(base, OPEN_COMMAND)))?;
        Ok(Self {
            keys,
            protocol: value(root.as_ref(), URL_PROTOCOL)?,
            description: value(root.as_ref(), "")?,
            command: value(command.as_ref(), "")?,
        })
    }

    fn record(&self, hive: &RegKey, path: &str, executable: &Path) -> Result<()> {
        let transaction = Transaction::new().context("begin dsh recovery backup")?;
        {
            let (journal, disposition) = hive.create_subkey_transacted(path, &transaction)?;
            if disposition != REG_CREATED_NEW_KEY {
                bail!("a dsh recovery backup already exists");
            }
            journal.set_value("Executable", &executable.as_os_str())?;
            let keys =
                self.keys.iter().enumerate().fold(0u32, |bits, (index, present)| bits | (u32::from(*present) << index));
            journal.set_value("Keys", &keys)?;
            for (name, value) in RECOVERY_VALUES.into_iter().zip([&self.protocol, &self.description, &self.command]) {
                if let Some(value) = value {
                    journal.set_raw_value(name, value)?;
                }
            }
        }
        transaction.commit().context("commit dsh recovery backup")
    }

    fn restore(&self, hive: &RegKey, base: &str, executable: &Path) -> Result<bool> {
        let command_path = join(base, OPEN_COMMAND);
        let key = optional(hive.open_subkey(&command_path))?;
        if !value(key.as_ref(), "")?.as_ref().is_some_and(|value| owns_command(value, executable)) {
            return Ok(false);
        }
        drop(key);

        // Read and edit in the same transaction so the ownership check and empty-key cleanup
        // cannot overwrite changes made by an unrelated program during restoration.
        let transaction = Transaction::new().context("begin dsh registry restoration")?;
        let access = KEY_READ | KEY_SET_VALUE;
        {
            let Some(command) = optional(hive.open_subkey_transacted_with_flags(&command_path, &transaction, access))?
            else {
                return Ok(false);
            };
            let Some(current) = value(Some(&command), "")? else {
                return Ok(false);
            };
            if !owns_command(&current, executable) {
                return Ok(false);
            }
            let root = hive.open_subkey_transacted_with_flags(base, &transaction, access)?;
            restore_value(&root, URL_PROTOCOL, &"".to_reg_value(), self.protocol.as_ref())?;
            restore_value(&root, "", &"URL:dsh".to_reg_value(), self.description.as_ref())?;
            restore_value(&command, "", &current, self.command.as_ref())?;
        }

        for (existed, path) in self.keys.iter().zip(PATHS).rev() {
            if !existed {
                let path = join(base, path);
                if let Some(key) = optional(hive.open_subkey_transacted(&path, &transaction))? {
                    let info = key.query_info()?;
                    if info.values == 0 && info.sub_keys == 0 {
                        drop(key);
                        hive.delete_subkey_transacted(path, &transaction)?;
                    }
                }
            }
        }
        transaction.commit().context("commit dsh registry restoration")?;
        Ok(true)
    }
}

fn restore_record(hive: &RegKey, base: &str, path: &str) -> Result<bool> {
    let Some(journal) = optional(hive.open_subkey(path))? else { return Ok(false) };
    let executable = PathBuf::from(journal.get_value::<OsString, _>("Executable")?);
    let keys = journal.get_value::<u32, _>("Keys")?;
    if !executable.is_absolute() || keys >= 1 << PATHS.len() {
        bail!("invalid dsh recovery backup");
    }
    let [protocol, description, command] = RECOVERY_VALUES;
    let snapshot = Snapshot {
        keys: std::array::from_fn(|index| keys & (1 << index) != 0),
        protocol: value(Some(&journal), protocol)?,
        description: value(Some(&journal), description)?,
        command: value(Some(&journal), command)?,
    };
    drop(journal);
    let restored = snapshot.restore(hive, base, &executable)?;
    hive.delete_subkey(path).context("clear the resolved dsh recovery backup")?;
    Ok(restored)
}

fn join(base: &str, path: &str) -> String {
    if path.is_empty() { base.to_owned() } else { format!(r"{base}\{path}") }
}

fn optional<T>(result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn value(key: Option<&RegKey>, name: &str) -> io::Result<Option<RegValue>> {
    match key {
        Some(key) => optional(key.get_raw_value(name)),
        None => Ok(None),
    }
}

fn owns_command(value: &RegValue, executable: &Path) -> bool {
    if value.vtype != REG_SZ {
        return false;
    }
    let Ok(raw) = OsString::from_reg_value(value) else { return false };
    let Some(command) = raw.to_str() else { return false };
    let Some(path) = command.strip_prefix('"').and_then(|path| path.strip_suffix("\" \"%1\"")) else {
        return false;
    };
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return false;
    }
    match candidate.canonicalize() {
        Ok(candidate) => candidate == executable,
        // The application cache can be removed after the daemon stops. The journal still
        // identifies the exact registered path, including the filesystem's canonical form.
        Err(error) if error.kind() == io::ErrorKind::NotFound => executable.to_str().is_some_and(|executable| {
            let prefix = r"\\?\";
            path.strip_prefix(prefix)
                .unwrap_or(path)
                .eq_ignore_ascii_case(executable.strip_prefix(prefix).unwrap_or(executable))
        }),
        Err(_) => false,
    }
}

fn restore_value(key: &RegKey, name: &str, written: &RegValue, before: Option<&RegValue>) -> io::Result<()> {
    if before == Some(written) || value(Some(key), name)?.as_ref() != Some(written) {
        return Ok(());
    }
    match before {
        Some(before) => key.set_raw_value(name, before),
        None => key.delete_value(name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        hive: RegKey,
        container: String,
        base: String,
        path: PathBuf,
        command: String,
    }

    impl Fixture {
        fn new() -> Self {
            let path = std::env::current_exe().unwrap().canonicalize().unwrap();
            let command = format!("\"{}\" \"%1\"", path.display());
            let container = format!(r"Software\OneX-DshProtocol-Test-{}", crate::launch::uuid_v4());
            Self { hive: RegKey::predef(HKEY_CURRENT_USER), base: join(&container, "dsh"), container, path, command }
        }

        fn key(&self, path: &str) -> RegKey {
            self.hive.create_subkey(join(&self.base, path)).unwrap().0
        }

        fn snapshot(&self) -> Snapshot {
            Snapshot::read(&self.hive, &self.base).unwrap()
        }

        fn journal(&self) -> String {
            join(&self.container, "recovery")
        }

        fn take_over(&self) {
            let root = self.key("");
            root.set_value(URL_PROTOCOL, &"").unwrap();
            root.set_value("", &"URL:dsh").unwrap();
            self.key(OPEN_COMMAND).set_value("", &self.command).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            optional(self.hive.delete_subkey_all(&self.container)).unwrap();
        }
    }

    #[test]
    fn restores_previous_values_and_preserves_unrelated_edits() {
        let fixture = Fixture::new();
        let root = fixture.key("");
        root.set_value("", &"previous description").unwrap();
        root.set_value(URL_PROTOCOL, &17u32).unwrap();
        let command = fixture.key(OPEN_COMMAND);
        command.set_value("", &"previous handler").unwrap();
        let before = fixture.snapshot();

        fixture.take_over();
        root.set_value("", &"description changed concurrently").unwrap();
        command.set_value("other", &42u32).unwrap();
        assert!(before.restore(&fixture.hive, &fixture.base, &fixture.path).unwrap());
        assert_eq!(root.get_value::<String, _>("").unwrap(), "description changed concurrently");
        assert_eq!(root.get_value::<u32, _>(URL_PROTOCOL).unwrap(), 17);
        assert_eq!(command.get_value::<String, _>("").unwrap(), "previous handler");
        assert_eq!(command.get_value::<u32, _>("other").unwrap(), 42);
    }

    #[test]
    fn removes_only_owned_registration_from_a_clean_registry() {
        let fixture = Fixture::new();
        fixture.snapshot().record(&fixture.hive, &fixture.journal(), &fixture.path).unwrap();
        fixture.take_over();
        assert!(restore_record(&fixture.hive, &fixture.base, &fixture.journal()).unwrap());
        assert_eq!(fixture.snapshot().keys, [false; PATHS.len()]);
    }

    #[test]
    fn leaves_a_new_handler_untouched() {
        let fixture = Fixture::new();
        let before = fixture.snapshot();
        fixture.take_over();
        let command = fixture.key(OPEN_COMMAND);
        command.set_value("", &"unrelated handler").unwrap();
        assert!(!before.restore(&fixture.hive, &fixture.base, &fixture.path).unwrap());
        assert_eq!(command.get_value::<String, _>("").unwrap(), "unrelated handler");
    }

    #[test]
    fn recovers_raw_values_after_guard_memory_is_lost() {
        let fixture = Fixture::new();
        let root = fixture.key("");
        root.set_value(URL_PROTOCOL, &17u32).unwrap();
        let command = fixture.key(OPEN_COMMAND);
        command.set_value("", &"original handler").unwrap();
        fixture.snapshot().record(&fixture.hive, &fixture.journal(), &fixture.path).unwrap();
        fixture.take_over();

        assert!(restore_record(&fixture.hive, &fixture.base, &fixture.journal()).unwrap());
        assert!(!restore_record(&fixture.hive, &fixture.base, &fixture.journal()).unwrap());
        assert_eq!(root.get_value::<u32, _>(URL_PROTOCOL).unwrap(), 17);
        assert_eq!(command.get_value::<String, _>("").unwrap(), "original handler");
        assert!(optional(fixture.hive.open_subkey(fixture.journal())).unwrap().is_none());
    }

    #[test]
    fn clears_resolved_backup_when_the_handler_has_changed() {
        let fixture = Fixture::new();
        let command = fixture.key(OPEN_COMMAND);
        command.set_value("", &"original handler").unwrap();
        fixture.snapshot().record(&fixture.hive, &fixture.journal(), &fixture.path).unwrap();
        fixture.take_over();
        command.set_value("", &"unrelated handler").unwrap();

        assert!(!restore_record(&fixture.hive, &fixture.base, &fixture.journal()).unwrap());
        assert_eq!(command.get_value::<String, _>("").unwrap(), "unrelated handler");
        assert!(optional(fixture.hive.open_subkey(fixture.journal())).unwrap().is_none());
    }

    #[test]
    fn owns_the_exact_registered_path_after_the_managed_binary_is_removed() {
        let fixture = Fixture::new();
        let directory = fixture.path.parent().unwrap();
        let path = directory.join("OneX deleted DeepSeek.exe");
        let command = format!("\"{}\" \"%1\"", path.display().to_string().trim_start_matches(r"\\?\"));
        assert!(owns_command(&command.to_reg_value(), &path));
        assert!(!owns_command(&command.to_reg_value(), &directory.join("Another DeepSeek.exe")));
    }
}
