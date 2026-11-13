// Real, browser-available telemetry only. Anything that needs the native (Tauri/Rust) link
// returns null so the UI can show an honest "unavailable" state. No simulated values (blueprint UI-03).
import { clapDetector } from './awaken'
import { clapPref } from './prefs'
import { useEffect, useRef, useState } from 'react'
import { log } from './activity'

export function useClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

type NetInfo = { online: boolean; type: string | null; downlinkMbps: number | null; rttMs: number | null }
type NavConnection = { effectiveType?: string; downlink?: number; rtt?: number; addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void }

export function useNetwork(): NetInfo {
  const read = (): NetInfo => {
    const c = (navigator as Navigator & { connection?: NavConnection }).connection
    return {
      online: navigator.onLine,
      type: c?.effectiveType ?? null,
      downlinkMbps: c?.downlink ?? null,
      rttMs: c?.rtt ?? null,
    }
  }
  const [net, setNet] = useState(read)
  useEffect(() => {
    const c = (navigator as Navigator & { connection?: NavConnection }).connection
    const update = () => setNet(read())
    const on = () => { log('info', 'Network connection restored'); update() }
    const off = () => { log('warn', 'Network connection lost'); update() }
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    c?.addEventListener?.('change', update)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
      c?.removeEventListener?.('change', update)
    }
  }, [])
  return net
}

type BatteryInfo = { level: number; charging: boolean } | null
type BatteryManager = { level: number; charging: boolean; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void }

/** null = API unavailable or no battery reported. */
export function useBattery(): BatteryInfo {
  const [b, setB] = useState<BatteryInfo>(null)
  useEffect(() => {
    const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }).getBattery
    if (!getBattery) return
    let mgr: BatteryManager | null = null
    const update = () => mgr && setB({ level: Math.round(mgr.level * 100), charging: mgr.charging })
    getBattery.call(navigator).then((m) => {
      mgr = m
      update()
      m.addEventListener('levelchange', update)
      m.addEventListener('chargingchange', update)
    }).catch(() => setB(null))
    return () => {
      mgr?.removeEventListener('levelchange', update)
      mgr?.removeEventListener('chargingchange', update)
    }
  }, [])
  return b
}

