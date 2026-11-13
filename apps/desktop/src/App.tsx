import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { HudPanel, Meter, RingGauge, Scope, type Status } from './components/hud'
import { ReactorCore } from './components/ReactorCore'
import { ApprovalPanel, type ApprovalRequest } from './components/ApprovalPanel'
import { log, useActivity } from './lib/activity'
import { cancelRun, runCommand } from './lib/commands'
import { getCore, setCore, STATE_META, useCore, type CoreState } from './lib/core-state'
import { prerender, speak, useSpeechLevel, warmVoice } from './lib/speech'
import { commonPhrases } from './lib/actions'
import { FILLERS } from './lib/commands'
import { setInstalledApps } from './lib/prefs'
import { setContextProvider, useModelState, warmModel } from './lib/llm'
import { useBattery, useClock, useFps, useMicrophone, useNetwork, type MicState } from './lib/telemetry'
import { fmtBytes, fmtRate, fmtUptime, NATIVE, useTelemetry, useWifi } from './lib/native'
import { MOTION_PREFS, resolveMotion, setMotionPref, useMotionPref, type Motion } from './lib/settings'
import { go, SCREENS, useScreen } from './lib/nav'
import { ago, headlines, openLink, startNewsSchedule, useNews } from './lib/news'
import { feedsPref, orbAtStartPref, sttComparePref, sttEnginePref, wakePref, type SttEngine } from './lib/prefs'
import { heardWake } from './lib/wake'
import { ENGINE_LABEL, sttBusy, transcribe } from './lib/stt'
import { MusicScreen } from './screens/MusicScreen'
import { NewsScreen } from './screens/NewsScreen'
import { SettingsScreen } from './screens/SettingsScreen'

let startLogged = false
let warmed = false
const pad = (n: number) => String(n).padStart(2, '0')
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const REST: CoreState[] = ['standby', 'listening', 'muted']
const BUSY: CoreState[] = ['thinking', 'planning', 'executing', 'speaking', 'transcribing']

const MOTION_TEXT: Record<Motion, string> = { full: 'FULL', low: 'LOW POWER', still: 'STILL' }

const micChip: Record<MicState, [Status, string]> = {
  off: ['na', 'OFF'], starting: ['warn', 'OPENING'], live: ['good', 'LIVE'], denied: ['bad', 'DENIED'], error: ['bad', 'ERROR'],
}

/** Example shown only in design-preview mode, clearly labelled. Real approvals come with the tool layer. */
const PREVIEW_APPROVAL: ApprovalRequest = {
  action: 'Delete file', target: 'C:\\Users\\you\\Downloads\\old-report.pdf', risk: 'high',
  detail: 'Moves the file to the Recycle Bin. A second confirmation is required.',
}

