import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import {
  findEdgeHops,
  type DiGraph,
  type EdgeSegment,
  type GraphLayout,
} from './graph'

export type GraphCanvasHandle = {
  fitView: () => void
  centerOn: (nodeId: string) => void
  zoomBy: (factor: number) => void
}

type GraphCanvasProps = {
  graph: DiGraph
  nodeSet: Set<string>
  layout: GraphLayout
  focusId: string | null
  roots: Set<string>
  superNodes: Set<string>
  selectedEdgeId: string | null
  highlightEdges?: Set<string>
  highlightNodes?: Set<string>
  showNodeLabels: boolean
  showEdgeLabels: boolean
  showHops: boolean
  edgeThickness: number
  onSelect: (nodeId: string) => void
  onSelectEdge: (edgeId: string | null) => void
  onScaleChange?: (pct: number) => void
}

type Camera = { scale: number; tx: number; ty: number }

const NODE_RADIUS = 8
const MIN_SCALE = 0.05
const MAX_SCALE = 4
const DEFAULT_EDGE_COLOR = '#64748b'
const BACK_EDGE_COLOR = '#f472b6'
const DEFAULT_NODE_COLOR = '#4f8ef7'
const FOCUS_COLOR = '#f8fafc'
const ROOT_RING = '#f59e0b'
const SELECTED_EDGE_COLOR = '#f8fafc'
const PATH_COLOR = '#38bdf8'

