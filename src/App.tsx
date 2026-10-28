import { useEffect, useMemo, useRef, useState } from 'react'
import TreeCanvas, { type TreeCanvasHandle } from './TreeCanvas'
import GraphCanvas, { type GraphCanvasHandle } from './GraphCanvas'
import {
  buildCondensedView,
  buildDiGraph,
  computeSCCs,
  findPath,
  layeredLayout,
  traceFrom,
  SAMPLE_NETWORK,
  type TraceDirection,
} from './graph'
import { elkLayout } from './elkLayout'
import {
  getAncestorPath,
  getDescendantCounts,
  getLegendGroups,
  getRenderGraph,
  parseMermaidTree,
  revealAncestorsToRoot,
  searchNodes,
  toggleNodeExpanded,
  type SearchMatch,
} from './tree'

const DEFAULT_MERMAID = `graph LR
    A[Raíz]
    B[Hijo 1]
    C[Hijo 2]
    D[Nieto 1]
    E[Nieto 2]
    F[Hijo 3]
    G[Bisnieto 1]
    H[Bisnieto 2]

    A -->|padre| B
    A --> C
    B --> D
    B --> E
    C --> F
    D --> G
    D --> H

    classDef root fill:#dbeafe,stroke:#2563eb,color:#0f172a
    classDef branch fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef leaf fill:#fef3c7,stroke:#d97706,color:#78350f

    class A root
    class B,C,F branch
    class D,E,G,H leaf`

const readFileText = async (file: File) => file.text()
type LayoutDirection = 'LR' | 'TB'
type ViewMode = 'tree' | 'graph'

