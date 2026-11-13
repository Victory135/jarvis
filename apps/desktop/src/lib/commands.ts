// Handles one request (typed or spoken). Order:
//  1. Instant local answers: "Jarvis?", time, date.
//  2. Actions done directly by the app, no model needed: open apps (allowlist), music, volume, Spotify search,
//     privacy mute. Replies report what really happened.
//  3. Requests for other actions get an honest "not yet" from code, so the model can never claim to have done
//     something it didn't (spec: never confuse a promised action with a completed one).
//  4. Everything else goes to the local language model: the reply is written (shown live), then spoken.
import { log } from './activity'
import { tryAction, normalise, type ActionReply } from './actions'
import { webContext, webQuery } from './web'
import { setCore, type CoreState } from './core-state'
import { chat, forSpeech, thinkingReady } from './llm'
import { NATIVE } from './native'
import { playAwakening, showAwakening } from './awaken'
import { isCached, openSpeaker, playCached, pieces, speak, stopSpeaking, type Speaker } from './speech'

let runId = 0
let abort: AbortController | null = null
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const UNSUPPORTED = /^(call|ring|delete|deleting|remove|erase|install|installing|uninstall|download|downloading|book|buy|order|set (?:a |an )?(?:reminder|alarm|timer)|remind me|shut ?down|restart|reboot|log off|lock)\b/

export const FILLERS = ['One moment, sir.', 'Let me think.', 'Give me a second.', 'Considering that now.', 'Bear with me, sir.']
let lastFiller = -1
const DEEP = /^(?:explain|tell me about|describe|why|how does|how do|what are the|compare|walk me through|analyse|analyze|plan|help me (?:plan|decide|think))\b|\b(?:think (?:about|it|this|that|hard|carefully|properly|deeply)|in detail|step by step|pros and cons|thoroughly|deep dive)\b/

