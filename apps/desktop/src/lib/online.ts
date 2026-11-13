// Services the owner connects himself: YouTube (API key), a news API (key) and Spotify (his own account, PKCE).
// The keys and the Spotify token live on the native side, encrypted by Windows; this file never sees them.
// Every reply reports what the service actually answered. Nothing is claimed to be playing until it is.
import { invoke } from '@tauri-apps/api/core'
import { log } from './activity'
import type { ActionReply } from './actions'

export type OnlineStatus = { youtubeKey: boolean; newsKey: boolean; newsProvider: string | null; spotifyClientId: boolean; spotifyConnected: boolean; spotifyAccount: string | null }
type Reply = { status: number; body: string }

const ok = (text: string): ActionReply => ({ text, outcome: 'success' })
const warn = (text: string): ActionReply => ({ text, outcome: 'warning' })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const json = (r: Reply): any => { try { return JSON.parse(r.body) } catch { return {} } }
const clean = (e: unknown) => String(e).replace(/^Error: /, '').replace(/\.$/, '')

let cached: OnlineStatus | null = null
export async function onlineStatus(fresh = false): Promise<OnlineStatus> {
  if (!cached || fresh) cached = await invoke<OnlineStatus>('online_status')
  return cached
}
export async function setKey(name: 'youtube_key' | 'news_key' | 'news_provider' | 'spotify_client_id', value: string) {
  await invoke('online_set', { name, value })
  log('info', value.trim() ? `Saved: ${name.replace(/_/g, ' ')} (kept encrypted on this PC)` : `Removed: ${name.replace(/_/g, ' ')}`)
  return onlineStatus(true)
}

// ---------- YouTube ----------
const HTML: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }
const unHtml = (s: string) => s.replace(/&(?:amp|quot|#39|lt|gt);/g, (m) => HTML[m])

export const YT_NO_KEY = "I've opened the results; add a YouTube API key in Settings and I'll start videos myself."
export async function youtubePlay(query: string): Promise<ActionReply> {
  const results = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
  const openResults = async (say: string) => {
    try { await invoke('open_link', { url: results }); log('info', `Opened YouTube results for "${query}"`); return warn(say) } catch { return warn("I couldn't open YouTube, sir.") }
  }
  if (!(await onlineStatus()).youtubeKey) return openResults(YT_NO_KEY)
  let r: Reply
  try {
    r = await invoke<Reply>('keyed_get', { service: 'youtube', query: `search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}` })
  } catch (e) {
    log('warn', `YouTube search failed: ${clean(e)}`)
    return openResults("I couldn't reach YouTube's search, sir, so I've opened the results instead.")
  }
  const v = json(r)
  if (r.status !== 200) {
    const reason: string = v?.error?.errors?.[0]?.reason ?? ''
    log('warn', `YouTube search refused (${r.status}${reason ? ` ${reason}` : ''})`)
    if (/quota/i.test(reason)) return openResults("Today's YouTube search allowance is used up, sir, so I've opened the results instead.")
    if (r.status === 400 || r.status === 403) return openResults("YouTube didn't accept the API key, sir. I've opened the results; please check the key in Settings.")
    return openResults(`YouTube answered with an error, sir, code ${r.status}. I've opened the results instead.`)
  }
  const item = v?.items?.[0]
  const id: string | undefined = item?.id?.videoId
  if (!id || !/^[\w-]{6,20}$/.test(id)) return openResults(`YouTube found no video for ${query}, sir. The results page is up.`)
  const title = unHtml(String(item.snippet?.title ?? query))
  try {
    await invoke('open_link', { url: `https://www.youtube.com/watch?v=${id}` })
  } catch { return warn("I found the video but couldn't open the browser, sir.") }
  log('info', `YouTube: opened "${title}" (${id})`)
  return ok(`Playing ${title.replace(/\s*[|([].*$/, '').trim() || title} on YouTube, sir.`)
}

// ---------- Spotify ----------
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export async function connectSpotify(): Promise<string> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)))
  log('info', 'Spotify: waiting for you to approve the connection in the browser')
  try {
    const name = await invoke<string>('spotify_connect', { verifier, challenge, state })
    log('info', `Spotify connected: ${name}`)
    return name
  } finally { await onlineStatus(true) }
}
export async function disconnectSpotify() {
  await invoke('spotify_disconnect')
  log('info', 'Spotify disconnected; the saved sign-in was deleted')
  return onlineStatus(true)
}

const sp = (method: string, path: string, body?: unknown) =>
  invoke<Reply>('spotify_api', { method, path, body: body === undefined ? null : JSON.stringify(body) })

