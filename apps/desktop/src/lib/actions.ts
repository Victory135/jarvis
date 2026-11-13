// Deterministic voice/typed actions, answered instantly without the language model:
// open apps (allowlist on the native side), music transport, system volume, Spotify search, and the
// internet abilities in web.ts (searches, websites, news, weather, quick facts).
// Every reply reports what really happened (the native call's result), never what was merely attempted.
import { invoke } from '@tauri-apps/api/core'
import { log } from './activity'
import { mediaControl, prettyApp, type MediaSession } from './media'
import { knownSite, openSite, tryWeb, WEB_PHRASES } from './web'
import { isName } from './wake'
import { contactsPref } from './prefs'
import { spotifyConnected, spotifyLiked, spotifyPlaylist, spotifyShuffle, spotifyTrack, spotifyTransport, spotifyVolume } from './online'

export type ActionReply = { text: string; outcome: 'success' | 'warning'; action?: 'mute' }

/** Spoken names (including common speech-recognition slips) -> allowlisted app id. Longest names first. */
const ALIASES: [string, string][] = ([
  ['google chrome', 'chrome'], ['chrome', 'chrome'], ['crow', 'chrome'], ['chrom', 'chrome'], ['krome', 'chrome'], ['the browser', 'chrome'], ['browser', 'chrome'],
  ['microsoft edge', 'edge'], ['edge', 'edge'], ['firefox', 'firefox'], ['fire fox', 'firefox'],
  ['spotify', 'spotify'], ['spot ify', 'spotify'], ['spotty fy', 'spotify'], ['spotty fi', 'spotify'],
  ['whatsapp', 'whatsapp'], ['whats app', 'whatsapp'], ["what's app", 'whatsapp'], ['what sap', 'whatsapp'],
  ['discord', 'discord'], ['netflix', 'netflix'],
  ['visual studio code', 'vscode'], ['vs code', 'vscode'], ['vscode', 'vscode'], ['v s code', 'vscode'], ['code editor', 'vscode'],
  ['microsoft word', 'word'], ['ms word', 'word'], ['word', 'word'], ['microsoft excel', 'excel'], ['excel', 'excel'],
  ['powerpoint', 'powerpoint'], ['power point', 'powerpoint'], ['vlc', 'vlc'], ['media player', 'mediaplayer'], ['music player', 'mediaplayer'],
  ['calculator', 'calculator'], ['calc', 'calculator'], ['notepad', 'notepad'], ['note pad', 'notepad'], ['paint', 'paint'],
  ['snipping tool', 'snipping'], ['file explorer', 'explorer'], ['explorer', 'explorer'], ['my files', 'explorer'], ['files', 'explorer'], ['this pc', 'explorer'],
  ['task manager', 'taskmanager'], ['windows settings', 'settings'], ['settings', 'settings'], ['camera', 'camera'], ['photos', 'photos'],
  ['clock', 'clock'], ['alarms', 'clock'], ['mail', 'mail'], ['email', 'mail'], ['calendar', 'calendar'],
] as [string, string][]).sort((a, b) => b[0].length - a[0].length)

const SPOKEN: [RegExp, string][] = [
  [/ (?:you|u) tube /g, ' youtube '], [/ (?:what's up|whats up|what's app|whats app|what sap|watsapp|whatsup) /g, ' whatsapp '], [/ g mail /g, ' gmail '],
  [/ (?:spot if i|spot if y|spotty fi|spotty fy|spot ify|sportify) /g, ' spotify '], [/ (?:insta gram) /g, ' instagram '], [/ (?:face book) /g, ' facebook '],
]

