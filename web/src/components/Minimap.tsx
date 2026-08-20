import { useEffect, useRef } from 'react'

import type { GraphControls } from './GraphCanvas'
import { paint } from '../graph/style'

const W = 160
const H = 108
const PAD = 6

/**
 * The whole graph as dots, with the viewport drawn on it.
 *
 * The one rule it has to keep: a namespace holding an unprotected workload is
 * red here even when it is nowhere near the current view. Focus and zoom exist
 * to hide things, and the moment they can hide the thing somebody is hunting,
 * they have made the tool worse rather than more usable. So the dots come from
 * the node data rather than from what the canvas is currently painting.
 */
export function Minimap({ controls }: { controls: React.RefObject<GraphControls | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let frame = 0
    let last = 0

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw)
      // A minimap is a glance, not an animation. Ten frames a second is past
      // the point anyone notices, and this runs beside a WebGL canvas that has
      // better uses for the budget.
      if (now - last < 100) return
      last = now

      const el = canvas.current
      const snap = controls.current?.snapshot()
      if (!el || !snap || snap.nodes.length === 0) return

      const dpr = window.devicePixelRatio || 1
      if (el.width !== W * dpr || el.height !== H * dpr) {
        el.width = W * dpr
        el.height = H * dpr
      }
      const ctx = el.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      // Everything, including the parts of the viewport that reach past it.
      const xs = snap.nodes.map((n) => n.x).concat([snap.view.x0, snap.view.x1])
      const ys = snap.nodes.map((n) => n.y).concat([snap.view.y0, snap.view.y1])
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)

      const spanX = maxX - minX || 1
      const spanY = maxY - minY || 1
      const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY)
      const ox = (W - spanX * scale) / 2
      const oy = (H - spanY * scale) / 2
      const at = (x: number, y: number) => ({
        x: ox + (x - minX) * scale,
        y: oy + (y - minY) * scale,
      })

      const danger = paint('danger')
      const quiet = paint('neutralEdge')
      for (const node of snap.nodes) {
        const p = at(node.x, node.y)
        ctx.beginPath()
        ctx.arc(p.x, p.y, node.danger ? 2.4 : 1.6, 0, Math.PI * 2)
        ctx.fillStyle = node.danger ? danger : quiet
        ctx.fill()
      }

      const a = at(snap.view.x0, snap.view.y0)
      const b = at(snap.view.x1, snap.view.y1)
      ctx.strokeStyle = paint('accent')
      ctx.lineWidth = 1
      ctx.strokeRect(
        Math.round(a.x) + 0.5,
        Math.round(a.y) + 0.5,
        Math.max(2, Math.round(b.x - a.x)),
        Math.max(2, Math.round(b.y - a.y)),
      )
    }

    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [controls])

  const jump = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const snap = controls.current?.snapshot()
    if (!snap || snap.nodes.length === 0) return
    const rect = event.currentTarget.getBoundingClientRect()

    const xs = snap.nodes.map((n) => n.x).concat([snap.view.x0, snap.view.x1])
    const ys = snap.nodes.map((n) => n.y).concat([snap.view.y0, snap.view.y1])
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const spanX = maxX - minX || 1
    const spanY = maxY - minY || 1
    const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY)
    const ox = (W - spanX * scale) / 2
    const oy = (H - spanY * scale) / 2

    controls.current?.panTo(
      (event.clientX - rect.left - ox) / scale + minX,
      (event.clientY - rect.top - oy) / scale + minY,
    )
  }

  return (
    <canvas
      ref={canvas}
      onClick={jump}
      aria-label="Minimap"
      title="The whole graph. Red is a workload nothing protects, wherever it is."
      style={{ width: W, height: H }}
      className="glass rim pointer-events-auto absolute right-3.5 bottom-3.5 z-10 cursor-pointer rounded-lg border border-line"
    />
  )
}
