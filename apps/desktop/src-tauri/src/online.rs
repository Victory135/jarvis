// Online services the owner connects himself: YouTube Data API, a news API, and Spotify (Authorization Code + PKCE).
// Keys and the Spotify refresh token are kept in one file encrypted with Windows DPAPI (readable only by this
// Windows account on this PC). They are never returned to the interface, never logged, and each is sent only to the
// service it belongs to.
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const REDIRECT: &str = "http://127.0.0.1:43821/callback";
const SCOPES: &str = "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private user-library-read";
/// Names the interface may set. The Spotify refresh token is written only by the connect flow.
const SETTABLE: &[&str] = &["youtube_key", "news_key", "news_provider", "spotify_client_id"];
/// service -> (base address, name of the key parameter, secret holding the key)
const KEYED: &[(&str, &str, &str, &str)] = &[
    ("youtube", "https://www.googleapis.com/youtube/v3/", "key", "youtube_key"),
    ("newsapi", "https://newsapi.org/v2/", "apiKey", "news_key"),
    ("gnews", "https://gnews.io/api/v4/", "apikey", "news_key"),
    ("newsdata", "https://newsdata.io/api/1/", "apikey", "news_key"),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub youtube_key: bool,
    pub news_key: bool,
    pub news_provider: Option<String>,
    pub spotify_client_id: bool,
    pub spotify_connected: bool,
    pub spotify_account: Option<String>,
}

#[derive(Serialize)]
pub struct Reply {
    pub status: u16,
    pub body: String,
}

static ACCESS: Mutex<Option<(String, Instant)>> = Mutex::new(None);
static CONNECTING: Mutex<bool> = Mutex::new(false);
/// Held across every read-change-write of the store, so two changes at once cannot drop each other's keys.
static STORE: Mutex<()> = Mutex::new(());
fn store() -> std::sync::MutexGuard<'static, ()> { STORE.lock().unwrap_or_else(|e| e.into_inner()) }

pub fn enc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') { o.push(b as char) } else { o.push_str(&format!("%{b:02X}")) }
    }
    o
}