/** Lowercase, drop punctuation, wake words and politeness: "Jarvis, could you open Chrome please?" -> "open chrome". */
export function normalise(input: string): string {
  let t = ' ' + input.toLowerCase().replace(/[’']/g, "'").replace(/[.,!?;:"]+/g, ' ').replace(/\s+/g, ' ').trim() + ' '
  // his name however the speech engine spelt it, and names it tends to split in two
  t = t.replace(/^ (?:(?:hey|ok|okay|hi|hello) )?(\S+) /, (all, w) => (isName(w) ? ' ' : all))
  for (const [re, to] of SPOKEN) t = t.replace(re, to)
  const lead = /^ (?:hey |ok |okay |hi |hello )?(?:jarvis|jervis|travis|jerry's|jarvis's) |^ (?:please|can you|could you|would you|will you|kindly|go ahead and|i want you to|i'd like you to|just) /
  for (let i = 0; i < 6 && lead.test(t); i++) t = t.replace(lead, ' ')
  t = t.replace(/ (?:please|for me|now|right now|jarvis|thanks|thank you)(?= $)/g, ' ').replace(/ (?:please|for me|now|right now|jarvis|thanks|thank you)(?= $)/g, ' ')
  return t.replace(/\s+/g, ' ').trim()
}

function findApp(name: string): string | null {
  const n = ` ${name.replace(/\b(the|my|app|application|program)\b/g, ' ').replace(/\s+/g, ' ').trim()} `
  for (const [alias, id] of ALIASES) if (n.includes(` ${alias} `)) return id
  return null
}

const APP_NAMES: Record<string, string> = {
  chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', spotify: 'Spotify', whatsapp: 'WhatsApp', discord: 'Discord', netflix: 'Netflix',
  vscode: 'VS Code', word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint', vlc: 'VLC', mediaplayer: 'Media Player', calculator: 'Calculator',
  notepad: 'Notepad', paint: 'Paint', snipping: 'the Snipping Tool', explorer: 'File Explorer', taskmanager: 'Task Manager', settings: 'Settings',
  camera: 'the Camera', photos: 'Photos', clock: 'the Clock', mail: 'Mail', calendar: 'the Calendar',
}
export const openingLine = (id: string) => `Opening ${APP_NAMES[id] ?? id}, sir.`

async function openApp(id: string): Promise<ActionReply> {
  try {
    const name = await invoke<string>('app_open', { id })
    log('info', `Opened ${name}`)
    return { text: openingLine(id), outcome: 'success' }
  } catch (e) {
    log('warn', `Could not open ${APP_NAMES[id] ?? id}: ${String(e)}`)
    return { text: `I couldn't open ${APP_NAMES[id] ?? id}, sir. ${String(e).replace(/\.$/, '')}.`, outcome: 'warning' }
  }
}

async function sessions(): Promise<MediaSession[]> {
  try { return (await invoke<{ sessions: MediaSession[] }>('media_status')).sessions } catch { return [] }
}
const currentSession = (s: MediaSession[]) => s.find((x) => x.current) ?? s[0]

async function media(action: 'pause' | 'play' | 'next' | 'prev'): Promise<ActionReply> {
  const s = currentSession(await sessions())
  // Spotify is driven through its own API when it is connected and is the one playing.
  if (!s || /spotify/i.test(s.app)) {
    const viaApi = await spotifyTransport(action)
    if (viaApi) return viaApi
  }
  if (!s) return { text: 'Nothing is playing at the moment, sir.', outcome: 'warning' }
  if (action === 'pause' && s.status !== 'playing') return { text: 'It is already paused, sir.', outcome: 'success' }
  if (action === 'play' && s.status === 'playing') return { text: 'It is already playing, sir.', outcome: 'success' }
  await mediaControl(s.app, action === 'pause' || action === 'play' ? 'toggle' : action)
  const app = prettyApp(s.app)
  log('info', `Media: ${action} (${app})`)
  return { text: action === 'pause' ? 'Paused.' : action === 'play' ? 'Resuming.' : action === 'next' ? 'Next track, sir.' : 'Previous track, sir.', outcome: 'success' }
}

type Vol = { level: number; muted: boolean }
async function volume(change: { to?: number; by?: number; muted?: boolean }): Promise<ActionReply> {
  try {
    const cur = await invoke<Vol>('volume_get')
    // "Up" and "down" move to the next ten (29 -> 20 or 30), so the spoken level is one of the ready-made replies.
    const step = (by: number) => (by > 0 ? Math.floor(cur.level / 10) * 10 + 10 : Math.ceil(cur.level / 10) * 10 - 10)
    const to = change.to ?? (change.by != null ? Math.max(0, Math.min(100, step(change.by))) : undefined)
    // Raising the volume while muted should be audible: unmute too.
    const muted = change.muted ?? (to != null && to > cur.level && cur.muted ? false : undefined)
    const v = await invoke<Vol>('volume_set', { level: to ?? null, muted: muted ?? null })
    log('info', `Volume ${v.level}%${v.muted ? ' (muted)' : ''}`)
    if (change.muted === true) return { text: 'Sound muted.', outcome: 'success' }
    if (change.muted === false && to == null) return { text: 'Sound on, sir.', outcome: 'success' }
    return { text: `Volume ${v.level} percent.`, outcome: 'success' }
  } catch (e) {
    log('warn', `Volume control failed: ${String(e)}`)
    return { text: "I couldn't reach the volume control, sir.", outcome: 'warning' }
  }
}

async function playSpotify(): Promise<ActionReply> {
  let s = (await sessions()).find((x) => /spotify/i.test(x.app))
  if (!s) {
    const opened = await openApp('spotify')
    if (opened.outcome !== 'success') return opened
    for (let i = 0; i < 16 && !s; i++) { await new Promise((r) => setTimeout(r, 500)); s = (await sessions()).find((x) => /spotify/i.test(x.app)) }
    if (!s) return { text: "Spotify is open, sir. It hasn't loaded a track yet, so press play there once.", outcome: 'success' }
  }
  if (s.status !== 'playing') { await mediaControl(s.app, 'toggle'); log('info', 'Media: play (Spotify)') }
  return { text: s.status === 'playing' ? 'Spotify is already playing, sir.' : 'Playing on Spotify, sir.', outcome: 'success' }
}

/** "play X": the exact track through the Spotify connection, or the search page when it isn't connected. */
async function playOnSpotify(query: string): Promise<ActionReply> {
  if (await spotifyConnected()) return spotifyTrack(query)
  try {
    await invoke('spotify_search', { query })
    log('info', `Spotify search: ${query}`)
    return { text: SPOTIFY_SEARCHED, outcome: 'success' }
  } catch (e) {
    return { text: `I couldn't search Spotify, sir. ${String(e).replace(/\.$/, '')}.`, outcome: 'warning' }
  }
}

/** Messages are typed for the owner, never sent: he presses Enter himself. */
async function compose(kind: 'whatsapp' | 'email', who: string, text: string): Promise<ActionReply> {
  const name = who.replace(/^(?:my |the )/, '').trim()
  const c = contactsPref.get().find((x) => x.name.toLowerCase() === name) ?? contactsPref.get().find((x) => x.name.toLowerCase().split(' ').includes(name))
  const body = text.replace(/^\w/, (ch) => ch.toUpperCase())
  const Name = c?.name ?? name.replace(/\b[a-z]/g, (ch) => ch.toUpperCase())
  try {
    if (kind === 'whatsapp') {
      const phone = c?.phone.replace(/\D/g, '') ?? ''
      await invoke('open_link', { url: `https://web.whatsapp.com/send?${phone ? `phone=${phone}&` : ''}text=${encodeURIComponent(body)}` })
      log('info', `WhatsApp message typed for ${Name} (not sent)`)
      return { text: phone ? `Your message to ${Name} is typed in WhatsApp, sir. Press Enter to send it.` : `I don't have a number for ${Name}, sir, so WhatsApp is open with the message ready. Choose the chat and send it.`, outcome: 'success' }
    }
    await invoke('open_link', { url: `https://mail.google.com/mail/?view=cm&fs=1${c?.email ? `&to=${encodeURIComponent(c.email)}` : ''}&body=${encodeURIComponent(body)}` })
    log('info', `Email drafted for ${Name} (not sent)`)
    return { text: c?.email ? `Your email to ${Name} is drafted in Gmail, sir. Review it and press Send.` : `I don't have an address for ${Name}, sir. The draft is open in Gmail; add the address and send it.`, outcome: 'success' }
  } catch (e) {
    return { text: `I couldn't open the message window, sir. ${String(e).replace(/\.$/, '')}.`, outcome: 'warning' }
  }
}

const SPOTIFY_SEARCHED = "The search is up in Spotify, sir. Choosing the track myself needs the Spotify connection, which isn't set up yet."
const WORDS: Record<string, number> = { zero: 0, ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, 'a hundred': 100, 'one hundred': 100, half: 50, max: 100, maximum: 100, full: 100 }
const num = (s: string): number | null => (/^\d+$/.test(s) ? Math.min(100, +s) : s in WORDS ? WORDS[s] : null)

/** Recognise and perform an action. Returns null when the request isn't one of these (it goes to the model). */
export async function tryAction(input: string): Promise<ActionReply | null> {
  const t = normalise(input)
  let m: RegExpMatchArray | null

  // privacy mute (microphone) vs sound mute (speakers) must not be confused
  if (/^(?:mute|turn off|switch off|block|disable) (?:the |my )?(?:mic|microphone)\b|^privacy (?:mode|mute)\b|^stop listening\b/.test(t)) {
    return { text: 'Microphone muted.', outcome: 'success', action: 'mute' }
  }
  if (/^(?:mute|silence)(?: (?:the |my )?(?:sound|volume|audio|speakers?|computer|laptop|pc))?$/.test(t)) return volume({ muted: true })
  if (/^(?:unmute|un mute)(?: (?:the |my )?(?:sound|volume|audio|speakers?))?$|^(?:turn|switch) (?:the )?sound (?:back )?on$/.test(t)) return volume({ muted: false })
  if ((m = t.match(/^(?:set |turn |put |change )?(?:the )?(?:volume|sound)(?: level)? (?:to |at )?(\d{1,3}|[a-z ]+?)(?: percent| %)?$/)) && num(m[1].trim()) != null) return volume({ to: num(m[1].trim())! })
  if (/^(?:(?:turn|crank|bring) (?:the )?(?:volume|sound|it|music) up|volume up|(?:make it |a bit |little )?louder|increase (?:the )?volume|raise (?:the )?volume)\b/.test(t)) return volume({ by: 10 })
  if (/^(?:(?:turn|bring) (?:the )?(?:volume|sound|it|music) down|volume down|(?:make it |a bit |little )?quieter|lower (?:the )?volume|decrease (?:the )?volume|reduce (?:the )?volume)\b/.test(t)) return volume({ by: -10 })
  if (/^(?:max|maximum|full) volume$/.test(t)) return volume({ to: 100 })

  // music
  if (/^(?:pause|stop)(?: (?:the |my )?(?:music|song|track|video|playback|it|this|that|spotify))?$/.test(t)) return media('pause')
  if (/^(?:resume|continue|unpause)(?: .*)?$|^play$|^(?:play|start) (?:it|again|the music|music again)$/.test(t)) return media('play')
  if (/^(?:next|skip)(?: (?:the )?(?:song|track|one|this))?$|^(?:play )?(?:the )?next (?:song|track)$/.test(t)) return media('next')
  if (/^(?:previous|last|go back)(?: (?:the )?(?:song|track|one))?$|^(?:play )?(?:the )?(?:previous|last) (?:song|track)$/.test(t)) return media('prev')
  if (/^play (?:some |something|music|my music|songs)(?: (?:on|from|in|using|with|through) spotify)?$|^play spotify$|^(?:start|put on) (?:some )?music$/.test(t)) return playSpotify()
  if (/^play (?:my )?(?:liked|favou?rite|saved) (?:songs|tracks|music)(?: (?:on|from|in|using|with|through) spotify)?$|^play my likes$/.test(t)) return spotifyLiked()
  if ((m = t.match(/^play (?:my |the )?playlist (.+?)(?: (?:on|from|in|using|with|through) spotify)?$/)) || (m = t.match(/^play (?:my |the )?(.+?) playlist(?: (?:on|from|in|using|with|through) spotify)?$/))) return spotifyPlaylist(m[1])
  if ((m = t.match(/^(?:turn |switch |put )?shuffle (on|off)$|^(?:turn|switch) (on|off) shuffle$|^(shuffle)(?: (?:it|this|the (?:music|songs|playlist)))?$/))) return spotifyShuffle((m[1] ?? m[2] ?? 'on') !== 'off')
  if ((m = t.match(/^(?:set )?spotify volume (?:to )?(\d{1,3})(?: percent)?$/))) return spotifyVolume(Math.min(100, +m[1]))
  if ((m = t.match(/^(?:play|put on) (.+?) (?:on|from|in|using|with|through) spotify$/))) return playOnSpotify(m[1])
  if ((m = t.match(/^(?:search|look up|find) (.+?) (?:on|from|in|using|with|through) spotify$/))) {
    try {
      await invoke('spotify_search', { query: m[1] })
      log('info', `Spotify search: ${m[1]}`)
      return { text: 'The search is up in Spotify, sir.', outcome: 'success' }
    } catch (e) {
      return { text: `I couldn't search Spotify, sir. ${String(e).replace(/\.$/, '')}.`, outcome: 'warning' }
    }
  }

  // messages: typed for him, never sent
  if ((m = t.match(/^(?:send |write |type )?(?:a |an )?(?:whatsapp|whatsapp message|message|text|text message)(?: on whatsapp)? (?:to |for )?(.+?) (?:saying|that says|that|telling (?:him|her|them)(?: that)?|:) (.+)$/))
    || (m = t.match(/^(?:whatsapp|message|text) (.+?) saying (.+)$/))) return compose('whatsapp', m[1], m[2])
  if ((m = t.match(/^(?:send |write |draft )?(?:an |a )?(?:email|mail)(?: to)? (.+?) (?:saying|that says|that|about|:) (.+)$/))) return compose('email', m[1], m[2])

  // "<app> web", "<app> website", "<app> in chrome": the official website rather than the desktop app
  if ((m = t.match(/^(?:open|launch|start|show|show me|go to|bring up|load)(?: up)? (.+?) (?:web|website|site|web version|online|(?:in|on) (?:the |my )?(?:google chrome|chrome|browser|web|website))$/))) {
    const site = await openSite(m[1])
    if (site) return site
  }

  if (/^(?:what(?:'s| is) (?:this |that )?(?:playing|song|track|music)(?: is this| is that| right now| now)?|(?:what|which) (?:song|track|music) is (?:this|that|playing|it)|what am i listening to|who(?:'s| is) (?:singing|this by|the (?:singer|artist)))$/.test(t)) {
    const s = currentSession(await sessions())
    if (!s || !s.title) return { text: 'Nothing is playing at the moment, sir.', outcome: 'warning' }
    return { text: `${s.status === 'playing' ? 'This is' : 'Paused on'} ${s.title}${s.artist ? ` by ${s.artist}` : ''}, sir.`, outcome: 'success' }
  }

  // the internet: searches, websites, news, weather, quick facts
  const web = await tryWeb(t)
  if (web) return web

  // "play <something>" with no place named goes to Spotify
  if ((m = t.match(/^(?:play|put on) (?!a game|the game|chess|along|with\b)(.+)$/))) {
    return playOnSpotify(m[1])
  }

  // apps
  if ((m = t.match(/^(?:open|opening|launch|start|run|fire up|bring up|load|open up|show me|show)(?: up)? (.+)$/))) {
    const id = findApp(m[1])
    if (id) {
      const r = await openApp(id)
      // Not installed as an app (Netflix, WhatsApp...): use the website instead.
      if (r.outcome === 'success' || !knownSite(m[1])) return r
    }
    const site = await openSite(m[1])
    if (site) return site
    if (/^(open|opening|launch|run|fire up|open up)$/.test(t.split(' ')[0]) || /^(?:open|launch)\b/.test(t)) {
      return { text: `${m[1].replace(/^(the|my) /, '').replace(/^\w/, (c) => c.toUpperCase())} isn't on my list of applications yet, sir.`, outcome: 'warning' }
    }
  }
  if ((m = t.match(/^(?:close|quit|exit|kill|shut) (.+)$/)) && findApp(m[1])) {
    return { text: "I don't close applications yet, sir. Unsaved work makes that one worth an approval step, which comes later.", outcome: 'warning' }
  }
  return null
}

/** Phrases worth having pre-made in the JARVIS voice (instant replies). */
const smallTalkLines = ['Good morning, sir.', 'Good afternoon, sir.', 'Good evening, sir.', 'Good night, sir.', 'Hello, sir.', 'Fully operational, sir. And yourself?', 'My pleasure, sir.', "I'm here, sir."]
export function commonPhrases(installedAppIds: string[]): string[] {
  return [
    ...smallTalkLines,
    'Yes, sir?', 'Welcome home, sir.', 'Searching the web, sir.', 'Paused.', 'Resuming.', 'Next track, sir.', 'Previous track, sir.', 'Nothing is playing at the moment, sir.',
    'Sound muted.', 'Sound on, sir.', SPOTIFY_SEARCHED, 'Microphone muted.', "I didn't catch that, sir.", 'It is already playing, sir.', 'It is already paused, sir.',
    ...installedAppIds.map(openingLine), ...WEB_PHRASES,
    ...[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((n) => `Volume ${n} percent.`),
  ]
}
