// Wi-Fi state from the built-in `netsh wlan show interfaces` (read-only, no admin needed).
// Returns None when there is no wireless adapter or the command fails.
use serde::Serialize;
use std::process::Command;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WifiStatus {
    pub adapter: Option<String>,
    pub state: Option<String>,
    pub ssid: Option<String>,
    pub signal_pct: Option<u8>,
    pub radio: Option<String>,
    pub rx_mbps: Option<f32>,
    pub tx_mbps: Option<f32>,
}

#[cfg(windows)]
pub fn read() -> Option<WifiStatus> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("netsh")
        .args(["wlan", "show", "interfaces"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(windows))]
pub fn read() -> Option<WifiStatus> {
    None
}

/// Parses the first interface block. Keys are matched in English; other display languages yield None fields.
fn parse(text: &str) -> Option<WifiStatus> {
    let mut w = WifiStatus::default();
    let mut seen = false;
    for line in text.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_string());
        match k.as_str() {
            "name" if seen => break, // second adapter: stop at the first one
            "name" => seen = true,
            "description" => w.adapter = Some(v),
            "state" => w.state = Some(v),
            "ssid" => w.ssid = Some(v).filter(|s| !s.is_empty()),
            "signal" => w.signal_pct = v.trim_end_matches('%').trim().parse().ok(),
            "radio type" => w.radio = Some(v),
            "receive rate (mbps)" => w.rx_mbps = v.parse().ok(),
            "transmit rate (mbps)" => w.tx_mbps = v.parse().ok(),
            _ => {}
        }
    }
    seen.then_some(w)
}
