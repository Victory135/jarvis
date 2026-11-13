// Central reactor: original SVG geometry (concentric rings, ticks, segmented arcs, coil blocks).
// Built as a stack of same-size SVG layers. Each moving part (spinning ring, pulse, glow, voice ring) is its
// own layer, so the GPU compositor rotates/fades a finished bitmap instead of the CPU repainting the whole
// reactor every frame. Visuals are driven by data-state (CSS) and --level (real mic RMS or TTS word envelope).
import { memo, type ReactNode } from 'react'
import type { CoreState } from '../lib/core-state'

const polar = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180
  return [Math.cos(a) * r, Math.sin(a) * r] as const
}

/** Annular sector path between radii r1<r2 from angle a0 to a1 (degrees). */
const sector = (r1: number, r2: number, a0: number, a1: number) => {
  const [x0, y0] = polar(r2, a0)
  const [x1, y1] = polar(r2, a1)
  const [x2, y2] = polar(r1, a1)
  const [x3, y3] = polar(r1, a0)
  return `M${x0},${y0} A${r2},${r2} 0 0 1 ${x1},${y1} L${x2},${y2} A${r1},${r1} 0 0 0 ${x3},${y3} Z`
}

const arc = (r: number, a0: number, a1: number) => {
  const [x0, y0] = polar(r, a0)
  const [x1, y1] = polar(r, a1)
  return `M${x0},${y0} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1},${y1}`
}

const TICKS = Array.from({ length: 120 }, (_, i) => i)
const COILS = Array.from({ length: 40 }, (_, i) => i)
const SPOKES = Array.from({ length: 12 }, (_, i) => i)
const A = 'var(--accent)'

/** One full-size layer of the stack. */
function L({ className = '', children }: { className?: string; children: ReactNode }) {
  return <svg className={`layer ${className}`} viewBox="-300 -300 600 600" aria-hidden="true">{children}</svg>
}

