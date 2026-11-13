// Speech output, two local engines:
//  - JARVIS voice: Kokoro British male voices from the local voice helper (desktop app), streamed sentence by
//    sentence and played through Web Audio with an optional subtle "AI" finish. The core's speaking animation
//    follows the real loudness of the audio being played.
//  - Windows voices through the Web Speech API (installed, offline voices only), used as the fallback.
// Nothing here goes online, and nothing is saved.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import { NATIVE } from './native'
import { jarvisVoicePref, voiceEnginePref, voiceFxPref, voicePref } from './prefs'
import { log } from './activity'

// ---------- shared speaking level (drives the reactor) ----------
let level = 0
let raf = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function decay() {
  level = Math.max(0, level * 0.9 - 0.01)
  emit()
  raf = level > 0 ? requestAnimationFrame(decay) : 0
}
function kick(v: number) {
  level = Math.max(level, v)
  if (!raf) raf = requestAnimationFrame(decay)
}
function setLevel(v: number) {
  if (Math.abs(v - level) < 0.02) return
  level = v
  emit()
}

export function useSpeechLevel(): number {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => level)
}

export type SpeakResult = 'done' | 'interrupted' | 'no-voice' | 'unsupported' | 'error'

// ---------- Windows voices (Web Speech API) ----------
export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/** Installed, offline English voices only. Online/remote voices are never offered or used. */
export function localVoices(): SpeechSynthesisVoice[] {
  if (!speechAvailable()) return []
  return speechSynthesis.getVoices().filter((v) => v.localService && v.lang.toLowerCase().startsWith('en'))
}

/** Voice list that updates when Windows finishes loading voices. */
export function useLocalVoices(): SpeechSynthesisVoice[] {
  const [v, setV] = useState(localVoices)
  useEffect(() => {
    if (!speechAvailable()) return
    const on = () => setV(localVoices())
    speechSynthesis.addEventListener('voiceschanged', on)
    on()
    return () => speechSynthesis.removeEventListener('voiceschanged', on)
  }, [])
  return v
}

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = localVoices()
  const chosen = voicePref.get()
  if (chosen) {
    const v = voices.find((x) => x.name === chosen)
    if (v) return v
  }
  for (const p of ['george', 'ryan', 'david', 'mark', 'guy', 'male']) {
    const v = voices.find((x) => x.name.toLowerCase().includes(p))
    if (v) return v
  }
  return voices[0] ?? null
}

async function voiceReady(): Promise<SpeechSynthesisVoice | null> {
  if (speechSynthesis.getVoices().length) return pickVoice()
  await new Promise<void>((r) => {
    const t = setTimeout(r, 1200)
    speechSynthesis.addEventListener('voiceschanged', () => { clearTimeout(t); r() }, { once: true })
  })
  return pickVoice()
}

// ---------- JARVIS voice (Kokoro via the local voice helper) ----------
export const JARVIS_VOICES: { id: string; name: string; note: string }[] = [
  { id: 'bm_daniel', name: 'DANIEL', note: 'Soft, formal' },
  { id: 'bm_george', name: 'GEORGE', note: 'Deep, measured' },
  { id: 'bm_lewis', name: 'LEWIS', note: 'Warm, calm' },
  { id: 'bm_fable', name: 'FABLE', note: 'Bright, crisp' },
]
const SPEED = 1.0

type Chunk = { seq?: number; sr?: number; pcm?: string; text?: string; done?: boolean }

let ctx: AudioContext | null = null
let input: AudioNode | null = null
let analyser: AnalyserNode | null = null
let fxWet: GainNode | null = null
let fxDry: GainNode | null = null

/** Room impulse made from decaying noise (no recorded material). */
function impulse(c: AudioContext, seconds: number, decayPow: number): AudioBuffer {
  const len = Math.floor(c.sampleRate * seconds)
  const b = c.createBuffer(2, len, c.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decayPow)
  }
  return b
}