/** Measured render rate of this window (frames actually painted), sampled every second. Pauses when hidden. */
export function useFps(enabled = true): number | null {
  const [fps, setFps] = useState<number | null>(null)
  useEffect(() => {
    if (!enabled) { setFps(null); return }
    let raf = 0
    let frames = 0
    let start = performance.now()
    let warm = false // first window includes page load / tab switch; discard it
    const tick = (t: number) => {
      frames++
      if (t - start >= 1000) {
        if (warm) setFps(Math.round((frames * 1000) / (t - start)))
        warm = true
        frames = 0
        start = t
      }
      raf = requestAnimationFrame(tick)
    }
    const run = () => { cancelAnimationFrame(raf); frames = 0; warm = false; start = performance.now(); raf = requestAnimationFrame(tick) }
    const vis = () => (document.hidden ? cancelAnimationFrame(raf) : run())
    run()
    document.addEventListener('visibilitychange', vis)
    return () => { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', vis) }
  }, [enabled])
  return fps
}

export type MicState = 'off' | 'starting' | 'live' | 'denied' | 'error'

/** Why a command capture ended without audio. */
export type CaptureEnd = 'no-speech' | 'cancelled' | 'mic-off' | 'claps'
export type Capture = { pcm: Int16Array; seconds: number; voiced: number } | { none: CaptureEnd }

const RATE = 16000 // what both speech engines expect; the browser resamples the mic for us
const FRAME = 1024 // ~64 ms per analysis frame
const NO_SPEECH_S = 6
const MAX_S = 12
const END_SILENCE_S = 0.7 // was 1.0; 0.75 keeps normal mid-sentence pauses
const PREROLL_S = 0.3
const FLOOR = 0.008 // quietest level treated as speech (a soft voice across the room on the built-in microphone)

/**
 * Microphone. Opens only on explicit user action. The level meter and waveform are analysed live; a voice
 * command is captured into memory only while `capture()` runs, handed back once, and never written to disk.
 */
export function useMicrophone() {
  const [state, setState] = useState<MicState>('off')
  const [level, setLevel] = useState(0)
  const [device, setDevice] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef(0)
  const endCapture = useRef<((c: Capture) => void) | null>(null)
  const opening = useRef<Promise<boolean> | null>(null)

  const stop = () => {
    endCapture.current?.({ none: 'mic-off' })
    window.clearInterval(rafRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    void ctxRef.current?.close()
    streamRef.current = null
    ctxRef.current = null
    srcRef.current = null
    analyserRef.current = null
    setLevel(0)
    setDevice(null)
    setState('off')
    log('info', 'Microphone closed')
  }

  /** Opens the microphone. Resolves true when live. */
  const start = (): Promise<boolean> => {
    if (ctxRef.current) return Promise.resolve(true)
    // one opening at a time (the wake listener and TALK can both ask)
    opening.current ??= open().finally(() => { opening.current = null })
    return opening.current
  }
  const open = async (): Promise<boolean> => {
    if (!navigator.mediaDevices?.getUserMedia) { setState('error'); log('warn', 'Microphone API not available'); return false }
    setState('starting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      const ctx = new AudioContext({ sampleRate: RATE })
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.6
      const src = ctx.createMediaStreamSource(stream)
      src.connect(analyser)
      streamRef.current = stream
      ctxRef.current = ctx
      srcRef.current = src
      analyserRef.current = analyser
      setDevice(stream.getAudioTracks()[0]?.label || 'Default input')
      setState('live')
      log('info', 'Microphone opened (nothing is recorded to disk)')
      // Sample ~15 times a second (not every frame), and only re-render when the level visibly changes.
      const buf = new Float32Array(analyser.fftSize)
      rafRef.current = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        const v = Math.round(Math.min(1, Math.sqrt(sum / buf.length) * 4) * 50) / 50
        setLevel((prev) => (prev === v ? prev : v))
      }, 66)
      return true
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      setState(denied ? 'denied' : 'error')
      log('warn', denied ? 'Microphone permission denied' : `Microphone failed: ${(e as Error).message}`)
      return false
    }
  }

  /**
   * Capture one spoken command: waits for speech (up to 6 s), stops after ~1 s of quiet or 12 s total.
   * The noise floor is measured from the first 0.3 s so a fan or a noisy room doesn't count as speech.
   */
  const capture = (opts: { wake?: boolean } = {}): Promise<Capture> => {
    const wake = !!opts.wake // waiting for the wake word: no time limit, and the noise floor keeps adapting
    const ctx = ctxRef.current
    const src = srcRef.current
    if (!ctx || !src) return Promise.resolve({ none: 'mic-off' })
    return new Promise<Capture>((resolve) => {
      // ScriptProcessor is deprecated but universally available and fine for a few seconds of 16 kHz mono.
      const proc = ctx.createScriptProcessor(FRAME, 1, 1)
      const mute = ctx.createGain()
      mute.gain.value = 0
      src.connect(proc)
      proc.connect(mute)
      mute.connect(ctx.destination)
      const frameS = FRAME / RATE
      const chunks: Float32Array[] = []
      let frames = 0
      let floor = 0
      let floorN = 0
      let thresh = FLOOR
      let loud = 0
      let speechAt = -1
      let quiet = 0
      let voiced = 0
      let done = false
      const claps = wake && clapPref.get() ? clapDetector(RATE) : null
      const finish = (c: Capture) => {
        if (done) return
        done = true
        endCapture.current = null
        proc.onaudioprocess = null
        try { src.disconnect(proc); proc.disconnect(); mute.disconnect() } catch { /* already gone */ }
        if (!wake) setCapturing(false)
        resolve(c)
      }
      endCapture.current = finish
      if (!wake) setCapturing(true)
      proc.onaudioprocess = (e) => {
        const data = new Float32Array(e.inputBuffer.getChannelData(0))
        frames++
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        const rms = Math.sqrt(sum / data.length)
        const t = frames * frameS
        // two sharp claps (and no speech with them) open the "Wake up, Jarvis" window
        if (claps?.push(data) && voiced < 0.4) { finish({ none: 'claps' }); return }
        if (t <= PREROLL_S) { floor += rms; floorN++; thresh = Math.max(FLOOR, (floor / floorN) * 3) }
        chunks.push(data)
        if (speechAt < 0) {
          // keep only a short pre-roll before speech starts
          while (chunks.length > Math.ceil(PREROLL_S / frameS) + 2) chunks.shift()
          loud = rms > thresh ? loud + 1 : 0
          if (loud >= 2) speechAt = t
          else if (wake) {
            // follow slow changes in room noise (fan, traffic) while waiting
            if (t > PREROLL_S && floorN && rms < thresh) { floor = (floor / floorN) * 0.97 + rms * 0.03; floorN = 1; thresh = Math.max(FLOOR, floor * 2.5) }
          } else if (t >= NO_SPEECH_S) finish({ none: 'no-speech' })
          return
        }
        if (rms > thresh) voiced += frameS
        quiet = rms < thresh * 0.7 ? quiet + frameS : 0
        if (quiet >= END_SILENCE_S || t - (wake ? speechAt : 0) >= MAX_S) {
          // drop the trailing silence (keep 0.25 s): silence at the end makes Whisper repeat itself
          const dropFrames = Math.max(0, Math.floor((quiet - 0.25) / frameS))
          if (dropFrames > 0) chunks.splice(chunks.length - dropFrames, dropFrames)
          const n = chunks.reduce((a, c) => a + c.length, 0)
          const pcm = new Int16Array(n)
          let o = 0
          for (const c of chunks) for (let i = 0; i < c.length; i++) pcm[o++] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767)))
          finish({ pcm, seconds: n / RATE, voiced })
        }
      }
    })
  }

  const cancelCapture = () => endCapture.current?.({ none: 'cancelled' })

  useEffect(() => () => { window.clearInterval(rafRef.current); streamRef.current?.getTracks().forEach((t) => t.stop()); void ctxRef.current?.close() }, [])

  return { state, level, device, capturing, analyser: analyserRef, start, stop, capture, cancelCapture }
}
