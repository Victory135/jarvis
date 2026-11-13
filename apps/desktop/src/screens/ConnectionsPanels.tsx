// Settings panels for the services the owner connects himself. Keys go straight to the native side, where Windows
// encrypts them for this account; they are never shown again, never logged, and are sent only to their own service.
import { useEffect, useState, type FormEvent } from 'react'
import { HudPanel } from '../components/hud'
import { log } from '../lib/activity'
import { NATIVE } from '../lib/native'
import { connectSpotify, disconnectSpotify, onlineStatus, setKey, type OnlineStatus } from '../lib/online'
import { contactsPref } from '../lib/prefs'

const PROVIDERS: [string, string][] = [['newsapi', 'NEWSAPI.ORG'], ['gnews', 'GNEWS.IO'], ['newsdata', 'NEWSDATA.IO']]

function KeyRow(props: { label: string; saved: boolean; placeholder: string; onSave: (v: string) => Promise<unknown> }) {
  const [v, setV] = useState('')
  const [err, setErr] = useState('')
  const [edit, setEdit] = useState(false)
  const save = async (value: string) => {
    setErr('')
    try { await props.onSave(value); setV(''); setEdit(false) } catch (e) { setErr(String(e)) }
  }
  // A saved key is shown as a filled, locked row, so an empty box is never mistaken for a lost key.
  if (props.saved && !edit) return (
    <div className="feed-form">
      <input type="text" readOnly value={`${props.label}: ●●●●●●●●●●●●  SAVED ✓`} aria-label={`${props.label} is saved`} />
      <button type="button" className="btn" onClick={() => setEdit(true)}>CHANGE</button>
      <button type="button" className="btn tiny" onClick={() => void save('')}>REMOVE</button>
      {err && <p className="note" style={{ margin: 0 }}><b>{err}</b></p>}
    </div>
  )
  return (
    <form className="feed-form" onSubmit={(e: FormEvent) => { e.preventDefault(); if (v.trim()) void save(v) }}>
      <input type="password" autoComplete="off" spellCheck={false} value={v} onChange={(e) => setV(e.target.value)}
        placeholder={props.saved ? `${props.label}: saved (paste a new one to replace)` : props.placeholder} aria-label={props.label} disabled={!NATIVE} />
      <button type="submit" className="btn" disabled={!v.trim() || !NATIVE}>SAVE</button>
      {props.saved && <button type="button" className="btn tiny" onClick={() => { setV(''); setEdit(false) }}>CANCEL</button>}
      {err && <p className="note" style={{ margin: 0 }}><b>{err}</b></p>}
    </form>
  )
}