const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(
  { graph, nodeSet, layout, focusId, roots, superNodes, selectedEdgeId, highlightEdges, highlightNodes, showNodeLabels, showEdgeLabels, showHops, edgeThickness, onSelect, onSelectEdge, onScaleChange },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cameraRef = useRef<Camera>({ scale: 1, tx: 0, ty: 0 })
  const frameRef = useRef<number | null>(null)
  const sizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 })
  const hitBoxesRef = useRef<Array<{ id: string; x: number; y: number; r: number }>>([])
  const edgeHitsRef = useRef<Array<{ id: string; pts: Array<{ x: number; y: number }> }>>([])
  const lastScaleRef = useRef<number>(-1)
  const dragRef = useRef({ active: false, moved: false, x: 0, y: 0 })

  const stateRef = useRef({ graph, nodeSet, layout, focusId, roots, superNodes, selectedEdgeId, highlightEdges, highlightNodes, showNodeLabels, showEdgeLabels, showHops, edgeThickness, onScaleChange, onSelectEdge })
  stateRef.current = { graph, nodeSet, layout, focusId, roots, superNodes, selectedEdgeId, highlightEdges, highlightNodes, showNodeLabels, showEdgeLabels, showHops, edgeThickness, onScaleChange, onSelectEdge }

  const worldBounds = useCallback(() => {
    const positions = stateRef.current.layout.positions
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of positions.values()) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    return { minX, minY, maxX, maxY }
  }, [])

  const scheduleDraw = useCallback(() => {
    if (frameRef.current != null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      draw()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const { width, height } = sizeRef.current
    const cam = cameraRef.current
    const st = stateRef.current

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#020817'
    ctx.fillRect(0, 0, width, height)

    const toScreen = (x: number, y: number) => ({ x: x * cam.scale + cam.tx, y: y * cam.scale + cam.ty })
    const radius = NODE_RADIUS * Math.min(1.6, Math.max(0.5, cam.scale))

    // Build de-duplicated induced edges.
    const pairs = new Map<string, { source: string; target: string; label?: string; color?: string; direction: string }>()
    for (const e of st.graph.edges) {
      if (!st.nodeSet.has(e.source) || !st.nodeSet.has(e.target)) continue
      if (e.source === e.target) continue
      const key = `${e.source}->${e.target}`
      if (!pairs.has(key)) pairs.set(key, { source: e.source, target: e.target, label: e.label, color: e.color, direction: e.direction })
    }

    // Compute screen-space segments (trimmed to node radius) for drawing + hop detection.
    type Seg = { id: string; back: boolean; color: string; label?: string; p1: { x: number; y: number }; p2: { x: number; y: number }; angle: number }
    const segs: Seg[] = []
    const routed: Array<{ id: string; back: boolean; color: string; label?: string; pts: Array<{ x: number; y: number }> }> = []
    const routes = st.layout.routes
    const margin = 240
    for (const [key, e] of pairs) {
      const a = st.layout.positions.get(e.source)
      const b = st.layout.positions.get(e.target)
      if (!a || !b) continue
      const back = st.layout.backEdges.has(key)
      const color = back ? BACK_EDGE_COLOR : e.color ?? DEFAULT_EDGE_COLOR
      const route = routes?.get(key)
      if (route && route.length >= 2) {
        const scr = route.map((p) => toScreen(p.x, p.y))
        const xs = scr.map((p) => p.x)
        const ys = scr.map((p) => p.y)
        if (Math.max(...xs) < -margin || Math.min(...xs) > width + margin || Math.max(...ys) < -margin || Math.min(...ys) > height + margin) continue
        // Trim endpoints to the node radius along the first/last segment.
        const p0 = scr[0]
        const p1 = scr[1]
        let d = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1
        scr[0] = { x: p0.x + ((p1.x - p0.x) / d) * radius, y: p0.y + ((p1.y - p0.y) / d) * radius }
        const q1 = scr[scr.length - 2]
        const q0 = scr[scr.length - 1]
        d = Math.hypot(q0.x - q1.x, q0.y - q1.y) || 1
        scr[scr.length - 1] = { x: q0.x - ((q0.x - q1.x) / d) * radius, y: q0.y - ((q0.y - q1.y) / d) * radius }
        routed.push({ id: key, back, color, label: e.label, pts: scr })
        continue
      }
      const s1 = toScreen(a.x, a.y)
      const s2 = toScreen(b.x, b.y)
      if (Math.max(s1.x, s2.x) < -margin || Math.min(s1.x, s2.x) > width + margin || Math.max(s1.y, s2.y) < -margin || Math.min(s1.y, s2.y) > height + margin) continue
      const dx = s2.x - s1.x, dy = s2.y - s1.y
      const len = Math.hypot(dx, dy) || 1
      const ux = dx / len, uy = dy / len
      segs.push({
        id: key,
        back,
        color,
        label: e.label,
        p1: { x: s1.x + ux * radius, y: s1.y + uy * radius },
        p2: { x: s2.x - ux * radius, y: s2.y - uy * radius },
        angle: Math.atan2(dy, dx),
      })
    }

    // Hops where straight edges cross (drawn on the "upper"/later edge).
    const hopsByEdge = new Map<string, Array<{ x: number; y: number }>>()
    if (st.showHops && segs.length > 1 && segs.length < 4000) {
      const segInput: EdgeSegment[] = segs.map((s) => ({ id: s.id, x1: s.p1.x, y1: s.p1.y, x2: s.p2.x, y2: s.p2.y }))
      for (const hop of findEdgeHops(segInput)) {
        if (!hopsByEdge.has(hop.id)) hopsByEdge.set(hop.id, [])
        hopsByEdge.get(hop.id)!.push({ x: hop.x, y: hop.y })
      }
    }

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const thickness = Math.max(0.6, st.edgeThickness * Math.min(1, cam.scale))
    const edgeHits: Array<{ id: string; pts: Array<{ x: number; y: number }> }> = []

    // Z-priority so selected/path edges draw on top (above aliased edges).
    const edgePriority = (id: string) => (st.selectedEdgeId === id ? 3 : st.highlightEdges?.has(id) ? 2 : 1)
    const edgeDrawColor = (id: string, baseColor: string) =>
      st.selectedEdgeId === id ? SELECTED_EDGE_COLOR : st.highlightEdges?.has(id) ? PATH_COLOR : baseColor
    const edgeDrawWidth = (id: string) =>
      st.selectedEdgeId === id ? thickness * 2.6 + 1 : st.highlightEdges?.has(id) ? thickness * 2 + 0.5 : thickness

    // Rounded orthogonal routed polylines (tree-style curves + looped back-edges).
    const sortedRouted = [...routed].sort((x, y) => edgePriority(x.id) - edgePriority(y.id))
    for (const r of routed) edgeHits.push({ id: r.id, pts: r.pts })
    for (const r of sortedRouted) {
      const color = edgeDrawColor(r.id, r.color)
      ctx.strokeStyle = color
      ctx.lineWidth = edgeDrawWidth(r.id)
      ctx.setLineDash(r.back && st.selectedEdgeId !== r.id ? [6, 5] : [])
      drawRoundedPolyline(ctx, r.pts, 14)
      ctx.setLineDash([])
      const b = r.pts[r.pts.length - 1]
      const a = r.pts[r.pts.length - 2]
      drawArrow(ctx, b.x, b.y, Math.atan2(b.y - a.y, b.x - a.x), color, cam.scale)
      if (st.showEdgeLabels && r.label && cam.scale > 0.45) {
        const mid = r.pts[Math.floor(r.pts.length / 2)]
        ctx.save()
        ctx.font = '11px Inter, system-ui, sans-serif'
        ctx.fillStyle = '#94a3b8'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(r.label, mid.x, mid.y - 6)
        ctx.restore()
      }
    }

    // Straight edges with hops (fallback when no route is available).
    for (const s of segs) {
      edgeHits.push({ id: s.id, pts: [s.p1, s.p2] })
      const color = edgeDrawColor(s.id, s.color)
      ctx.strokeStyle = color
      ctx.lineWidth = edgeDrawWidth(s.id)
      ctx.setLineDash(s.back && st.selectedEdgeId !== s.id ? [6, 5] : [])
      drawEdgePath(ctx, s.p1, s.p2, hopsByEdge.get(s.id), 6)
      ctx.setLineDash([])
      drawArrow(ctx, s.p2.x, s.p2.y, s.angle, color, cam.scale)

      if (st.showEdgeLabels && s.label && cam.scale > 0.45) {
        const mx = (s.p1.x + s.p2.x) / 2
        const my = (s.p1.y + s.p2.y) / 2
        ctx.save()
        ctx.font = '11px Inter, system-ui, sans-serif'
        ctx.fillStyle = '#94a3b8'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(s.label, mx, my - 6)
        ctx.restore()
      }
    }
    edgeHitsRef.current = edgeHits

    // Draw nodes.
    const hitBoxes: Array<{ id: string; x: number; y: number; r: number }> = []
    ctx.textBaseline = 'middle'
    for (const id of st.nodeSet) {
      const p = st.layout.positions.get(id)
      if (!p) continue
      const s = toScreen(p.x, p.y)
      if (s.x < -margin || s.x > width + margin || s.y < -margin || s.y > height + margin) continue
      const node = st.graph.nodes.get(id)
      if (!node) continue

      const isFocus = st.focusId === id
      const isRoot = st.roots.has(id)
      const isSuper = st.superNodes.has(id)
      const isPath = st.highlightNodes?.has(id) ?? false
      const r = (isFocus ? radius + 3 : radius) * (isSuper ? 1.5 : 1)

      if (isPath) {
        // Path node: cyan halo so the highlighted path reads clearly.
        ctx.beginPath()
        ctx.arc(s.x, s.y, r + 4, 0, Math.PI * 2)
        ctx.strokeStyle = PATH_COLOR
        ctx.lineWidth = 2.5
        ctx.stroke()
      }

      if (isSuper) {
        // Cycle super-node: hexagon-ish double ring to signal "expandable cluster".
        ctx.beginPath()
        ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2)
        ctx.strokeStyle = '#a78bfa'
        ctx.lineWidth = 2
        ctx.stroke()
      }

      ctx.beginPath()
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
      ctx.fillStyle = node.color ?? DEFAULT_NODE_COLOR
      ctx.fill()
      if (isFocus) {
        ctx.lineWidth = 3
        ctx.strokeStyle = FOCUS_COLOR
        ctx.stroke()
      } else if (isRoot) {
        ctx.lineWidth = 3
        ctx.strokeStyle = ROOT_RING
        ctx.stroke()
      } else {
        ctx.lineWidth = isSuper ? 2 : 1
        ctx.strokeStyle = isSuper ? '#c4b5fd' : 'rgba(15,23,42,0.6)'
        ctx.stroke()
      }

      if (st.showNodeLabels) {
        const fontPx = 15 * cam.scale
        if (fontPx >= 4) {
          const label = node.label || id
          ctx.font = `${isFocus || isSuper ? '600 ' : ''}${fontPx}px Inter, system-ui, sans-serif`
          const w = ctx.measureText(label).width
          const tx = s.x + r + 4
          const h = fontPx + 4
          ctx.fillStyle = 'rgba(2,8,23,0.7)'
          ctx.fillRect(tx - 2, s.y - h / 2, w + 4, h)
          ctx.fillStyle = isSuper ? '#ddd6fe' : isFocus ? '#ffffff' : isRoot ? '#fde68a' : '#e2e8f0'
          ctx.textAlign = 'left'
          ctx.fillText(label, tx, s.y + 0.5)
        }
      }

      hitBoxes.push({ id, x: s.x, y: s.y, r: r + 4 })
    }
    hitBoxesRef.current = hitBoxes

    const pct = Math.round(cam.scale * 100)
    if (pct !== lastScaleRef.current) {
      lastScaleRef.current = pct
      st.onScaleChange?.(pct)
    }
  }, [])

  const fitView = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { width, height } = sizeRef.current
    const { minX, minY, maxX, maxY } = worldBounds()
    const pad = 90
    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY, 1.4)))
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    cameraRef.current = { scale, tx: width / 2 - cx * scale, ty: height / 2 - cy * scale }
    scheduleDraw()
  }, [scheduleDraw, worldBounds])

  const centerOn = useCallback((nodeId: string) => {
    const p = stateRef.current.layout.positions.get(nodeId)
    if (!p) return
    const { width, height } = sizeRef.current
    const cam = cameraRef.current
    cameraRef.current = { scale: cam.scale, tx: width / 2 - p.x * cam.scale, ty: height / 2 - p.y * cam.scale }
    scheduleDraw()
  }, [scheduleDraw])

  const zoomBy = useCallback((factor: number) => {
    const { width, height } = sizeRef.current
    const cam = cameraRef.current
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * factor))
    const cx = width / 2, cy = height / 2
    const wx = (cx - cam.tx) / cam.scale, wy = (cy - cam.ty) / cam.scale
    cameraRef.current = { scale: next, tx: cx - wx * next, ty: cy - wy * next }
    scheduleDraw()
  }, [scheduleDraw])

  useImperativeHandle(ref, () => ({ fitView, centerOn, zoomBy }), [fitView, centerOn, zoomBy])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    const applySize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = parent.getBoundingClientRect()
      sizeRef.current = { width: rect.width, height: rect.height }
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      scheduleDraw()
    }
    applySize()
    const observer = new ResizeObserver(applySize)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [scheduleDraw])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const local = (e: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }
    const onDown = (e: PointerEvent) => {
      const l = local(e)
      dragRef.current = { active: true, moved: false, x: l.x, y: l.y }
      canvas.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d.active) return
      const l = local(e)
      const dx = l.x - d.x, dy = l.y - d.y
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true
      const cam = cameraRef.current
      cameraRef.current = { scale: cam.scale, tx: cam.tx + dx, ty: cam.ty + dy }
      d.x = l.x; d.y = l.y
      scheduleDraw()
    }
    const hit = (lx: number, ly: number) => {
      const boxes = hitBoxesRef.current
      for (let i = boxes.length - 1; i >= 0; i -= 1) {
        const b = boxes[i]
        if (Math.hypot(lx - b.x, ly - b.y) <= b.r + 6) return b.id
      }
      return null
    }
    const hitEdge = (lx: number, ly: number) => {
      let best: string | null = null
      let bestDist = 8
      for (const edge of edgeHitsRef.current) {
        const pts = edge.pts
        for (let i = 0; i < pts.length - 1; i += 1) {
          const dist = pointSegmentDistance(lx, ly, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y)
          if (dist < bestDist) {
            bestDist = dist
            best = edge.id
          }
        }
      }
      return best
    }
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current
      dragRef.current = { ...d, active: false }
      try { canvas.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
      if (d.moved) return
      const l = local(e)
      const id = hit(l.x, l.y)
      if (id) {
        onSelect(id)
        stateRef.current.onSelectEdge(null)
        return
      }
      const edgeId = hitEdge(l.x, l.y)
      stateRef.current.onSelectEdge(edgeId)
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const l = local(e)
      const cam = cameraRef.current
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * Math.exp(-e.deltaY * 0.0015)))
      const wx = (l.x - cam.tx) / cam.scale, wy = (l.y - cam.ty) / cam.scale
      cameraRef.current = { scale: next, tx: l.x - wx * next, ty: l.y - wy * next }
      scheduleDraw()
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [onSelect, scheduleDraw])

  useEffect(() => {
    scheduleDraw()
  }, [graph, nodeSet, layout, focusId, roots, superNodes, selectedEdgeId, highlightEdges, highlightNodes, showNodeLabels, showEdgeLabels, showHops, edgeThickness, scheduleDraw])

  return <canvas ref={canvasRef} className="tree-canvas" aria-label="Visualización de grafo" />
})

function pointSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

function drawRoundedPolyline(
  ctx: CanvasRenderingContext2D,
  pts: Array<{ x: number; y: number }>,
  radius: number,
) {
  if (pts.length < 2) return
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y)
    ctx.stroke()
    return
  }
  for (let i = 1; i < pts.length - 1; i += 1) {
    // Clamp the fillet radius to the shorter adjacent segment.
    const prev = pts[i - 1]
    const cur = pts[i]
    const next = pts[i + 1]
    const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y)
    const d2 = Math.hypot(next.x - cur.x, next.y - cur.y)
    const r = Math.max(0, Math.min(radius, d1 / 2, d2 / 2))
    ctx.arcTo(cur.x, cur.y, next.x, next.y, r)
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y)
  ctx.stroke()
}

function drawEdgePath(
  ctx: CanvasRenderingContext2D,
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  hops: Array<{ x: number; y: number }> | undefined,
  hopRadius: number,
) {
  ctx.beginPath()
  if (!hops || hops.length === 0) {
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
    ctx.stroke()
    return
  }
  const dx = p2.x - p1.x, dy = p2.y - p1.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len, uy = dy / len
  const px = -uy, py = ux // perpendicular
  const sorted = [...hops].sort((a, b) => ((a.x - p1.x) * ux + (a.y - p1.y) * uy) - ((b.x - p1.x) * ux + (b.y - p1.y) * uy))
  ctx.moveTo(p1.x, p1.y)
  for (const h of sorted) {
    const entry = { x: h.x - ux * hopRadius, y: h.y - uy * hopRadius }
    const exit = { x: h.x + ux * hopRadius, y: h.y + uy * hopRadius }
    const control = { x: h.x + px * hopRadius * 1.6, y: h.y + py * hopRadius * 1.6 }
    ctx.lineTo(entry.x, entry.y)
    ctx.quadraticCurveTo(control.x, control.y, exit.x, exit.y)
  }
  ctx.lineTo(p2.x, p2.y)
  ctx.stroke()
}

function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string, scale: number) {
  const size = Math.max(5, 8 * Math.min(1.4, Math.max(0.6, scale)))
  ctx.save()
  ctx.setLineDash([])
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(-size, -size * 0.5)
  ctx.lineTo(-size, size * 0.5)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

export default GraphCanvas
