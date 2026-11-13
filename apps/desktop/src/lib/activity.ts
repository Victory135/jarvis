// Tiny activity log store: only real events are logged here.
import { useSyncExternalStore } from 'react'

export type ActivityItem = { id: number; at: Date; level: 'info' | 'warn'; text: string }

let items: ActivityItem[] = []
let nextId = 1
const listeners = new Set<() => void>()

export function log(level: ActivityItem['level'], text: string) {
  items = [{ id: nextId++, at: new Date(), level, text }, ...items].slice(0, 50)
  listeners.forEach((l) => l())
}

export function useActivity(): ActivityItem[] {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l) },
    () => items,
  )
}
