// Native link for the HUD. Every value returned here is measured on this machine at call time.
// Anything that cannot be read is returned as None so the UI shows an honest "unavailable" state.
mod apps;
mod llm;
mod media;
mod online;
mod procjob;
mod search;
mod shell;
mod stt;
mod tts;
mod web;
mod wifi;

use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use sysinfo::{CpuRefreshKind, Disks, MemoryRefreshKind, Networks, RefreshKind, System};

struct Probe {
    sys: System,
    disks: Disks,
    nets: Networks,
    last_net: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Telemetry {
    /// Whole-machine CPU load since the previous sample, 0-100.
    cpu_pct: f32,
    cpu_name: String,
    cpu_threads: usize,
    mem_used: u64,
    mem_total: u64,
    /// Drive that holds Windows (usually C:).
    disk_mount: Option<String>,
    disk_used: Option<u64>,
    disk_total: Option<u64>,
    /// Bytes per second across physical interfaces since the previous sample.
    net_rx_bps: Option<f64>,
    net_tx_bps: Option<f64>,
    uptime_s: u64,
    sample_ms: u64,
}

fn is_virtual(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["loopback", "vethernet", "virtualbox", "vmware", "hyper-v", "isatap", "teredo", "bluetooth", "pseudo"]
        .iter()
        .any(|k| n.contains(k))
}

impl Probe {
    fn new() -> Result<Self, String> {
        let sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing().with_usage())
                .with_memory(MemoryRefreshKind::nothing().with_ram()),
        )
        .map_err(|e| format!("system probe: {e}"))?;
        Ok(Probe {
            sys,
            disks: Disks::new_with_refreshed_list().map_err(|e| format!("disk probe: {e}"))?,
            nets: Networks::new_with_refreshed_list().map_err(|e| format!("network probe: {e}"))?,
            last_net: Instant::now(),
        })
    }

    fn sample(&mut self) -> Telemetry {
        let t0 = Instant::now();
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        self.disks.refresh(true);
        self.nets.refresh(true);

        let elapsed = self.last_net.elapsed().as_secs_f64();
        self.last_net = Instant::now();
        let (mut rx, mut tx) = (0u64, 0u64);
        for (name, data) in self.nets.iter() {
            if is_virtual(&name.to_string_lossy()) {
                continue;
            }
            rx += data.received();
            tx += data.transmitted();
        }
        // The first sample has no previous window to compare against.
        let rate = |b: u64| if elapsed > 0.2 { Some(b as f64 / elapsed) } else { None };

        let sys_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let disk = self
            .disks
            .iter()
            .find(|d| d.mount_point().to_string_lossy().to_ascii_uppercase().starts_with(&sys_drive.to_ascii_uppercase()));

        let cpus = self.sys.cpus();
        Telemetry {
            cpu_pct: self.sys.global_cpu_usage(),
            cpu_name: cpus.first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
            cpu_threads: cpus.len(),
            mem_used: self.sys.used_memory(),
            mem_total: self.sys.total_memory(),
            disk_mount: disk.map(|d| d.mount_point().to_string_lossy().trim_end_matches('\\').to_string()),
            disk_used: disk.map(|d| d.total_space().saturating_sub(d.available_space())),
            disk_total: disk.map(|d| d.total_space()),
            net_rx_bps: rate(rx),
            net_tx_bps: rate(tx),
            uptime_s: System::uptime().unwrap_or(0),
            sample_ms: t0.elapsed().as_millis() as u64,
        }
    }
}

#[tauri::command]
fn telemetry(state: tauri::State<'_, Mutex<Result<Probe, String>>>) -> Result<Telemetry, String> {
    let mut guard = state.lock().map_err(|_| "telemetry lock poisoned".to_string())?;
    match guard.as_mut() {
        Ok(p) => Ok(p.sample()),
        Err(e) => Err(e.clone()),
    }
}

#[tauri::command]
async fn wifi_status() -> Option<wifi::WifiStatus> {
    // netsh is a short-lived child process; run it off the main thread.
    tauri::async_runtime::spawn_blocking(wifi::read).await.ok().flatten()
}

/// Runs a blocking WinRT call on a worker thread so the UI thread never waits on it.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn media_status() -> Result<media::MediaStatus, String> {
    blocking(media::status).await
}

#[tauri::command]
async fn media_control(app: String, action: String) -> Result<bool, String> {
    blocking(move || media::control(&app, &action)).await
}

#[tauri::command]
async fn fetch_feed(url: String) -> Result<web::Feed, String> {
    blocking(move || web::fetch(&url)).await
}

#[tauri::command]
async fn web_get(url: String) -> Result<String, String> {
    blocking(move || web::get(&url)).await
}

#[tauri::command]
async fn web_search(query: String) -> Result<search::Found, String> {
    blocking(move || search::search(&query)).await
}

#[tauri::command]
async fn open_link(url: String) -> Result<(), String> {
    blocking(move || web::open(&url)).await
}

#[tauri::command]
fn stt_engines(stt: tauri::State<'_, Arc<stt::Stt>>) -> Vec<stt::EngineInfo> {
    stt.engines()
}