pub fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && s.is_char_boundary(i + 1) && s.is_char_boundary(i + 3) {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) { out.push(v); i += 3; continue }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::io::{Read, Write};
    use windows::core::HSTRING;
    use windows::Foundation::Uri;
    use windows::Storage::Streams::UnicodeEncoding;
    use windows::Web::Http::{HttpClient, HttpMethod, HttpRequestMessage, HttpStringContent};
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    fn dpapi(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            if protect { CryptProtectData(&input, None, None, None, None, 0, &mut out) } else { CryptUnprotectData(&input, None, None, None, None, 0, &mut out) }
                .map_err(|_| "Windows could not unlock the key store".to_string())?;
            let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
            Ok(v)
        }
    }

    pub fn load(dir: &PathBuf) -> BTreeMap<String, String> {
        let Ok(raw) = std::fs::read(dir.join("keys.bin")) else { return BTreeMap::new() };
        dpapi(&raw, false).ok().and_then(|p| serde_json::from_slice(&p).ok()).unwrap_or_default()
    }

    pub fn save(dir: &PathBuf, m: &BTreeMap<String, String>) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let plain = serde_json::to_vec(m).map_err(|e| e.to_string())?;
        let (file, tmp) = (dir.join("keys.bin"), dir.join("keys.tmp"));
        // A store that exists but cannot be read is set aside, never silently replaced by an empty one.
        if let Ok(old) = std::fs::read(&file) {
            if dpapi(&old, false).is_err() { let _ = std::fs::copy(&file, dir.join("keys.unreadable")); }
        }
        // Written whole to a second file and then swapped in, so a crash or a reader mid-write never sees half a store.
        std::fs::write(&tmp, dpapi(&plain, true)?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
    }

    /// One request. `auth`: bearer token. `body`: (content, media type).
    pub fn http(method: &str, url: &str, auth: Option<&str>, body: Option<(&str, &str)>) -> Result<Reply, String> {
        http_t(method, url, auth, body, 15)
    }
    pub fn http_t(method: &str, url: &str, auth: Option<&str>, body: Option<(&str, &str)>, secs: u64) -> Result<Reply, String> {
        let client = HttpClient::new().map_err(|e| e.message().to_string())?;
        let uri = Uri::CreateUri(&HSTRING::from(url)).map_err(|_| "not a valid address".to_string())?;
        let m = match method { "GET" => HttpMethod::Get(), "POST" => HttpMethod::Post(), "PUT" => HttpMethod::Put(), "DELETE" => HttpMethod::Delete(), _ => return Err("method not allowed".into()) }
            .map_err(|e| e.message().to_string())?;
        let req = HttpRequestMessage::Create(&m, &uri).map_err(|e| e.message().to_string())?;
        if let Ok(h) = req.Headers() {
            let _ = h.TryAppendWithoutValidation(&HSTRING::from("User-Agent"), &HSTRING::from("JARVIS-HUD/0.1 (personal assistant)"));
        }
        if let Some(t) = auth {
            let h = req.Headers().map_err(|e| e.message().to_string())?;
            let _ = h.TryAppendWithoutValidation(&HSTRING::from("Authorization"), &HSTRING::from(format!("Bearer {t}")));
        }
        if method != "GET" {
            let (text, kind) = body.unwrap_or(("", "application/json"));
            let c = HttpStringContent::CreateFromStringWithEncodingAndMediaType(&HSTRING::from(text), UnicodeEncoding::Utf8, &HSTRING::from(kind))
                .map_err(|e| e.message().to_string())?;
            let _ = req.SetContent(&c);
        }
        let op = client.SendRequestAsync(&req).map_err(|e| e.message().to_string())?;
        let (tx, rx) = std::sync::mpsc::channel();
        let waiter = op.clone();
        std::thread::spawn(move || {
            let r = waiter.join().and_then(|resp| {
                let status = resp.StatusCode()?.0 as u16;
                let body = resp.Content().and_then(|c| c.ReadAsStringAsync()).and_then(|o| o.join()).map(|h| h.to_string()).unwrap_or_default();
                Ok(Reply { status, body })
            });
            let _ = tx.send(r);
        });
        match rx.recv_timeout(Duration::from_secs(secs)) {
            Ok(r) => r.map_err(|e| format!("no connection ({})", e.message())),
            Err(_) => { let _ = op.Cancel(); Err(format!("no answer within {secs} s")) }
        }
    }

    /// Wait for Spotify to send the browser back to this PC. Returns the query string of the callback.
    pub fn wait_callback(state: &str) -> Result<String, String> {
        let l = std::net::TcpListener::bind("127.0.0.1:43821").map_err(|_| "port 43821 on this PC is in use".to_string())?;
        l.set_nonblocking(true).map_err(|e| e.to_string())?;
        let until = Instant::now() + Duration::from_secs(180);
        loop {
            if Instant::now() > until { return Err("nobody approved the connection within three minutes".into()) }
            let Ok((mut s, _)) = l.accept() else { std::thread::sleep(Duration::from_millis(150)); continue };
            let _ = s.set_nonblocking(false);
            let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).into_owned();
            let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
            let page = |s: &mut std::net::TcpStream, msg: &str| {
                let html = format!("<!doctype html><meta charset=utf-8><title>J.A.R.V.I.S.</title><body style=\"background:#030913;color:#9fe8ff;font:20px sans-serif;text-align:center;padding-top:20vh\">{msg}</body>");
                let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len()).as_bytes());
            };
            let Some(q) = path.strip_prefix("/callback?") else { page(&mut s, "Nothing here."); continue };
            let get = |k: &str| q.split('&').find_map(|p| p.strip_prefix(&format!("{k}="))).map(dec);
            if get("state").as_deref() != Some(state) { page(&mut s, "That reply did not match my request, so I ignored it."); continue }
            if let Some(e) = get("error") { page(&mut s, "Connection declined. You can close this tab."); return Err(format!("Spotify said: {e}")) }
            page(&mut s, "Spotify is connected, sir. You can close this tab.");
            return get("code").ok_or_else(|| "Spotify sent no code".to_string());
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn load(_: &PathBuf) -> BTreeMap<String, String> { BTreeMap::new() }
    pub fn save(_: &PathBuf, _: &BTreeMap<String, String>) -> Result<(), String> { Err("Windows-only".into()) }
    pub fn http(_: &str, _: &str, _: Option<&str>, _: Option<(&str, &str)>) -> Result<Reply, String> { Err("Windows-only".into()) }
    pub fn http_t(_: &str, _: &str, _: Option<&str>, _: Option<(&str, &str)>, _: u64) -> Result<Reply, String> { Err("Windows-only".into()) }
    pub fn wait_callback(_: &str) -> Result<String, String> { Err("Windows-only".into()) }
}

