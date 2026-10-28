import ELK from 'elkjs/lib/elk-api'
import type { DiGraph, GraphLayout } from './graph'

// ELK runs off the main thread via a Web Worker (Vite resolves the worker URL).
let elkInstance: InstanceType<typeof ELK> | null = null
const getElk = (): InstanceType<typeof ELK> => {
  if (!elkInstance) {
    elkInstance = new ELK({
      workerFactory: () => new Worker(new URL('elkjs/lib/elk-worker.min.js', import.meta.url)),
    })
  }
  return elkInstance
}

const estimateWidth = (label: string) => Math.max(40, 24 + label.length * 7.2)

/**
 * High-quality layered layout via ELK (Sugiyama with dummy nodes + crossing
 * minimization + orthogonal routing). Async. Node positions are returned as
 * centers; edge routes (orthogonal polylines) are returned per edge id.
 */
export const elkLayout = async (
  graph: DiGraph,
  nodeSet: Set<string>,
  dir: 'LR' | 'TB',
  backEdges: Set<string>,
): Promise<GraphLayout & { routes: Map<string, Array<{ x: number; y: number }>> }> => {
  const positions = new Map<string, { x: number; y: number }>()
  const routes = new Map<string, Array<{ x: number; y: number }>>()
  const layerOf = new Map<string, number>()

  const children = [...nodeSet].map((id) => {
    const node = graph.nodes.get(id)
    const label = node?.label ?? id
    return { id, width: estimateWidth(label), height: 34 }
  })

  const seen = new Set<string>()
  const edges: Array<{ id: string; sources: string[]; targets: string[] }> = []
  for (const e of graph.edges) {
    if (!nodeSet.has(e.source) || !nodeSet.has(e.target) || e.source === e.target) continue
    const key = `${e.source}->${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ id: key, sources: [e.source], targets: [e.target] })
  }

  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': dir === 'LR' ? 'RIGHT' : 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '34',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children,
    edges,
  }

  const result = await getElk().layout(elkGraph)

  for (const child of result.children ?? []) {
    const cx = (child.x ?? 0) + (child.width ?? 0) / 2
    const cy = (child.y ?? 0) + (child.height ?? 0) / 2
    positions.set(child.id, { x: cx, y: cy })
    layerOf.set(child.id, Math.round((dir === 'LR' ? child.x ?? 0 : child.y ?? 0) / 90))
  }

  for (const edge of result.edges ?? []) {
    const section = (edge as { sections?: Array<{ startPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }>; endPoint: { x: number; y: number } }> }).sections?.[0]
    if (!section) continue
    const pts: Array<{ x: number; y: number }> = [section.startPoint]
    if (section.bendPoints) pts.push(...section.bendPoints)
    pts.push(section.endPoint)
    routes.set(edge.id, pts)
  }

  return { positions, routes, layerOf, backEdges }
}
