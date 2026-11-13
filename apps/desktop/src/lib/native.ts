// Native (Tauri/Rust) telemetry. In a plain browser there is no native link and every hook returns null,
// so panels keep their honest "unavailable" state. Values are measured by the Rust side; nothing is simulated.
import { useEffect, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { log } from './activity'

export const NATIVE = isTauri()

export type Telemetry = {
  cpuPct: number
  cpuName: string
  cpuThreads: number
  memUsed: number
  memTotal: number
  diskMount: string | null
  diskUsed: number | null
  diskTotal: number | null
  netRxBps: number | null
  netTxBps: number | null
  uptimeS: number
  sampleMs: number
}

export type WifiStatus = {
  adapter: string | null
  state: string | null
  ssid: string | null
  signalPct: number | null
  radio: string | null
  rxMbps: number | null
  txMbps: number | null
}

/** Poll a native command on an interval; pauses while the window is hidden (low power). */
function usePoll<T>(cmd: string, everyMs: number): T | null {
  const [v, setV] = useState<T | null>(null)
  useEffect(() => {
    if (!NATIVE) return
    let alive = true
    let id = 0
    let failed = false
    const tick = async () => {
      try {
        const r = await invoke<T>(cmd)
        if (alive) setV(r)
        failed = false
      } catch (e) {
        if (!failed) log('warn', `Native ${cmd} failed: ${String(e)}`)
        failed = true
        if (alive) setV(null)
      }
    }
    const start = () => { window.clearInterval(id); void tick(); id = window.setInterval(tick, everyMs) }
    const vis = () => (document.hidden ? window.clearInterval(id) : start())
    start()
    document.addEventListener('visibilitychange', vis)
    return () => { alive = false; window.clearInterval(id); document.removeEventListener('visibilitychange', vis) }
  }, [cmd, everyMs])
  return v
}

export const useTelemetry = (everyMs = 1000) => usePoll<Telemetry>('telemetry', everyMs)
export const useWifi = () => usePoll<WifiStatus | null>('wifi_status', 10000)

export function fmtBytes(n: number, digits = 1): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i === 0 ? 0 : digits)} ${u[i]}`
}

export function fmtRate(bps: number | null): string {
  if (bps == null) return 'MEASURING'
  return `${fmtBytes(bps)}/s`
}

export function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d ? `${d}D ${h}H ${m}M` : `${h}H ${m}M`
}