/// Plain request with no credentials (web search and page reading).
pub fn fetch(method: &str, url: &str, body: Option<(&str, &str)>, secs: u64) -> Result<Reply, String> {
    imp::http_t(method, url, None, body, secs)
}

pub fn status(dir: &PathBuf) -> Status {
    let m = imp::load(dir);
    let has = |k: &str| m.get(k).map(|v| !v.is_empty()).unwrap_or(false);
    Status {
        youtube_key: has("youtube_key"),
        news_key: has("news_key"),
        news_provider: m.get("news_provider").cloned(),
        spotify_client_id: has("spotify_client_id"),
        spotify_connected: has("spotify_refresh"),
        spotify_account: m.get("spotify_account").cloned(),
    }
}

pub fn set(dir: &PathBuf, name: &str, value: &str) -> Result<(), String> {
    if !SETTABLE.contains(&name) { return Err("that setting cannot be changed from here".into()) }
    let v = value.trim();
    if v.len() > 300 || v.chars().any(|c| c.is_control()) { return Err("that does not look like a key".into()) }
    let _g = store();
    let mut m = imp::load(dir);
    // Saving the same value again changes nothing; only a different Client ID ends the Spotify sign-in.
    if m.get(name).map(String::as_str).unwrap_or("") == v { return Ok(()) }
    if v.is_empty() { m.remove(name); } else { m.insert(name.into(), v.into()); }
    if name == "spotify_client_id" { forget_spotify(&mut m) }
    imp::save(dir, &m)
}

fn forget_spotify(m: &mut BTreeMap<String, String>) {
    m.remove("spotify_refresh");
    m.remove("spotify_account");
    if let Ok(mut a) = ACCESS.lock() { *a = None }
}

/// GET against one of the keyed services; the key is added here and never seen by the interface.
pub fn keyed_get(dir: &PathBuf, service: &str, query: &str) -> Result<Reply, String> {
    let (_, base, param, secret) = KEYED.iter().find(|k| k.0 == service).ok_or("unknown service")?;
    if query.contains("://") || query.starts_with('/') || query.contains("..") || query.chars().any(|c| c.is_whitespace()) { return Err("bad request".into()) }
    let key = imp::load(dir).get(*secret).cloned().filter(|k| !k.is_empty()).ok_or("no key is set")?;
    let sep = if query.contains('?') { '&' } else { '?' };
    imp::http("GET", &format!("{base}{query}{sep}{param}={}", enc(&key)), None, None)
}

fn token_request(dir: &PathBuf, form: String) -> Result<String, String> {
    let r = imp::http("POST", "https://accounts.spotify.com/api/token", None, Some((&form, "application/x-www-form-urlencoded")))?;
    let v: serde_json::Value = serde_json::from_str(&r.body).unwrap_or_default();
    if r.status != 200 {
        let why = v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("no reason given");
        if v["error"] == "invalid_grant" {
            let _g = store();
            let mut m = imp::load(dir);
            forget_spotify(&mut m);
            let _ = imp::save(dir, &m);
            return Err("Spotify no longer accepts my sign-in; please connect again in Settings".into());
        }
        return Err(format!("Spotify refused the sign-in ({}: {why})", r.status));
    }
    let access = v["access_token"].as_str().ok_or("Spotify sent no token")?.to_string();
    let secs = v["expires_in"].as_u64().unwrap_or(3600).saturating_sub(60);
    if let Some(refresh) = v["refresh_token"].as_str() {
        let _g = store();
        let mut m = imp::load(dir);
        m.insert("spotify_refresh".into(), refresh.into());
        imp::save(dir, &m)?;
    }
    if let Ok(mut a) = ACCESS.lock() { *a = Some((access.clone(), Instant::now() + Duration::from_secs(secs))) }
    Ok(access)
}

