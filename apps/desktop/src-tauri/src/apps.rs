// Opening apps and controlling the system volume.
// Apps: ALLOWLIST ONLY. The HUD sends an app id ("chrome"), never a path or command line; each id maps to a fixed
// set of ways to find that app on this PC (known folders, App Paths registry, Store app id, URI scheme, Start-menu
// shortcut). Launch goes through ShellExecute (no shell string, no arguments). No terminals or script hosts.
// Volume: Windows Core Audio on the default playback device.
use serde::Serialize;
use std::path::{Path, PathBuf};

enum Way {
    /// Absolute path; %VAR% expanded.
    Exe(&'static str),
    /// Registered under ...\CurrentVersion\App Paths\<name>.
    AppPath(&'static str),
    /// Store/packaged app: (AppUserModelID, package family folder under %LOCALAPPDATA%\Packages used to detect it).
    Aumid(&'static str, &'static str),
    /// Program in %WINDIR%\System32.
    System(&'static str),
    /// Start-menu shortcut name (searched in the all-users and per-user Start menus).
    Lnk(&'static str),
    /// URI scheme registered with Windows (e.g. "ms-settings:").
    Uri(&'static str),
}

struct App {
    id: &'static str,
    name: &'static str,
    ways: &'static [Way],
}

use Way::*;
const APPS: &[App] = &[
    App { id: "chrome", name: "Chrome", ways: &[Exe(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"), Exe(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"), Exe(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"), AppPath("chrome.exe"), Lnk("Google Chrome")] },
    App { id: "edge", name: "Edge", ways: &[AppPath("msedge.exe"), Exe(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"), Lnk("Microsoft Edge")] },
    App { id: "firefox", name: "Firefox", ways: &[AppPath("firefox.exe"), Exe(r"%ProgramFiles%\Mozilla Firefox\firefox.exe"), Lnk("Firefox")] },
    App { id: "spotify", name: "Spotify", ways: &[Exe(r"%APPDATA%\Spotify\Spotify.exe"), Aumid("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0"), Lnk("Spotify")] },
    App { id: "whatsapp", name: "WhatsApp", ways: &[Aumid("5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App", "5319275A.WhatsAppDesktop_cv1g1gvanyjgm"), Lnk("WhatsApp")] },
    App { id: "discord", name: "Discord", ways: &[Lnk("Discord")] },
    App { id: "netflix", name: "Netflix", ways: &[Aumid("4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App", "4DF9E0F8.Netflix_mcm4njqhnhss8")] },
    App { id: "vscode", name: "VS Code", ways: &[Exe(r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"), Exe(r"%ProgramFiles%\Microsoft VS Code\Code.exe"), AppPath("code.exe"), Lnk("Visual Studio Code")] },
    App { id: "word", name: "Word", ways: &[AppPath("winword.exe"), Lnk("Word")] },
    App { id: "excel", name: "Excel", ways: &[AppPath("excel.exe"), Lnk("Excel")] },
    App { id: "powerpoint", name: "PowerPoint", ways: &[AppPath("powerpnt.exe"), Lnk("PowerPoint")] },
    App { id: "vlc", name: "VLC", ways: &[AppPath("vlc.exe"), Exe(r"%ProgramFiles%\VideoLAN\VLC\vlc.exe")] },
    App { id: "mediaplayer", name: "Media Player", ways: &[Aumid("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic", "Microsoft.ZuneMusic_8wekyb3d8bbwe")] },
    App { id: "calculator", name: "Calculator", ways: &[Aumid("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", "Microsoft.WindowsCalculator_8wekyb3d8bbwe"), System("calc.exe")] },
    App { id: "notepad", name: "Notepad", ways: &[System("notepad.exe")] },
    App { id: "paint", name: "Paint", ways: &[System("mspaint.exe")] },
    App { id: "snipping", name: "Snipping Tool", ways: &[System("SnippingTool.exe")] },
    App { id: "explorer", name: "File Explorer", ways: &[System(r"..\explorer.exe")] },
    App { id: "taskmanager", name: "Task Manager", ways: &[System("Taskmgr.exe")] },
    App { id: "settings", name: "Settings", ways: &[Uri("ms-settings:")] },
    App { id: "camera", name: "Camera", ways: &[Aumid("Microsoft.WindowsCamera_8wekyb3d8bbwe!App", "Microsoft.WindowsCamera_8wekyb3d8bbwe")] },
    App { id: "photos", name: "Photos", ways: &[Aumid("Microsoft.Windows.Photos_8wekyb3d8bbwe!App", "Microsoft.Windows.Photos_8wekyb3d8bbwe")] },
    App { id: "clock", name: "Clock", ways: &[Aumid("Microsoft.WindowsAlarms_8wekyb3d8bbwe!App", "Microsoft.WindowsAlarms_8wekyb3d8bbwe")] },
    App { id: "mail", name: "Mail", ways: &[Aumid("microsoft.windowscommunicationsapps_8wekyb3d8bbwe!microsoft.windowslive.mail", "microsoft.windowscommunicationsapps_8wekyb3d8bbwe")] },
    App { id: "calendar", name: "Calendar", ways: &[Aumid("microsoft.windowscommunicationsapps_8wekyb3d8bbwe!microsoft.windowslive.calendar", "microsoft.windowscommunicationsapps_8wekyb3d8bbwe")] },
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub installed: bool,
    /// How it would be launched (for the Settings list): "program", "store app", "shortcut", "link".
    pub via: Option<&'static str>,
}

fn expand(p: &str) -> String {
    let mut out = String::new();
    let mut rest = p;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('%') {
            Some(j) => {
                out.push_str(&std::env::var(&after[..j]).unwrap_or_default());
                rest = &after[j + 1..];
            }
            None => { out.push('%'); rest = after; }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(windows)]
fn app_path(name: &str) -> Option<PathBuf> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let key = HSTRING::from(format!(r"Software\Microsoft\Windows\CurrentVersion\App Paths\{name}"));
        let mut buf = [0u16; 1024];
        let mut len = (buf.len() * 2) as u32;
        let ok = unsafe { RegGetValueW(root, &key, None, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut len)) };
        if ok.is_ok() {
            let s = String::from_utf16_lossy(&buf[..(len as usize / 2).saturating_sub(1)]);
            let p = PathBuf::from(s.trim_matches('"'));
            if p.exists() { return Some(p) }
        }
    }
    None
}
#[cfg(not(windows))]
fn app_path(_: &str) -> Option<PathBuf> { None }

fn find_lnk(dir: &Path, name: &str, depth: u8) -> Option<PathBuf> {
    let want = format!("{}.lnk", name.to_lowercase());
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() && depth > 0 {
            if let Some(f) = find_lnk(&p, name, depth - 1) { return Some(f) }
        } else if p.file_name().map(|f| f.to_string_lossy().to_lowercase() == want).unwrap_or(false) {
            return Some(p);
        }
    }
    None
}

#[cfg(windows)]
fn uri_registered(scheme: &str) -> bool {
    use windows::Win32::System::Registry::{RegOpenKeyExW, RegCloseKey, HKEY, HKEY_CLASSES_ROOT, KEY_READ};
    let name = windows::core::HSTRING::from(scheme.trim_end_matches(':'));
    let mut k = HKEY::default();
    let ok = unsafe { RegOpenKeyExW(HKEY_CLASSES_ROOT, &name, None, KEY_READ, &mut k) }.is_ok();
    if ok { unsafe { let _ = RegCloseKey(k); } }
    ok
}
#[cfg(not(windows))]
fn uri_registered(_: &str) -> bool { false }

/// The concrete target ShellExecute will open for this app, if it is installed.
fn resolve(app: &App) -> Option<(String, &'static str)> {
    for w in app.ways {
        match w {
            Exe(p) => { let p = expand(p); if Path::new(&p).exists() { return Some((p, "program")) } }
            AppPath(n) => { if let Some(p) = app_path(n) { return Some((p.to_string_lossy().into(), "program")) } }
            Aumid(id, family) => {
                let dir = PathBuf::from(expand(r"%LOCALAPPDATA%\Packages")).join(family);
                if dir.is_dir() { return Some((format!(r"shell:AppsFolder\{id}"), "store app")) }
            }
            System(exe) => {
                let p = PathBuf::from(expand(r"%WINDIR%\System32")).join(exe);
                if p.exists() { return Some((p.to_string_lossy().into(), "program")) }
            }
            Lnk(n) => {
                for root in [r"%ProgramData%\Microsoft\Windows\Start Menu\Programs", r"%APPDATA%\Microsoft\Windows\Start Menu\Programs"] {
                    if let Some(p) = find_lnk(Path::new(&expand(root)), n, 3) { return Some((p.to_string_lossy().into(), "shortcut")) }
                }
            }
            Uri(u) => { if uri_registered(u) { return Some((u.to_string(), "link")) } }
        }
    }
    None
}

pub fn list() -> Vec<AppInfo> {
    APPS.iter().map(|a| {
        let r = resolve(a);
        AppInfo { id: a.id, name: a.name, installed: r.is_some(), via: r.map(|x| x.1) }
    }).collect()
}

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let r = unsafe { ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from(target), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    // ShellExecute returns a value > 32 on success.
    if r.0 as isize > 32 { Ok(()) } else { Err(format!("Windows refused to open it (code {})", r.0 as isize)) }
}
#[cfg(not(windows))]
fn shell_open(_: &str) -> Result<(), String> { Err("Windows only".into()) }

/// Open an allowlisted app by id. Returns its display name.
pub fn open(id: &str) -> Result<&'static str, String> {
    let app = APPS.iter().find(|a| a.id == id).ok_or("not an app I'm allowed to open")?;
    let (target, _) = resolve(app).ok_or_else(|| format!("{} isn't installed on this PC", app.name))?;
    shell_open(&target).map(|_| app.name)
}

/// Open Spotify's own search for `query` (spotify:search:...). Only letters, digits, spaces and simple punctuation.
pub fn spotify_search(query: &str) -> Result<(), String> {
    let q = query.trim();
    if q.is_empty() || q.len() > 100 || !q.chars().all(|c| c.is_alphanumeric() || " '&.,-!?".contains(c)) {
        return Err("that search text isn't allowed".into());
    }
    let encoded: String = q.chars().map(|c| if c == ' ' { "%20".to_string() } else if c.is_alphanumeric() { c.to_string() } else { format!("%{:02X}", c as u32) }).collect();
    if !uri_registered("spotify:") { return Err("Spotify isn't installed on this PC".into()) }
    shell_open(&format!("spotify:search:{encoded}"))
}

// ---------------- volume ----------------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    /// 0-100
    pub level: u32,
    pub muted: bool,
}

#[cfg(windows)]
fn endpoint() -> Result<windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume, String> {
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED); // fine if already initialised on this thread
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let dev = en.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|_| "no playback device".to_string())?;
        dev.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
pub fn volume_get() -> Result<Volume, String> {
    let ep = endpoint()?;
    unsafe {
        let level = ep.GetMasterVolumeLevelScalar().map_err(|e| e.to_string())?;
        let muted = ep.GetMute().map_err(|e| e.to_string())?.as_bool();
        Ok(Volume { level: (level * 100.0).round() as u32, muted })
    }
}

/// Set any of: absolute level (0-100), mute state. Returns the resulting state (read back, not assumed).
#[cfg(windows)]
pub fn volume_set(level: Option<u32>, muted: Option<bool>) -> Result<Volume, String> {
    let ep = endpoint()?;
    unsafe {
        if let Some(l) = level {
            ep.SetMasterVolumeLevelScalar(l.min(100) as f32 / 100.0, std::ptr::null()).map_err(|e| e.to_string())?;
        }
        if let Some(m) = muted {
            ep.SetMute(m, std::ptr::null()).map_err(|e| e.to_string())?;
        }
    }
    volume_get()
}

#[cfg(not(windows))]
pub fn volume_get() -> Result<Volume, String> { Err("Windows only".into()) }
#[cfg(not(windows))]
pub fn volume_set(_: Option<u32>, _: Option<bool>) -> Result<Volume, String> { Err("Windows only".into()) }
