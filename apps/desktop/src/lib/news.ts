// News from feeds the user added in Settings. Fetched by the native side (https only) when the user
// refreshes, and every 30 minutes while the app runs, only if at least one feed exists. Nothing is generated.
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { NATIVE } from './native'
import { log } from './activity'
import { feedsPref, type FeedConfig } from './prefs'

export type FeedItem = { title: string; link: string | null; published: string | null }
export type FeedResult = {
  url: string
  name: string
  status: 'loading' | 'ok' | 'error'
  title: string | null
  items: FeedItem[]
  error: string | null
  fetchedAt: Date | null
}
export type Headline = FeedItem & { source: string; at: number | null }

const AUTO_REFRESH_MS = 30 * 60 * 1000
let results: Record<string, FeedResult> = {}
let refreshing = false
let lastRefresh: Date | null = null
const listeners = new Set<() => void>()
let snapshot: { results: Record<string, FeedResult>; refreshing: boolean; lastRefresh: Date | null } = { results, refreshing, lastRefresh }
const notify = () => { snapshot = { results, refreshing, lastRefresh }; listeners.forEach((l) => l()) }

export function useNews() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => snapshot)
}

// Some feeds (The Hindu) send UTF-8 without saying so, and Windows then reads it as Western European, turning
// "Srinagar’s" into "Srinagarâ€™s". If a title is exactly such a misreading, read it back the right way.
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ'
export function unmangle(s: string): string {
  if (!/[\u00c2-\u00f4]/.test(s)) return s
  const fixed = s.replace(/[\u00c2-\u00f4][\u0080-\u00bf\u0152-\u2122]{1,3}/g, (seq) => {
    const bytes = new Uint8Array(seq.length)
    for (let i = 0; i < seq.length; i++) {
      const c = seq.charCodeAt(i)
      const k = c > 0xff ? CP1252.indexOf(seq[i]) : -1
      if (c > 0xff && k < 0) return seq
      bytes[i] = k >= 0 ? 0x80 + k : c
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return seq }
  })
  // A no-break space arrives as "Â" plus a space that the feed reader has already tidied to a plain one.
  return fixed.replace(/\u00c2(?=\s|$)/g, '')
}

async function fetchOne(f: FeedConfig) {
  const prev = results[f.url]
  results = { ...results, [f.url]: { url: f.url, name: f.name, status: 'loading', title: prev?.title ?? null, items: prev?.items ?? [], error: null, fetchedAt: prev?.fetchedAt ?? null } }
  notify()
  try {
    const feed = await invoke<{ title: string | null; items: FeedItem[] }>('fetch_feed', { url: f.url })
    results = { ...results, [f.url]: { url: f.url, name: f.name, status: 'ok', title: feed.title && unmangle(feed.title), items: feed.items.map((it) => ({ ...it, title: unmangle(it.title) })), error: null, fetchedAt: new Date() } }
  } catch (e) {
    results = { ...results, [f.url]: { ...results[f.url], status: 'error', error: String(e) } }
    log('warn', `Feed failed: ${f.name}: ${String(e)}`)
  }
  notify()
}

export async function refreshNews() {
  const feeds = feedsPref.get()
  // drop results for feeds that were removed
  results = Object.fromEntries(Object.entries(results).filter(([u]) => feeds.some((f) => f.url === u)))
  if (!NATIVE || refreshing || feeds.length === 0) { notify(); return }
  refreshing = true
  notify()
  await Promise.all(feeds.map(fetchOne))
  refreshing = false
  lastRefresh = new Date()
  const n = Object.values(results).reduce((a, r) => a + r.items.length, 0)
  log('info', `News refreshed: ${n} headlines from ${feeds.length} feed${feeds.length === 1 ? '' : 's'}`)
  notify()
}

/** Headlines from the feeds currently configured, newest first (undated items last, in feed order). */
export function headlines(r: Record<string, FeedResult>, feeds: FeedConfig[]): Headline[] {
  const all: Headline[] = []
  for (const f of Object.values(r).filter((x) => feeds.some((c) => c.url === x.url))) {
    for (const it of f.items) {
      const t = it.published ? Date.parse(it.published) : NaN
      all.push({ ...it, source: f.name, at: isNaN(t) ? null : t })
    }
  }
  return all.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity))
}

export function ago(ms: number | null, now = Date.now()): string {
  if (ms == null) return '—'
  const m = Math.round((now - ms) / 60000)
  if (m < 1) return 'NOW'
  if (m < 60) return `${m}M`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}H` : `${Math.round(h / 24)}D`
}

export async function openLink(url: string | null) {
  if (!url) return
  try { await invoke('open_link', { url }) } catch (e) { log('warn', `Could not open link: ${String(e)}`) }
}

let started = false
/** Start the 30-minute refresh (once). The first refresh runs immediately if feeds exist. */
export function startNewsSchedule() {
  if (started || !NATIVE) return
  started = true
  void refreshNews()
  window.setInterval(() => void refreshNews(), AUTO_REFRESH_MS)
}

/** Ready-made feeds the user can add with one click. None are added by default. */
export const FEED_PRESETS: FeedConfig[] = [
  { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { name: 'BBC Technology', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { name: 'The Hindu', url: 'https://www.thehindu.com/news/national/feeder/default.rss' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
]
