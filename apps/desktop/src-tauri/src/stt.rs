// Local speech-to-text with a provider switch (blueprint 05): Vosk or Whisper, both on this PC.
// Audio arrives as 16 kHz mono PCM (i16, little endian) from the HUD, is decoded in memory and dropped.
// Nothing is written to disk. Models load on first use and stay loaded.
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

pub const SAMPLE_RATE: u32 = 16_000;
/// Hard cap on one utterance (blueprint: no unbounded audio buffers).
pub const MAX_SECONDS: usize = 15;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub text: String,
    pub engine: &'static str,
    pub audio_ms: u64,
    /// Time to load the model, if this call loaded it (first use).
    pub load_ms: Option<u64>,
    pub decode_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub id: &'static str,
    pub model: String,
    pub available: bool,
    pub loaded: bool,
}

#[derive(Default)]
pub struct Stt {
    vosk: Mutex<Option<vosk::Model>>,
    whisper: Mutex<Option<whisper_rs::WhisperContext>>,
}

const VOSK_MODEL: &str = "vosk-model/vosk-model-small-en-in-0.4";
const WHISPER_MODEL: &str = "whisper/ggml-base.en.bin";

/// The `models` folder: next to the exe (installed build) or in an ancestor folder (development).
pub fn models_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().skip(1).map(|d| d.join("models")).find(|m| m.is_dir())
}

fn model_path(rel: &str) -> Option<PathBuf> {
    models_dir().map(|m| m.join(rel)).filter(|p| p.exists())
}

impl Stt {
    pub fn engines(&self) -> Vec<EngineInfo> {
        vec![
            EngineInfo {
                id: "vosk",
                model: "Vosk small English (India) 0.4".into(),
                available: model_path(VOSK_MODEL).is_some(),
                loaded: self.vosk.lock().map(|g| g.is_some()).unwrap_or(false),
            },
            EngineInfo {
                id: "whisper",
                model: "Whisper base.en (whisper.cpp)".into(),
                available: model_path(WHISPER_MODEL).is_some(),
                loaded: self.whisper.lock().map(|g| g.is_some()).unwrap_or(false),
            },
        ]
    }

    pub fn transcribe(&self, engine: &str, pcm: &[i16], threads: Option<i32>) -> Result<Transcript, String> {
        if pcm.len() > SAMPLE_RATE as usize * MAX_SECONDS {
            return Err(format!("utterance longer than {MAX_SECONDS} s"));
        }
        let audio_ms = pcm.len() as u64 * 1000 / SAMPLE_RATE as u64;
        match engine {
            "vosk" => self.vosk(pcm, audio_ms),
            "whisper" => self.whisper(pcm, audio_ms, threads),
            _ => Err("unknown speech engine".into()),
        }
    }

    fn vosk(&self, pcm: &[i16], audio_ms: u64) -> Result<Transcript, String> {
        let mut guard = self.vosk.lock().map_err(|_| "speech engine busy".to_string())?;
        let mut load_ms = None;
        if guard.is_none() {
            let p = model_path(VOSK_MODEL).ok_or("Vosk model not found in models/")?;
            let t = Instant::now();
            vosk::set_log_level(vosk::LogLevel::Error);
            *guard = Some(vosk::Model::new(path_str(&p)?).ok_or("Vosk could not load its model")?);
            load_ms = Some(t.elapsed().as_millis() as u64);
        }
        let model = guard.as_ref().unwrap();
        let t = Instant::now();
        let mut rec = vosk::Recognizer::new(model, SAMPLE_RATE as f32).ok_or("Vosk recogniser failed")?;
        rec.set_words(false);
        // Feed in 0.25 s frames (blueprint: small audio frames).
        for chunk in pcm.chunks(SAMPLE_RATE as usize / 4) {
            rec.accept_waveform(chunk).map_err(|e| format!("Vosk: {e:?}"))?;
        }
        let text = rec.final_result().single().map(|r| r.text.to_string()).unwrap_or_default();
        Ok(Transcript { text: tidy(&text), engine: "vosk", audio_ms, load_ms, decode_ms: t.elapsed().as_millis() as u64 })
    }

