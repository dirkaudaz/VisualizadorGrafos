import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import type { MermaidTree, RenderGraph, TreeEdge } from './tree'

export type TreeCanvasHandle = {
  fitView: () => void
  centerOn: (nodeId: string) => void
  zoomBy: (factor: number) => void
  ensureVisible: (nodeId: string) => void
}

type TreeCanvasProps = {
  tree: MermaidTree
  render: RenderGraph
  descendantCounts: Map<string, number>
  selectedNodeId: string | null
  layoutDirection: 'LR' | 'TB'
  showNodeLabels: boolean
  showEdgeLabels: boolean
  edgeThickness: number
  onSelect: (nodeId: string) => void
  onToggle: (nodeId: string) => void
  onRevealAncestors: (nodeId: string) => void
  onScaleChange?: (pct: number) => void
}

type Camera = { scale: number; tx: number; ty: number }

const NODE_RADIUS = 6
const MIN_SCALE = 0.05
const MAX_SCALE = 4
const DEFAULT_EDGE_COLOR = '#64748b'
const DEFAULT_NODE_COLOR = '#4f8ef7'

const edgeKey = (edge: TreeEdge) => `${edge.source}->${edge.target}`

const TreeCanvas = forwardRef<TreeCanvasHandle, TreeCanvasProps>(function TreeCanvas(
  {
    tree,
    render,
    descendantCounts,
    selectedNodeId,
    layoutDirection,
    showNodeLabels,
    showEdgeLabels,
    edgeThickness,
    onSelect,
    onToggle,
    onRevealAncestors,
    onScaleChange,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cameraRef = useRef<Camera>({ scale: 1, tx: 0, ty: 0 })
  const frameRef = useRef<number | null>(null)
  const sizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 })
  const hitBoxesRef = useRef<Array<{ id: string; x0: number; y0: number; x1: number; y1: number }>>([])
  const lastReportedScaleRef = useRef<number>(-1)
  const dragRef = useRef<{ active: boolean; moved: boolean; x: number; y: number }>({
    active: false,
    moved: false,
    x: 0,
    y: 0,
  })

  // Keep the latest props available to the imperative draw loop without re-binding listeners.
  const stateRef = useRef({
    tree,
    render,
    descendantCounts,
    selectedNodeId,
    layoutDirection,
    showNodeLabels,
    showEdgeLabels,
    edgeThickness,
    onScaleChange,
  })
  stateRef.current = {
    tree,
    render,
    descendantCounts,
    selectedNodeId,
    layoutDirection,
    showNodeLabels,
    showEdgeLabels,
    edgeThickness,
    onScaleChange,
  }

  const worldBounds = useCallback(() => {
    const positions = stateRef.current.render.positions
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const pos of positions.values()) {
      if (pos.x < minX) minX = pos.x
      if (pos.y < minY) minY = pos.y
      if (pos.x > maxX) maxX = pos.x
      if (pos.y > maxY) maxY = pos.y
    }
    if (!Number.isFinite(minX)) {
      return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    }
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
    const {
      tree: curTree,
      render: curRender,
      descendantCounts: curCounts,
      selectedNodeId: curSelected,
      layoutDirection: dir,
      showNodeLabels: labelsOn,
      showEdgeLabels: edgeLabelsOn,
      edgeThickness: thickness,
    } = stateRef.current

    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#020817'
    ctx.fillRect(0, 0, width, height)

    const toScreen = (x: number, y: number) => ({ x: x * cam.scale + cam.tx, y: y * cam.scale + cam.ty })

    // Viewport cull margin in screen pixels.
    const margin = 200

    // --- Connectors (curved file-explorer elbows with arrowheads) ---
    ctx.lineWidth = Math.max(0.5, thickness * Math.min(1, cam.scale))
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const edge of curTree.edges) {
      const key = edgeKey(edge)
      if (!curRender.visibleEdges.has(key)) continue
      const parentPos = curRender.positions.get(edge.source)
      const childPos = curRender.positions.get(edge.target)
      if (!parentPos || !childPos) continue

      const p = toScreen(parentPos.x, parentPos.y)
      const c = toScreen(childPos.x, childPos.y)

      if (
        Math.max(p.x, c.x) < -margin ||
        Math.min(p.x, c.x) > width + margin ||
        Math.max(p.y, c.y) < -margin ||
        Math.min(p.y, c.y) > height + margin
      ) {
        continue
      }

      ctx.strokeStyle = edge.color ?? DEFAULT_EDGE_COLOR
      ctx.beginPath()

      if (dir === 'LR') {
        const corner = Math.min(14 * cam.scale, Math.abs(c.y - p.y) / 2, Math.abs(c.x - p.x) / 2)
        const startY = p.y + NODE_RADIUS * cam.scale
        ctx.moveTo(p.x, startY)
        ctx.lineTo(p.x, c.y - corner)
        ctx.quadraticCurveTo(p.x, c.y, p.x + corner, c.y)
        ctx.lineTo(c.x - NODE_RADIUS * cam.scale, c.y)
        ctx.stroke()
        drawArrow(ctx, c.x - NODE_RADIUS * cam.scale, c.y, 0, edge.color ?? DEFAULT_EDGE_COLOR, cam.scale, edge.direction)
      } else {
        const corner = Math.min(14 * cam.scale, Math.abs(c.x - p.x) / 2, Math.abs(c.y - p.y) / 2)
        const startX = p.x + NODE_RADIUS * cam.scale
        ctx.moveTo(startX, p.y)
        ctx.lineTo(c.x - corner, p.y)
        ctx.quadraticCurveTo(c.x, p.y, c.x, p.y + corner)
        ctx.lineTo(c.x, c.y - NODE_RADIUS * cam.scale)
        ctx.stroke()
        drawArrow(ctx, c.x, c.y - NODE_RADIUS * cam.scale, Math.PI / 2, edge.color ?? DEFAULT_EDGE_COLOR, cam.scale, edge.direction)
      }

      if (edgeLabelsOn && edge.label && cam.scale > 0.45) {
        const midX = dir === 'LR' ? p.x + 6 : (p.x + c.x) / 2
        const midY = dir === 'LR' ? (p.y + c.y) / 2 : p.y - 6
        ctx.save()
        ctx.font = '11px Inter, system-ui, sans-serif'
        ctx.fillStyle = '#94a3b8'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(edge.label, midX + 4, midY)
        ctx.restore()
      }
    }

    // --- Nodes ---
    const hitBoxes: Array<{ id: string; x0: number; y0: number; x1: number; y1: number }> = []
    ctx.textBaseline = 'middle'
    ctx.font = '13px Inter, system-ui, sans-serif'

    for (const nodeId of curRender.order) {
      const pos = curRender.positions.get(nodeId)
      if (!pos) continue
      const node = curTree.nodes.get(nodeId)
      if (!node) continue

      const s = toScreen(pos.x, pos.y)
      if (s.x < -margin || s.x > width + margin || s.y < -margin || s.y > height + margin) {
        continue
      }

      const isSelected = curSelected === nodeId
      const radius = (isSelected ? NODE_RADIUS + 2 : NODE_RADIUS) * Math.min(1.6, Math.max(0.6, cam.scale))

      const hasChildren = node.children.length > 0
      const isExpanded = hasChildren && curRender.visibleEdges.has(`${nodeId}->${node.children[0]}`)
      const isCollapsedParent = hasChildren && !isExpanded

      // Expand/collapse chevron for nodes with children.
      if (hasChildren) {
        ctx.fillStyle = '#cbd5e1'
        ctx.beginPath()
        const chevSize = 4 * Math.min(1.4, Math.max(0.7, cam.scale))
        const cx = s.x - radius - chevSize - 2
        if (isExpanded) {
          ctx.moveTo(cx - chevSize, s.y - chevSize)
          ctx.lineTo(cx + chevSize, s.y - chevSize)
          ctx.lineTo(cx, s.y + chevSize)
        } else {
          ctx.moveTo(cx - chevSize, s.y - chevSize)
          ctx.lineTo(cx + chevSize, s.y)
          ctx.lineTo(cx - chevSize, s.y + chevSize)
        }
        ctx.closePath()
        ctx.fill()
      }

      // Node marker.
      ctx.beginPath()
      ctx.arc(s.x, s.y, radius, 0, Math.PI * 2)
      ctx.fillStyle = node.color ?? DEFAULT_NODE_COLOR
      ctx.fill()
      if (isSelected) {
        ctx.lineWidth = 2
        ctx.strokeStyle = '#f8fafc'
        ctx.stroke()
      } else {
        ctx.lineWidth = 1
        ctx.strokeStyle = 'rgba(15,23,42,0.6)'
        ctx.stroke()
      }

      // Label (+ a lighter/smaller count suffix on collapsed, non-leaf nodes).
      let labelWidth = 0
      if (labelsOn && cam.scale > 0.2) {
        const label = node.label || nodeId
        const mainFont = isSelected ? '600 13px Inter, system-ui, sans-serif' : '13px Inter, system-ui, sans-serif'
        const suffix = isCollapsedParent
          ? ` (${node.children.length} : ${curCounts.get(nodeId) ?? 0})`
          : ''

        ctx.font = mainFont
        const mainWidth = ctx.measureText(label).width
        let suffixWidth = 0
        if (suffix) {
          ctx.font = '11px Inter, system-ui, sans-serif'
          suffixWidth = ctx.measureText(suffix).width
        }
        labelWidth = mainWidth + suffixWidth

        const textX = s.x + radius + 6
        // Readable chip behind the label.
        ctx.fillStyle = 'rgba(2,8,23,0.65)'
        ctx.fillRect(textX - 2, s.y - 9, labelWidth + 4, 18)

        ctx.textAlign = 'left'
        ctx.font = mainFont
        ctx.fillStyle = isSelected ? '#ffffff' : '#e2e8f0'
        ctx.fillText(label, textX, s.y + 0.5)

        if (suffix) {
          ctx.font = '11px Inter, system-ui, sans-serif'
          ctx.fillStyle = '#7f93ad'
          ctx.fillText(suffix, textX + mainWidth, s.y + 0.5)
        }
      }

      const boxX1 = labelsOn ? s.x + radius + 10 + labelWidth : s.x + radius + 4
      hitBoxes.push({
        id: nodeId,
        x0: s.x - radius - 14,
        y0: s.y - 11,
        x1: boxX1,
        y1: s.y + 11,
      })
    }

    hitBoxesRef.current = hitBoxes
    ctx.restore()

    const pct = Math.round(cam.scale * 100)
    if (pct !== lastReportedScaleRef.current) {
      lastReportedScaleRef.current = pct
      stateRef.current.onScaleChange?.(pct)
    }
  }, [])

  const fitView = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { width, height } = sizeRef.current
    const { minX, minY, maxX, maxY } = worldBounds()
    const pad = 80
    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY, 1.2)),
    )
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    cameraRef.current = {
      scale,
      tx: width / 2 - centerX * scale,
      ty: height / 2 - centerY * scale,
    }
    scheduleDraw()
  }, [scheduleDraw, worldBounds])

  const centerOn = useCallback(
    (nodeId: string) => {
      const pos = stateRef.current.render.positions.get(nodeId)
      if (!pos) return
      const { width, height } = sizeRef.current
      const cam = cameraRef.current
      cameraRef.current = {
        scale: cam.scale,
        tx: width / 2 - pos.x * cam.scale,
        ty: height / 2 - pos.y * cam.scale,
      }
      scheduleDraw()
    },
    [scheduleDraw],
  )

  // Pan to a node only when it is outside (or near the edge of) the viewport.
  const ensureVisible = useCallback(
    (nodeId: string) => {
      const pos = stateRef.current.render.positions.get(nodeId)
      if (!pos) return
      const { width, height } = sizeRef.current
      const cam = cameraRef.current
      const sx = pos.x * cam.scale + cam.tx
      const sy = pos.y * cam.scale + cam.ty
      const m = 60
      if (sx < m || sx > width - m || sy < m || sy > height - m) {
        cameraRef.current = {
          scale: cam.scale,
          tx: width / 2 - pos.x * cam.scale,
          ty: height / 2 - pos.y * cam.scale,
        }
        scheduleDraw()
      }
    },
    [scheduleDraw],
  )

  const zoomBy = useCallback(
    (factor: number) => {
      const { width, height } = sizeRef.current
      const cam = cameraRef.current
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * factor))
      // Zoom around the canvas center.
      const cx = width / 2
      const cy = height / 2
      const worldX = (cx - cam.tx) / cam.scale
      const worldY = (cy - cam.ty) / cam.scale
      cameraRef.current = {
        scale: nextScale,
        tx: cx - worldX * nextScale,
        ty: cy - worldY * nextScale,
      }
      scheduleDraw()
    },
    [scheduleDraw],
  )

  useImperativeHandle(ref, () => ({ fitView, centerOn, zoomBy, ensureVisible }), [fitView, centerOn, zoomBy, ensureVisible])

  // Resize handling.
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

  // Pointer interactions (pan + click).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const getLocal = (event: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    const onPointerDown = (event: PointerEvent) => {
      const local = getLocal(event)
      dragRef.current = { active: true, moved: false, x: local.x, y: local.y }
      canvas.setPointerCapture(event.pointerId)
    }

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag.active) return
      const local = getLocal(event)
      const dx = local.x - drag.x
      const dy = local.y - drag.y
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true
      const cam = cameraRef.current
      cameraRef.current = { scale: cam.scale, tx: cam.tx + dx, ty: cam.ty + dy }
      drag.x = local.x
      drag.y = local.y
      scheduleDraw()
    }

    const hitTest = (lx: number, ly: number) => {
      const boxes = hitBoxesRef.current
      for (let i = boxes.length - 1; i >= 0; i -= 1) {
        const box = boxes[i]
        if (lx >= box.x0 && lx <= box.x1 && ly >= box.y0 && ly <= box.y1) return box.id
      }
      return null
    }

    const onPointerUp = (event: PointerEvent) => {
      const drag = dragRef.current
      dragRef.current = { ...drag, active: false }
      try {
        canvas.releasePointerCapture(event.pointerId)
      } catch {
        /* ignore */
      }
      if (drag.moved) return
      const local = getLocal(event)
      const nodeId = hitTest(local.x, local.y)
      if (!nodeId) return
      onSelect(nodeId)
      onToggle(nodeId)
    }

    const onDoubleClick = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const nodeId = hitTest(event.clientX - rect.left, event.clientY - rect.top)
      if (!nodeId) return
      onSelect(nodeId)
      onRevealAncestors(nodeId)
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const local = getLocal(event)
      const cam = cameraRef.current
      const factor = Math.exp(-event.deltaY * 0.0015)
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * factor))
      // Zoom toward the cursor.
      const worldX = (local.x - cam.tx) / cam.scale
      const worldY = (local.y - cam.ty) / cam.scale
      cameraRef.current = {
        scale: nextScale,
        tx: local.x - worldX * nextScale,
        ty: local.y - worldY * nextScale,
      }
      scheduleDraw()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('dblclick', onDoubleClick)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('dblclick', onDoubleClick)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [onRevealAncestors, onSelect, onToggle, scheduleDraw])

  // Redraw whenever render inputs change (camera is preserved across these).
  useEffect(() => {
    scheduleDraw()
  }, [render, descendantCounts, selectedNodeId, showNodeLabels, showEdgeLabels, edgeThickness, layoutDirection, tree, scheduleDraw])

  return <canvas ref={canvasRef} className="tree-canvas" aria-label="Visualización de árbol" />
})

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  color: string,
  scale: number,
  direction: TreeEdge['direction'],
) {
  const size = Math.max(5, 7 * Math.min(1.4, Math.max(0.7, scale)))
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(-size, -size * 0.55)
  ctx.lineTo(-size, size * 0.55)
  ctx.closePath()
  ctx.fill()
  if (direction === 'backward' || direction === 'both') {
    // Mark reverse direction with a hollow notch at the tail-ish side.
    ctx.beginPath()
    ctx.moveTo(-size * 1.6, 0)
    ctx.lineTo(-size * 2.4, -size * 0.5)
    ctx.lineTo(-size * 2.4, size * 0.5)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}

export default TreeCanvas
