// Speech-to-text through the desktop app's local engines (Vosk / Whisper). Audio goes to the native side as raw
// 16 kHz PCM over IPC, is decoded in memory and dropped. Results (text + timings) are kept for the benchmark view.
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { SttEngine } from './prefs'

export type Transcript = { text: string; engine: SttEngine; audioMs: number; loadMs: number | null; decodeMs: number }
export type EngineInfo = { id: SttEngine; model: string; available: boolean; loaded: boolean }

let history: (Transcript & { at: Date })[] = []
const listeners = new Set<() => void>()
let busy = 0
/** True while speech is being recognised (background jobs wait for this). */
export const sttBusy = () => busy > 0

export function useSttHistory() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => history)
}

/** `keep` false: the result is not added to the visible history (used while checking for the wake word). */
export async function transcribe(pcm: Int16Array, engine: SttEngine, keep = true): Promise<Transcript> {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  busy++
  let r: Transcript
  try { r = await invoke<Transcript>('transcribe', bytes, { headers: { 'x-engine': engine } }) } finally { busy-- }
  if (keep) {
    history = [{ ...r, at: new Date() }, ...history].slice(0, 8)
    listeners.forEach((l) => l())
  }
  return r
}

export const sttEngines = () => invoke<EngineInfo[]>('stt_engines')

export const ENGINE_LABEL: Record<SttEngine, string> = { vosk: 'VOSK', whisper: 'WHISPER' }