/// Body: raw 16 kHz mono i16 PCM. Header `x-engine`: "vosk" | "whisper".
#[tauri::command]
async fn transcribe(request: tauri::ipc::Request<'_>, stt: tauri::State<'_, Arc<stt::Stt>>) -> Result<stt::Transcript, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw audio".into());
    };
    let engine = request.headers().get("x-engine").and_then(|v| v.to_str().ok()).unwrap_or("vosk").to_string();
    let threads = request.headers().get("x-threads").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()); // tuning only
    let pcm = stt::decode_pcm(bytes)?;
    let stt = Arc::clone(&stt);
    blocking(move || stt.transcribe(&engine, &pcm, threads)).await
}

#[tauri::command]
fn tts_info(tts: tauri::State<'_, Arc<tts::Tts>>) -> tts::TtsInfo {
    tts.info()
}

/// Load the voice model ahead of time (about 5 s) so the first reply isn't delayed.
#[tauri::command]
async fn tts_warm(tts: tauri::State<'_, Arc<tts::Tts>>) -> Result<Option<u64>, String> {
    let tts = Arc::clone(&tts);
    blocking(move || tts.ensure()).await
}

#[tauri::command]
fn tts_new_id(tts: tauri::State<'_, Arc<tts::Tts>>) -> u64 {
    tts.new_id()
}

#[tauri::command]
fn tts_cancel(id: u64, tts: tauri::State<'_, Arc<tts::Tts>>) {
    tts.cancel(id);
}

/// Streams {seq, sr, pcm(base64 i16), text} chunks, then {done: true}, over `on_chunk`.
#[tauri::command]
async fn tts_speak(
    id: u64,
    text: String,
    voice: String,
    speed: f64,
    on_chunk: tauri::ipc::Channel<serde_json::Value>,
    tts: tauri::State<'_, Arc<tts::Tts>>,
) -> Result<(), String> {
    let tts = Arc::clone(&tts);
    blocking(move || tts.speak(id, &text, &voice, speed, |v| { let _ = on_chunk.send(v); })).await
}

/// Start the local language model if needed and return its local address and per-launch key.
#[tauri::command]
async fn llm_endpoint(llm: tauri::State<'_, Arc<llm::Llm>>, fast: Option<bool>) -> Result<llm::Endpoint, String> {
    let llm = Arc::clone(&llm);
    blocking(move || llm.ensure(fast.unwrap_or(false))).await
}

#[tauri::command]
fn llm_status(llm: tauri::State<'_, Arc<llm::Llm>>) -> serde_json::Value {
    serde_json::json!({ "available": llm.available(), "running": llm.running() })
}

#[tauri::command]
async fn apps_list() -> Vec<apps::AppInfo> {
    tauri::async_runtime::spawn_blocking(apps::list).await.unwrap_or_default()
}

/// Open an allowlisted app by id (never a path). Returns the app's display name.
#[tauri::command]
async fn app_open(id: String) -> Result<String, String> {
    blocking(move || apps::open(&id).map(String::from)).await
}

#[tauri::command]
async fn spotify_search(query: String) -> Result<(), String> {
    blocking(move || apps::spotify_search(&query)).await
}

#[tauri::command]
async fn volume_get() -> Result<apps::Volume, String> {
    blocking(apps::volume_get).await
}

#[tauri::command]
async fn volume_set(level: Option<u32>, muted: Option<bool>) -> Result<apps::Volume, String> {
    blocking(move || apps::volume_set(level, muted)).await
}

fn keys_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path().app_local_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
async fn online_status(app: tauri::AppHandle) -> Result<online::Status, String> {
    let dir = keys_dir(&app)?;
    blocking(move || Ok(online::status(&dir))).await
}

#[tauri::command]
async fn online_set(app: tauri::AppHandle, name: String, value: String) -> Result<(), String> {
    let dir = keys_dir(&app)?;
    blocking(move || online::set(&dir, &name, &value)).await
}

#[tauri::command]
async fn keyed_get(app: tauri::AppHandle, service: String, query: String) -> Result<online::Reply, String> {
    let dir = keys_dir(&app)?;
    blocking(move || online::keyed_get(&dir, &service, &query)).await
}

#[tauri::command]
async fn spotify_connect(app: tauri::AppHandle, verifier: String, challenge: String, state: String) -> Result<String, String> {
    let dir = keys_dir(&app)?;
    blocking(move || online::spotify_connect(&dir, &verifier, &challenge, &state, web::open)).await
}

#[tauri::command]
async fn spotify_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    let dir = keys_dir(&app)?;
    blocking(move || online::spotify_disconnect(&dir)).await
}

#[tauri::command]
async fn spotify_api(app: tauri::AppHandle, method: String, path: String, body: Option<String>) -> Result<online::Reply, String> {
    let dir = keys_dir(&app)?;
    blocking(move || online::spotify_api(&dir, &method, &path, body.as_deref())).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(Probe::new()))
        .manage(Arc::new(stt::Stt::default()))
        .manage(Arc::new(tts::Tts::default()))
        .manage(Arc::new(llm::Llm::default()))
        .setup(|app| {
            shell::build_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(shell::on_window_event)
        .invoke_handler(tauri::generate_handler![telemetry, wifi_status, shell::toggle_orb, shell::show_hud, shell::orb_is_open,
            media_status, media_control, fetch_feed, open_link, web_get, stt_engines, transcribe,
            tts_info, tts_warm, tts_new_id, tts_cancel, tts_speak, llm_endpoint, llm_status,
            apps_list, app_open, spotify_search, volume_get, volume_set,
            web_search, online_status, online_set, keyed_get, spotify_connect, spotify_disconnect, spotify_api
        ])
        .run(tauri::generate_context!())
        .expect("error while running JARVIS");
}