fn access(dir: &PathBuf, force: bool) -> Result<String, String> {
    if !force {
        if let Ok(a) = ACCESS.lock() {
            if let Some((t, until)) = a.as_ref() { if Instant::now() < *until { return Ok(t.clone()) } }
        }
    }
    let m = imp::load(dir);
    let (Some(id), Some(refresh)) = (m.get("spotify_client_id"), m.get("spotify_refresh")) else { return Err("Spotify is not connected".into()) };
    token_request(dir, format!("grant_type=refresh_token&refresh_token={}&client_id={}", enc(refresh), enc(id)))
}

/// Opens Spotify's consent page (via `open`), waits for the browser to come back, and stores the refresh token.
pub fn spotify_connect(dir: &PathBuf, verifier: &str, challenge: &str, state: &str, open: impl Fn(&str) -> Result<(), String>) -> Result<String, String> {
    let ok = |s: &str, min: usize| s.len() >= min && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'));
    if !ok(verifier, 43) || !ok(challenge, 43) || !ok(state, 16) { return Err("bad sign-in request".into()) }
    let id = imp::load(dir).get("spotify_client_id").cloned().ok_or("add the Spotify Client ID first")?;
    {
        let mut c = CONNECTING.lock().map_err(|_| "busy".to_string())?;
        if *c { return Err("a connection attempt is already waiting in the browser".into()) }
        *c = true;
    }
    let result = (|| {
        open(&format!(
            "https://accounts.spotify.com/authorize?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge_method=S256&code_challenge={}&state={}&show_dialog=true",
            enc(&id), enc(REDIRECT), enc(SCOPES), challenge, state
        ))?;
        let code = imp::wait_callback(state)?;
        let token = token_request(dir, format!(
            "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}&code_verifier={}",
            enc(&code), enc(REDIRECT), enc(&id), verifier
        ))?;
        if !imp::load(dir).contains_key("spotify_refresh") { return Err("Spotify sent no long-term token".into()) }
        let me = imp::http("GET", "https://api.spotify.com/v1/me", Some(&token), None)?;
        let v: serde_json::Value = serde_json::from_str(&me.body).unwrap_or_default();
        let name = v["display_name"].as_str().or(v["id"].as_str()).unwrap_or("your account").to_string();
        let _g = store();
        let mut m = imp::load(dir);
        m.insert("spotify_account".into(), name.clone());
        imp::save(dir, &m)?;
        Ok(name)
    })();
    if let Ok(mut c) = CONNECTING.lock() { *c = false }
    result
}

pub fn spotify_disconnect(dir: &PathBuf) -> Result<(), String> {
    let _g = store();
    let mut m = imp::load(dir);
    forget_spotify(&mut m);
    imp::save(dir, &m)
}

/// A Spotify Web API call. Refreshes the token when it has expired (401) and tries once more.
pub fn spotify_api(dir: &PathBuf, method: &str, path: &str, body: Option<&str>) -> Result<Reply, String> {
    if !path.starts_with("/v1/") || path.contains("..") || path.contains("://") || path.chars().any(|c| c.is_whitespace()) { return Err("bad request".into()) }
    let url = format!("https://api.spotify.com{path}");
    let b = body.map(|t| (t, "application/json"));
    let r = imp::http(method, &url, Some(&access(dir, false)?), b)?;
    if r.status != 401 { return Ok(r) }
    imp::http(method, &url, Some(&access(dir, true)?), b)
}
