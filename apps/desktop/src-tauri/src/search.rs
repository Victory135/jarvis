// Free web search and page reading for spoken answers. No keys, no accounts.
// Search: DuckDuckGo's HTML page, then Wikipedia's search API if that is blocked or empty (never more than one query every 2 s,
// honest User-Agent, no attempt to get round a block). Pages: https only, public hosts only, text only.
// Everything returned here is DATA for the model to read. Nothing in it is ever executed or followed.
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone)]
pub struct Hit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String,
}

#[derive(Serialize, Clone)]
pub struct Page {
    pub url: String,
    pub title: String,
    pub excerpt: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub engine: String,
    pub results: Vec<Hit>,
    pub pages: Vec<Page>,
    pub cached: bool,
}

static CACHE: Mutex<Option<HashMap<String, (Instant, Found)>>> = Mutex::new(None);
static LAST: Mutex<Option<Instant>> = Mutex::new(None);

fn entities(s: &str) -> String {
    let mut o = s.replace("&amp;", "&").replace("&quot;", "\"").replace("&#x27;", "'").replace("&#39;", "'").replace("&apos;", "'")
        .replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").replace("&#160;", " ").replace("&mdash;", "-").replace("&ndash;", "-")
        .replace("&rsquo;", "'").replace("&lsquo;", "'").replace("&ldquo;", "\"").replace("&rdquo;", "\"").replace("&hellip;", "...").replace("&rupee;", "Rs ");
    // numeric entities
    while let Some(i) = o.find("&#") {
        let Some(j) = o[i..].find(';').map(|j| i + j) else { break };
        let body = &o[i + 2..j];
        let code = if let Some(h) = body.strip_prefix('x').or(body.strip_prefix('X')) { u32::from_str_radix(h, 16).ok() } else { body.parse().ok() };
        let ch = code.and_then(char::from_u32).filter(|_| j - i <= 10).unwrap_or(' ');
        o.replace_range(i..=j, &ch.to_string());
    }
    o
}

fn strip_tags(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    let mut depth = false;
    for c in s.chars() {
        match c { '<' => depth = true, '>' if depth => { depth = false; o.push(' ') }, _ if !depth => o.push(c), _ => {} }
    }
    entities(&o).split_whitespace().collect::<Vec<_>>().join(" ")
}

fn host_of(url: &str) -> String {
    url.split("://").nth(1).unwrap_or("").split(['/', '?', '#']).next().unwrap_or("").trim_start_matches("www.").to_ascii_lowercase()
}

/// Public https pages only: no local or private addresses, nothing that needs a sign-in or isn't text.
fn readable(url: &str) -> bool {
    let l = url.to_ascii_lowercase();
    if !l.starts_with("https://") { return false }
    let h = host_of(&l);
    let h = h.split(':').next().unwrap_or("");
    if !h.contains('.') || h.starts_with('[') || h.ends_with(".local") || h.ends_with(".internal") || h == "localhost" { return false }
    if h.chars().all(|c| c.is_ascii_digit() || c == '.') { return false }
    let skip = ["youtube.com", "youtu.be", "facebook.com", "instagram.com", "x.com", "twitter.com", "linkedin.com", "tiktok.com", "pinterest.com", "reddit.com", "quora.com"];
    if skip.iter().any(|s| h == *s || h.ends_with(&format!(".{s}"))) { return false }
    let path = l.split(['?', '#']).next().unwrap_or("");
    ![".pdf", ".zip", ".mp4", ".mp3", ".jpg", ".png", ".doc", ".docx", ".xls", ".xlsx", ".ppt"].iter().any(|e| path.ends_with(e))
}

