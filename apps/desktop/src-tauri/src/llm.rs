// Local language model: runs llama.cpp's server (models/llama, MIT) with the GGUF model in models/llm, bound to
// 127.0.0.1 on a free port with a random API key created at each launch. The HUD talks to it directly over HTTP
// (OpenAI-style streaming). Nothing leaves the PC. The server is tied to this process with a Windows job object,
// so it is killed even if JARVIS crashes.
use serde::Serialize;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub url: String,
    pub key: String,
    pub model: String,
    /// Set when this call started the server.
    pub load_ms: Option<u64>,
}

#[derive(Default)]
pub struct Llm {
    state: Mutex<Option<(Child, Endpoint)>>,
    /// The small, quick model for everyday talk (only when a second, smaller GGUF is present).
    fast: Mutex<Option<(Child, Endpoint)>>,
}

/// The server and a model file: the largest GGUF in models/llm for thinking, the smallest for quick replies.
fn files(fast: bool) -> Option<(PathBuf, PathBuf)> {
    let models = crate::stt::models_dir()?;
    let server = models.join("llama").join("llama-server.exe");
    let model = std::fs::read_dir(models.join("llm")).ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "gguf").unwrap_or(false))
        .map(|p| (std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0), p));
    let model = if fast { model.min_by_key(|x| x.0) } else { model.max_by_key(|x| x.0) }?.1;
    server.exists().then_some((server, model))
}

/// 128 random bits from the OS-seeded hasher keys, as hex.
fn random_key() -> String {
    (0..2).map(|_| {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(Instant::now().elapsed().as_nanos());
        format!("{:016x}", h.finish())
    }).collect()
}

fn healthy(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(300)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
    if s.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let n = s.read(&mut buf).unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).contains(" 200 ")
}

impl Llm {
    pub fn available(&self) -> bool {
        files(false).is_some()
    }

    pub fn running(&self) -> bool {
        self.state.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Start the server if needed and wait until the model is loaded (up to 3 minutes).
    pub fn ensure(&self, fast: bool) -> Result<Endpoint, String> {
        // With a single model file there is no separate quick model: both roles share one server.
        let two = files(true).map(|f| f.1) != files(false).map(|f| f.1);
        let fast = fast && two;
        let optional = two && !fast; // the large thinking model, when a quick one exists beside it
        let mut g = if fast { &self.fast } else { &self.state }.lock().map_err(|_| "model busy".to_string())?;
        if let Some((child, ep)) = g.as_mut() {
            if child.try_wait().ok().flatten().is_none() {
                return Ok(Endpoint { load_ms: None, ..ep.clone() });
            }
            *g = None; // it exited; start again
        }
        let (server, model) = files(fast).ok_or("language model files not found in models/")?;
        // The thinking model is only loaded when it fits in free memory. Squeezed in, it pushes everything else
        // (speech recognition above all) out to the disk and the whole PC crawls.
        if optional {
            let need = std::fs::metadata(&model).map(|m| m.len()).unwrap_or(0) * 2 + (3u64 << 30); // loaded it takes about twice its file size; plus room for what else is open
            let ram = sysinfo::MemoryRefreshKind::nothing().with_ram();
            let mut sys = sysinfo::System::new_with_specifics(sysinfo::RefreshKind::nothing().with_memory(ram)).map_err(|e| format!("could not read memory: {e}"))?;
            sys.refresh_memory_specifics(ram);
            let free = sys.total_memory().saturating_sub(sys.used_memory());
            if free < need {
                return Err(format!("not enough free memory ({:.1} GB free, {:.1} GB needed)", free as f64 / 1e9, need as f64 / 1e9));
            }
        }
        let port = TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).map_err(|e| e.to_string())?;
        let key = random_key();
        // The model and the voice never run at the same time (both are limited by memory bandwidth on this laptop),
        // so each can use the whole CPU.
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 4);
        let mut cmd = Command::new(&server);
        cmd.current_dir(server.parent().unwrap())
            .args(["--host", "127.0.0.1", "--port", &port.to_string(), "--api-key", &key])
            .arg("-m").arg(&model)
            .args(["-c", "4096", "-np", "1", "-t", &threads.to_string(), "--jinja", "--no-webui"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS: hearing the owner always gets the processor first.
            cmd.creation_flags(0x0800_0000 | 0x0000_4000);
        }
        let t = Instant::now();
        let mut child = cmd.spawn().map_err(|e| format!("could not start the language model: {e}"))?;
        crate::procjob::tie_to_app(&child);
        while !healthy(port) {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("language model server exited ({status})"));
            }
            if t.elapsed() > Duration::from_secs(180) {
                let _ = child.kill();
                return Err("language model took too long to load".into());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let name = model.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ep = Endpoint { url: format!("http://127.0.0.1:{port}"), key, model: name, load_ms: None };
        *g = Some((child, ep.clone()));
        Ok(Endpoint { load_ms: Some(t.elapsed().as_millis() as u64), ..ep })
    }
}
