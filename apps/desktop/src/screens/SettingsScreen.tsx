// Settings: everything here is stored on this PC only.
import { useEffect, useState, type FormEvent } from 'react'
import { HudPanel } from '../components/hud'
import { ConnectionsPanel, ContactsPanel } from './ConnectionsPanels'
import { log } from '../lib/activity'
import { NATIVE } from '../lib/native'
import { FEED_PRESETS, refreshNews } from '../lib/news'
import { useInstalledApps, webSearchPref, feedsPref, jarvisVoicePref, orbAtStartPref, sttComparePref, wakePref, sttEnginePref, voiceEnginePref, voiceFxPref, voicePref, type SttEngine } from '../lib/prefs'
import { invoke } from '@tauri-apps/api/core'
import { useModelState } from '../lib/llm'
import { ENGINE_LABEL, sttEngines, useSttHistory, type EngineInfo } from '../lib/stt'
import { MOTION_PREFS, setMotionPref, useMotionPref, type MotionPref } from '../lib/settings'
import { JARVIS_VOICES, previewVoice, speak, stopSpeaking, useLocalVoices, warmVoice } from '../lib/speech'

const MOTION_HELP: Record<MotionPref, string> = {
  auto: 'Full on mains power, low power on battery, still if Windows asks for reduced motion.',
  full: 'Everything moves all the time. Uses the most power.',
  low: 'The core rests still when idle and moves only while JARVIS is working.',
  still: 'No animation at all.',
}

export function SettingsScreen() {
  return (
    <div className="screen screen-settings">
      <MotionPanel />
      <VoicePanel />
      <FeedsPanel />
      <DesktopPanel />
      <PrivacyPanel />
      <SpeechPanel />
      <ConnectionsPanel />
      <ContactsPanel />
    </div>
  )
}

function MotionPanel() {
  const pref = useMotionPref()
  return (
    <HudPanel code="SET-01" title="Motion" status={{ tone: 'ok', text: pref.toUpperCase() }}>
      <div className="seg" role="radiogroup" aria-label="Motion">
        {MOTION_PREFS.map((p) => (
          <button key={p} type="button" role="radio" aria-checked={pref === p} className={pref === p ? 'on' : ''}
            onClick={() => { setMotionPref(p); log('info', `Motion set to ${p.toUpperCase()}`) }}>{p.toUpperCase()}</button>
        ))}
      </div>
      <dl className="help">
        {MOTION_PREFS.map((p) => <div key={p} className={pref === p ? 'on' : ''}><dt>{p.toUpperCase()}</dt><dd>{MOTION_HELP[p]}</dd></div>)}
      </dl>
    </HudPanel>
  )
}