    fn whisper(&self, pcm: &[i16], audio_ms: u64, threads: Option<i32>) -> Result<Transcript, String> {
        use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
        let mut guard = self.whisper.lock().map_err(|_| "speech engine busy".to_string())?;
        let mut load_ms = None;
        if guard.is_none() {
            let p = model_path(WHISPER_MODEL).ok_or("Whisper model not found in models/")?;
            let t = Instant::now();
            let ctx = WhisperContext::new_with_params(path_str(&p)?, WhisperContextParameters::default())
                .map_err(|e| format!("Whisper could not load its model: {e}"))?;
            *guard = Some(ctx);
            load_ms = Some(t.elapsed().as_millis() as u64);
        }
        let ctx = guard.as_ref().unwrap();
        let t = Instant::now();
        let mut state = ctx.create_state().map_err(|e| e.to_string())?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        // Measured on this PC (2 cores, 4 logical): 4 threads is fastest, then 3, 2, 1.
        let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let threads = threads.unwrap_or(logical.clamp(1, 4) as i32).clamp(1, 8);
        params.set_n_threads(threads);
        // No second and third attempts at higher "temperature" when unsure: on noise they triple the time.
        params.set_temperature_inc(0.0);
        params.set_language(Some("en"));
        // Bias recognition towards the assistant's name (otherwise often heard as "Jerry's" or "Travis").
        params.set_initial_prompt("Jarvis.");
        params.set_no_context(true);
        params.set_single_segment(true);
        params.set_no_timestamps(true);
        params.set_suppress_blank(true);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        // whisper.cpp needs at least ~1 s of audio; pad short clips with silence.
        let mut audio: Vec<f32> = pcm.iter().map(|&s| s as f32 / 32768.0).collect();
        if audio.len() < SAMPLE_RATE as usize + SAMPLE_RATE as usize / 10 {
            audio.resize(SAMPLE_RATE as usize + SAMPLE_RATE as usize / 10, 0.0);
        }
        // Whisper's encoder normally runs over a fixed 30 s window (1500 frames of 20 ms). For short commands,
        // shrink it to the clip length plus a margin: same result for short speech, several times faster.
        let secs = audio.len() as f64 / SAMPLE_RATE as f64;
        let frames = (secs * 50.0).ceil() as i32;
        let ctx_min: i32 = std::env::var("JARVIS_WHISPER_CTX_MIN").ok().and_then(|v| v.parse().ok()).unwrap_or(0); // tuning knob
        params.set_audio_ctx((frames + 128).max(ctx_min).min(1500));
        // Speech is at most ~4 words/s (~6 tokens/s). A hard cap stops the model looping on silence.
        params.set_max_tokens((secs * 6.0).ceil() as i32 + 8);
        state.full(params, &audio).map_err(|e| format!("Whisper: {e}"))?;
        let mut text = String::new();
        for i in 0..state.full_n_segments() {
            if let Some(seg) = state.get_segment(i) {
                if let Ok(s) = seg.to_str_lossy() {
                    text.push_str(&s);
                }
            }
        }
        Ok(Transcript { text: collapse_repeats(&tidy(&text)), engine: "whisper", audio_ms, load_ms, decode_ms: t.elapsed().as_millis() as u64 })
    }
}

fn path_str(p: &Path) -> Result<String, String> {
    p.to_str().map(str::to_string).ok_or_else(|| "model path is not valid text".into())
}

/// Whisper marks non-speech as [BLANK_AUDIO], (music) etc.; treat those as nothing heard.
fn tidy(s: &str) -> String {
    let t = s.trim();
    let only_marker = (t.starts_with('[') && t.ends_with(']')) || (t.starts_with('(') && t.ends_with(')'));
    if only_marker { String::new() } else { t.split_whitespace().collect::<Vec<_>>().join(" ") }
}

/// Last guard against a known Whisper failure: the same phrase emitted again and again ("a b c a b c a b").
/// If the words are one short phrase repeated (the last copy may be cut off), keep a single copy.
fn collapse_repeats(s: &str) -> String {
    let words: Vec<&str> = s.split_whitespace().collect();
    let norm: Vec<String> = words.iter().map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()).collect();
    for len in 1..=words.len() / 2 {
        if (len..norm.len()).all(|i| norm[i] == norm[i % len]) {
            return words[..len].join(" ").trim_end_matches(|c: char| c == ',').to_string();
        }
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::collapse_repeats as c;
    #[test]
    fn repeats() {
        assert_eq!(c("mute the microphone mute the microphone mute"), "mute the microphone");
        assert_eq!(c("What is it? What is it? What is it?"), "What is it?");
        assert_eq!(c("what time is it"), "what time is it");
        assert_eq!(c("play play"), "play");
        assert_eq!(c("go to the shop and go to the bank"), "go to the shop and go to the bank");
    }
}

/// Raw IPC body: little-endian i16 samples.
pub fn decode_pcm(bytes: &[u8]) -> Result<Vec<i16>, String> {
    if bytes.len() % 2 != 0 {
        return Err("audio data is not 16-bit".into());
    }
    Ok(bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect())
}