export function ConnectionsPanel() {
  const [s, setS] = useState<OnlineStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  useEffect(() => { if (NATIVE) void onlineStatus(true).then(setS).catch((e) => setMsg(`Could not read the saved keys: ${String(e)}`)) }, [])
  const connect = async () => {
    setBusy(true)
    setMsg('Approve the connection in the browser tab that just opened.')
    try { const name = await connectSpotify(); setMsg(`Connected as ${name}.`) } catch (e) { setMsg(String(e)); log('warn', `Spotify connection failed: ${String(e)}`) }
    setS(await onlineStatus(true))
    setBusy(false)
  }
  const count = s ? [s.youtubeKey, s.newsKey, s.spotifyConnected].filter(Boolean).length : 0
  return (
    <HudPanel code="SET-07" title="Connections" status={!NATIVE ? { tone: 'na', text: 'DESKTOP APP ONLY' } : { tone: count ? 'good' : 'na', text: `${count} OF 3 CONNECTED` }}>
      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
        <p className="note" style={{ margin: 0 }}><b>SPOTIFY</b> · {s?.spotifyConnected ? `Connected${s.spotifyAccount ? ` as ${s.spotifyAccount}` : ''}` : 'Not connected'}</p>
        <KeyRow label="Spotify Client ID" saved={!!s?.spotifyClientId} placeholder="Spotify Client ID" onSave={async (v) => { const x = await setKey('spotify_client_id', v); setS(x); if (v.trim() && !x.spotifyConnected) setMsg('Client ID saved. Now press CONNECT, then Agree in the browser.') }} />
        <div className="toolbar">
          <span className="note">{msg || 'Premium is needed to start tracks.'}</span>
          {s?.spotifyConnected
            ? <button type="button" className="btn" onClick={() => void disconnectSpotify().then((x) => { setS(x); setMsg('Disconnected; the saved sign-in was deleted.') })}>DISCONNECT</button>
            : <button type="button" className="btn" disabled={!s?.spotifyClientId || busy} onClick={() => void connect()}>{busy ? 'WAITING' : 'CONNECT'}</button>}
        </div>
        <details className="note">
          <summary>How to get the Client ID</summary>
          Sign in at developer.spotify.com, open Dashboard, Create app. Redirect URI: <b>http://127.0.0.1:43821/callback</b>. Tick "Web API". Save, then copy the Client ID here. No client secret is needed.
        </details>

        <p className="note" style={{ margin: 0 }}><b>YOUTUBE</b> · {s?.youtubeKey ? 'Key saved: "play … on YouTube" starts the first result' : 'No key: he opens the results page'}</p>
        <KeyRow label="YouTube API key" saved={!!s?.youtubeKey} placeholder="YouTube Data API key" onSave={async (v) => setS(await setKey('youtube_key', v))} />
        <details className="note">
          <summary>How to create the key</summary>
          Google Cloud Console → new project → APIs &amp; Services → enable "YouTube Data API v3" → Credentials → Create credentials → API key → restrict it to that API. The free allowance is about 100 searches a day.
        </details>

        <p className="note" style={{ margin: 0 }}><b>NEWS API</b> · {s?.newsKey ? 'Key saved: ask "news about …" on any subject' : 'Optional. Without it he reads your RSS feeds.'}</p>
        <div className="seg" role="radiogroup" aria-label="News provider">
          {PROVIDERS.map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={(s?.newsProvider ?? 'newsapi') === id} className={(s?.newsProvider ?? 'newsapi') === id ? 'on' : ''}
              disabled={!NATIVE} onClick={() => void setKey('news_provider', id).then(setS)}>{label}</button>
          ))}
        </div>
        <KeyRow label="News API key" saved={!!s?.newsKey} placeholder="News API key" onSave={async (v) => setS(await setKey('news_key', v))} />
        <p className="note" style={{ margin: 0 }}>Keys are encrypted by Windows on this PC and never shown again. Spotify, YouTube and the news service are contacted only when you ask for them.</p>
      </div>
    </HudPanel>
  )
}

export function ContactsPanel() {
  const contacts = contactsPref.use()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const add = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n || (!phone.trim() && !email.trim())) return
    contactsPref.set([...contacts.filter((c) => c.name.toLowerCase() !== n.toLowerCase()), { name: n, phone: phone.replace(/[^\d+]/g, ''), email: email.trim() }])
    log('info', 'Contact saved on this PC')
    setName(''); setPhone(''); setEmail('')
  }
  return (
    <HudPanel code="SET-08" title="Contacts" status={{ tone: contacts.length ? 'ok' : 'na', text: `${contacts.length} SAVED` }}>
      {contacts.length > 0 && (
        <ul className="list">
          {contacts.map((c) => (
            <li key={c.name} className="feed-row">
              <span className="row-main">{c.name}</span>
              <span className="row-sub">{[c.phone, c.email].filter(Boolean).join(' · ')}</span>
              <button type="button" className="btn tiny" onClick={() => contactsPref.set(contacts.filter((x) => x.name !== c.name))} aria-label={`Remove ${c.name}`}>REMOVE</button>
            </li>
          ))}
        </ul>
      )}
      <form className="feed-form" onSubmit={add}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name as you say it" aria-label="Contact name" />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="WhatsApp number with country code" aria-label="Phone" inputMode="tel" />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" aria-label="Email" />
        <button type="submit" className="btn" disabled={!name.trim() || (!phone.trim() && !email.trim())}>ADD</button>
      </form>
      <p className="note" style={{ margin: 0 }}>Say "message Ravi saying I'm on my way" or "email Ravi saying …". He types it in WhatsApp or Gmail; you press Send. Stored on this PC only.</p>
    </HudPanel>
  )
}