/** Signal chain: voice -> high-pass -> presence EQ -> [dry | doubling + small room] -> analyser -> speakers. */
function audio(): AudioContext {
  if (ctx) return ctx
  ctx = new AudioContext()
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 85
  const presence = ctx.createBiquadFilter(); presence.type = 'peaking'; presence.frequency.value = 3200; presence.Q.value = 0.9; presence.gain.value = 2.5
  const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 9000; air.gain.value = 1.5
  hp.connect(presence).connect(air)
  fxDry = ctx.createGain()
  fxWet = ctx.createGain()
  const doubler = ctx.createDelay(0.05); doubler.delayTime.value = 0.012
  const doublerGain = ctx.createGain(); doublerGain.gain.value = 0.22
  const room = ctx.createConvolver(); room.buffer = impulse(ctx, 0.45, 3.2)
  const roomGain = ctx.createGain(); roomGain.gain.value = 0.14
  air.connect(fxDry)
  air.connect(doubler).connect(doublerGain).connect(fxWet)
  air.connect(room).connect(roomGain).connect(fxWet)
  analyser = ctx.createAnalyser(); analyser.fftSize = 1024
  fxDry.connect(analyser)
  fxWet.connect(analyser)
  analyser.connect(ctx.destination)
  input = hp
  return ctx
}

/** The sound output, guaranteed running: if it is stuck (it would swallow every reply in silence), it is reopened. */
async function liveAudio(): Promise<AudioContext> {
  let c = audio()
  const nudge = (x: AudioContext) => Promise.race([x.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1500))])
  if (c.state !== 'running') await nudge(c)
  if (c.state !== 'running') {
    log('warn', 'Sound output was stuck: reopening it')
    void c.close().catch(() => {})
    ctx = null
    c = audio()
    if (c.state !== 'running') await nudge(c)
  }
  return c
}

function applyFx() {
  if (!fxDry || !fxWet) return
  const on = voiceFxPref.get()
  fxDry.gain.value = 1
  fxWet.gain.value = on ? 1 : 0
}

function decodePcm(b64: string, c: AudioContext, sr: number): AudioBuffer {
  const bin = atob(b64)
  const n = bin.length >> 1
  const buf = c.createBuffer(1, n, sr)
  const d = buf.getChannelData(0)
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)
    if (v >= 0x8000) v -= 0x10000
    d[i] = v / 32768
  }
  return buf
}

export type Speaker = {
  /** Queue text to be spoken (a sentence or more). */
  say(text: string): void
  /** No more text is coming; `done` resolves when everything has been spoken. */
  end(): void
  cancel(): void
  done: Promise<SpeakResult>
}

// ---------- pre-made phrases ----------
// Short lines in the JARVIS voice are kept as audio in memory (per voice), so replies like "Yes, sir?" or
// "Opening Chrome, sir." play instantly instead of being made each time. Any short line spoken once is kept too.
const phraseCache = new Map<string, AudioBuffer[]>()
const CACHE_MAX_CHARS = 70
const CACHE_MAX = 80
const cacheKey = (voice: string, text: string) => `${voice}|${text.trim()}`
function remember(voice: string, text: string, buffers: AudioBuffer[]) {
  if (text.length > CACHE_MAX_CHARS || !buffers.length) return
  phraseCache.set(cacheKey(voice, text), buffers)
  if (phraseCache.size > CACHE_MAX) phraseCache.delete(phraseCache.keys().next().value!)
}
export const isCached = (text: string) => NATIVE && voiceEnginePref.get() === 'jarvis' && phraseCache.has(cacheKey(jarvisVoicePref.get(), text))

type Session = { cancel: () => void }
let current: Session | null = null

/**
 * JARVIS voice, streamed: sentences can be queued while a reply is still being written. Each sentence is made by the
 * voice helper and played back to back on one timeline. The reactor level follows the real audio.
 */
/**
 * The voice is made a little slower than it is spoken (about 0.9 s of speech per second on this laptop), so if he
 * began the moment the first sentence was ready he would run out of speech and stop at every full stop. Given the
 * sentences he is about to say, this works out how long to wait before starting so that each sentence is ready by
 * the time the one before it ends. A breath of up to 0.3 s between sentences is allowed, as in normal speech.
 */