/// Pull (title, link, snippet) out of a results page by the class names the engine uses.
fn parse(html: &str, link_class: &str, snippet_class: &str) -> Vec<Hit> {
    let mut out = Vec::new();
    let marker = format!("class=\"{link_class}\"");
    let mut at = 0;
    while let Some(p) = html[at..].find(&marker).map(|p| p + at) {
        at = p + marker.len();
        let Some(open) = html[..p].rfind("<a ") else { continue };
        let Some(close) = html[p..].find('>').map(|c| c + p) else { break };
        let tag = &html[open..close];
        let Some(h) = tag.find("href=\"") else { continue };
        let href = entities(tag[h + 6..].split('"').next().unwrap_or(""));
        let Some(end) = html[close..].find("</a>").map(|e| e + close) else { break };
        let title = strip_tags(&html[close + 1..end]);
        if href.contains("duckduckgo.com/y.js") || href.contains("ad_domain") || href.contains("ad_provider") { continue }
        let url = match href.find("uddg=") {
            Some(u) => crate::online::dec(href[u + 5..].split('&').next().unwrap_or("")),
            None if href.starts_with("//") => format!("https:{href}"),
            None => href,
        };
        let next = html[end..].find(&marker).map(|n| n + end).unwrap_or(html.len());
        let snippet = html[end..next].find(&format!("class=\"{snippet_class}\"")).and_then(|s| {
            let s = s + end;
            let a = html[s..next].find('>')? + s + 1;
            let b = html[a..next].find("</a>").or_else(|| html[a..next].find("</p>")).map(|b| b + a).unwrap_or(next.min(a + 600));
            Some(strip_tags(&html[a..b]))
        }).unwrap_or_default();
        if !url.starts_with("http") || title.is_empty() { continue }
        let source = host_of(&url);
        out.push(Hit { title, url, snippet, source });
        if out.len() >= 8 { break }
    }
    out
}

fn remove_blocks(html: &str, tags: &[&str]) -> String {
    let mut s = html.to_string();
    for t in tags {
        loop {
            let lower = s.to_ascii_lowercase();
            let Some(a) = lower.find(&format!("<{t}")) else { break };
            // only a real tag: next char ends the name
            let after = lower.as_bytes().get(a + 1 + t.len()).copied().unwrap_or(b' ');
            if after.is_ascii_alphanumeric() || after == b'-' {
                // not this tag (e.g. <navigation>): hide it from the next search by nudging one char
                s.replace_range(a..a + 1, " ");
                continue;
            }
            let end = lower[a..].find(&format!("</{t}")).and_then(|e| lower[a + e..].find('>').map(|g| a + e + g + 1)).unwrap_or(s.len());
            s.replace_range(a..end, " ");
        }
    }
    s
}

const STOP: &[&str] = &["the", "and", "for", "what", "who", "when", "where", "how", "was", "are", "is", "did", "does", "with", "from", "that", "this", "about", "latest", "tell", "new", "has", "have", "which", "will", "its", "any"];

/// Title and the few paragraphs of a page that best match the question.
fn extract(html: &str, query: &str) -> Option<(String, String)> {
    let lower = html.to_ascii_lowercase();
    if !lower.contains("<html") && !lower.contains("<body") && !lower.contains("<p") { return None }
    let title = lower.find("<title").and_then(|a| {
        let s = html[a..].find('>')? + a + 1;
        let e = lower[s..].find("</title")? + s;
        Some(strip_tags(&html[s..e]))
    }).unwrap_or_default();
    let body = remove_blocks(html, &["script", "style", "noscript", "nav", "footer", "header", "aside", "form", "svg", "iframe", "template", "figure", "button", "select"]);
    let bl = body.to_ascii_lowercase();
    // prefer the article or main region when the page marks one
    let region = ["<article", "<main"].iter().find_map(|t| {
        let a = bl.find(t)?;
        let e = bl[a..].rfind(&format!("</{}", &t[1..])).map(|e| a + e).unwrap_or(body.len());
        (e - a > 1500).then(|| body[a..e].to_string())
    }).unwrap_or(body);
    let mut marked = region;
    for t in ["</p>", "</div>", "</li>", "</h1>", "</h2>", "</h3>", "</h4>", "</tr>", "<br>", "<br/>", "<br />", "</P>", "</DIV>", "</LI>"] { marked = marked.replace(t, "\n") }
    let paras: Vec<String> = marked.split('\n').map(strip_tags).filter(|p| p.len() >= 70 && p.split(' ').count() >= 10).collect();
    if paras.is_empty() { return None }
    let keys: Vec<String> = query.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 2 && !STOP.contains(w)).map(String::from).collect();
    let mut scored: Vec<(usize, usize)> = paras.iter().enumerate().map(|(i, p)| {
        let pl = p.to_lowercase();
        (keys.iter().filter(|k| pl.contains(k.as_str())).count() * 10 + usize::from(p.chars().any(|c| c.is_ascii_digit())) * 2 + usize::from(i < 4), i)
    }).collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut pick: Vec<usize> = scored.iter().take(3).map(|s| s.1).collect();
    pick.sort();
    let mut words = 0;
    let mut out = Vec::new();
    for i in pick {
        let w: Vec<&str> = paras[i].split(' ').collect();
        let take = w.len().min(110usize.saturating_sub(words));
        if take < 8 { break }
        out.push(w[..take].join(" "));
        words += take;
    }
    (!out.is_empty()).then(|| (title, out.join(" ... ")))
}