/** Ready-made replies to everyday pleasantries, so they are answered at once instead of waiting for the model. */
export const SMALL_TALK = {
  morning: 'Good morning, sir.', afternoon: 'Good afternoon, sir.', evening: 'Good evening, sir.', night: 'Good night, sir.',
  hello: 'Hello, sir.', well: 'Fully operational, sir. And yourself?', thanks: 'My pleasure, sir.', here: "I'm here, sir.",
}
function smallTalk(t: string, now: Date): string | null {
  const words = t.replace(/\b(?:hey|ok|okay|jarvis|jervis|travis|sir|very|a)\b/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (!words.length || words.length > 7) return null // longer than a pleasantry: let him think about it
  const s = words.join(' ')
  if (/^(?:thanks|thank you|cheers|much appreciated)(?: (?:a lot|so much|very much|mate|buddy))?$/.test(s)) return SMALL_TALK.thanks
  if (/^good ?night\b/.test(s)) return SMALL_TALK.night
  if (/^(?:good )?(?:morning|afternoon|evening)\b/.test(s) || /^(?:hello|hi|hey there|hello there|greetings)$/.test(s)) {
    if (/^(?:hello|hi|hey there|hello there|greetings)$/.test(s)) return SMALL_TALK.hello
    const h = now.getHours()
    return h < 12 ? SMALL_TALK.morning : h < 18 ? SMALL_TALK.afternoon : SMALL_TALK.evening
  }
  if (/^(?:hello |hi )?(?:how are you|how are you doing|how do you do|how are things|are you (?:ok|okay|alright|all right|well)|you (?:ok|okay|alright)|how is it going|how's it going)(?: today| tonight)?$/.test(s)) return SMALL_TALK.well
  if (/^(?:are you (?:there|awake|listening|online|up)|you there|can you hear me|do you hear me)$/.test(s)) return SMALL_TALK.here
  return null
}

async function local(input: string, now = new Date()): Promise<ActionReply | null> {
  const t = normalise(input)
  const chat = smallTalk(input.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim(), now)
  if (chat) return { text: chat, outcome: 'success' }
  if (t === '' || /^(?:hey |ok |hello |hi )?(?:jarvis|jervis|jarvis's|jerry's|travis)?$/.test(t)) return { text: 'Yes, sir?', outcome: 'success' }
  if (/\b(what('s| is) the time|what time is it|current time|time now|tell me the time)\b/.test(t)) {
    return { text: `It's ${now.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })}, sir.`, outcome: 'success' }
  }
  if (/\b(what('s| is) the date|what day is it|today'?s date|what is today)\b/.test(t)) {
    return { text: `It's ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`, outcome: 'success' }
  }
  if (NATIVE) {
    const a = await tryAction(input)
    if (a) return a
  }
  if (UNSUPPORTED.test(t)) {
    return { text: "That's beyond my reach for now, sir. I can open apps and websites, search the web, run the music and type messages for you, but not that yet.", outcome: 'warning' }
  }
  return null
}

export const SEARCHING = 'Searching the web, sir.'
export const WELCOME = 'Welcome home, sir.'
const WAKE_UP = /^(?:wake up|awaken|wake up daddy'?s home|daddy'?s home|i'?m home|i am home|start (?:the )?(?:day|briefing)|(?:give me |start )?(?:my |the )?(?:daily |morning )?briefing|brief me)$/

/** Start-up sound, greeting, then a briefing made only from live data (clock, weather if a city is set, headlines). */
async function awakening(live: () => boolean, rest: () => CoreState, firstAudio: () => void) {
  log('info', 'Awakening sequence started')
  setCore('executing', 'Systems coming online')
  showAwakening()
  // The briefing is gathered while the sound plays.
  const now = new Date()
  const gathering = (async () => {
    const parts = [`It's ${now.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })} on ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}.`]
    if (NATIVE) {
      const [w, n] = await Promise.all([tryAction('weather today').catch(() => null), tryAction('what is the news').catch(() => null)])
      if (w?.outcome === 'success') parts.push(w.text.replace(/, sir\b/, ''))
      if (n?.outcome === 'success') parts.push(n.text.replace(/^From (.+?), sir\./, 'The headlines from $1.'))
      else parts.push("I couldn't reach the news just now.")
    }
    return parts.join(' ')
  })()
  const bed = await playAwakening()
  firstAudio()
  if (!live()) { bed.stop(); return }
  const greeted = await speak(WELCOME, () => { if (live()) setCore('speaking', WELCOME) })
  if (!live() || greeted === 'interrupted') { bed.stop(); return }
  setCore('thinking', 'Preparing your briefing')
  const briefing = await gathering
  if (!live()) { bed.stop(); return }
  const result = await speak(briefing, () => { bed.stop(); if (live()) setCore('speaking', briefing) })
  bed.stop()
  if (!live() || result === 'interrupted') return
  log('info', 'Awakening sequence complete')
  setCore('success', 'All systems ready')
  await wait(1200)
  if (live()) setCore(rest())
}

export function cancelRun() {
  runId++
  abort?.abort()
  abort = null
  stopSpeaking()
}

/** Handle a typed or spoken request. `rest` returns the state to fall back to (standby / listening / muted). */
export async function runCommand(input: string, rest: () => CoreState, onMute: () => void, t0 = performance.now(), spoken = false) {
  const id = ++runId
  const live = () => id === runId
  // Time from the end of the request (end of speech, or pressing Enter) to the first sound of the reply.
  const firstAudio = () => log('info', `First audio ${((performance.now() - t0) / 1000).toFixed(1)} s after you ${spoken ? 'stopped speaking' : 'pressed Enter'}`)
  log('info', `You: "${input.slice(0, 80)}"`)
  if (WAKE_UP.test(normalise(input))) { await awakening(live, rest, firstAudio); return }
  setCore('thinking', 'Understanding request')
  // Only real actions take long enough to show this (matching a request is instant).
  const acting = window.setTimeout(() => { if (live()) setCore('executing', 'Carrying out your request') }, 120)
  const quick = await local(input)
  window.clearTimeout(acting)
  if (!live()) return

  if (quick || !NATIVE) {
    const reply = quick ?? { text: "I can't answer that here. My reasoning core runs in the desktop app.", outcome: 'warning' as const }
    const result = await speak(reply.text, () => { firstAudio(); if (live()) setCore('speaking', reply.text) })
    if (!live() || result === 'interrupted') return
    if (result !== 'done') {
      setCore('error', `Voice output unavailable · ${reply.text}`)
      await wait(4000)
      if (live()) setCore(rest())
      return
    }
    if (reply.action === 'mute') onMute()
    setCore(reply.outcome, reply.text)
    await wait(reply.outcome === 'warning' ? 2200 : 1200)
    if (live()) setCore(rest())
    return
  }

  // ---- language model: think first, then speak ----
  // On this laptop the model and the voice both saturate memory bandwidth, so running them together halves both
  // (measured 1.7 vs 4.5 tokens/s). The reply is written first, shown live under the core, then spoken.
  let written = ''
  abort = new AbortController()
  // If the model hasn't started answering quickly, acknowledge with a pre-made line (playback only: no synthesis
  // competes with the model). Never the same line twice in a row.
  let fillerPlayed = false
  const fillerTimer = window.setTimeout(() => {
    if (!live() || written || fillerPlayed) return
    const choices = FILLERS.map((_, k) => k).filter((k) => k !== lastFiller && isCached(FILLERS[k]))
    if (!choices.length) return
    lastFiller = choices[Math.floor(Math.random() * choices.length)]
    fillerPlayed = true
    firstAudio()
    void playCached(FILLERS[lastFiller])
  }, 800)
  const slowTimer = window.setTimeout(() => { if (live() && !written) setCore('thinking', 'Thinking') }, 2500)
  // He speaks once the whole reply is written. Starting on the first sentence while the rest was still being
  // written and voiced left him silent at every full stop (voicing is slower than speaking on this laptop).
  let speaker: Speaker | null = null
  const sayAll = () => {
    const parts = pieces(forSpeech(written))
    if (!parts.length) return
    speaker = openSpeaker(() => { if (!fillerPlayed) firstAudio(); if (live()) setCore('speaking', forSpeech(written)) }, parts)
    for (const p of parts) speaker.say(p)
  }
  // Everyday questions go to the quick model; requests for real thinking go to the large one.
  // Questions about current things are answered from what the web says right now, not from the model's memory.
  const query = NATIVE ? webQuery(input) : null
  let web = null
  if (query) {
    setCore('executing', `Searching the web · ${query}`)
    if (isCached(SEARCHING)) { fillerPlayed = true; firstAudio(); void playCached(SEARCHING) }
    web = await webContext(query)
    if (!live()) return
    setCore('thinking', web ? `Reading ${web.sources.slice(0, 3).join(', ')}` : 'Nothing found on the web')
  }
  const deep = !web && thinkingReady() && DEEP.test(normalise(input))
  const limit = deep ? 160 : 60
  if (deep) log('info', 'Using the thinking model for this one')
  let res
  try {
    res = await chat(input, limit, (delta) => {
      if (!live()) return
      written += delta
      setCore('thinking', forSpeech(written))
    }, abort.signal, deep, web?.note ?? (query ? '(A web search for this was tried just now and returned nothing. Say you could not check; do not guess.)' : ''))
  } catch (e) {
    window.clearTimeout(slowTimer)
    window.clearTimeout(fillerTimer)
    if (!live()) return
    log('warn', `Language model failed: ${String(e)}`)
    setCore('error', 'Reasoning core not responding')
    await speak("My reasoning core isn't responding, sir. Give me a moment.")
    if (live()) setCore(rest())
    return
  }
  window.clearTimeout(slowTimer)
  window.clearTimeout(fillerTimer)
  if (!live()) return
  const sec = (ms: number | null) => (ms == null ? '-' : (ms / 1000).toFixed(1))
  if (web) log('info', `Web answer written ${((performance.now() - t0) / 1000).toFixed(1)} s after the question (search ${web.seconds.toFixed(1)} s)`)
  log('info', `JARVIS [${res.model.slice(0, 14)}] (${sec(res.firstTokenMs)} s to first word, ${sec(res.totalMs)} s total, ${res.tokens} tokens): "${res.text.slice(0, 160)}"`)
  // If he ran into the length limit mid-sentence, stop at the last complete sentence instead of trailing off.
  if (res.tokens >= limit && !/[.!?…]["')\]]?\s*$/.test(written)) {
    const end = Math.max(written.lastIndexOf('. '), written.lastIndexOf('! '), written.lastIndexOf('? ')) + 1
    if (end > 0) written = written.slice(0, end)
  }
  sayAll()
  if (!speaker) {
    setCore('warning', 'No answer produced')
    await wait(1800)
    if (live()) setCore(rest())
    return
  }
  ;(speaker as Speaker).end()
  const result = await (speaker as Speaker).done
  if (!live() || result === 'interrupted') return
  if (result !== 'done') {
    setCore('error', `Voice output unavailable · ${res.text}`)
    await wait(5000)
    if (live()) setCore(rest())
    return
  }
  setCore('success', res.text)
  await wait(1200)
  if (live()) setCore(rest())
}