type Device = { id: string | null; name: string; is_active: boolean; is_restricted: boolean }
async function devices(): Promise<Device[]> {
  const r = await sp('GET', '/v1/me/player/devices')
  return r.status === 200 ? ((json(r).devices ?? []) as Device[]).filter((d) => d.id && !d.is_restricted) : []
}
/** An active device, or any available one; starts the Spotify app and waits for it when there is none. */
async function findDevice(launch: boolean): Promise<Device | null> {
  // This PC first: an idle phone that Spotify still lists as "active" accepts requests and plays nothing.
  const pc = (x: Device) => (x as { type?: string }).type === 'Computer'
  const pick = (d: Device[]) => d.find((x) => x.is_active && pc(x)) ?? d.find(pc) ?? d.find((x) => x.is_active) ?? d[0] ?? null
  let d = pick(await devices())
  if (d || !launch) return d
  try { await invoke('app_open', { id: 'spotify' }); log('info', 'Spotify: no device was ready, so the app was started') } catch (e) {
    log('warn', `Could not start Spotify: ${clean(e)}`)
    return null
  }
  for (let i = 0; i < 12 && !d; i++) { await wait(1000); d = pick(await devices()) }
  return d
}

export const SPOTIFY_IDLE = "Spotify took the request but didn't start, sir. Press play once in the Spotify window, then ask me again."
const NOT_CONNECTED = "Spotify isn't connected yet, sir. Add your Client ID and press Connect in Settings, then I can start the exact track."
const fail = (r: Reply, what: string): ActionReply => {
  const v = json(r)
  const reason: string = v?.error?.reason ?? ''
  log('warn', `Spotify ${what} refused (${r.status}${reason ? ` ${reason}` : ''})`)
  if (r.status === 403 && /PREMIUM/i.test(reason + v?.error?.message)) return warn('Spotify says playback control needs a Premium account, sir.')
  if (r.status === 403) return warn(`Spotify refused that, sir: ${String(v?.error?.message ?? 'not allowed').replace(/\.$/, '')}.`)
  if (r.status === 429) return warn('Spotify asked me to slow down, sir. Try again in a moment.')
  return warn(`Spotify answered with an error, sir, code ${r.status}.`)
}

/** Start playback and confirm Spotify accepted it. `body`: {uris:[...]} or {context_uri}. */
async function start(body: Record<string, unknown>, done: string): Promise<ActionReply> {
  let dev = await findDevice(true)
  if (!dev) {
    const who = (await onlineStatus()).spotifyAccount
    return warn(`Spotify shows no player for the account I'm connected to${who ? `, ${who}` : ''}, sir. The Spotify app on this PC is probably signed in to a different account.`)
  }
  let r = await sp('PUT', `/v1/me/player/play?device_id=${encodeURIComponent(dev.id!)}`, body)
  if (r.status === 404) { // the device went away: bring Spotify up and try once more
    await wait(1500)
    dev = await findDevice(true)
    if (!dev) return warn("Spotify's player went away, sir. Open it once and ask me again.")
    r = await sp('PUT', `/v1/me/player/play?device_id=${encodeURIComponent(dev.id!)}`, body)
  }
  if (r.status !== 204 && r.status !== 202 && r.status !== 200) return fail(r, 'playback')
  // Spotify saying "accepted" is not the same as music playing: look at the player before claiming it.
  const playing = async () => { const p = await sp('GET', '/v1/me/player'); return p.status === 200 && json(p)?.is_playing === true }
  let on = false
  for (let i = 0; i < 6 && !on; i++) {
    await wait(700)
    on = await playing()
    // a player that was asleep often takes the first request only as a wake-up: ask once more
    if (!on && i === 2) await sp('PUT', `/v1/me/player/play?device_id=${encodeURIComponent(dev.id!)}`, body)
  }
  if (!on) {
    log('warn', `Spotify accepted the request but nothing started playing (on ${dev.name})`)
    return warn(SPOTIFY_IDLE)
  }
  log('info', `Spotify: ${done.replace(/, sir\.$/, '')} (on ${dev.name})`)
  return ok(done)
}

async function guard(run: () => Promise<ActionReply>): Promise<ActionReply> {
  if (!(await onlineStatus()).spotifyConnected) return warn(NOT_CONNECTED)
  try { return await run() } catch (e) {
    const msg = clean(e)
    log('warn', `Spotify failed: ${msg}`)
    if (/not connected|connect again/i.test(msg)) { await onlineStatus(true); return warn(`${msg.replace(/^\w/, (c) => c.toUpperCase())}, sir.`) }
    return warn(`I couldn't reach Spotify, sir: ${msg}.`)
  }
}

export const spotifyConnected = async () => (await onlineStatus()).spotifyConnected

export const spotifyTrack = (query: string) => guard(async () => {
  const m = query.match(/^(.+?) by (.+)$/)
  const q = m ? `${m[1]} ${m[2]}` : query
  const r = await sp('GET', `/v1/search?type=track&limit=1&q=${encodeURIComponent(q)}`)
  if (r.status !== 200) return fail(r, 'search')
  const t = json(r)?.tracks?.items?.[0]
  if (!t?.uri) return warn(`Spotify found nothing for ${query}, sir.`)
  // Kept short: every spoken word costs about half a second before he can start talking.
  const artist: string = t.artists?.[0]?.name ?? ''
  const title = String(t.name).replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+-\s+.*$/, '').trim() || String(t.name)
  return start({ uris: [t.uri] }, `Playing ${title}${artist ? ` by ${artist}` : ''}, sir.`)
})