function App() {
  const [mermaidText, setMermaidText] = useState(DEFAULT_MERMAID)
  const [fileName, setFileName] = useState<string | null>(null)
  const [mode, setMode] = useState<ViewMode>('tree')
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([])
  const [layoutDirection, setLayoutDirection] = useState<LayoutDirection>('LR')
  const [showNodeLabels, setShowNodeLabels] = useState(true)
  const [showEdgeLabels, setShowEdgeLabels] = useState(true)
  const [edgeThickness, setEdgeThickness] = useState(2)
  const [showLegend, setShowLegend] = useState(true)
  const [zoomPct, setZoomPct] = useState(100)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [graphFocusId, setGraphFocusId] = useState<string | null>(null)
  const [traceDir, setTraceDir] = useState<TraceDirection>('both')
  const [showHops, setShowHops] = useState(true)
  const [collapseCycles, setCollapseCycles] = useState(false)
  const [expandedSccs, setExpandedSccs] = useState<Set<number>>(new Set())
  const [layoutEngine, setLayoutEngine] = useState<'fast' | 'elk'>('fast')
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [pathOrigin, setPathOrigin] = useState<string>('')
  const [pathDest, setPathDest] = useState<string>('')
  const [elkResult, setElkResult] = useState<{ positions: Map<string, { x: number; y: number }>; backEdges: Set<string>; layerOf: Map<string, number>; routes: Map<string, Array<{ x: number; y: number }>> } | null>(null)
  const [elkPending, setElkPending] = useState(false)
  const canvasRef = useRef<TreeCanvasHandle | null>(null)
  const graphCanvasRef = useRef<GraphCanvasHandle | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const pendingFitRef = useRef(false)

  const parsedTree = useMemo(() => parseMermaidTree(mermaidText), [mermaidText])

  useEffect(() => {
    if (!parsedTree.rootId) {
      setExpanded(new Set())
      setSelectedNodeId(null)
      return
    }
    setSelectedNodeId(parsedTree.rootId)
    setExpanded(new Set())
    pendingFitRef.current = true
  }, [parsedTree.rootId, mermaidText])

  useEffect(() => {
    const nextResults = searchTerm.trim() ? searchNodes(parsedTree, searchTerm) : []
    setSearchResults(nextResults)
  }, [parsedTree, searchTerm])

  const visibleGraph = useMemo(
    () => getRenderGraph(parsedTree, expanded, layoutDirection),
    [expanded, layoutDirection, parsedTree],
  )

  const descendantCounts = useMemo(() => getDescendantCounts(parsedTree), [parsedTree])
  const legendGroups = useMemo(() => getLegendGroups(parsedTree), [parsedTree])
  const ancestorPath = useMemo(
    () => (selectedNodeId ? getAncestorPath(parsedTree, selectedNodeId) : []),
    [parsedTree, selectedNodeId],
  )

  // Fit the view only on explicit reset / initial load / orientation change — never on expand.
  useEffect(() => {
    if (pendingFitRef.current && parsedTree.rootId) {
      pendingFitRef.current = false
      requestAnimationFrame(() => canvasRef.current?.fitView())
    }
  }, [visibleGraph, parsedTree.rootId])

  useEffect(() => {
    if (!parsedTree.rootId) return
    pendingFitRef.current = true
  }, [layoutDirection, parsedTree.rootId])

  const selectedNode = selectedNodeId ? parsedTree.nodes.get(selectedNodeId) ?? null : null
  const totalNodes = parsedTree.nodes.size
  const visibleCount = visibleGraph.visibleNodes.size
  const hasValidGraph = Boolean(parsedTree.rootId) && !parsedTree.validationError

  // ---- Graph mode (arbitrary directed graphs, cycles allowed) ----
  const diGraph = useMemo(() => buildDiGraph(mermaidText), [mermaidText])
  const graphScc = useMemo(() => computeSCCs(diGraph), [diGraph])
  const cycleCount = useMemo(
    () => graphScc.components.filter((c) => c.length > 1).length,
    [graphScc],
  )
  const graphHasContent = diGraph.nodes.size > 0 && !diGraph.validationError

  // Pick a sensible default focus (highest total degree) when the graph changes.
  useEffect(() => {
    if (!graphHasContent) {
      setGraphFocusId(null)
      return
    }
    setGraphFocusId((current) => {
      if (current && diGraph.nodes.has(current)) return current
      let best: string | null = null
      let bestDeg = -1
      for (const id of diGraph.nodes.keys()) {
        const deg = (diGraph.in.get(id)?.length ?? 0) + (diGraph.out.get(id)?.length ?? 0)
        if (deg > bestDeg) {
          bestDeg = deg
          best = id
        }
      }
      return best
    })
  }, [diGraph, graphHasContent])

  const graphTrace = useMemo(
    () => (graphFocusId && diGraph.nodes.has(graphFocusId) ? traceFrom(diGraph, graphFocusId, traceDir) : null),
    [diGraph, graphFocusId, traceDir],
  )
  const graphNodeSet = useMemo(
    () => graphTrace?.nodes ?? (graphFocusId ? new Set([graphFocusId]) : new Set<string>()),
    [graphTrace, graphFocusId],
  )
  const graphRoots = useMemo(() => graphTrace?.roots ?? new Set<string>(), [graphTrace])

  // Path finder: shortest directed path origin → destino (if any).
  const pathResult = useMemo(
    () => (pathOrigin && pathDest ? findPath(diGraph, pathOrigin, pathDest) : null),
    [diGraph, pathOrigin, pathDest],
  )

  // Node set to display: the trace plus any path nodes so the path is visible.
  const activeNodeSet = useMemo(() => {
    if (!pathResult) return graphNodeSet
    const set = new Set(graphNodeSet)
    for (const id of pathResult.nodes) set.add(id)
    return set
  }, [graphNodeSet, pathResult])

  const graphNodeOptions = useMemo(
    () =>
      [...diGraph.nodes.values()]
        .map((n) => ({ id: n.id, label: n.label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [diGraph],
  )

  const selectedEdgeLabel = useMemo(() => {
    if (!selectedEdgeId) return ''
    const [s, t] = selectedEdgeId.split('->')
    const name = (id: string) => (id.startsWith('scc:') ? 'Ciclo' : diGraph.nodes.get(id)?.label ?? id)
    return `${name(s)} → ${name(t)}`
  }, [selectedEdgeId, diGraph])

  // Reset per-SCC expansion when the graph changes or collapsing is turned off.
  useEffect(() => {
    setExpandedSccs(new Set())
  }, [diGraph, collapseCycles])

  // Clear transient selections/paths when the underlying graph changes.
  useEffect(() => {
    setSelectedEdgeId(null)
    setPathOrigin('')
    setPathDest('')
  }, [diGraph])

  // Condense cycles into expandable super-nodes (optional), then lay out.
  const condensed = useMemo(
    () => buildCondensedView(diGraph, graphScc, activeNodeSet, collapseCycles, expandedSccs),
    [diGraph, graphScc, activeNodeSet, collapseCycles, expandedSccs],
  )

  // Path highlight sets, mapped through the condensation so they stay correct
  // when cycles are collapsed.
  const highlightNodes = useMemo(() => {
    if (!pathResult) return undefined
    return new Set(pathResult.nodes.map((id) => condensed.renderIdOf(id)))
  }, [pathResult, condensed])
  const highlightEdges = useMemo(() => {
    if (!pathResult) return undefined
    const set = new Set<string>()
    const seq = pathResult.nodes
    for (let i = 0; i < seq.length - 1; i += 1) {
      const s = condensed.renderIdOf(seq[i])
      const t = condensed.renderIdOf(seq[i + 1])
      if (s !== t) set.add(`${s}->${t}`)
    }
    return set
  }, [pathResult, condensed])

  const graphLayout = useMemo(
    () => layeredLayout(condensed.graph, condensed.nodeSet, layoutDirection),
    [condensed, layoutDirection],
  )

  // Optional high-quality layout via ELK (async, off main thread). Falls back
  // to the fast layout while computing or on error. Back-edge styling reuses
  // the fast layout's detection.
  useEffect(() => {
    if (mode !== 'graph' || layoutEngine !== 'elk' || condensed.nodeSet.size === 0) {
      setElkResult(null)
      setElkPending(false)
      return
    }
    let cancelled = false
    setElkPending(true)
    elkLayout(condensed.graph, condensed.nodeSet, layoutDirection, graphLayout.backEdges)
      .then((result) => {
        if (cancelled) return
        setElkResult({ positions: result.positions, backEdges: result.backEdges, layerOf: result.layerOf, routes: result.routes })
        setElkPending(false)
        requestAnimationFrame(() => graphCanvasRef.current?.fitView())
      })
      .catch((error) => {
        if (cancelled) return
        console.error('ELK layout failed, using fast layout:', error)
        setElkResult(null)
        setElkPending(false)
      })
    return () => {
      cancelled = true
    }
  }, [mode, layoutEngine, condensed, layoutDirection, graphLayout])

  const effectiveGraphLayout = layoutEngine === 'elk' && elkResult ? elkResult : graphLayout
  const graphFocusRenderId = graphFocusId ? condensed.renderIdOf(graphFocusId) : null
  const graphRootsRender = useMemo(
    () => new Set([...graphRoots].map((id) => condensed.renderIdOf(id))),
    [graphRoots, condensed],
  )

  const handleGraphSelect = (id: string) => {
    if (id.startsWith('scc:')) {
      const comp = Number(id.slice(4))
      setExpandedSccs((previous) => {
        const next = new Set(previous)
        next.add(comp)
        return next
      })
      return
    }
    setGraphFocusId(id)
    requestAnimationFrame(() => graphCanvasRef.current?.centerOn(id))
  }

  const graphLegendGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; color: string }>()
    for (const node of diGraph.nodes.values()) {
      const key = node.className ?? `__color__:${node.color ?? '#4f8ef7'}`
      if (!groups.has(key)) {
        groups.set(key, { key, label: node.className ?? (node.color ? 'Personalizado' : 'Sin clase'), color: node.color ?? '#4f8ef7' })
      }
    }
    return [...groups.values()]
  }, [diGraph])

  const graphSearchResults = useMemo(() => {
    const q = searchTerm.trim().toLowerCase()
    if (!q) return [] as Array<{ id: string; label: string }>
    const out: Array<{ id: string; label: string }> = []
    for (const node of diGraph.nodes.values()) {
      if (node.label.toLowerCase().includes(q) || node.id.toLowerCase().includes(q)) {
        out.push({ id: node.id, label: node.label })
      }
      if (out.length >= 20) break
    }
    return out
  }, [diGraph, searchTerm])

  const activeValid = mode === 'tree' ? hasValidGraph : graphHasContent

  // Re-fit the graph view when its structure/orientation changes.
  useEffect(() => {
    if (mode !== 'graph') return
    requestAnimationFrame(() => graphCanvasRef.current?.fitView())
  }, [effectiveGraphLayout, mode, layoutDirection])

  const handleSelectFocus = (nodeId: string) => {
    setGraphFocusId(nodeId)
    requestAnimationFrame(() => graphCanvasRef.current?.centerOn(nodeId))
  }

  const handleLoadSample = () => {
    setFileName('red-ejemplo.mmd')
    setMermaidText(SAMPLE_NETWORK)
    setMode('graph')
  }

  const handleSearchSelection = (nodeId: string) => {
    setSelectedNodeId(nodeId)
    setExpanded((previous) => revealAncestorsToRoot(parsedTree, nodeId, previous))
    requestAnimationFrame(() => canvasRef.current?.centerOn(nodeId))
  }

  const handleResetToRoot = () => {
    if (!parsedTree.rootId) return
    setExpanded(new Set())
    setSelectedNodeId(parsedTree.rootId)
    pendingFitRef.current = true
  }

  const handleFit = () => (mode === 'graph' ? graphCanvasRef.current : canvasRef.current)?.fitView()
  const handleCenterOnRoot = () => {
    if (mode === 'graph') {
      if (graphFocusId) graphCanvasRef.current?.centerOn(graphFocusId)
      return
    }
    if (parsedTree.rootId) canvasRef.current?.centerOn(parsedTree.rootId)
  }
  const handleZoomIn = () => (mode === 'graph' ? graphCanvasRef.current : canvasRef.current)?.zoomBy(1.2)
  const handleZoomOut = () => (mode === 'graph' ? graphCanvasRef.current : canvasRef.current)?.zoomBy(1 / 1.2)

  const selectedHasChildren = selectedNode ? selectedNode.children.length > 0 : false
  const selectedExpanded = selectedNodeId ? expanded.has(selectedNodeId) : false

  const handleToggleSelectedChildren = () => {
    if (selectedNodeId) setExpanded((previous) => toggleNodeExpanded(parsedTree, selectedNodeId, previous))
  }
  const handleRevealSelectedAncestors = () => {
    if (!selectedNodeId) return
    setExpanded((previous) => revealAncestorsToRoot(parsedTree, selectedNodeId, previous))
    requestAnimationFrame(() => canvasRef.current?.ensureVisible(selectedNodeId))
  }

  const handleBreadcrumbSelect = (nodeId: string) => {
    setSelectedNodeId(nodeId)
    setExpanded((previous) => revealAncestorsToRoot(parsedTree, nodeId, previous))
    requestAnimationFrame(() => canvasRef.current?.ensureVisible(nodeId))
  }

  // Keyboard shortcuts: f fit · r root · +/- zoom · / search · arrows navigate · Enter toggle · ? help.
  useEffect(() => {
    const selectAndShow = (nodeId: string) => {
      setSelectedNodeId(nodeId)
      requestAnimationFrame(() => canvasRef.current?.ensureVisible(nodeId))
    }

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'

      if (event.key === '/' && !typing) {
        event.preventDefault()
        searchInputRef.current?.focus()
        return
      }
      if (event.key === 'Escape' && typing) {
        ;(target as HTMLElement)?.blur()
        return
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return

      // View shortcuts work in both modes.
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault()
        ;(mode === 'graph' ? graphCanvasRef.current : canvasRef.current)?.fitView()
        return
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        ;(mode === 'graph' ? graphCanvasRef.current : canvasRef.current)?.zoomBy(1.2)
        return
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        ;(mode === 'graph' ? graphCanvasRef.current : canvasRef.current)?.zoomBy(1 / 1.2)
        return
      }
      if (event.key === '?') {
        event.preventDefault()
        setShowShortcuts((value) => !value)
        return
      }

      // The remaining shortcuts drive tree navigation only.
      if (mode !== 'tree' || !parsedTree.rootId) return

      const order = visibleGraph.order
      const current = selectedNodeId
      const node = current ? parsedTree.nodes.get(current) : null
      const index = current ? order.indexOf(current) : -1

      switch (event.key) {
        case 'r':
        case 'R':
          event.preventDefault()
          handleResetToRoot()
          break
        case 'ArrowDown':
          event.preventDefault()
          if (index < 0) selectAndShow(order[0])
          else if (index < order.length - 1) selectAndShow(order[index + 1])
          break
        case 'ArrowUp':
          event.preventDefault()
          if (index > 0) selectAndShow(order[index - 1])
          break
        case 'ArrowRight':
          event.preventDefault()
          if (node && node.children.length > 0) {
            if (expanded.has(node.id)) {
              selectAndShow(node.children[0])
            } else {
              setExpanded((previous) => {
                const next = new Set(previous)
                next.add(node.id)
                return next
              })
              selectAndShow(node.children[0])
            }
          }
          break
        case 'ArrowLeft':
          event.preventDefault()
          if (node && node.children.length > 0 && expanded.has(node.id)) {
            setExpanded((previous) => toggleNodeExpanded(parsedTree, node.id, previous))
          } else if (node?.parentId) {
            selectAndShow(node.parentId)
          }
          break
        case 'Enter':
        case ' ':
          if (current) {
            event.preventDefault()
            setExpanded((previous) => toggleNodeExpanded(parsedTree, current, previous))
          }
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, parsedTree, visibleGraph, selectedNodeId, expanded])

  const handleLayoutChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setLayoutDirection(event.target.value as LayoutDirection)
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const contents = await readFileText(file)
    setFileName(file.name)
    setMermaidText(contents)
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="panel-header">
          <div className="panel-title">
            <h1>Mermaid Tree Viewer</h1>
            <span className="source-name" title={fileName ?? 'Grafo de ejemplo'}>
              {fileName ?? 'Grafo de ejemplo'}
            </span>
          </div>
          <span className="chip" title={mode === 'graph' ? 'Nodos en análisis / totales' : 'Nodos visibles / totales'}>
            {(mode === 'graph' ? graphNodeSet.size : visibleCount).toLocaleString()} /{' '}
            {(mode === 'graph' ? diGraph.nodes.size : totalNodes).toLocaleString()}
          </span>
        </div>

        {mode === 'tree' && parsedTree.validationError ? (
          <div className="error-box">{parsedTree.validationError}</div>
        ) : null}
        {mode === 'graph' && diGraph.validationError ? (
          <div className="error-box">{diGraph.validationError}</div>
        ) : null}

        <div className="source-panel">
          <label className="file-picker">
            <input type="file" accept=".mmd,.txt,.md,.mermaid" onChange={handleFileUpload} />
            <span>Cargar archivo Mermaid</span>
          </label>

          <div className="source-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={!showCode}
              className={!showCode ? 'active' : ''}
              onClick={() => setShowCode(false)}
            >
              Resumen
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={showCode}
              className={showCode ? 'active' : ''}
              onClick={() => setShowCode(true)}
            >
              Código Mermaid
            </button>
          </div>

          {showCode ? (
            <textarea
              className="source-code"
              value={mermaidText}
              spellCheck={false}
              aria-label="Contenido Mermaid"
              onChange={(event) => {
                setFileName(null)
                setMermaidText(event.target.value)
              }}
            />
          ) : (
            <div className="source-summary">
              <div>
                <span>Archivo</span>
                <strong title={fileName ?? 'Grafo de ejemplo'}>{fileName ?? 'Grafo de ejemplo'}</strong>
              </div>
              <div>
                <span>Nodos</span>
                <strong>{(mode === 'graph' ? diGraph.nodes.size : totalNodes).toLocaleString()}</strong>
              </div>
              {mode === 'graph' ? (
                <div>
                  <span>Ciclos</span>
                  <strong className={cycleCount > 0 ? 'err' : 'ok'}>{cycleCount}</strong>
                </div>
              ) : (
                <div>
                  <span>Estado</span>
                  <strong className={hasValidGraph ? 'ok' : 'err'}>{hasValidGraph ? 'Árbol válido' : 'No válido'}</strong>
                </div>
              )}
            </div>
          )}

          <div className="mode-row">
            <div className="source-tabs" role="tablist" aria-label="Modo de visualización">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'tree'}
                className={mode === 'tree' ? 'active' : ''}
                onClick={() => setMode('tree')}
              >
                Árbol
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'graph'}
                className={mode === 'graph' ? 'active' : ''}
                onClick={() => setMode('graph')}
              >
                Grafo
              </button>
            </div>
            <button type="button" className="ghost-btn" onClick={handleLoadSample}>
              Cargar red de ejemplo
            </button>
          </div>
        </div>

        {mode === 'graph' ? (
          <div className="field-group search-group">
            <label htmlFor="search">Nodo foco (origen del análisis)</label>
            <input
              id="search"
              ref={searchInputRef}
              type="text"
              value={searchTerm}
              disabled={!graphHasContent}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Buscar nodo…  ( / para enfocar )"
            />
            <div className="results-box">
              {graphSearchResults.length === 0 ? (
                <p className="empty-state">
                  {searchTerm.trim() ? 'Sin resultados' : graphFocusId ? `Foco: ${diGraph.nodes.get(graphFocusId)?.label ?? graphFocusId}` : 'Escribe o haz click en un nodo'}
                </p>
              ) : (
                <ul>
                  {graphSearchResults.map((result) => (
                    <li key={result.id}>
                      <button type="button" onClick={() => handleSelectFocus(result.id)}>
                        <strong>{result.label}</strong>
                        <span>{result.id === graphFocusId ? 'foco' : ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <div className="field-group search-group">
            <label htmlFor="search">Buscar por etiqueta</label>
            <input
              id="search"
              ref={searchInputRef}
              type="text"
              value={searchTerm}
              disabled={!hasValidGraph}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Ej: Raíz o Hijo 1  ( / para enfocar )"
            />
            <div className="results-box">
              {searchResults.length === 0 ? (
                <p className="empty-state">{searchTerm.trim() ? 'Sin resultados' : 'Escribe para buscar nodos'}</p>
              ) : (
                <ul>
                  {searchResults.slice(0, 20).map((result) => (
                    <li key={result.nodeId}>
                      <button type="button" onClick={() => handleSearchSelection(result.nodeId)}>
                        <strong>{result.label}</strong>
                        <span>nivel {result.depth}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {mode === 'graph' ? (
          <details className="section" open>
            <summary>Análisis dirigido</summary>
            <div className="section-body">
              <div className="field-group compact-row">
                <label htmlFor="traceDir">Dirección</label>
                <select
                  id="traceDir"
                  value={traceDir}
                  disabled={!graphHasContent}
                  onChange={(event) => setTraceDir(event.target.value as TraceDirection)}
                >
                  <option value="upstream">Fuentes (aguas arriba)</option>
                  <option value="downstream">Impacto (aguas abajo)</option>
                  <option value="both">Ambos</option>
                </select>
              </div>
              <div className="field-group compact-row">
                <label htmlFor="layoutEngine">Motor de layout {elkPending ? '· calculando…' : ''}</label>
                <select
                  id="layoutEngine"
                  value={layoutEngine}
                  disabled={!graphHasContent}
                  onChange={(event) => setLayoutEngine(event.target.value as 'fast' | 'elk')}
                >
                  <option value="fast">Rápido (Sugiyama)</option>
                  <option value="elk">ELK (alta calidad)</option>
                </select>
              </div>
              <div className="trace-stats">
                <div>
                  <span>En análisis</span>
                  <strong>{graphNodeSet.size}</strong>
                </div>
                <div>
                  <span>{traceDir === 'downstream' ? 'Sumideros' : 'Fuentes raíz'}</span>
                  <strong>{graphRoots.size}</strong>
                </div>
              </div>
              <label className="checkbox-single">
                <input type="checkbox" checked={showHops} onChange={(event) => setShowHops(event.target.checked)} />
                Saltos en cruces de aristas
              </label>
              {cycleCount > 0 ? (
                <label className="checkbox-single">
                  <input
                    type="checkbox"
                    checked={collapseCycles}
                    onChange={(event) => setCollapseCycles(event.target.checked)}
                  />
                  Contraer ciclos ({cycleCount})
                </label>
              ) : null}
              {collapseCycles && condensed.superNodes.size > 0 ? (
                <p className="hint-text">Click en un nodo ⟳ para expandir el ciclo.</p>
              ) : null}
            </div>
          </details>
        ) : null}

        {mode === 'graph' ? (
          <details className="section">
            <summary>Camino (origen → destino)</summary>
            <div className="section-body">
              <div className="field-group compact-row">
                <label htmlFor="pathOrigin">Origen</label>
                <select
                  id="pathOrigin"
                  value={pathOrigin}
                  disabled={!graphHasContent}
                  onChange={(event) => setPathOrigin(event.target.value)}
                >
                  <option value="">— elegir —</option>
                  {graphNodeOptions.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-group compact-row">
                <label htmlFor="pathDest">Destino</label>
                <select
                  id="pathDest"
                  value={pathDest}
                  disabled={!graphHasContent}
                  onChange={(event) => setPathDest(event.target.value)}
                >
                  <option value="">— elegir —</option>
                  {graphNodeOptions.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label}
                    </option>
                  ))}
                </select>
              </div>
              {pathOrigin && pathDest ? (
                pathResult ? (
                  <p className="path-result ok">
                    Camino resaltado · {pathResult.nodes.length} nodos, {pathResult.edges.size} aristas
                  </p>
                ) : (
                  <p className="path-result err">No existe un camino dirigido entre esos nodos.</p>
                )
              ) : (
                <p className="hint-text">Elige origen y destino para resaltar el camino.</p>
              )}
              {pathOrigin || pathDest ? (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    setPathOrigin('')
                    setPathDest('')
                  }}
                >
                  Limpiar camino
                </button>
              ) : null}
            </div>
          </details>
        ) : null}

        {mode === 'graph' && selectedEdgeId ? (
          <div className="selected-edge">
            <span>Arista seleccionada</span>
            <strong>{selectedEdgeLabel}</strong>
            <button type="button" onClick={() => setSelectedEdgeId(null)} aria-label="Quitar selección">
              ✕
            </button>
          </div>
        ) : null}

        <details className="section" open>
          <summary>Apariencia</summary>
          <div className="section-body">
            <div className="field-group compact-row">
              <label htmlFor="layout">Orientación</label>
              <select id="layout" value={layoutDirection} disabled={!activeValid} onChange={handleLayoutChange}>
                <option value="LR">Izquierda a derecha</option>
                <option value="TB">Arriba hacia abajo</option>
              </select>
            </div>

            <div className="field-group compact-row">
              <label htmlFor="edgeThickness">Grosor de aristas</label>
              <div className="slider-wrap">
                <input
                  id="edgeThickness"
                  type="range"
                  min="1"
                  max="6"
                  step="1"
                  value={edgeThickness}
                  disabled={!activeValid}
                  onChange={(event) => setEdgeThickness(Number(event.target.value))}
                />
                <span>{edgeThickness}px</span>
              </div>
            </div>

            <div className="checkbox-row">
              <label>
                <input
                  type="checkbox"
                  checked={showNodeLabels}
                  disabled={!activeValid}
                  onChange={(event) => setShowNodeLabels(event.target.checked)}
                />
                Mostrar etiquetas de nodos
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showEdgeLabels}
                  disabled={!activeValid}
                  onChange={(event) => setShowEdgeLabels(event.target.checked)}
                />
                Mostrar etiquetas de aristas
              </label>
            </div>
          </div>
        </details>
      </aside>

      <main className="viewer-panel">
        <div className="viewer-wrapper">
          {activeValid ? (
            <>
              {mode === 'tree' && ancestorPath.length > 1 ? (
                <nav className="breadcrumb" aria-label="Camino a la raíz">
                  {ancestorPath.map((nodeId, idx) => {
                    const crumb = parsedTree.nodes.get(nodeId)
                    const isLast = idx === ancestorPath.length - 1
                    return (
                      <span className="breadcrumb-item" key={nodeId}>
                        <button
                          type="button"
                          className={isLast ? 'current' : ''}
                          onClick={() => handleBreadcrumbSelect(nodeId)}
                          title={crumb?.label ?? nodeId}
                        >
                          {crumb?.label ?? nodeId}
                        </button>
                        {!isLast ? <span className="breadcrumb-sep">›</span> : null}
                      </span>
                    )
                  })}
                </nav>
              ) : null}

              <div className="legend-panel">
                <div className="legend-header">
                  <span>Leyenda</span>
                  <button type="button" onClick={() => setShowLegend((prev) => !prev)}>
                    {showLegend ? 'Ocultar' : 'Mostrar'}
                  </button>
                </div>
                {showLegend ? (
                  <div className="legend-items">
                    {(mode === 'graph' ? graphLegendGroups : legendGroups).map((group) => (
                      <div className="legend-item" key={group.key}>
                        <span
                          className="legend-swatch"
                          style={{ background: group.color, borderColor: group.color }}
                        />
                        <span>{group.label}</span>
                      </div>
                    ))}
                    {mode === 'graph' ? (
                      <>
                        <div className="legend-item">
                          <span className="legend-swatch" style={{ background: '#0b1220', borderColor: '#f8fafc' }} />
                          <span>Nodo foco</span>
                        </div>
                        <div className="legend-item">
                          <span className="legend-swatch" style={{ background: '#0b1220', borderColor: '#f59e0b' }} />
                          <span>Fuente / raíz</span>
                        </div>
                        <div className="legend-item">
                          <span className="legend-swatch" style={{ background: '#a78bfa', borderColor: '#c4b5fd' }} />
                          <span>Ciclo contraído (⟳)</span>
                        </div>
                        <div className="legend-item">
                          <span className="legend-swatch edge back" />
                          <span>Arista inversa (ciclo)</span>
                        </div>
                        <div className="legend-item">
                          <span className="legend-swatch edge" style={{ background: '#38bdf8' }} />
                          <span>Camino resaltado</span>
                        </div>
                      </>
                    ) : null}
                    <div className="legend-item">
                      <span className="legend-swatch edge" />
                      <span>Arista</span>
                    </div>
                  </div>
                ) : null}
              </div>

              {mode === 'graph' ? (
                <GraphCanvas
                  ref={graphCanvasRef}
                  graph={condensed.graph}
                  nodeSet={condensed.nodeSet}
                  layout={effectiveGraphLayout}
                  focusId={graphFocusRenderId}
                  roots={graphRootsRender}
                  superNodes={condensed.superNodes}
                  selectedEdgeId={selectedEdgeId}
                  highlightEdges={highlightEdges}
                  highlightNodes={highlightNodes}
                  showNodeLabels={showNodeLabels}
                  showEdgeLabels={showEdgeLabels}
                  showHops={showHops}
                  edgeThickness={edgeThickness}
                  onSelect={handleGraphSelect}
                  onSelectEdge={setSelectedEdgeId}
                  onScaleChange={setZoomPct}
                />
              ) : (
                <TreeCanvas
                  ref={canvasRef}
                  tree={parsedTree}
                  render={visibleGraph}
                  descendantCounts={descendantCounts}
                  selectedNodeId={selectedNodeId}
                  layoutDirection={layoutDirection}
                  showNodeLabels={showNodeLabels}
                  showEdgeLabels={showEdgeLabels}
                  edgeThickness={edgeThickness}
                  onScaleChange={setZoomPct}
                  onSelect={setSelectedNodeId}
                  onToggle={(nodeId) =>
                    setExpanded((previous) => toggleNodeExpanded(parsedTree, nodeId, previous))
                  }
                  onRevealAncestors={(nodeId) =>
                    setExpanded((previous) => revealAncestorsToRoot(parsedTree, nodeId, previous))
                  }
                />
              )}

              <div className="canvas-hint">
                {mode === 'graph'
                  ? 'Click: fijar nodo foco · arrastra para desplazar · rueda para zoom'
                  : 'Click: expandir/colapsar · Doble click: camino a la raíz'}
              </div>

              <div className="viewer-controls" role="toolbar" aria-label="Controles de vista">
                {mode === 'tree' ? (
                  <>
                    <button
                      type="button"
                      className="node-action"
                      title={
                        selectedNode
                          ? `${selectedExpanded ? 'Colapsar' : 'Expandir'} hijos de “${selectedNode.label}”`
                          : 'Expandir / colapsar hijos'
                      }
                      aria-label="Expandir o colapsar hijos del nodo seleccionado"
                      disabled={!selectedHasChildren}
                      onClick={handleToggleSelectedChildren}
                    >
                      {selectedExpanded ? '⊟' : '⊞'}
                    </button>
                    <button
                      type="button"
                      className="node-action"
                      title={
                        selectedNode ? `Expandir ancestros de “${selectedNode.label}”` : 'Expandir ancestros'
                      }
                      aria-label="Expandir ancestros del nodo seleccionado hasta la raíz"
                      onClick={handleRevealSelectedAncestors}
                    >
                      ⤴
                    </button>
                    <span className="control-divider" />
                  </>
                ) : null}
                <button type="button" title="Acercar" aria-label="Acercar" onClick={handleZoomIn}>
                  +
                </button>
                <span className="zoom-readout" title="Nivel de zoom">
                  {zoomPct}%
                </span>
                <button type="button" title="Alejar" aria-label="Alejar" onClick={handleZoomOut}>
                  −
                </button>
                <span className="control-divider" />
                <button type="button" title="Ajustar a la vista" aria-label="Ajustar a la vista" onClick={handleFit}>
                  ⤢
                </button>
                <button type="button" title="Centrar en la raíz" aria-label="Centrar en la raíz" onClick={handleCenterOnRoot}>
                  ◎
                </button>
                <button type="button" title="Volver a la raíz" aria-label="Volver a la raíz" onClick={handleResetToRoot}>
                  ⌂
                </button>
                <span className="control-divider" />
                <button
                  type="button"
                  title="Atajos de teclado"
                  aria-label="Atajos de teclado"
                  className={showShortcuts ? 'active' : ''}
                  onClick={() => setShowShortcuts((value) => !value)}
                >
                  ?
                </button>
              </div>

              {showShortcuts ? (
                <div className="shortcuts-panel" role="dialog" aria-label="Atajos de teclado">
                  <div className="shortcuts-header">
                    <span>Atajos de teclado</span>
                    <button type="button" onClick={() => setShowShortcuts(false)} aria-label="Cerrar">
                      ✕
                    </button>
                  </div>
                  <ul>
                    <li><kbd>/</kbd><span>Enfocar búsqueda</span></li>
                    <li><kbd>↑</kbd><kbd>↓</kbd><span>Nodo anterior / siguiente</span></li>
                    <li><kbd>→</kbd><span>Expandir / primer hijo</span></li>
                    <li><kbd>←</kbd><span>Colapsar / ir al padre</span></li>
                    <li><kbd>Enter</kbd><span>Expandir / colapsar</span></li>
                    <li><kbd>f</kbd><span>Ajustar a la vista</span></li>
                    <li><kbd>r</kbd><span>Volver a la raíz</span></li>
                    <li><kbd>+</kbd><kbd>−</kbd><span>Acercar / alejar</span></li>
                    <li><kbd>?</kbd><span>Mostrar / ocultar ayuda</span></li>
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty-canvas">Carga un grafo Mermaid válido para visualizar el árbol.</div>
          )}
        </div>
      </main>
    </div>
  )
}

export default App
