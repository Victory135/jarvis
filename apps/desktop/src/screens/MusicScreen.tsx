// Music: what Windows says is playing, with the player's own transport controls.
// No visualiser: JARVIS can't see system audio without recording it, and it doesn't fake one.
import { useEffect, useState } from 'react'
import { HudPanel } from '../components/hud'
import { NATIVE } from '../lib/native'
import { fmtTime, mediaControl, prettyApp, useMedia, type MediaSession } from '../lib/media'

const STATUS_TONE = { playing: 'good', paused: 'warn', stopped: 'na', changing: 'ok', opened: 'ok', closed: 'na' } as const

export function MusicScreen() {
  const [media, reload] = useMedia(true, 1000)
  const sessions = media && 'sessions' in media ? media.sessions : []
  const [pick, setPick] = useState<string | null>(null)
  // Follow Windows' current session unless the user picked another player.
  const s = sessions.find((x) => x.app === pick) ?? sessions.find((x) => x.current) ?? sessions[0] ?? null
  useEffect(() => { if (pick && !sessions.some((x) => x.app === pick)) setPick(null) }, [pick, sessions])

  const act = async (a: 'toggle' | 'next' | 'prev') => { if (s) { await mediaControl(s.app, a); reload() } }

  return (
    <div className="screen screen-music">
      <HudPanel code="MUS-01" title="Now playing" className="np"
        status={!NATIVE ? { tone: 'na', text: 'NO NATIVE LINK' } : !s ? { tone: 'na', text: 'IDLE' } : { tone: STATUS_TONE[s.status], text: s.status.toUpperCase() }}>
        {!NATIVE ? (
          <div className="empty"><span className="empty-title">DESKTOP BUILD ONLY</span><span className="note">Now playing comes from Windows media controls in the desktop app.</span></div>
        ) : media && 'error' in media ? (
          <div className="empty"><span className="empty-title">MEDIA INFO UNAVAILABLE</span><span className="note">{media.error}</span></div>
        ) : !s ? (
          <div className="empty">
            <span className="empty-title">{media ? 'NOTHING PLAYING' : 'READING MEDIA SESSIONS'}</span>
            <span className="note">Play something in any app that shows in the Windows volume flyout (Spotify, YouTube in Edge or Chrome, Media Player) and it appears here.</span>
          </div>
        ) : (
          <NowPlaying s={s} onAct={act} />
        )}
      </HudPanel>

      <div className="screen-side">
        <HudPanel code="MUS-02" title="Players" status={{ tone: sessions.length ? 'ok' : 'na', text: `${sessions.length} OPEN` }} className="grow">
          {sessions.length === 0 ? (
            <div className="empty"><span className="empty-title">NO MEDIA APPS</span></div>
          ) : (
            <ul className="list">
              {sessions.map((x) => (
                <li key={x.app}>
                  <button type="button" className={`row ${s?.app === x.app ? 'on' : ''}`} onClick={() => setPick(x.app)} aria-pressed={s?.app === x.app}>
                    <span className="row-main">{x.title ?? 'Untitled'}</span>
                    <span className="row-sub">{prettyApp(x.app)}{x.current ? ' · WINDOWS CURRENT' : ''}</span>
                    <span className={`row-tag s-${STATUS_TONE[x.status]}`}>{x.status.toUpperCase()}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </HudPanel>
        <HudPanel code="MUS-03" title="Source" className="fit" status={{ tone: 'ok', text: 'LOCAL' }}>
          <p className="note" style={{ margin: 0 }}>
            Read from Windows media controls on this PC. Buttons ask the player to play, pause or skip. No audio is recorded,
            so there is no visualiser.
          </p>
        </HudPanel>
      </div>
    </div>
  )
}

function NowPlaying({ s, onAct }: { s: MediaSession; onAct: (a: 'toggle' | 'next' | 'prev') => void }) {
  const pct = s.positionS != null && s.durationS ? Math.min(100, (s.positionS / s.durationS) * 100) : null
  return (
    <div className="np-body">
      <div className="np-app">{prettyApp(s.app).toUpperCase()}</div>
      <div className="np-title" title={s.title ?? undefined}>{s.title ?? 'Untitled'}</div>
      <div className="np-artist">{s.artist ?? <span className="na">Artist not reported</span>}</div>
      {s.album && <div className="np-album">{s.album}</div>}
      <div className="np-progress" role="progressbar" aria-label="Track position"
        aria-valuemin={0} aria-valuemax={Math.round(s.durationS ?? 0)} aria-valuenow={s.positionS != null ? Math.round(s.positionS) : undefined}>
        <div className="np-track">{pct != null && <div className="np-fill" style={{ width: `${pct}%` }} />}</div>
        <div className="np-times">
          <span>{fmtTime(s.positionS)}</span>
          <span>{pct == null ? 'POSITION NOT REPORTED BY THIS PLAYER' : ''}</span>
          <span>{fmtTime(s.durationS)}</span>
        </div>
      </div>
      <div className="np-controls">
        <button type="button" className="btn" disabled={!s.canPrev} onClick={() => onAct('prev')}>◀◀ PREV</button>
        <button type="button" className="btn big" disabled={!s.canToggle} onClick={() => onAct('toggle')}>
          {s.status === 'playing' ? 'PAUSE' : 'PLAY'}
        </button>
        <button type="button" className="btn" disabled={!s.canNext} onClick={() => onAct('next')}>NEXT ▶▶</button>
      </div>
    </div>
  )
}
