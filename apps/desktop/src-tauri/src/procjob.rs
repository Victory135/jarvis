// Ties helper processes (model server, voice helper) to JARVIS with a Windows job object that kills them when
// the last handle closes, i.e. when JARVIS exits for any reason, including a crash.
use std::process::Child;

#[cfg(windows)]
pub fn tie_to_app(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    // One job for the app's lifetime; its handle is never closed explicitly, so Windows closes it on exit.
    static JOB: OnceLock<Option<isize>> = OnceLock::new();
    let job = JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32).ok()?;
        Some(job.0 as isize)
    });
    if let Some(h) = job {
        unsafe {
            let _ = AssignProcessToJobObject(HANDLE(*h as *mut _), HANDLE(child.as_raw_handle()));
        }
    }
}

#[cfg(not(windows))]
pub fn tie_to_app(_child: &Child) {}
