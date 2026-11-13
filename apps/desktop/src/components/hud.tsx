// Reusable HUD primitives: HudPanel, RingGauge, Meter, Scope. Original code.
import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

export type Status = 'ok' | 'good' | 'warn' | 'bad' | 'na'

export function HudPanel(props: {
  code: string
  title: string
  status?: { tone: Status; text: string }
  className?: string
  children: ReactNode
}) {
  const { code, title, status, className = '', children } = props
  return (
    <section className={`panel ${className}`} aria-label={title}>
      <span className="chamfer-line tr" />
      <span className="chamfer-line bl" />
      <header className="panel-head">
        <span className="panel-code">{code}</span>
        <h2 className="panel-title" style={{ margin: 0 }}>{title}</h2>
        {status && (
          <span className={`panel-status s-${status.tone}`}>
            <span className="dot" />
            {status.text}
          </span>
        )}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}

const R = 40
const C = 2 * Math.PI * R
const SWEEP = 0.75 * C

/** 270° ring gauge. value=null renders the unavailable state (dashed track, no number). */
export function RingGauge({ label, value, unit = '%', caption }: { label: string; value: number | null; unit?: string; caption?: string }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value))
  const tone = value == null ? 'var(--hud-muted)' : pct > 85 ? 'var(--hud-red)' : pct > 65 ? 'var(--hud-amber)' : 'var(--hud-cyan)'
  const ticks = Array.from({ length: 28 }, (_, i) => i)
  return (
    <div className="gauge" role="meter" aria-label={label} aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={100}>
      <svg viewBox="-56 -56 112 112">
        <g transform="rotate(135)">
          {ticks.map((i) => {
            const a = (i / 27) * 270 * (Math.PI / 180)
            const long = i % 9 === 0
            return (
              <line key={i} x1={Math.cos(a) * 47} y1={Math.sin(a) * 47} x2={Math.cos(a) * (long ? 53 : 50)} y2={Math.sin(a) * (long ? 53 : 50)}
                stroke="var(--hud-cyan)" strokeOpacity={long ? 0.7 : 0.28} strokeWidth={long ? 1.4 : 1} />
            )
          })}
          <circle r={R} fill="none" stroke="var(--hud-cyan)" strokeOpacity={0.14} strokeWidth={6}
            strokeDasharray={value == null ? '3 5' : `${SWEEP} ${C}`} />
          {value != null && (
            <circle r={R} fill="none" stroke={tone} strokeWidth={6} strokeDasharray={`${(pct / 100) * SWEEP} ${C}`}
              style={{ transition: 'stroke-dasharray 600ms ease' }} />
          )}
        </g>
        <circle r={30} fill="none" stroke="var(--hud-cyan)" strokeOpacity={0.12} />
        <text y={value == null ? 4 : 5} textAnchor="middle" fill={value == null ? 'var(--hud-muted)' : 'var(--hud-white)'}
          style={{ fontFamily: 'var(--font-mono)', fontSize: value == null ? 11 : 17 }}>
          {value == null ? 'N/A' : Math.round(pct)}
          {value != null && <tspan fontSize={9} fill="var(--hud-muted)">{unit}</tspan>}
        </text>
      </svg>
      <span className="gauge-label">{label}</span>
      {caption && <span className="gauge-cap" title={caption}>{caption}</span>}
    </div>
  )
}

export function Meter({ value, label }: { value: number; label: string }) {
  return (
    <div className="meter" role="meter" aria-label={label} aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.round(value * 100)}%` }} />
      <span className="meter-ticks" />
    </div>
  )
}

/** Oscilloscope drawn from a live AnalyserNode. Draws a flat line (no animation loop) when there is no source. */
/** Live waveform. Drawn at `fps` (not every display frame) to keep the compositor mostly idle. */
export function Scope({ analyser, active, fps = 30 }: { analyser: RefObject<AnalyserNode | null>; active: boolean; fps?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const g = cv.getContext('2d')
    if (!g) return
    let timer = 0
    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      cv.width = Math.max(1, cv.clientWidth * dpr)
      cv.height = Math.max(1, cv.clientHeight * dpr)
    }
    const drawFrame = (data: Float32Array | null) => {
      const { width: w, height: h } = cv
      g.clearRect(0, 0, w, h)
      g.strokeStyle = 'rgba(0,216,255,0.12)'
      g.lineWidth = 1
      g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke()
      g.strokeStyle = active ? '#00d8ff' : 'rgba(111,159,180,0.55)'
      g.lineWidth = Math.max(1, h / 40)
      g.beginPath()
      if (!data) { g.moveTo(0, h / 2); g.lineTo(w, h / 2) }
      else {
        for (let i = 0; i < data.length; i++) {
          const x = (i / (data.length - 1)) * w
          const y = h / 2 + data[i] * h * 1.6
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y)
        }
      }
      g.stroke()
    }
    size()
    const ro = new ResizeObserver(() => { size(); if (!active) drawFrame(null) })
    ro.observe(cv)
    if (active && analyser.current) {
      const buf = new Float32Array(analyser.current.fftSize)
      timer = window.setInterval(() => {
        const a = analyser.current
        if (a && !document.hidden) { a.getFloatTimeDomainData(buf); drawFrame(buf) }
      }, 1000 / fps)
    } else drawFrame(null)
    return () => { window.clearInterval(timer); ro.disconnect() }
  }, [active, analyser, fps])
  return <canvas ref={ref} className="scope" aria-label={active ? 'Live microphone waveform' : 'Microphone off'} />
}
