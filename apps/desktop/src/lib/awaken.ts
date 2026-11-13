// The awakening: two claps, "Wake up, Jarvis", then an original start-up sound, the greeting and a short briefing.
// The sound is synthesised here (no film audio is used or needed). The briefing is built from live data only.
import { log } from './activity'

/** Streaming double-clap detector. Feed it microphone frames; `push` returns true on the second clap of a pair. */
export function clapDetector(rate: number) {
  const WIN = Math.round(rate * 0.005) // 5 ms windows
  let floor = 0.01 // slow average of the quiet level
  let inBurst = false
  let burstMs = 0
  let peak = 0
  let quietMs = 1000
  let busyMs = 0 // sustained loud sound recently (speech, music): not claps
  let firstAt = -1
  let now = 0
  return {
    push(data: Float32Array): boolean {
      let hit = false
      for (let o = 0; o + WIN <= data.length; o += WIN) {
        let sum = 0
        for (let i = o; i < o + WIN; i++) sum += data[i] * data[i]
        const e = Math.sqrt(sum / WIN)
        now += 5
        const thresh = Math.max(0.1, floor * 8)
        if (!inBurst) {
          if (e > thresh && quietMs >= 60) { inBurst = true; burstMs = 5; peak = e } else {
            quietMs = e < thresh * 0.5 ? quietMs + 5 : 0
            floor = floor * 0.995 + Math.min(e, 0.05) * 0.005
            busyMs = Math.max(0, busyMs - 2)
          }
          continue
        }
        burstMs += 5
        peak = Math.max(peak, e)
        if (e < peak * 0.3 || burstMs > 220) {
          const clap = burstMs <= 180 && e < peak * 0.3 // a sharp sound that dies away at once
          inBurst = false
          quietMs = 0
          if (!clap) { busyMs = 1500; firstAt = -1; continue }
          if (busyMs > 0) { firstAt = -1; continue }
          const gap = now - firstAt
          if (firstAt >= 0 && gap >= 160 && gap <= 900) { firstAt = -1; hit = true } else firstAt = now
        }
      }
      if (firstAt >= 0 && now - firstAt > 900) firstAt = -1
      return hit
    },
  }
}

/**
 * Original start-up sound: a low swell, a rising sweep, three relay clicks and a soft chord, then a quiet hum that
 * stays under the greeting. Returns when the opening has played; call `stop()` to fade the hum out.
 */
export async function playAwakening(): Promise<{ stop: () => void }> {
  let ctx: AudioContext
  try { ctx = new AudioContext() } catch { return { stop() {} } }
  if (ctx.state !== 'running') { try { await ctx.resume() } catch { /* stays silent */ } }
  const t = ctx.currentTime + 0.05
  const out = ctx.createGain()
  out.gain.value = 0.55
  const comp = ctx.createDynamicsCompressor()
  out.connect(comp)
  comp.connect(ctx.destination)
  const tone = (type: OscillatorType, f0: number, f1: number, start: number, dur: number, level: number, pan = 0) => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    const p = ctx.createStereoPanner()
    o.type = type
    o.frequency.setValueAtTime(f0, t + start)
    o.frequency.exponentialRampToValueAtTime(f1, t + start + dur)
    g.gain.setValueAtTime(0.0001, t + start)
    g.gain.exponentialRampToValueAtTime(level, t + start + dur * 0.35)
    g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur)
    p.pan.value = pan
    o.connect(g); g.connect(p); p.connect(out)
    o.start(t + start); o.stop(t + start + dur + 0.05)
  }
  const noise = (start: number, dur: number, level: number, f0: number, f1: number, q: number, pan = 0) => {
    const n = Math.ceil(ctx.sampleRate * dur)
    const buf = ctx.createBuffer(1, n, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1
    const s = ctx.createBufferSource()
    s.buffer = buf
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.Q.value = q
    f.frequency.setValueAtTime(f0, t + start)
    f.frequency.exponentialRampToValueAtTime(f1, t + start + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t + start)
    g.gain.exponentialRampToValueAtTime(level, t + start + Math.min(0.02, dur * 0.5))
    g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur)
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    s.connect(f); f.connect(g); g.connect(p); p.connect(out)
    s.start(t + start)
  }
  tone('sine', 34, 62, 0, 2.6, 0.9) // power coming up
  tone('sine', 68, 124, 0.2, 2.4, 0.25)
  noise(0.3, 2.2, 0.22, 180, 5200, 1.2) // rising sweep
  ;[0.55, 1.05, 1.5].forEach((s, i) => noise(s, 0.06, 0.5, 2400, 900, 4, [-0.6, 0.6, 0][i])) // relays
  ;[[220, -0.4], [330, 0.4], [440, -0.2], [660, 0.2]].forEach(([f, p], i) => tone('triangle', f, f * 1.003, 2.2 + i * 0.07, 2.2, 0.12, p)) // chord
  tone('sine', 880, 1760, 2.25, 0.5, 0.05)
  // hum under the greeting
  const hum = ctx.createOscillator()
  const humGain = ctx.createGain()
  hum.type = 'sine'
  hum.frequency.value = 55
  humGain.gain.setValueAtTime(0.0001, t + 2.4)
  humGain.gain.exponentialRampToValueAtTime(0.12, t + 3.4)
  hum.connect(humGain); humGain.connect(out)
  hum.start(t + 2.4)
  log('info', 'Awakening sound started (original, made on this PC)')
  await new Promise((r) => setTimeout(r, 3300))
  let stopped = false
  return {
    stop() {
      if (stopped) return
      stopped = true
      const n = ctx.currentTime
      humGain.gain.cancelScheduledValues(n)
      humGain.gain.setValueAtTime(Math.max(0.0001, humGain.gain.value), n)
      humGain.gain.exponentialRampToValueAtTime(0.0001, n + 1.2)
      setTimeout(() => { void ctx.close() }, 1500)
    },
  }
}

/** The panels light up in order while the sequence runs (cosmetic only; every reading stays live). */
export function showAwakening(ms = 6500) {
  const el = document.documentElement
  el.classList.remove('awakening')
  void el.offsetWidth
  el.classList.add('awakening')
  window.setTimeout(() => el.classList.remove('awakening'), ms)
}
