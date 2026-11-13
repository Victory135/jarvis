// Bridge to the voice helper (sidecar/tts_server.py, Kokoro). Starts it once, sends one request at a time,
// and streams each synthesised chunk straight to the HUD over a Tauri channel. The helper exits on its own
// when this process ends (its stdin closes). Audio is never written to disk.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

struct Proc {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    voices: Vec<String>,
}

#[derive(Default)]
pub struct Tts {
    proc: Mutex<Option<Proc>>,
    next_id: AtomicU64,
    /// Requests with id <= this are cancelled: their remaining chunks are drained but not forwarded.
    cancelled_upto: AtomicU64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsInfo {
    pub available: bool,
    pub running: bool,
    pub voices: Vec<String>,
    pub reason: Option<String>,
}

fn paths() -> Option<(PathBuf, PathBuf, PathBuf)> {
    let models = crate::stt::models_dir()?;
    let root = models.parent()?.to_path_buf();
    let python = root.join("sidecar").join(".venv").join("Scripts").join("python.exe");
    let script = root.join("sidecar").join("tts_server.py");
    (python.exists() && script.exists() && models.join("kokoro").is_dir()).then_some((python, script, models))
}

impl Tts {
    pub fn info(&self) -> TtsInfo {
        let running = self.proc.lock().map(|p| p.is_some()).unwrap_or(false);
        let voices = self.proc.lock().ok().and_then(|p| p.as_ref().map(|p| p.voices.clone())).unwrap_or_default();
        match paths() {
            Some(_) => TtsInfo { available: true, running, voices, reason: None },
            None => TtsInfo { available: false, running, voices, reason: Some("voice helper or Kokoro model not found".into()) },
        }
    }

    /// Start the helper if needed and wait until its model is loaded. Returns the load time on a fresh start.
    pub fn ensure(&self) -> Result<Option<u64>, String> {
        let mut g = self.proc.lock().map_err(|_| "voice busy".to_string())?;
        if g.is_some() {
            return Ok(None);
        }
        let (python, script, models) = paths().ok_or("voice helper or Kokoro model not found")?;
        let mut cmd = Command::new(python);
        cmd.arg("-X").arg("utf8").arg(script)
            .env("JARVIS_MODELS", models)
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("could not start voice helper: {e}"))?;
        crate::procjob::tie_to_app(&child);
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let mut stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        let mut line = String::new();
        loop {
            line.clear();
            if stdout.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                return Err("voice helper exited while loading".into());
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some(f) = v.get("fatal") {
                return Err(format!("voice helper failed: {f}"));
            }
            if v.get("ready").is_some() {
                let voices = v["voices"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                let load = v["loadMs"].as_u64();
                *g = Some(Proc { _child: child, stdin, stdout, voices });
                return Ok(load);
            }
        }
    }

    pub fn new_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn cancel(&self, id: u64) {
        self.cancelled_upto.fetch_max(id, Ordering::SeqCst);
    }

    /// Synthesise `text`, calling `on_chunk` for each chunk message (forwarded as-is to the HUD).
    pub fn speak(&self, id: u64, text: &str, voice: &str, speed: f64, mut on_chunk: impl FnMut(Value)) -> Result<(), String> {
        self.ensure()?;
        let mut g = self.proc.lock().map_err(|_| "voice busy".to_string())?;
        let p = g.as_mut().ok_or("voice helper not running")?;
        let req = json!({ "id": id, "text": text, "voice": voice, "speed": speed });
        let sent = writeln!(p.stdin, "{req}").and_then(|_| p.stdin.flush());
        if let Err(e) = sent {
            *g = None; // helper died; next call restarts it
            return Err(format!("voice helper not responding: {e}"));
        }
        let mut line = String::new();
        loop {
            line.clear();
            match p.stdout.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    *g = None;
                    return Err("voice helper stopped".into());
                }
                Ok(_) => {}
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(e) = v.get("error") {
                return Err(format!("voice: {}", e.as_str().unwrap_or("error")));
            }
            let done = v.get("done").is_some();
            if self.cancelled_upto.load(Ordering::SeqCst) < id {
                on_chunk(v);
            }
            if done {
                return Ok(());
            }
        }
    }
}