export const spotifyLiked = () => guard(async () => {
  const r = await sp('GET', '/v1/me/tracks?limit=50')
  if (r.status !== 200) return fail(r, 'liked songs')
  const uris: string[] = (json(r).items ?? []).map((i: { track?: { uri?: string } }) => i.track?.uri).filter(Boolean)
  if (!uris.length) return warn('Your liked songs list is empty, sir.')
  return start({ uris }, 'Playing your liked songs, sir.')
})

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
export const spotifyPlaylist = (name: string) => guard(async () => {
  const r = await sp('GET', '/v1/me/playlists?limit=50')
  if (r.status !== 200) return fail(r, 'playlists')
  const lists: { name: string; uri: string }[] = json(r).items ?? []
  const want = words(name)
  const hit = lists.find((p) => words(p.name) === want) ?? lists.find((p) => words(p.name).includes(want)) ?? lists.find((p) => want.split(' ').every((w) => words(p.name).includes(w)))
  if (!hit) return warn(`I couldn't find a playlist called ${name} in your library, sir.`)
  return start({ context_uri: hit.uri }, `Playing your playlist ${hit.name}, sir.`)
})

/** Transport through Spotify's own API. Null when Spotify isn't the connected, active player (the caller falls back). */
export async function spotifyTransport(action: 'pause' | 'play' | 'next' | 'prev'): Promise<ActionReply | null> {
  if (!(await onlineStatus()).spotifyConnected) return null
  try {
    const d = (await devices()).find((x) => x.is_active)
    if (!d) return null
    const r = action === 'pause' ? await sp('PUT', '/v1/me/player/pause') : action === 'play' ? await sp('PUT', '/v1/me/player/play')
      : await sp('POST', action === 'next' ? '/v1/me/player/next' : '/v1/me/player/previous')
    if (r.status !== 204 && r.status !== 202 && r.status !== 200) return r.status === 403 && action !== 'next' && action !== 'prev' ? null : fail(r, action)
    log('info', `Spotify: ${action}`)
    return ok(action === 'pause' ? 'Paused.' : action === 'play' ? 'Resuming.' : action === 'next' ? 'Next track, sir.' : 'Previous track, sir.')
  } catch { return null }
}

export const spotifyShuffle = (on: boolean) => guard(async () => {
  const d = await findDevice(false)
  if (!d) return warn('Spotify has nothing playing at the moment, sir.')
  const r = await sp('PUT', `/v1/me/player/shuffle?state=${on}&device_id=${encodeURIComponent(d.id!)}`)
  if (r.status !== 204 && r.status !== 202 && r.status !== 200) return fail(r, 'shuffle')
  log('info', `Spotify: shuffle ${on ? 'on' : 'off'}`)
  return ok(on ? 'Shuffle is on, sir.' : 'Shuffle is off, sir.')
})

export const spotifyVolume = (percent: number) => guard(async () => {
  const d = await findDevice(false)
  if (!d) return warn('Spotify has nothing playing at the moment, sir.')
  const r = await sp('PUT', `/v1/me/player/volume?volume_percent=${Math.round(percent)}&device_id=${encodeURIComponent(d.id!)}`)
  if (r.status !== 204 && r.status !== 202 && r.status !== 200) return fail(r, 'volume')
  log('info', `Spotify volume ${Math.round(percent)}%`)
  return ok(`Spotify volume ${Math.round(percent)} percent.`)
})

// ---------- news API ----------
export type Headline = { title: string; link: string | null; source: string | null; published: string | null }
/** Headlines from the owner's news API, or null when no key is set. `topic` empty = top stories for India. */
export async function keyedNews(topic: string): Promise<{ provider: string; items: Headline[] } | null> {
  const s = await onlineStatus()
  if (!s.newsKey) return null
  const provider = s.newsProvider ?? 'newsapi'
  const q = encodeURIComponent(topic)
  const query = provider === 'gnews' ? (topic ? `search?q=${q}&lang=en&max=5&sortby=publishedAt` : 'top-headlines?lang=en&country=in&max=5')
    : provider === 'newsdata' ? (topic ? `latest?language=en&q=${q}` : 'latest?language=en&country=in')
    : (topic ? `everything?q=${q}&language=en&pageSize=5&sortBy=publishedAt` : 'top-headlines?country=in&pageSize=5')
  const r = await invoke<Reply>('keyed_get', { service: provider, query })
  const v = json(r)
  if (r.status !== 200) throw new Error(`the news service answered ${r.status}${v?.message ? `: ${String(v.message).slice(0, 120)}` : v?.errors ? `: ${JSON.stringify(v.errors).slice(0, 120)}` : ''}`)
  const raw: any[] = v.articles ?? v.results ?? []
  const items = raw.map((a): Headline => ({
    title: String(a.title ?? '').replace(/\s+-\s+[^-]{2,40}$/, ''), link: a.url ?? a.link ?? null,
    source: a.source?.name ?? a.source_name ?? a.source_id ?? null, published: a.publishedAt ?? a.pubDate ?? null,
  })).filter((a) => a.title && a.title !== '[Removed]')
  return { provider: provider === 'gnews' ? 'GNews' : provider === 'newsdata' ? 'NewsData' : 'NewsAPI', items }
}