export const ReactorCore = memo(function ReactorCore({ state }: { state: CoreState }) {
  return (
    <div className="reactor" data-state={state} role="img" aria-label={`JARVIS core, ${state.replace('_', ' ')}`}>
      {/* static back plate */}
      <L>
        <defs>
          <radialGradient id="haze">
            <stop offset="0%" style={{ stopColor: 'var(--accent)' }} stopOpacity="0.10" />
            <stop offset="70%" style={{ stopColor: 'var(--accent)' }} stopOpacity="0.025" />
            <stop offset="100%" style={{ stopColor: 'var(--accent)' }} stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle r={298} fill="url(#haze)" />
        {[0, 90, 180, 270].map((a) => {
          const [x, y] = polar(a % 180 === 0 ? 297 : 304, a)
          return <text key={a} x={x} y={y} textAnchor="middle" dominantBaseline="middle"
            fill="var(--hud-muted)" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 1 }}>{String(a).padStart(3, '0')}</text>
        })}
        <circle r={261} fill="none" stroke={A} strokeOpacity={0.4} />
        <circle r={228} fill="none" stroke={A} strokeOpacity={0.35} strokeDasharray="2 6" />
        <circle r={176} fill="none" stroke="var(--accent-soft)" strokeOpacity={0.55} strokeWidth={1.5} />
        <circle r={166} fill="none" stroke={A} strokeOpacity={0.22} />
      </L>

      {/* outer bezel: 120 ticks, every 10th long */}
      <L className="spin spin-a bezel">
        {TICKS.map((i) => {
          const long = i % 10 === 0
          const mid = i % 5 === 0
          const [x1, y1] = polar(266, i * 3)
          const [x2, y2] = polar(long ? 286 : mid ? 279 : 274, i * 3)
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={A} strokeOpacity={long ? 0.85 : mid ? 0.5 : 0.25} strokeWidth={long ? 2 : 1} />
        })}
      </L>

      {/* expanding pulse (wake / success) */}
      <L className="pulse"><circle r={261} fill="none" stroke={A} strokeWidth={3} /></L>

      {/* segmented arc ring */}
      <L className="spin spin-b">
        {[0, 120, 240].map((a) => (
          <path key={a} d={arc(242, a + 6, a + 104)} fill="none" stroke={A} strokeOpacity={0.55} strokeWidth={7} />
        ))}
        {[0, 120, 240].map((a) => (
          <path key={`m${a}`} d={arc(242, a + 108, a + 114)} fill="none" stroke="var(--accent-soft)" strokeOpacity={0.9} strokeWidth={7} />
        ))}
      </L>

      {/* coil blocks */}
      <L className="spin spin-c">
        {COILS.map((i) => (
          <path key={i} d={sector(188, 206, i * 9 + 1.2, i * 9 + 7.8)} fill={A} fillOpacity={i % 5 === 0 ? 0.38 : 0.07}
            stroke={A} strokeOpacity={i % 5 === 0 ? 0.8 : 0.4} strokeWidth={0.8} />
        ))}
      </L>

      {/* execution track (executing): dashed outer band */}
      <L className="spin exec"><circle r={216} fill="none" stroke="var(--accent-soft)" strokeWidth={1.5} strokeDasharray="14 10" /></L>

      {/* activity sweep (thinking / planning / executing): indeterminate, no fake percentage */}
      <L className="spin sweep">
        <path d={arc(156, 0, 70)} fill="none" stroke="var(--accent-soft)" strokeWidth={3} strokeLinecap="round" />
        <path d={arc(156, 180, 220)} fill="none" stroke={A} strokeWidth={2} strokeOpacity={0.7} />
      </L>

      {/* plan step markers (planning): 3 waypoints on the inner track */}
      <L className="steps">
        {[300, 0, 60].map((a, i) => {
          const [x, y] = polar(156, a)
          return <g key={a}><circle cx={x} cy={y} r={7} fill="var(--hud-bg)" stroke="var(--accent-soft)" strokeWidth={2} />
            <text x={x} y={y + 0.5} textAnchor="middle" dominantBaseline="middle" fill="var(--accent-soft)" style={{ fontFamily: 'var(--font-mono)', fontSize: 8 }}>{i + 1}</text></g>
        })}
      </L>

      {/* inner glow */}
      <L className="glow breathe">
        <defs>
          <radialGradient id="core-glow">
            <stop offset="0%" stopColor="#eafbff" stopOpacity="0.95" />
            <stop offset="22%" style={{ stopColor: 'var(--accent-soft)' }} stopOpacity="0.75" />
            <stop offset="48%" style={{ stopColor: 'var(--accent)' }} stopOpacity="0.32" />
            <stop offset="78%" style={{ stopColor: 'var(--accent-deep)' }} stopOpacity="0.06" />
            <stop offset="100%" style={{ stopColor: 'var(--accent-deep)' }} stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle r={170} fill="url(#core-glow)" />
      </L>

      {/* static inner frame: spokes, ring, crosshair */}
      <L>
        {SPOKES.map((i) => {
          const [x1, y1] = polar(104, i * 30 + 15)
          const [x2, y2] = polar(144, i * 30 + 15)
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--accent-soft)" strokeOpacity={0.35} strokeWidth={1.2} />
        })}
        <circle r={100} fill="none" stroke="var(--accent-soft)" strokeOpacity={0.5} strokeWidth={1.2} />
        {[0, 90, 180, 270].map((a) => {
          const [x1, y1] = polar(108, a)
          const [x2, y2] = polar(124, a)
          return <line key={`x${a}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--hud-white)" strokeOpacity={0.7} strokeWidth={1.5} />
        })}
      </L>

      <L className="spin spin-d">
        {[0, 90, 180, 270].map((a) => (
          <path key={a} d={arc(84, a + 20, a + 70)} fill="none" stroke="var(--hud-white)" strokeOpacity={0.7} strokeWidth={2.5} />
        ))}
      </L>

      {/* voice ring: scales with real audio level */}
      <L className="voice">
        <circle r={116} fill="none" stroke="var(--accent-soft)" strokeWidth={2} />
        <circle r={128} fill="none" stroke={A} strokeOpacity={0.4} strokeWidth={1} />
      </L>

      <L className="eye"><circle r={52} fill="rgba(234,251,255,0.10)" stroke="var(--hud-white)" strokeOpacity={0.85} strokeWidth={2} /></L>
      <L className="pupil"><circle r={26} fill="#eafbff" fillOpacity={0.85} /></L>

      {/* privacy mute glyph */}
      <L className="mute-glyph">
        <g stroke="var(--hud-white)" strokeWidth={4} fill="none" strokeLinecap="round">
          <rect x={-11} y={-30} width={22} height={38} rx={11} />
          <path d="M-20,-2 a20,20 0 0 0 40,0 M0,18 v12 M-12,30 h24" />
          <path d="M-30,-36 L30,36" stroke="var(--hud-red)" />
        </g>
      </L>
    </div>
  )
})