let voiceRate = 0.85 // seconds of speech made per second, measured as he goes
const estS = (text: string) => text.split(/\s+/).length / 2.6 + 0.3
function startDelayS(voice: string, parts: string[]): number {
  let made = 0, offset = 0, wait = 0, breath = 0
  parts.forEach((p) => {
    const d = estS(p)
    if (!phraseCache.has(cacheKey(voice, p))) made += d / voiceRate + 0.2
    wait = Math.max(wait, made - offset - breath)
    offset += d
    breath += /[.!?…]["')\]]?$/.test(p) ? 0.3 : 0.05 // a breath after a sentence; almost none inside one
  })
  return wait
}
function jarvisSpeaker(onStart?: (voice: string) => void, voiceOverride?: string, plan?: string[]): Speaker {
  current?.cancel()
  const voice = voiceOverride ?? jarvisVoicePref.get()
  const queue: string[] = []
  const sources: AudioBufferSourceNode[] = []
  const ids: number[] = []
  let ended = false
  let working = false
  let started = false
  let cancelled = false
  let failed = false
  let playing = 0
  let nextAt = 0
  const held: { c: AudioContext; b: AudioBuffer }[] = []
  const t0 = performance.now()
  const startAt = t0 + (plan ? startDelayS(voice, plan) * 1000 : 0)
  let holdTimer = 0
  let resolveDone!: (r: SpeakResult) => void
  const done = new Promise<SpeakResult>((r) => { resolveDone = r })
  const meter = new Float32Array(1024)
  const timer = window.setInterval(() => {
    if (!analyser) return
    analyser.getFloatTimeDomainData(meter)
    let sum = 0
    for (let i = 0; i < meter.length; i++) sum += meter[i] * meter[i]
    setLevel(Math.min(1, Math.sqrt(sum / meter.length) * 4.5))
  }, 33)
  const finish = (r: SpeakResult) => {
    window.clearInterval(timer)
    setLevel(0)
    if (current === session) current = null
    resolveDone(r)
  }
  const release = () => { while (held.length) { const h = held.shift()!; play(h.c, h.b) } }
  const maybeFinish = () => {
    if (!cancelled && ended && !working && queue.length === 0) {
      if (held.length) release()
      if (playing === 0) finish(failed && !started ? 'error' : 'done')
    }
  }
  const offer = (c: AudioContext, b: AudioBuffer, ready = false) => {
    void ready
    held.push({ c, b })
    if (started || performance.now() >= startAt) { release(); return }
    if (!holdTimer) holdTimer = window.setTimeout(() => { if (!cancelled) release() }, startAt - performance.now())
  }
  const play = (c: AudioContext, b: AudioBuffer) => {
    const s = c.createBufferSource()
    s.buffer = b
    s.connect(input!)
    nextAt = Math.max(nextAt, c.currentTime + 0.04)
    s.start(nextAt)
    nextAt += b.duration
    sources.push(s)
    playing++
    s.onended = () => { playing--; maybeFinish() }
    if (!started) {
      started = true
      log('info', `JARVIS voice: speaking after ${((performance.now() - t0) / 1000).toFixed(1)} s`)
      onStart?.(voice)
    }
  }
  const synth = (c: AudioContext, text: string) => new Promise<void>((resolve, reject) => {
    const hit = phraseCache.get(cacheKey(voice, text))
    if (hit) { for (const b of hit) offer(c, b, true); resolve(); return }
    const made: AudioBuffer[] = []
    const began = performance.now()
    invoke<number>('tts_new_id').then((id) => {
      ids.push(id)
      const ch = new Channel<Chunk>()
      ch.onmessage = (m) => {
        if (cancelled) return
        if (m.pcm && m.sr) { const b = decodePcm(m.pcm, c, m.sr); made.push(b); offer(c, b) }
        if (m.done) {
          const audio = made.reduce((a, b) => a + b.duration, 0)
          const wall = (performance.now() - began) / 1000
          if (audio > 1 && wall > 0.2) voiceRate = Math.max(0.3, Math.min(3, voiceRate * 0.6 + (audio / wall) * 0.4))
          remember(voice, text, made)
          resolve()
        }
      }
      invoke('tts_speak', { id, text, voice, speed: SPEED, onChunk: ch }).catch(reject)
    }, reject)
  })
  const pump = async () => {
    if (working) return
    working = true
    const c = await liveAudio()
    applyFx()
    while (queue.length && !cancelled) {
      const text = queue.shift()!
      try { await synth(c, text) } catch (e) {
        failed = true
        log('warn', `JARVIS voice failed: ${String(e)}`)
        queue.length = 0
      }
    }
    working = false
    maybeFinish()
  }
  const session: Session = {
    cancel: () => {
      if (cancelled) return
      cancelled = true
      for (const id of ids) void invoke('tts_cancel', { id }).catch(() => {})
      for (const s of sources) { try { s.stop() } catch { /* not started */ } }
      finish('interrupted')
    },
  }
  current = session
  return {
    say: (text) => { const t = text.trim(); if (t && !cancelled) { queue.push(t); void pump() } },
    end: () => { ended = true; maybeFinish() },
    cancel: session.cancel,
    done,
  }
}

/** Windows voices, queued sentence by sentence through the Web Speech API. */
function windowsSpeaker(onStart?: (voice: string) => void): Speaker {
  current?.cancel()
  let pending = 0
  let ended = false
  let started = false
  let cancelled = false
  let resolveDone!: (r: SpeakResult) => void
  const done = new Promise<SpeakResult>((r) => { resolveDone = r })
  const session: Session = { cancel: () => { if (!cancelled) { cancelled = true; speechSynthesis.cancel(); resolveDone('interrupted') } } }
  current = session
  const check = () => { if (ended && pending === 0 && !cancelled) { if (current === session) current = null; resolveDone('done') } }
  return {
    say: (text) => {
      if (cancelled || !text.trim()) return
      pending++
      void voiceReady().then((voice) => {
        if (!voice) { pending--; resolveDone('no-voice'); return }
        const u = new SpeechSynthesisUtterance(text)
        u.voice = voice
        u.pitch = 0.95
        u.onstart = () => { kick(0.8); if (!started) { started = true; onStart?.(voice.name) } }
        u.onboundary = (e) => { if (e.name === 'word' || e.name === undefined) kick(0.6 + Math.min(0.4, (e.charLength ?? 4) / 20)) }
        u.onend = () => { pending--; check() }
        u.onerror = () => { pending--; check() }
        speechSynthesis.speak(u)
      })
    },
    end: () => { ended = true; check() },
    cancel: session.cancel,
    done,
  }
}

/** Open a speaker on the chosen voice engine (JARVIS voice in the desktop app, else Windows voices). */
export function openSpeaker(onStart?: (voice: string) => void, plan?: string[]): Speaker {
  if (NATIVE && voiceEnginePref.get() === 'jarvis') return jarvisSpeaker(onStart, undefined, plan)
  if (!speechAvailable()) return { say() {}, end() {}, cancel() {}, done: Promise.resolve('unsupported') }
  return windowsSpeaker(onStart)
}

/** Play a pre-made phrase right away (no synthesis). Returns false if it isn't cached. */
export async function playCached(text: string): Promise<boolean> {
  if (!isCached(text)) return false
  const sp = jarvisSpeaker()
  sp.say(text)
  sp.end()
  await sp.done
  return true
}

// Pre-made phrases are also kept on disk (IndexedDB, this PC only), so later start-ups don't have to voice them
// again: voicing ~40 phrases keeps the CPU busy for over a minute, which slows speech recognition meanwhile.
type Stored = { pcm: string; sr: number }[]
let dbP: Promise<IDBDatabase | null> | null = null
const phraseDb = () => (dbP ??= new Promise<IDBDatabase | null>((resolve) => {
  try {
    const req = indexedDB.open('jarvis-phrases', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('phrases')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  } catch { resolve(null) }
}))
const diskKey = (voice: string, text: string) => `${SPEED}|${cacheKey(voice, text)}`
async function diskGet(key: string): Promise<Stored | null> {
  const db = await phraseDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction('phrases').objectStore('phrases').get(key)
      req.onsuccess = () => resolve((req.result as Stored | undefined) ?? null)
      req.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}
async function diskPut(key: string, value: Stored) {
  const db = await phraseDb()
  try { db?.transaction('phrases', 'readwrite').objectStore('phrases').put(value, key) } catch { /* cache only */ }
}

let prerenderQueue: Promise<unknown> = Promise.resolve()
/** Make and keep the given phrases in the current JARVIS voice, one at a time, skipping ones already kept.
 *  `idle()` is checked before each phrase so this never competes with a live request. */
export function prerender(texts: string[], idle: () => boolean = () => true): Promise<number> {
  // one batch at a time, so two callers never voice the same phrases side by side
  const run = prerenderQueue.then(() => prerenderNow(texts, idle))
  prerenderQueue = run.catch(() => 0)
  return run
}
async function prerenderNow(texts: string[], idle: () => boolean): Promise<number> {
  if (!NATIVE || voiceEnginePref.get() !== 'jarvis') return 0
  const voice = jarvisVoicePref.get()
  const c = audio()
  let made = 0
  for (const text of texts) {
    if (phraseCache.has(cacheKey(voice, text))) continue
    const saved = await diskGet(diskKey(voice, text))
    if (saved?.length) { remember(voice, text, saved.map((m) => decodePcm(m.pcm, c, m.sr))); made++; continue }
    while (!idle()) await new Promise((r) => setTimeout(r, 1000))
    const id = await invoke<number>('tts_new_id')
    const raw: Stored = []
    const ch = new Channel<Chunk>()
    // The audio arrives on the channel, which can lag behind the command's own result: wait for its "done".
    let complete = false
    const finished = new Promise<void>((resolve) => {
      ch.onmessage = (m) => { if (m.pcm && m.sr) raw.push({ pcm: m.pcm, sr: m.sr }); if (m.done) { complete = true; resolve() } }
    })
    try {
      await invoke('tts_speak', { id, text, voice, speed: SPEED, onChunk: ch })
      await Promise.race([finished, new Promise((r) => setTimeout(r, 4000))])
    } catch { break }
    if (!raw.length) continue
    remember(voice, text, raw.map((m) => decodePcm(m.pcm, c, m.sr)))
    if (complete) void diskPut(diskKey(voice, text), raw)
    made++
  }
  return made
}

/** Load the JARVIS voice in the background so the first reply isn't delayed. */
export function warmVoice(): Promise<void> {
  if (!NATIVE || voiceEnginePref.get() !== 'jarvis') return Promise.resolve()
  const t = performance.now()
  return invoke<number | null>('tts_warm')
    .then((ms) => { if (ms != null) log('info', `JARVIS voice ready (${((ms || performance.now() - t) / 1000).toFixed(1)} s to load)`) })
    .catch((e) => log('warn', `JARVIS voice unavailable, using Windows voice: ${String(e)}`))
}

/** Play a short sample in one JARVIS voice without changing the chosen voice. */
export async function previewVoice(voiceId: string, name: string): Promise<SpeakResult> {
  if (!NATIVE) return 'unsupported'
  const sp = jarvisSpeaker(undefined, voiceId)
  sp.say(`Good evening. This is ${name.charAt(0) + name.slice(1).toLowerCase()}. All systems are online, and I am at your service.`)
  sp.end()
  return sp.done
}

// ---------- entry points ----------
/** Split into sentences for voicing. */
export const sentences = (text: string) => text.split(/(?<=[.!?…]["')\]]?)\s+(?=["'(\[]?[A-Z0-9])/).filter(Boolean)
/** Sentences, with long ones cut at their commas. His voice is made slower than he speaks, so shorter pieces let
 *  him start sooner: he begins once the remaining pieces can keep up (see startDelayS). */
export const pieces = (text: string) => sentences(text).flatMap((s) => {
  if (s.split(/\s+/).length <= 8) return [s]
  const out: string[] = []
  for (const c of s.split(/(?<=[,;:])\s+/)) {
    const last = out[out.length - 1]
    if (last && (last.split(/\s+/).length < 4 || c.split(/\s+/).length < 3)) out[out.length - 1] = `${last} ${c}`
    else out.push(c)
  }
  return out
})

/** Speak a complete text. Falls back to the Windows voice if the JARVIS voice fails before starting. */
export async function speak(text: string, onStart?: (voice: string) => void): Promise<SpeakResult> {
  // Voiced a sentence at a time; he starts once the rest can keep up with his speaking (see startDelayS).
  const parts = isCached(text) ? [text] : pieces(text)
  const sp = openSpeaker(onStart, parts)
  for (const p of parts) sp.say(p)
  sp.end()
  const r = await sp.done
  if (r === 'error' && NATIVE && voiceEnginePref.get() === 'jarvis') {
    log('warn', 'Falling back to the Windows voice for this reply')
    const w = windowsSpeaker(onStart)
    w.say(text)
    w.end()
    return w.done
  }
  return r
}

export function stopSpeaking() {
  current?.cancel()
  if (speechAvailable()) speechSynthesis.cancel()
}
