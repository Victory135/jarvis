// Which screen the HUD shows. Ctrl+1..4 switch screens.
import { useSyncExternalStore } from 'react'

export const SCREENS = ['home', 'music', 'news', 'settings'] as const
export type Screen = (typeof SCREENS)[number]

let screen: Screen = 'home'
const listeners = new Set<() => void>()

export function go(s: Screen) {
  if (s === screen) return
  screen = s
  listeners.forEach((l) => l())
}

export function useScreen(): Screen {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => screen)
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return
    const i = Number(e.key) - 1
    if (i >= 0 && i < SCREENS.length) { e.preventDefault(); go(SCREENS[i]) }
  })
}