function useOsReducedMotion() {
  const [v, setV] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const m = matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setV(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return v
}

function greeting(h: number) {
  if (h < 5) return 'Working late.'
  if (h < 12) return 'Good morning.'
  if (h < 17) return 'Good afternoon.'
  return 'Good evening.'
}

function Chip({ k, v, tone }: { k: string; v: string; tone: Status }) {
  return (
    <div className={`chip s-${tone}`}>
      <span className="chip-k">{k}</span>
      <span className="chip-v">{v}</span>
    </div>
  )
}

export default function App() {
  const now = useClock()
  const net = useNetwork()
  const battery = useBattery()
  const [inTray, setInTray] = useState(false)
  const screen = useScreen()
  const news = useNews()
  const feeds = feedsPref.use()
  const motionPref = useMotionPref()
  const osReduced = useOsReducedMotion()
  // Hidden in the tray: nothing on screen, so nothing animates (WebView2 doesn't pause hidden windows itself).
  const motion = inTray ? 'still' : resolveMotion(motionPref, osReduced, battery != null && !battery.charging)
  const fps = useFps(motion === 'full')
  const mic = useMicrophone()
  const activity = useActivity()
  const core = useCore()
  const speechLevel = useSpeechLevel()
  const tele = useTelemetry(motion === 'full' ? 1000 : 3000)
  const wifi = useWifi()
  const [muted, setMuted] = useState(false)
  const [cmd, setCmd] = useState('')
  const [orbOpen, setOrbOpen] = useState(false)
  const [viewport, setViewport] = useState(() => [window.innerWidth, window.innerHeight])

  const wakeOn = wakePref.use() && NATIVE
  // With the wake word on, the open microphone is only waiting for "Hey Jarvis": that is standby, not listening.
  const restState = (): CoreState => (muted ? 'muted' : mic.state === 'live' && !wakeOn ? 'listening' : 'standby')
  const restRef = useRef(restState)
  restRef.current = restState
  const micRef = useRef(mic)
  micRef.current = mic
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  /** Close the microphone after a command, unless the wake word needs it kept open. */
  const closeMic = () => { if (!(wakePref.get() && !mutedRef.current)) mic.stop() }

  useEffect(() => {
    if (!startLogged) { startLogged = true; log('info', core.preview ? `Design preview: ${core.state} (simulated)` : (NATIVE ? 'HUD started: desktop build, native link up' : 'HUD started: browser preview, no native link')) }
    const onResize = () => setViewport([window.innerWidth, window.innerHeight])
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [core.preview, core.state])

  // Rest state follows real mic / mute events, but never interrupts an active stage.
  useEffect(() => {
    if (REST.includes(getCore().state)) setCore(restState())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted, mic.state, wakeOn])

  const toggleMute = () => {
    const next = !muted
    if (next && mic.state === 'live') mic.stop()
    setMuted(next)
    log('info', next ? 'Privacy mute ON: microphone blocked' : 'Privacy mute OFF')
  }

  const stop = () => {
    cancelRun()
    log('info', 'Stopped by user')
    setCore(restState())
  }

  // ---- push-to-talk: record one command, transcribe locally, run it like a typed command ----
  const talking = useRef(false)
  const talk = async (viaWake: unknown = false) => {
    if (muted || talking.current) return
    if (!NATIVE) { log('warn', 'Speech recognition needs the desktop app'); return }
    talking.current = true
    try {
      cancelRun()
      mic.cancelCapture() // the wake listener steps aside
      if (!(await mic.start())) return
      setCore('listening', 'Listening · speak now')
      const c = await mic.capture()
      const heardAt = performance.now() // you stopped speaking
      if ('none' in c) {
        closeMic()
        if (c.none === 'no-speech') {
          log('warn', 'No speech heard')
          setCore('warning', "Didn't hear anything")
          window.setTimeout(() => { if (getCore().state === 'warning') setCore(restState()) }, 1800)
        } else setCore(restState())
        return
      }
      // After "Hey Jarvis" the request is heard by the same engine that heard his name.
      const engine = viaWake === true ? 'whisper' : sttEnginePref.get()
      setCore('transcribing', `Transcribing ${c.seconds.toFixed(1)} s locally · ${ENGINE_LABEL[engine]}`)
      closeMic() // push-to-talk: the mic closes as soon as the command is captured
      let r
      try {
        r = await transcribe(c.pcm, engine)
      } catch (e) {
        log('warn', `Speech recognition failed: ${String(e)}`)
        setCore('error', 'Speech recognition failed')
        window.setTimeout(() => { if (getCore().state === 'error') setCore(restState()) }, 2500)
        return
      }
      const secs = (ms: number) => (ms / 1000).toFixed(1)
      log('info', `Heard (${ENGINE_LABEL[engine]}, ${secs(r.audioMs)} s audio, ${secs(r.decodeMs)} s${r.loadMs != null ? `, +${secs(r.loadMs)} s model load` : ''}): "${r.text}"`)
      if (sttComparePref.get()) {
        const other: SttEngine = engine === 'vosk' ? 'whisper' : 'vosk'
        void transcribe(c.pcm, other)
          .then((o) => log('info', `Compare ${ENGINE_LABEL[other]} (${secs(o.decodeMs)} s): "${o.text}"`))
          .catch((e) => log('warn', `Compare ${ENGINE_LABEL[other]} failed: ${String(e)}`))
      }
      if (!r.text) {
        setCore('warning', "Didn't catch that")
        void speak("I didn't catch that, sir.")
        window.setTimeout(() => { if (getCore().state === 'warning') setCore(restState()) }, 1800)
        return
      }
      await runCommand(r.text, restState, () => setMuted(true), heardAt, true)
    } finally {
      talking.current = false
    }
  }
  const talkRef = useRef(talk)
  talkRef.current = talk

  // ---- wake word: "Hey Jarvis" with no button. Speech that doesn't start with his name is dropped unseen. ----
  useEffect(() => {
    if (!wakeOn || muted) return
    let alive = true
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const atRest = () => !talking.current && REST.includes(getCore().state)
    const secs = (ms: number) => (ms / 1000).toFixed(1)
    let lastIgnored = 0
    const onPhrase = async (pcm: Int16Array, seconds: number) => {
      const heardAt = performance.now() // you stopped speaking
      // A long stretch of talk (a call, a video): check only its opening before spending more on it.
      if (seconds > 6 && !heardWake((await transcribe(pcm.subarray(0, 16000 * 3), 'whisper', false)).text)) return
      const r = await transcribe(pcm, 'whisper', false)
      const w = heardWake(r.text)
      if (!w && r.text && performance.now() - lastIgnored > 20000) {
        lastIgnored = performance.now()
        log('info', 'Heard speech that did not start with "Jarvis"; ignored and not kept')
      }
      if (!w || !alive || !atRest()) return
      log('info', `Wake word heard (${secs(r.audioMs)} s audio, ${secs(performance.now() - heardAt)} s to recognise): "${r.text}"`)
      if (w.command) {
        talking.current = true
        try { await runCommand(w.command, () => restRef.current(), () => setMuted(true), heardAt, true) } finally { talking.current = false }
        return
      }
      // Only his name: answer, then listen for the request.
      talking.current = true
      try {
        setCore('speaking', 'Yes, sir?')
        await speak('Yes, sir?')
      } finally { talking.current = false }
      if (alive) await talkRef.current(true)
    }
    // Two claps open a short window for "Wake up, Jarvis". Anything else said in it is dropped.
    const onClaps = async () => {
      talking.current = true
      try {
        log('info', 'Two claps heard: listening for "Wake up, Jarvis"')
        setCore('listening', 'Claps heard · say "Wake up, Jarvis"')
        const c = await micRef.current.capture()
        const heardAt = performance.now()
        if ('none' in c) { setCore(restRef.current()); return }
        const r = await transcribe(c.pcm, 'whisper', false)
        const w = heardWake(r.text)
        const said = r.text.toLowerCase()
        if (/\bwake\b|\bawake\b|daddy'?s home/.test(said)) await runCommand('wake up', () => restRef.current(), () => setMuted(true), heardAt, true)
        else if (w?.command) await runCommand(w.command, () => restRef.current(), () => setMuted(true), heardAt, true)
        else { log('info', 'No wake-up command followed the claps'); setCore(restRef.current()) }
      } finally { talking.current = false }
    }
    void (async () => {
      log('info', 'Wake word on: say "Hey Jarvis". Speech is checked on this PC and dropped unless it starts with his name')
      while (alive) {
        if (!atRest()) { await pause(80); continue }
        if (!(await micRef.current.start())) { log('warn', 'Wake word unavailable: the microphone could not be opened'); return }
        if (!alive) return
        // Stop waiting if JARVIS becomes busy (a typed command, his own voice), so he never hears himself.
        const guard = window.setInterval(() => { if (!atRest()) micRef.current.cancelCapture() }, 200)
        const c = await micRef.current.capture({ wake: true })
        window.clearInterval(guard)
        if (!alive) return
        if ('none' in c) {
          if (c.none === 'claps' && atRest()) { try { await onClaps() } catch (e) { log('warn', `Clap window failed: ${String(e)}`) } }
          else await pause(40)
          continue
        }
        if (!atRest() || c.voiced < 0.15) continue // a click or a thump, not speech
        try { await onPhrase(c.pcm, c.seconds) } catch (e) { log('warn', `Wake word check failed: ${String(e)}`); await pause(2000) }
      }
    })()
    return () => {
      alive = false
      micRef.current.cancelCapture()
      if (!talking.current && micRef.current.state === 'live') micRef.current.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeOn, muted])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === 'Space' && !e.repeat) { e.preventDefault(); void talkRef.current() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = cmd.trim()
    if (!text) return
    setCmd('')
    void runCommand(text, restState, () => { if (mic.state === 'live') mic.stop(); setMuted(true) })
  }

  const meta = STATE_META[core.state]
  const sttEngine = sttEnginePref.use()
  const model = useModelState()
  // Live facts for the model, read at the moment a question is asked (never cached or invented).
  const facts = useRef<() => Record<string, string | null>>(() => ({}))
  facts.current = () => ({
    'Time': `${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}, ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`,
    'CPU load': tele ? `${Math.round(tele.cpuPct)}% (includes JARVIS's own speech and reasoning while it works)` : null,
    'Memory': tele ? `${fmtBytes(tele.memUsed)} of ${fmtBytes(tele.memTotal, 0)} used` : null,
    'Drive C': tele?.diskTotal ? `${Math.round(((tele.diskUsed ?? 0) / tele.diskTotal) * 100)}% full, ${fmtBytes(tele.diskTotal - (tele.diskUsed ?? 0))} free` : null,
    'Battery': battery ? `${battery.level}%${battery.charging ? ', charging' : ', on battery'}` : null,
    'Wi-Fi': wifi ? (wifi.state?.toLowerCase() === 'connected' ? `${wifi.ssid ?? 'connected'}, ${wifi.signalPct ?? '?'}% signal` : wifi.state) : null,
    'Internet': net.online ? 'online' : 'offline',
    'Microphone': muted ? 'privacy mute on' : null,
  })
  useEffect(() => { setContextProvider(() => facts.current()) }, [])
  // Real readiness, not a fixed string: speech needs the desktop app; the language model isn't built yet.
  const statusLine = [
    !NATIVE ? 'Speech needs the desktop app' : muted ? 'Microphone muted' : wakeOn ? 'Say "Hey Jarvis" · checked on this PC, nothing kept · or press TALK' : `Speech ready · ${sttEngine === 'whisper' ? 'Whisper' : 'Vosk'} · press TALK or Ctrl+Space`,
    !NATIVE ? 'language model needs the desktop app' : model.state === 'ready' ? `reasoning core online` : model.state === 'loading' ? 'reasoning core loading' : model.state === 'unavailable' ? 'reasoning core unavailable' : 'reasoning core starting',
  ].join(' · ')
  const level = core.preview
    ? (['listening', 'transcribing', 'speaking'].includes(core.state) ? 0.55 : 0)
    : core.state === 'speaking' ? speechLevel : core.state === 'listening' ? mic.level : 0
  const [micTone, micText]: [Status, string] = muted ? ['bad', 'MUTED'] : micChip[mic.state]
  const pwr: [Status, string] = battery
    ? [battery.level < 20 && !battery.charging ? 'warn' : 'ok', `${battery.level}%${battery.charging ? ' CHG' : ''}`]
    : ['na', 'N/A']
  const busy = BUSY.includes(core.state)

  // Mirror the real core state to the mini orb window (desktop build only).
  const orbLevel = Math.round(level * 50) / 50
  const lastSent = useRef({ state: core.state, level: orbLevel })
  lastSent.current = { state: core.state, level: orbLevel }
  useEffect(() => {
    if (NATIVE) void emit('core', { state: core.state, level: orbLevel })
  }, [core.state, orbLevel])

  // Desktop start-up: news schedule (only fetches if feeds exist), orb state after a reload, orb at start.
  useEffect(() => {
    if (!NATIVE) return
    const first = !warmed
    void invoke<boolean>('orb_is_open').then((open) => {
      setOrbOpen(open)
      if (!open && orbAtStartPref.get() && first) void invoke('toggle_orb')
    })
    if (warmed) return // once per page load (React's development mode runs effects twice)
    warmed = true
    startNewsSchedule()
    // Load one heavy model at a time so start-up doesn't pin the CPU: voice (~6 s), then reasoning (~30 s).
    // One heavy job at a time: voice, then the instant phrases, then the model, then app phrases while idle.
    const idle = () => REST.includes(getCore().state) && !sttBusy()
    void warmVoice()
      .then(() => prerender(['Yes, sir?', ...FILLERS, "I didn't catch that, sir.", 'Paused.', 'Resuming.', 'Next track, sir.'], idle))
      .finally(() => void warmModel().then(async () => {
        const apps = await invoke<{ id: string; installed: boolean }[]>('apps_list').catch(() => [])
        setInstalledApps(apps.filter((a) => a.installed).map((a) => a.id))
        const n = await prerender(commonPhrases(apps.filter((a) => a.installed).map((a) => a.id)), idle)
        if (n) log('info', `Prepared ${n} instant replies in the JARVIS voice`)
      }))
  }, [])

  // Tray and orb events. Handlers read the latest closures through a ref.
  const toggleMuteRef = useRef(() => {})
  toggleMuteRef.current = toggleMute
  useEffect(() => {
    if (!NATIVE) return
    const offs = [
      listen('orb-ready', () => void emit('core', lastSent.current)),
      listen<boolean>('orb', (e) => { setOrbOpen(e.payload); log('info', e.payload ? 'Mini orb shown' : 'Mini orb hidden') }),
      listen<string>('tray', (e) => {
        if (e.payload === 'mute') toggleMuteRef.current()
        if (e.payload === 'hidden') { setInTray(true); log('info', 'HUD hidden to tray (Quit from the tray menu)') }
        if (e.payload === 'shown') setInTray(false)
      }),
    ]
    return () => offs.forEach((p) => void p.then((f) => f()))
  }, [])
  const pct = (a: number | null | undefined, b: number | null | undefined) => (a != null && b ? Math.round((a / b) * 1000) / 10 : null)
  const memPct = tele ? pct(tele.memUsed, tele.memTotal) : null
  const diskPct = tele ? pct(tele.diskUsed, tele.diskTotal) : null
  const wifiUp = wifi?.state?.toLowerCase() === 'connected'
  const wifiChip: [Status, string] = !NATIVE ? ['na', 'N/A'] : !wifi ? ['na', 'NO ADAPTER'] : wifiUp ? ['good', `${wifi.signalPct ?? '?'}%`] : ['warn', (wifi.state ?? 'DOWN').toUpperCase()]

  return (
    <>
      <div className="backdrop grid" />
      <div className="backdrop vignette" />
      <main className={`hud ${motion === 'still' ? 'reduced-motion' : motion === 'low' ? 'motion-low' : ''} ${['thinking', 'transcribing'].includes(core.state) ? 'cpu-saver' : ''}`}>
        {/* ---------- top status rail ---------- */}
        <header className="rail">
          <div className="brand">
            <span className="brand-mark">J.A.R.V.I.S.</span>
            <span className="brand-sub">LOCAL CORE · FAN BUILD</span>
          </div>
          <div className="clock" aria-live="off">
            <span className="clock-date">{DAYS[now.getDay()]} {pad(now.getDate())} {MONTHS[now.getMonth()]} {now.getFullYear()}</span>
            <span className="clock-time">{pad(now.getHours())}:{pad(now.getMinutes())}<span className="clock-sec">:{pad(now.getSeconds())}</span></span>
          </div>
          <div className="chips">
            <Chip k="CORE" v={meta.label} tone={meta.tone} />
            <Chip k="MIC" v={micText} tone={micTone} />
            <Chip k="NET" v={net.online ? 'ONLINE' : 'OFFLINE'} tone={net.online ? 'good' : 'bad'} />
            <Chip k="WIFI" v={wifiChip[1]} tone={wifiChip[0]} />
            <Chip k="PWR" v={pwr[1]} tone={pwr[0]} />
            <Chip k="MODEL" v="OFFLINE" tone="na" />
          </div>
        </header>

        {/* ---------- left instrument bank ---------- */}
        <aside className="bank" aria-label="Systems">
          <HudPanel code="SYS-01" title="Systems" status={tele ? { tone: 'good', text: `LIVE · ${motion === 'full' ? 1 : 3} S` } : { tone: 'na', text: NATIVE ? 'LINKING' : 'NO NATIVE LINK' }} className="grow">
            <div className="gauges">
              <RingGauge label="CPU" value={tele ? Math.round(tele.cpuPct) : null} caption={tele ? `${tele.cpuThreads} THREADS` : undefined} />
              <RingGauge label="MEMORY" value={memPct != null ? Math.round(memPct) : null} caption={tele ? `${fmtBytes(tele.memUsed)} / ${fmtBytes(tele.memTotal, 0)}` : undefined} />
              <RingGauge label="DISK" value={diskPct != null ? Math.round(diskPct) : null} caption={tele?.diskTotal ? `${tele.diskMount} ${fmtBytes(tele.diskTotal - (tele.diskUsed ?? 0), 0)} FREE` : undefined} />
            </div>
            {tele ? (
              <dl className="kv sys-kv" style={{ margin: 0 }}>
                <dt>PROCESSOR</dt><dd title={tele.cpuName}>{tele.cpuName.replace(/\((R|TM)\)/gi, '').replace(/\b(Intel|CPU)\b|@/gi, '').replace(/\s+/g, ' ').trim().toUpperCase()}</dd>
                <dt>UPTIME</dt><dd>{fmtUptime(tele.uptimeS)}</dd>
              </dl>
            ) : (
              <p className="note sys-kv" style={{ margin: 0 }}>Live CPU, memory and disk readings arrive with the desktop build. Nothing here is simulated.</p>
            )}
          </HudPanel>

          <HudPanel code="NET-02" title="Network" className="fit" status={net.online ? { tone: 'good', text: 'ONLINE' } : { tone: 'bad', text: 'OFFLINE' }}>
            <dl className="kv" style={{ margin: 0 }}>
              <dt>LINK CLASS</dt><dd className={net.type ? '' : 'na'}>{net.type?.toUpperCase() ?? 'N/A'}</dd>
              <dt>DOWNLINK EST.</dt><dd className={net.downlinkMbps != null ? '' : 'na'}>{net.downlinkMbps != null ? `${net.downlinkMbps} Mbps` : 'N/A'}</dd>
              <dt>LATENCY EST.</dt><dd className={net.rttMs != null ? '' : 'na'}>{net.rttMs != null ? `${net.rttMs} ms` : 'N/A'}</dd>
              <dt>DOWN NOW</dt><dd className={tele?.netRxBps != null ? '' : 'na'}>{tele ? fmtRate(tele.netRxBps) : 'NATIVE LINK'}</dd>
              <dt>UP NOW</dt><dd className={tele?.netTxBps != null ? '' : 'na'}>{tele ? fmtRate(tele.netTxBps) : 'NATIVE LINK'}</dd>
            </dl>
          </HudPanel>

          <HudPanel code="AUD-03" title="Audio input" status={{ tone: micTone, text: `MIC ${micText}` }}>
            <Scope analyser={mic.analyser} active={mic.state === 'live' && !inTray && (!wakeOn || core.state === 'listening')} fps={motion === 'full' ? 30 : 12} />
            <Meter value={mic.level} label="Microphone level" />
            <dl className="kv" style={{ margin: 0 }}>
              <dt>DEVICE</dt><dd className={mic.device ? '' : 'na'} title={mic.device ?? undefined}>{muted ? 'BLOCKED (PRIVACY MUTE)' : mic.device ?? 'CLOSED'}</dd>
            </dl>
          </HudPanel>

          <HudPanel code="RND-04" title="Render" className="fit" status={motion === 'full' ? { tone: 'ok', text: 'MEASURED' } : { tone: 'warn', text: MOTION_TEXT[motion] }}>
            <div className="seg" role="radiogroup" aria-label="Motion">
              {MOTION_PREFS.map((p) => (
                <button key={p} type="button" role="radio" aria-checked={motionPref === p} className={motionPref === p ? 'on' : ''}
                  onClick={() => { setMotionPref(p); log('info', `Motion set to ${p.toUpperCase()}`) }}>{p.toUpperCase()}</button>
              ))}
            </div>
            <dl className="kv" style={{ margin: 0 }}>
              <dt>FRAME RATE</dt><dd className={motion === 'full' ? '' : 'na'}>{motion !== 'full' ? 'NOT MEASURED' : fps != null ? `${fps} FPS` : 'MEASURING'}</dd>
              <dt>VIEWPORT</dt><dd>{viewport[0]} × {viewport[1]} · {Math.round(window.devicePixelRatio * 100) / 100}X</dd>
              <dt>CPU THREADS</dt><dd>{navigator.hardwareConcurrency || 'N/A'}</dd>
              <dt>MOTION</dt><dd title={motionPref === 'auto' ? 'Auto: low power on battery, still if Windows asks for reduced motion' : undefined}>
                {MOTION_TEXT[motion]}{motionPref === 'auto' ? ' · AUTO' : ''}
              </dd>
            </dl>
          </HudPanel>
        </aside>

        {screen === 'music' && <MusicScreen />}
        {screen === 'news' && <NewsScreen />}
        {screen === 'settings' && <SettingsScreen />}
        {screen === 'home' && <>
        {/* ---------- central core ---------- */}
        <section className="centre" aria-label="Core" data-state={core.state} style={{ '--level': level.toFixed(3) } as CSSProperties}>
          {core.preview && <div className="preview-banner">DESIGN PREVIEW · SIMULATED STATE · NOT LIVE</div>}
          <div className="reactor-wrap">
            <span className="reticle tl" /><span className="reticle tr" /><span className="reticle bl" /><span className="reticle br" />
            <ReactorCore state={core.state} />
          </div>
          <div className="core-state" role="status">{meta.label}</div>
          <div className="greeting">{greeting(now.getHours())}</div>
          <div className="subline">{core.detail ?? (core.preview ? `Preview of the ${meta.label.toLowerCase()} state · no real event` : statusLine)}</div>
          {core.state === 'awaiting_approval' && core.preview && (
            <ApprovalPanel request={PREVIEW_APPROVAL} preview
              onConfirm={() => log('info', 'Preview: approval confirmed (no action taken)')}
              onCancel={() => log('info', 'Preview: approval cancelled')} />
          )}
        </section>

        {/* ---------- right data bank ---------- */}
        <aside className="bank" aria-label="Intelligence">
          <HudPanel code="PLS-05" title="Pulse"
            status={feeds.length === 0 ? { tone: 'na', text: 'NO FEEDS' } : news.refreshing ? { tone: 'ok', text: 'REFRESHING' } : { tone: 'good', text: `${feeds.length} FEED${feeds.length > 1 ? 'S' : ''}` }}>
            {headlines(news.results, feeds).length === 0 ? (
              <div className="empty">
                <span className="empty-title">{feeds.length === 0 ? 'NO NEWS FEEDS CONFIGURED' : 'NO HEADLINES YET'}</span>
                <span className="note">Headlines appear only after a real feed refresh. Nothing is generated.</span>
                {feeds.length === 0 && <button type="button" className="btn tiny" onClick={() => go('settings')}>ADD FEEDS</button>}
              </div>
            ) : (
              <ul className="list headlines compact">
                {headlines(news.results, feeds).slice(0, 6).map((h, i) => (
                  <li key={`${h.link ?? h.title}-${i}`}>
                    <button type="button" className="row" disabled={!h.link} onClick={() => void openLink(h.link)} title={`${h.source}${h.link ? ' · open in browser' : ''}`}>
                      <span className="row-time">{ago(h.at)}</span>
                      <span className="row-main">{h.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </HudPanel>

          <HudPanel code="CAL-06" title="Schedule" className="fit" status={{ tone: 'na', text: 'NOT LINKED' }}>
            <div className="empty">
              <span className="empty-title">NO CALENDAR CONNECTED</span>
              <span className="note">Optional. Off by default.</span>
            </div>
          </HudPanel>

          <HudPanel code="DEV-07" title="Devices" className="fit" status={NATIVE ? { tone: 'ok', text: 'PARTIAL LINK' } : { tone: 'na', text: 'NO NATIVE LINK' }}>
            <dl className="kv" style={{ margin: 0 }}>
              <dt>WI-FI</dt>
              <dd className={wifiUp ? '' : 'na'} title={wifi?.adapter ?? undefined}>
                {!NATIVE ? 'N/A' : !wifi ? 'NO ADAPTER' : wifiUp ? `${wifi.ssid ?? 'HIDDEN'} · ${wifi.signalPct ?? '?'}% · ${wifi.rxMbps ?? '?'} MBPS` : (wifi.state ?? 'DOWN').toUpperCase()}
              </dd>
              <dt>BLUETOOTH</dt><dd className="na">N/A</dd>
              <dt>AUDIO OUT</dt><dd className="na">N/A</dd>
              <dt>PHONE LINK</dt><dd className="na">N/A</dd>
            </dl>
          </HudPanel>

          <HudPanel code="LOG-08" title="Activity" status={{ tone: 'ok', text: `${activity.length} EVENTS` }} className="grow">
            <ul className="log">
              {activity.map((a) => (
                <li key={a.id}>
                  <time>{pad(a.at.getHours())}:{pad(a.at.getMinutes())}:{pad(a.at.getSeconds())}</time>
                  <span className={a.level === 'warn' ? 'warn' : ''}>{a.text}</span>
                </li>
              ))}
            </ul>
          </HudPanel>
        </aside>
        </>}

        {/* ---------- command rail ---------- */}
        <form className="command" onSubmit={submit}>
          <nav className="dock" aria-label="Screens">
            {SCREENS.map((sc, i) => (
              <button key={sc} type="button" className={screen === sc ? 'on' : ''} aria-current={screen === sc ? 'page' : undefined}
                onClick={() => go(sc)} title={`Ctrl+${i + 1}`}>{sc.toUpperCase()}</button>
            ))}
          </nav>
          <label className="command-label" htmlFor="cmd">COMMAND ›</label>
          <input id="cmd" className="command-input" value={cmd} onChange={(e) => setCmd(e.target.value)}
            placeholder={NATIVE ? 'Type a request, or press TALK / Ctrl+Space and speak' : 'Type a request… (try: what time is it)'} autoComplete="off" spellCheck={false} />
          <div className="btns">
            <button type="button" className={`btn ${mic.capturing ? 'live' : ''}`} aria-pressed={mic.capturing}
              onClick={() => (mic.capturing ? mic.cancelCapture() : void talk())} disabled={muted || mic.state === 'starting' || core.state === 'transcribing'}
              title={muted ? 'Privacy mute is on' : mic.capturing ? 'Cancel' : 'Speak a command (Ctrl+Space). The mic closes when you stop talking.'}>
              {mic.capturing ? 'LISTENING' : core.state === 'transcribing' ? 'WAIT' : 'TALK'}
            </button>
            <button type="button" className={`btn ${muted ? 'amber' : ''}`} aria-pressed={muted} onClick={toggleMute}>
              {muted ? 'UNMUTE' : 'MUTE'}
            </button>
            {NATIVE && (
              <button type="button" className={`btn ${orbOpen ? 'live' : ''}`} aria-pressed={orbOpen}
                onClick={() => void invoke<boolean>('toggle_orb').catch((err) => log('warn', `Orb failed: ${String(err)}`))}
                title="Show or hide the floating mini orb">ORB</button>
            )}
            <button type="button" className="btn" disabled={!busy || core.preview} onClick={stop} title={busy ? 'Stop the current response' : 'Nothing is running'}>STOP</button>
            <button type="submit" className="btn" disabled={!cmd.trim() || core.preview}>SEND</button>
          </div>
        </form>
      </main>
    </>
  )
}
