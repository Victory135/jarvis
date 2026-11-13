// Local UI settings, kept in this device's storage only. Storage may be unavailable; defaults always work.
import { useSyncExternalStore } from 'react'

/** auto: low power on battery, still when the OS asks for reduced motion, otherwise full. */
export type MotionPref = 'auto' | 'full' | 'low' | 'still'
export type Motion = 'full' | 'low' | 'still'
export const MOTION_PREFS: MotionPref[] = ['auto', 'full', 'low', 'still']

const KEY = 'jarvis.motion'
const listeners = new Set<() => void>()

function load(): MotionPref {
  try {
    const v = localStorage.getItem(KEY)
    return MOTION_PREFS.includes(v as MotionPref) ? (v as MotionPref) : 'auto'
  } catch { return 'auto' }
}

let pref = load()

export function setMotionPref(p: MotionPref) {
  pref = p
  try { localStorage.setItem(KEY, p) } catch { /* storage blocked: setting lasts for this session */ }
  listeners.forEach((l) => l())
}

// The HUD and the orb are separate windows sharing this storage: follow changes made in the other one.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) { pref = load(); listeners.forEach((l) => l()) }
  })
}

export function useMotionPref(): MotionPref {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => pref)
}

/** Resolve the preference against real conditions (OS setting, battery state). */
export function resolveMotion(p: MotionPref, osReduced: boolean, onBattery: boolean): Motion {
  if (p !== 'auto') return p
  if (osReduced) return 'still'
  return onBattery ? 'low' : 'full'
}
