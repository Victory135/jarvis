// Now playing, from Windows' own media session list (the same source as the volume flyout's media card).
// Read-only except for the three transport buttons the user presses. No audio is captured.
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSession {
    /// App id reported by Windows (e.g. "Spotify.exe", "MSEdge"); prettified in the UI.
    pub app: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// playing | paused | stopped | changing | opened | closed
    pub status: String,
    pub position_s: Option<f64>,
    pub duration_s: Option<f64>,
    pub can_prev: bool,
    pub can_next: bool,
    pub can_toggle: bool,
    pub current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    pub sessions: Vec<MediaSession>,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as St,
    };

    const TICKS_PER_S: f64 = 10_000_000.0;
    /// 100 ns ticks between 1601-01-01 (Windows epoch) and 1970-01-01.
    const EPOCH_DIFF_TICKS: i64 = 116_444_736_000_000_000;

    fn manager() -> windows::core::Result<Manager> {
        Manager::RequestAsync()?.join()
    }

    fn opt(s: windows::core::Result<windows::core::HSTRING>) -> Option<String> {
        s.ok().map(|h| h.to_string().trim().to_string()).filter(|s| !s.is_empty())
    }

    fn read(s: &Session, current_id: &str) -> MediaSession {
        let app = s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
        let props = s.TryGetMediaPropertiesAsync().and_then(|op| op.join()).ok();
        let info = s.GetPlaybackInfo().ok();
        let status = info.as_ref().and_then(|i| i.PlaybackStatus().ok());
        let ctl = info.as_ref().and_then(|i| i.Controls().ok());
        let (mut position_s, mut duration_s) = (None, None);
        if let Ok(t) = s.GetTimelineProperties() {
            let start = t.StartTime().map(|x| x.Duration).unwrap_or(0);
            let end = t.EndTime().map(|x| x.Duration).unwrap_or(0);
            if end > start {
                duration_s = Some((end - start) as f64 / TICKS_PER_S);
                let mut pos = t.Position().map(|x| x.Duration).unwrap_or(0) - start;
                // Windows reports the position as of LastUpdatedTime; add the time since then while playing.
                if status == Some(St::Playing) {
                    if let Ok(upd) = t.LastUpdatedTime() {
                        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as i64 / 100).unwrap_or(0) + EPOCH_DIFF_TICKS;
                        if upd.UniversalTime > 0 && now > upd.UniversalTime {
                            pos += now - upd.UniversalTime;
                        }
                    }
                }
                position_s = Some((pos.clamp(0, end - start)) as f64 / TICKS_PER_S);
            }
        }
        let status = match status {
            Some(St::Playing) => "playing",
            Some(St::Paused) => "paused",
            Some(St::Stopped) => "stopped",
            Some(St::Changing) => "changing",
            Some(St::Opened) => "opened",
            _ => "closed",
        };
        MediaSession {
            current: !current_id.is_empty() && app == current_id,
            app,
            title: props.as_ref().and_then(|p| opt(p.Title())),
            artist: props.as_ref().and_then(|p| opt(p.Artist())),
            album: props.as_ref().and_then(|p| opt(p.AlbumTitle())),
            status: status.into(),
            position_s,
            duration_s,
            can_prev: ctl.as_ref().and_then(|c| c.IsPreviousEnabled().ok()).unwrap_or(false),
            can_next: ctl.as_ref().and_then(|c| c.IsNextEnabled().ok()).unwrap_or(false),
            can_toggle: ctl.as_ref().and_then(|c| c.IsPlayPauseToggleEnabled().ok()).unwrap_or(false),
        }
    }

    pub fn status() -> Result<MediaStatus, String> {
        let m = manager().map_err(|e| format!("media sessions unavailable: {e}"))?;
        let current_id = m.GetCurrentSession().and_then(|s| s.SourceAppUserModelId()).map(|h| h.to_string()).unwrap_or_default();
        let list = m.GetSessions().map_err(|e| e.to_string())?;
        let mut sessions: Vec<MediaSession> = (0..list.Size().unwrap_or(0)).filter_map(|i| list.GetAt(i).ok()).map(|s| read(&s, &current_id)).collect();
        sessions.sort_by_key(|s| !s.current);
        Ok(MediaStatus { sessions })
    }

    pub fn control(app: &str, action: &str) -> Result<bool, String> {
        let m = manager().map_err(|e| e.to_string())?;
        let list = m.GetSessions().map_err(|e| e.to_string())?;
        let s = (0..list.Size().unwrap_or(0))
            .filter_map(|i| list.GetAt(i).ok())
            .find(|s| s.SourceAppUserModelId().map(|h| h.to_string() == app).unwrap_or(false))
            .ok_or_else(|| "that player is no longer open".to_string())?;
        let op = match action {
            "toggle" => s.TryTogglePlayPauseAsync(),
            "next" => s.TrySkipNextAsync(),
            "prev" => s.TrySkipPreviousAsync(),
            _ => return Err("unknown action".into()),
        };
        op.and_then(|o| o.join()).map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
pub use imp::{control, status};

#[cfg(not(windows))]
pub fn status() -> Result<MediaStatus, String> { Err("media sessions are Windows-only".into()) }
#[cfg(not(windows))]
pub fn control(_: &str, _: &str) -> Result<bool, String> { Err("media sessions are Windows-only".into()) }
