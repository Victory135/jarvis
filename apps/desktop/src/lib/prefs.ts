// Small persisted preferences (this device's storage only). Storage can be blocked; defaults always work.
// The HUD and the orb are separate windows sharing this storage, so changes from the other window are followed.
import { useSyncExternalStore } from 'react'

export type Pref<T> = { use: () => T; get: () => T; set: (v: T) => void }

export function createPref<T>(key: string, fallback: T, valid: (v: unknown) => v is T): Pref<T> {
  const listeners = new Set<() => void>()
  const load = (): T => {
    try {
      const raw = localStorage.getItem(key)
      if (raw == null) return fallback
      const v: unknown = JSON.parse(raw)
      return valid(v) ? v : fallback
    } catch { return fallback }
  }
  let value = load()
  const notify = () => listeners.forEach((l) => l())
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => { if (e.key === key) { value = load(); notify() } })
  }
  return {
    get: () => value,
    set: (v: T) => {
      value = v
      try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* lasts for this session only */ }
      notify()
    },
    use: () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => value),
  }
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

/** Preferred voice name ('' = automatic choice). */
export const voicePref = createPref<string>('jarvis.voice', '', isString)
/** Open the mini orb when the desktop app starts. */
export const orbAtStartPref = createPref<boolean>('jarvis.orbAtStart', false, isBool)

export type FeedConfig = { url: string; name: string }
const isFeeds = (v: unknown): v is FeedConfig[] =>
  Array.isArray(v) && v.every((f) => !!f && typeof f.url === 'string' && typeof f.name === 'string')
/** News feeds the user added. Empty by default: nothing is fetched until the user adds a feed. */
export const feedsPref = createPref<FeedConfig[]>('jarvis.feeds', [], isFeeds)

export type SttEngine = 'vosk' | 'whisper'
/** Speech-to-text engine. Whisper by default: on this laptop it measured faster than Vosk for short commands
 *  (0.3-0.6 s vs ~1 s) and transcribed all test phrases correctly. Vosk stays available as the lighter option. */
export const sttEnginePref = createPref<SttEngine>('jarvis.stt', 'whisper', (v): v is SttEngine => v === 'vosk' || v === 'whisper')
/** Also run the other engine on each command and log both results (for comparing on your own voice). */
export const sttComparePref = createPref<boolean>('jarvis.sttCompare', false, isBool)

/** Hands-free wake word: answer to "Hey Jarvis" without pressing anything. */
export type WebMode = 'auto' | 'off'
export const webSearchPref = createPref<WebMode>('jarvis.websearch', 'auto', (v): v is WebMode => v === 'auto' || v === 'off')
export const clapPref = createPref<boolean>('jarvis.claps', true, isBool)
export const wakePref = createPref<boolean>('jarvis.wake', true, isBool)

/** Allowlisted apps found on this PC (set at start-up; not persisted). */
let installedApps: string[] = []
const appListeners = new Set<() => void>()
export function setInstalledApps(ids: string[]) { installedApps = ids; appListeners.forEach((l) => l()) }
export function useInstalledApps(): string[] {
  return useSyncExternalStore((l) => { appListeners.add(l); return () => appListeners.delete(l) }, () => installedApps)
}

export type VoiceEngine = 'jarvis' | 'windows'
/** 'jarvis' = Kokoro British male voice via the local voice helper; 'windows' = installed Windows voices. */
export const voiceEnginePref = createPref<VoiceEngine>('jarvis.voiceEngine', 'jarvis', (v): v is VoiceEngine => v === 'jarvis' || v === 'windows')
/** Kokoro British male voice id. */
export const jarvisVoicePref = createPref<string>('jarvis.jarvisVoice', 'bm_daniel', isString)
/** Subtle "AI" finish on the JARVIS voice (EQ, slight doubling, small room). */
export const voiceFxPref = createPref<boolean>('jarvis.voiceFx', true, isBool)

/** City for the weather as "name|lat|lon" ('' = not set; he asks instead of guessing where you are). */
export type Contact = { name: string; phone: string; email: string }
export const contactsPref = createPref<Contact[]>('jarvis.contacts', [], (v): v is Contact[] => Array.isArray(v) && v.every((c) => c && typeof c.name === 'string' && typeof c.phone === 'string' && typeof c.email === 'string'))
export const cityPref = createPref<string>('jarvis.city', '', isString)
