// Now playing from Windows' media sessions (desktop build only). Read-only plus transport buttons.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { NATIVE } from './native'
import { log } from './activity'

export type MediaSession = {
  app: string
  title: string | null
  artist: string | null
  album: string | null
  status: 'playing' | 'paused' | 'stopped' | 'changing' | 'opened' | 'closed'
  positionS: number | null
  durationS: number | null
  canPrev: boolean
  canNext: boolean
  canToggle: boolean
  current: boolean
}

export type MediaState = { sessions: MediaSession[] } | { error: string } | null

/** Polls the media sessions while `enabled`. null = not loaded yet (or no native link). */
export function useMedia(enabled: boolean, everyMs = 1000): [MediaState, () => void] {
  const [state, setState] = useState<MediaState>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!NATIVE || !enabled) return
    let alive = true
    const run = async () => {
      try {
        const r = await invoke<{ sessions: MediaSession[] }>('media_status')
        if (alive) setState(r)
      } catch (e) {
        if (alive) setState({ error: String(e) })
      }
    }
    void run()
    const id = window.setInterval(() => { if (!document.hidden) void run() }, everyMs)
    return () => { alive = false; window.clearInterval(id) }
  }, [enabled, everyMs, tick])
  return [state, () => setTick((t) => t + 1)]
}

export async function mediaControl(app: string, action: 'toggle' | 'next' | 'prev'): Promise<void> {
  try {
    const ok = await invoke<boolean>('media_control', { app, action })
    if (!ok) log('warn', `${prettyApp(app)} did not accept ${action}`)
  } catch (e) {
    log('warn', `Media control failed: ${String(e)}`)
  }
}

const KNOWN: [RegExp, string][] = [
  [/spotify/i, 'Spotify'],
  [/msedge/i, 'Microsoft Edge'],
  [/chrome/i, 'Google Chrome'],
  [/firefox/i, 'Firefox'],
  [/zunemusic/i, 'Media Player'],
  [/zunevideo/i, 'Films & TV'],
  [/vlc/i, 'VLC'],
  [/foobar/i, 'foobar2000'],
  [/applemusic|itunes/i, 'Apple Music'],
]

/** Windows reports app ids like "Spotify.exe" or "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic". */
export function prettyApp(id: string): string {
  for (const [re, name] of KNOWN) if (re.test(id)) return name
  const base = (id.split('!').pop() ?? id).split('\\').pop()!.replace(/\.exe$/i, '')
  return base.split(/[._]/).filter(Boolean).pop() ?? id
}

export function fmtTime(s: number | null): string {
  if (s == null || !isFinite(s)) return '--:--'
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const ss = String(Math.floor(s % 60)).padStart(2, '0')
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
