// Single explicit UI state machine for the core (blueprint V2.6 / V2.9).
// States change only on real events (mic opened, speech started, command routed ...).
// The one exception is design-preview mode (?state=...), which is labelled on screen as simulated.
import { useSyncExternalStore } from 'react'
import type { Status } from '../components/hud'

export const CORE_STATES = [
  'standby', 'wake_detected', 'listening', 'transcribing', 'thinking', 'planning',
  'awaiting_approval', 'executing', 'speaking', 'success', 'warning', 'error', 'muted',
] as const
export type CoreState = (typeof CORE_STATES)[number]

export const STATE_META: Record<CoreState, { label: string; tone: Status }> = {
  standby: { label: 'STANDBY', tone: 'ok' },
  wake_detected: { label: 'WAKE DETECTED', tone: 'ok' },
  listening: { label: 'LISTENING', tone: 'good' },
  transcribing: { label: 'TRANSCRIBING', tone: 'good' },
  thinking: { label: 'UNDERSTANDING', tone: 'ok' },
  planning: { label: 'PLANNING', tone: 'ok' },
  awaiting_approval: { label: 'AWAITING APPROVAL', tone: 'warn' },
  executing: { label: 'EXECUTING', tone: 'ok' },
  speaking: { label: 'SPEAKING', tone: 'ok' },
  success: { label: 'COMPLETE', tone: 'good' },
  warning: { label: 'WARNING', tone: 'warn' },
  error: { label: 'FAULT', tone: 'bad' },
  muted: { label: 'PRIVACY MUTE', tone: 'na' },
}

type Snapshot = { state: CoreState; detail: string | null; preview: boolean }

const params = new URLSearchParams(location.search)
const previewParam = params.get('state') as CoreState | null
const previewState = previewParam && (CORE_STATES as readonly string[]).includes(previewParam) ? previewParam : null

let snap: Snapshot = previewState
  ? { state: previewState, detail: params.get('detail'), preview: true }
  : { state: 'standby', detail: null, preview: false }
const listeners = new Set<() => void>()

export function setCore(state: CoreState, detail: string | null = null) {
  if (snap.preview) return // preview freezes the state; real events are ignored
  if (snap.state === state && snap.detail === detail) return
  snap = { state, detail, preview: false }
  listeners.forEach((l) => l())
}

export const getCore = () => snap

export function useCore(): Snapshot {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => snap)
}