fn read(url: &str, query: &str) -> Option<Page> {
    if !readable(url) { return None }
    let r = crate::online::fetch("GET", url, None, 8).ok()?;
    if r.status != 200 || r.body.len() > 1_500_000 { return None }
    let (title, excerpt) = extract(&r.body, query)?;
    Some(Page { url: url.to_string(), title, excerpt })
}

fn engine_search(query: &str) -> (String, Vec<Hit>) {
    // one search every 2 s at most
    if let Ok(mut last) = LAST.lock() {
        if let Some(t) = *last { let since = t.elapsed(); if since < Duration::from_secs(2) { std::thread::sleep(Duration::from_secs(2) - since) } }
        *last = Some(Instant::now());
    }
    let q = crate::online::enc(query);
    if std::env::var("JARVIS_TEST_NO_DDG").is_err() {
        if let Ok(r) = crate::online::fetch("POST", "https://html.duckduckgo.com/html/", Some((&format!("q={q}&kl=in-en"), "application/x-www-form-urlencoded")), 8) {
            if r.status == 200 && !r.body.contains("anomaly-modal") {
                let hits = parse(&r.body, "result__a", "result__snippet");
                if !hits.is_empty() { return ("DuckDuckGo".into(), hits) }
            }
        }
    }
    // Fallback: Wikipedia's own search API (Mojeek was tried and answers automated clients with a captcha, which
    // is never worked around).
    if let Ok(r) = crate::online::fetch("GET", &format!("https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={q}&srlimit=5&format=json"), None, 8) {
        if r.status == 200 {
            let v: serde_json::Value = serde_json::from_str(&r.body).unwrap_or_default();
            let hits: Vec<Hit> = v["query"]["search"].as_array().map(|a| a.iter().filter_map(|x| {
                let title = x["title"].as_str()?.to_string();
                Some(Hit { url: format!("https://en.wikipedia.org/wiki/{}", crate::online::enc(&title.replace(' ', "_"))), snippet: strip_tags(x["snippet"].as_str().unwrap_or("")), source: "en.wikipedia.org".into(), title })
            }).collect()).unwrap_or_default();
            if !hits.is_empty() { return ("Wikipedia".into(), hits) }
        }
    }
    ("none".into(), Vec::new())
}

pub fn search(query: &str) -> Result<Found, String> {
    let q = query.trim();
    if q.len() < 2 || q.len() > 200 { return Err("that is not something I can search for".into()) }
    let key = q.to_lowercase();
    if let Ok(mut c) = CACHE.lock() {
        let map = c.get_or_insert_with(HashMap::new);
        map.retain(|_, v| v.0.elapsed() < Duration::from_secs(600));
        if let Some((_, f)) = map.get(&key) { let mut f = f.clone(); f.cached = true; return Ok(f) }
    }
    let (engine, results) = engine_search(q);
    // read the first few readable pages at the same time
    let handles: Vec<_> = results.iter().filter(|h| readable(&h.url)).take(3).map(|h| {
        let (url, query) = (h.url.clone(), q.to_string());
        std::thread::spawn(move || read(&url, &query))
    }).collect();
    let pages: Vec<Page> = handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect();
    let found = Found { engine, results, pages, cached: false };
    if !found.results.is_empty() {
        if let Ok(mut c) = CACHE.lock() { c.get_or_insert_with(HashMap::new).insert(key, (Instant::now(), found.clone())); }
    }
    Ok(found)
}
