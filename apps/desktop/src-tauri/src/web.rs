// News feeds the user chose, fetched with Windows' built-in HTTP client and parsed with its XML parser
// (DTDs prohibited, no external entities). Only https feeds; only http(s) links are opened.
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub title: String,
    pub link: Option<String>,
    /// As written in the feed (RFC 822 or ISO 8601); parsed by the UI.
    pub published: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    pub title: Option<String>,
    pub items: Vec<FeedItem>,
}

const MAX_ITEMS: usize = 30;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const TIMEOUT_S: u64 = 15;
/// Services the assistant may query for spoken answers.
const LOOKUP_HOSTS: &[&str] = &["api.met.no", "nominatim.openstreetmap.org", "en.wikipedia.org"];

fn is_web_link(u: &str) -> bool {
    let l = u.trim().to_ascii_lowercase();
    l.starts_with("https://") || l.starts_with("http://")
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use windows::core::{Interface, HSTRING};
    use windows::Data::Xml::Dom::{IXmlNode, XmlDocument, XmlElement, XmlLoadSettings};
    use windows::Foundation::Uri;
    use windows::Web::Http::HttpClient;

    fn local(n: &IXmlNode) -> String {
        let name = n.NodeName().map(|h| h.to_string()).unwrap_or_default();
        name.rsplit(':').next().unwrap_or("").to_ascii_lowercase()
    }

    fn child<'a>(n: &IXmlNode, names: &[&str]) -> Option<IXmlNode> {
        let kids = n.ChildNodes().ok()?;
        (0..kids.Length().unwrap_or(0)).filter_map(|i| kids.Item(i).ok()).find(|k| names.contains(&local(k).as_str()))
    }

    fn text(n: &IXmlNode) -> Option<String> {
        let t = n.InnerText().ok()?.to_string();
        let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
        (!t.is_empty()).then_some(t)
    }

    /// RSS: <link>url</link>. Atom: <link href="url" rel="alternate"/> (first alternate or first link).
    fn link(item: &IXmlNode) -> Option<String> {
        let kids = item.ChildNodes().ok()?;
        let mut first: Option<String> = None;
        for k in (0..kids.Length().unwrap_or(0)).filter_map(|i| kids.Item(i).ok()) {
            if local(&k) != "link" { continue }
            if let Ok(el) = k.cast::<XmlElement>() {
                let href = el.GetAttribute(&HSTRING::from("href")).map(|h| h.to_string()).unwrap_or_default();
                let rel = el.GetAttribute(&HSTRING::from("rel")).map(|h| h.to_string()).unwrap_or_default();
                let v = if href.is_empty() { text(&k).unwrap_or_default() } else { href };
                if !is_web_link(&v) { continue }
                if rel.is_empty() || rel == "alternate" { return Some(v) }
                first.get_or_insert(v);
            }
        }
        first
    }

    fn download(url: &str) -> Result<String, String> {
        let client = HttpClient::new().map_err(|e| e.to_string())?;
        if let Ok(h) = client.DefaultRequestHeaders() {
            if let Ok(ua) = h.UserAgent() {
                let _ = ua.TryParseAdd(&HSTRING::from("JARVIS-HUD/0.1 (personal desktop assistant)"));
            }
        }
        let uri = Uri::CreateUri(&HSTRING::from(url)).map_err(|_| "not a valid address".to_string())?;
        let op = client.GetStringAsync(&uri).map_err(|e| e.to_string())?;
        let (tx, rx) = mpsc::channel();
        let waiter = op.clone();
        std::thread::spawn(move || { let _ = tx.send(waiter.join().map(|h| h.to_string())); });
        match rx.recv_timeout(Duration::from_secs(TIMEOUT_S)) {
            Ok(r) => r.map_err(|e| format!("download failed: {}", e.message())),
            Err(_) => { let _ = op.Cancel(); Err(format!("no answer within {TIMEOUT_S} s")) }
        }
    }

    pub fn fetch(url: &str) -> Result<Feed, String> {
        if !url.trim().to_ascii_lowercase().starts_with("https://") {
            return Err("only https:// feeds are allowed".into());
        }
        let body = download(url.trim())?;
        if body.len() > MAX_BYTES {
            return Err("feed is larger than 4 MB".into());
        }
        let settings = XmlLoadSettings::new().map_err(|e| e.to_string())?;
        let _ = settings.SetProhibitDtd(true);
        let _ = settings.SetResolveExternals(false);
        let doc = XmlDocument::new().map_err(|e| e.to_string())?;
        doc.LoadXmlWithSettings(&HSTRING::from(body.trim_start_matches('\u{feff}')), &settings)
            .map_err(|_| "not an RSS or Atom feed".to_string())?;
        let root: IXmlNode = doc.DocumentElement().map_err(|_| "empty feed".to_string())?.cast().map_err(|e| e.to_string())?;
        // RSS: <rss><channel><title/><item/>...  Atom: <feed><title/><entry/>...  RSS 1.0: <rdf:RDF><channel/><item/>
        let channel = child(&root, &["channel"]);
        let title = channel.as_ref().and_then(|c| child(c, &["title"])).or_else(|| child(&root, &["title"])).and_then(|t| text(&t));
        let mut items = Vec::new();
        for tag in ["item", "entry"] {
            let Ok(list) = doc.GetElementsByTagName(&HSTRING::from(tag)) else { continue };
            for i in 0..list.Length().unwrap_or(0) {
                if items.len() >= MAX_ITEMS { break }
                let Ok(n) = list.Item(i) else { continue };
                let Some(t) = child(&n, &["title"]).and_then(|t| text(&t)) else { continue };
                items.push(FeedItem {
                    title: t,
                    link: link(&n),
                    published: child(&n, &["pubdate", "published", "updated", "date"]).and_then(|d| text(&d)),
                });
            }
            if !items.is_empty() { break }
        }
        if items.is_empty() && title.is_none() {
            return Err("not an RSS or Atom feed".into());
        }
        Ok(Feed { title, items })
    }

    /// Plain GET for the assistant's look-ups (weather, place search, encyclopaedia). Fixed list of hosts, https only.
    pub fn get(url: &str) -> Result<String, String> {
        let uri = Uri::CreateUri(&HSTRING::from(url.trim())).map_err(|_| "not a valid address".to_string())?;
        let scheme = uri.SchemeName().map(|h| h.to_string()).unwrap_or_default();
        let host = uri.Host().map(|h| h.to_string().to_ascii_lowercase()).unwrap_or_default();
        if scheme != "https" || !LOOKUP_HOSTS.contains(&host.as_str()) {
            return Err("that address is not one of my look-up services".into());
        }
        let body = download(url.trim())?;
        if body.len() > 1024 * 1024 {
            return Err("the answer was larger than 1 MB".into());
        }
        Ok(body)
    }

    pub fn open(url: &str) -> Result<(), String> {
        if !is_web_link(url) {
            return Err("only web links can be opened".into());
        }
        let uri = Uri::CreateUri(&HSTRING::from(url.trim())).map_err(|_| "not a valid address".to_string())?;
        let ok = windows::System::Launcher::LaunchUriAsync(&uri).and_then(|o| o.join()).map_err(|e| e.to_string())?;
        if ok { Ok(()) } else { Err("Windows did not open the link".into()) }
    }
}

#[cfg(windows)]
pub use imp::{fetch, get, open};

#[cfg(not(windows))]
pub fn fetch(_: &str) -> Result<Feed, String> { Err("feeds are Windows-only in this build".into()) }
#[cfg(not(windows))]
pub fn get(_: &str) -> Result<String, String> { Err("Windows-only".into()) }
#[cfg(not(windows))]
pub fn open(_: &str) -> Result<(), String> { Err("Windows-only".into()) }
