use std::io;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr;
use std::time::Duration;

use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};

pub(crate) struct DesktopJob(OwnedHandle);

impl DesktopJob {
    pub(crate) fn new() -> io::Result<Self> {
        // SAFETY: A null name and security descriptor create a non-inheritable private job.
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: The successful call returned a new handle that is owned by this process.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        // SAFETY: The Windows POD information structure accepts zeroes for unused limits.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: The supplied structure matches the class and stays alive for the call.
        let ok = unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                ptr::from_ref(&limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(job) }
    }

    pub(crate) fn attach(&self, child: &tokio::process::Child) -> io::Result<()> {
        let process =
            child.raw_handle().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "desktop already exited"))?;
        // SAFETY: Both handles are borrowed from living owners and passed to Win32 for this call only.
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) async fn stop(self) -> io::Result<()> {
        // SAFETY: The job owns only this launch and its descendants.
        if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        for _ in 0..40 {
            // SAFETY: A zeroed POD structure is valid and QueryInformationJobObject initializes it.
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
            let ok = unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    ptr::from_mut(&mut info).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            if info.ActiveProcesses == 0 {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Err(io::Error::new(io::ErrorKind::TimedOut, "desktop job did not exit promptly"))
    }
}
