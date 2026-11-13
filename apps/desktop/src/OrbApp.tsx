// Floating mini orb: a small always-on-top reactor that mirrors the HUD's real core state.
// It holds no state of its own: everything comes from the main window over Tauri events.
import { useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ReactorCore } from './components/ReactorCore'
import { STATE_META, type CoreState } from './lib/core-state'
import { useBattery } from './lib/telemetry'
import { resolveMotion, useMotionPref } from './lib/settings'

export type CorePayload = { state: CoreState; level: number }

/** Left-button press anywhere on the disc (except buttons) moves the window. */
const drag = (e: ReactMouseEvent) => {
  if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
  void getCurrentWindow().startDragging()
}

export default function OrbApp() {
  const [core, setCore] = useState<CorePayload | null>(null)
  const pref = useMotionPref()
  const battery = useBattery()
  const osReduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const motion = resolveMotion(pref, osReduced, battery != null && !battery.charging)

  useEffect(() => {
    const un = listen<CorePayload>('core', (e) => setCore(e.payload))
    void emit('orb-ready')
    return () => { void un.then((f) => f()) }
  }, [])

  const state = core?.state ?? 'standby'
  const meta = STATE_META[state]
  return (
    // The orb is a transparent window: Windows blends every animated frame on the CPU, so it always
    // rests still (low-power rules) and only moves during active stages, whatever the HUD's motion setting.
    <div className={`orb-shell ${motion === 'still' ? 'reduced-motion' : 'motion-low'}`}>
      <div className="centre orb" data-state={state} style={{ '--level': (core?.level ?? 0).toFixed(3) } as CSSProperties}>
        <div className="orb-disc" onMouseDown={drag} title="Drag to move · click the centre to open the HUD">
          <ReactorCore state={state} />
          <button type="button" className="orb-open" onClick={() => void invoke('show_hud')} aria-label="Open the HUD" title="Open the HUD" />
        </div>
        <div className="orb-label" onMouseDown={drag}>{core ? meta.label : 'LINKING'}</div>
        <button type="button" className="orb-close" onClick={() => void invoke('toggle_orb')} aria-label="Hide the orb" title="Hide the orb">×</button>
      </div>
    </div>
  )
}