function VoicePanel() {
  const engine = voiceEnginePref.use()
  const jv = jarvisVoicePref.use()
  const fx = voiceFxPref.use()
  const winVoices = useLocalVoices()
  const chosen = voicePref.use()
  const [testing, setTesting] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const preview = async (id: string, name: string) => {
    if (playing === id) { stopSpeaking(); setPlaying(null); return }
    setPlaying(id)
    const r = await previewVoice(id, name)
    if (r === 'error') log('warn', `Could not play ${name}`)
    setPlaying((p) => (p === id ? null : p))
  }
  const [helper, setHelper] = useState<{ available: boolean; running: boolean } | null>(null)
  useEffect(() => { if (NATIVE) void invoke<{ available: boolean; running: boolean }>('tts_info').then(setHelper).catch(() => setHelper(null)) }, [engine, testing])
  const jarvisOk = NATIVE && helper?.available !== false
  const effectiveWin = winVoices.find((v) => v.name === chosen) ? chosen : ''
  const test = async () => {
    setTesting(true)
    const r = await speak('Good evening. All systems are online, and I am at your service.')
    if (r !== 'done' && r !== 'interrupted') log('warn', `Voice test: ${r}`)
    setTesting(false)
  }
  return (
    <HudPanel code="SET-02" title="Voice" status={engine === 'jarvis' && jarvisOk ? { tone: 'good', text: helper?.running ? 'JARVIS · READY' : 'JARVIS · LOADING' } : { tone: 'ok', text: 'WINDOWS' }}>
      <div className="seg two" role="radiogroup" aria-label="Voice engine">
        <button type="button" role="radio" aria-checked={engine === 'jarvis'} className={engine === 'jarvis' ? 'on' : ''} disabled={!jarvisOk}
          onClick={() => { voiceEnginePref.set('jarvis'); warmVoice(); log('info', 'Voice: JARVIS (British)') }}>JARVIS VOICE</button>
        <button type="button" role="radio" aria-checked={engine === 'windows'} className={engine === 'windows' ? 'on' : ''}
          onClick={() => { voiceEnginePref.set('windows'); log('info', 'Voice: Windows') }}>WINDOWS VOICE</button>
      </div>
      {engine === 'jarvis' ? (
        <>
          <ul className="list choices" style={{ flex: '0 0 auto' }}>
            {JARVIS_VOICES.map((v) => (
              <li key={v.id}>
                <label className="choice">
                  <input type="radio" name="jvoice" checked={jv === v.id} onChange={() => { jarvisVoicePref.set(v.id); log('info', `JARVIS voice: ${v.name}`) }} />
                  <span>{v.name}</span>
                  <span className="row-sub">{v.note}</span>
                  <button type="button" className={`btn tiny ${playing === v.id ? 'live' : ''}`} disabled={!jarvisOk}
                    onClick={(e) => { e.preventDefault(); void preview(v.id, v.name) }} aria-label={`Play a sample of ${v.name}`}>
                    {playing === v.id ? '■ STOP' : '▶ PLAY'}
                  </button>
                </label>
              </li>
            ))}
          </ul>
          <label className="choice">
            <input type="checkbox" checked={fx} onChange={(e) => voiceFxPref.set(e.target.checked)} />
            <span>AI FINISH</span>
            <span className="row-sub">EQ, light doubling, small room</span>
          </label>
        </>
      ) : winVoices.length === 0 ? (
        <div className="empty"><span className="empty-title">NO OFFLINE ENGLISH VOICES</span></div>
      ) : (
        <ul className="list choices">
          <li><label className="choice"><input type="radio" name="voice" checked={effectiveWin === ''} onChange={() => voicePref.set('')} /><span>AUTOMATIC</span><span className="row-sub">Prefers a male voice</span></label></li>
          {winVoices.map((v) => (
            <li key={v.name}>
              <label className="choice">
                <input type="radio" name="voice" checked={effectiveWin === v.name} onChange={() => { voicePref.set(v.name); log('info', `Voice set to ${v.name}`) }} />
                <span>{v.name.replace(/^Microsoft /, '').replace(/ - .*$/, '').toUpperCase()}</span>
                <span className="row-sub">{v.lang}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="toolbar">
        <span className="note">{engine === 'jarvis' ? 'Original voices (Kokoro), made on this PC.' : 'Installed Windows voices, offline.'}</span>
        <button type="button" className="btn" disabled={testing} onClick={() => void test()}>{testing ? 'SPEAKING' : 'TEST'}</button>
      </div>
    </HudPanel>
  )
}

function FeedsPanel() {
  const feeds = feedsPref.use()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const add = (f: { url: string; name: string }) => {
    if (feeds.some((x) => x.url === f.url)) return
    feedsPref.set([...feeds, f])
    log('info', `Feed added: ${f.name}`)
    void refreshNews()
  }
  const remove = (u: string) => {
    const f = feeds.find((x) => x.url === u)
    feedsPref.set(feeds.filter((x) => x.url !== u))
    if (f) log('info', `Feed removed: ${f.name}`)
    void refreshNews()
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const u = url.trim()
    let host = ''
    try { const p = new URL(u); if (p.protocol !== 'https:') throw new Error(); host = p.hostname } catch { setErr('Enter a full https:// feed address'); return }
    if (feeds.some((x) => x.url === u)) { setErr('Already added'); return }
    setErr(null)
    add({ url: u, name: name.trim() || host.replace(/^www\./, '') })
    setUrl(''); setName('')
  }
  const presets = FEED_PRESETS.filter((p) => !feeds.some((f) => f.url === p.url))
  return (
    <HudPanel code="SET-03" title="News feeds" status={{ tone: feeds.length ? 'ok' : 'na', text: `${feeds.length} ADDED` }}>
      {feeds.length > 0 && (
        <ul className="list">
          {feeds.map((f) => (
            <li key={f.url} className="feed-row">
              <span className="row-main">{f.name}</span>
              <span className="row-sub" title={f.url}>{f.url.replace(/^https:\/\//, '')}</span>
              <button type="button" className="btn tiny" onClick={() => remove(f.url)} aria-label={`Remove ${f.name}`}>REMOVE</button>
            </li>
          ))}
        </ul>
      )}
      {presets.length > 0 && (
        <div className="presets">
          {presets.map((p) => <button key={p.url} type="button" className="btn tiny" onClick={() => add(p)}>+ {p.name.toUpperCase()}</button>)}
        </div>
      )}
      <form className="feed-form" onSubmit={submit}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… feed address (RSS or Atom)" aria-label="Feed address" spellCheck={false} />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Feed name" />
        <button type="submit" className="btn" disabled={!url.trim()}>ADD</button>
      </form>
      {err && <p className="note" style={{ margin: 0 }}><b>{err}</b></p>}
      <p className="note" style={{ margin: 0 }}>None are added by default. Each feed is fetched straight from its site when you refresh, and every 30 minutes while JARVIS runs.</p>
    </HudPanel>
  )
}

const APP_LABEL: Record<string, string> = { vscode: 'VS Code', mediaplayer: 'Media Player', taskmanager: 'Task Manager', explorer: 'File Explorer', snipping: 'Snipping Tool', whatsapp: 'WhatsApp', powerpoint: 'PowerPoint' }

function DesktopPanel() {
  const orbAtStart = orbAtStartPref.use()
  const model = useModelState()
  const apps = useInstalledApps()
  return (
    <HudPanel code="SET-04" title="Desktop" status={NATIVE ? { tone: 'ok', text: 'DESKTOP APP' } : { tone: 'na', text: 'BROWSER PREVIEW' }}>
      <label className="choice">
        <input type="checkbox" checked={orbAtStart} disabled={!NATIVE} onChange={(e) => orbAtStartPref.set(e.target.checked)} />
        <span>OPEN MINI ORB AT START</span>
      </label>
      <dl className="kv" style={{ margin: 0 }}>
        <dt>CLOSE BUTTON</dt><dd>HIDES TO TRAY</dd>
        <dt>QUIT</dt><dd>TRAY MENU › QUIT JARVIS</dd>
        <dt>SCREENS</dt><dd>CTRL+1 … CTRL+4</dd>
        <dt>APPS I CAN OPEN</dt><dd className={apps.length ? '' : 'na'} title={apps.join(', ')}>{NATIVE ? (apps.length ? `${apps.length} FOUND` : 'CHECKING') : 'N/A'}</dd>
        <dt>START WITH WINDOWS</dt><dd className="na">NOT AVAILABLE YET</dd>
        <dt>VERSION</dt><dd>0.1.0 · {NATIVE ? 'DESKTOP (TAURI 2)' : 'BROWSER PREVIEW'}</dd>
        <dt>LANGUAGE MODEL</dt><dd className={model.state === 'ready' ? '' : 'na'} title={model.name}>{model.state === 'ready' ? model.name.replace(/-Q\d.*$/, '').replace(/-/g, ' ').toUpperCase() : model.state.toUpperCase()}</dd>
      </dl>
      <p className="note" style={{ margin: 0 }}>
        {apps.length > 0 && <>Say "open …" for: {apps.map((a) => APP_LABEL[a] ?? a.charAt(0).toUpperCase() + a.slice(1)).join(', ')}. </>}
        Unofficial fan project, not affiliated with Marvel or Disney. Original artwork. Licences: THIRD_PARTY_NOTICES.md.
      </p>
    </HudPanel>
  )
}

function PrivacyPanel() {
  const web = webSearchPref.use()
  return (
    <HudPanel code="SET-05" title="Privacy" status={{ tone: 'good', text: 'LOCAL FIRST' }}>
      <dl className="kv facts" style={{ margin: 0 }}>
        <dt>MICROPHONE</dt><dd>Open while the wake word is on; speech not starting with "Jarvis" is dropped unseen.</dd>
        <dt>SPEECH</dt><dd>Recognised on this PC. Audio is never saved or sent.</dd>
        <dt>VOICE OUTPUT</dt><dd>Made on this PC (JARVIS voice) or installed Windows voices.</dd>
        <dt>INTERNET</dt><dd>News feeds you add; weather, Wikipedia and searches when you ask. Spotify and YouTube are contacted only when you ask to play something.</dd>
        <dt>WEB SEARCH</dt><dd>Web questions are sent to DuckDuckGo (Wikipedia if it is busy); pages are read directly. Nothing of yours is added to a query.{' '}
          <button type="button" className="btn tiny" onClick={() => webSearchPref.set(web === 'auto' ? 'off' : 'auto')}>{web === 'auto' ? 'AUTO · TURN OFF' : 'OFF · TURN ON'}</button></dd>
        <dt>KEYS</dt><dd>Encrypted by Windows on this PC. Never shown, logged or sent anywhere but their own service.</dd>
        <dt>MUSIC</dt><dd>Read from Windows on this PC.</dd>
        <dt>SETTINGS</dt><dd>Stored on this PC only.</dd>
        <dt>REASONING</dt><dd>Local model on this PC. Conversation kept in memory only.</dd>
        <dt>ANALYTICS</dt><dd>None.</dd>
      </dl>
    </HudPanel>
  )
}

const ENGINE_HELP: Record<SttEngine, string> = {
  vosk: 'Small Indian-English model. Lighter on memory; may miss unusual words.',
  whisper: 'Whisper base.en. Most accurate, adds punctuation; about half a second per command here.',
}

function SpeechPanel() {
  const engine = sttEnginePref.use()
  const compare = sttComparePref.use()
  const wake = wakePref.use()
  const history = useSttHistory()
  const [info, setInfo] = useState<EngineInfo[] | null>(null)
  useEffect(() => { if (NATIVE) void sttEngines().then(setInfo).catch(() => setInfo([])) }, [history.length])
  const avail = (id: SttEngine) => info?.find((e) => e.id === id)
  return (
    <HudPanel code="SET-06" title="Speech" status={NATIVE ? { tone: 'good', text: 'LOCAL' } : { tone: 'na', text: 'DESKTOP ONLY' }}>
      <ul className="list choices" style={{ flex: '0 0 auto' }}>
        {(['vosk', 'whisper'] as SttEngine[]).map((id) => {
          const a = avail(id)
          return (
            <li key={id}>
              <label className="choice" title={ENGINE_HELP[id]}>
                <input type="radio" name="stt" checked={engine === id} disabled={!NATIVE || a?.available === false}
                  onChange={() => { sttEnginePref.set(id); log('info', `Speech engine set to ${ENGINE_LABEL[id]}`) }} />
                <span>{ENGINE_LABEL[id]}</span>
                <span className="row-sub">{!a ? '' : !a.available ? 'MODEL MISSING' : a.loaded ? 'LOADED' : 'LOADS ON FIRST USE'}</span>
              </label>
            </li>
          )
        })}
      </ul>
      <p className="note" style={{ margin: 0 }}>{ENGINE_HELP[engine]}</p>
      <label className="choice" title="The microphone stays open. Speech is checked on this PC and dropped unless it starts with his name. Nothing is recorded or stored.">
        <input type="checkbox" checked={wake} disabled={!NATIVE}
          onChange={(e) => { wakePref.set(e.target.checked); log('info', e.target.checked ? 'Wake word switched on' : 'Wake word switched off: press TALK to speak') }} />
        <span>ANSWER TO "HEY JARVIS" (HANDS-FREE)</span>
      </label>
      <label className="choice">
        <input type="checkbox" checked={compare} disabled={!NATIVE} onChange={(e) => sttComparePref.set(e.target.checked)} />
        <span>COMPARE BOTH ON EACH COMMAND</span>
      </label>
      {history.length === 0 ? (
        <p className="note" style={{ margin: 0 }}>Press TALK or Ctrl+Space and speak. Results and timings appear here and in the activity log.</p>
      ) : (
        <ul className="list stt-history">
          {history.map((h, i) => (
            <li key={i} className="feed-row">
              <span className="row-main">{h.text ? `"${h.text}"` : '(nothing recognised)'}</span>
              <span className="row-tag s-ok">{ENGINE_LABEL[h.engine]}</span>
              <span className="row-sub">{(h.audioMs / 1000).toFixed(1)} S AUDIO · {(h.decodeMs / 1000).toFixed(1)} S TO RECOGNISE{h.loadMs != null ? ` · +${(h.loadMs / 1000).toFixed(1)} S LOAD` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="note" style={{ margin: 0 }}>Audio stays in memory for one command and is never saved or sent anywhere.</p>
    </HudPanel>
  )
}
