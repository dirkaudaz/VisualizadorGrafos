import { useEffect, useMemo, useRef, useState } from 'react'
import TreeCanvas, { type TreeCanvasHandle } from './TreeCanvas'
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

function App() {
  const [mermaidText, setMermaidText] = useState(DEFAULT_MERMAID)
  const [fileName, setFileName] = useState<string | null>(null)
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
  const canvasRef = useRef<TreeCanvasHandle | null>(null)
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

  const handleFit = () => canvasRef.current?.fitView()
  const handleCenterOnRoot = () => {
    if (parsedTree.rootId) canvasRef.current?.centerOn(parsedTree.rootId)
  }
  const handleZoomIn = () => canvasRef.current?.zoomBy(1.2)
  const handleZoomOut = () => canvasRef.current?.zoomBy(1 / 1.2)

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
      if (!parsedTree.rootId) return

      const order = visibleGraph.order
      const current = selectedNodeId
      const node = current ? parsedTree.nodes.get(current) : null
      const index = current ? order.indexOf(current) : -1

      switch (event.key) {
        case 'f':
        case 'F':
          event.preventDefault()
          canvasRef.current?.fitView()
          break
        case 'r':
        case 'R':
          event.preventDefault()
          handleResetToRoot()
          break
        case '+':
        case '=':
          event.preventDefault()
          canvasRef.current?.zoomBy(1.2)
          break
        case '-':
        case '_':
          event.preventDefault()
          canvasRef.current?.zoomBy(1 / 1.2)
          break
        case '?':
          event.preventDefault()
          setShowShortcuts((value) => !value)
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
  }, [parsedTree, visibleGraph, selectedNodeId, expanded])

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
          <span className="chip" title="Nodos visibles / totales">
            {visibleCount.toLocaleString()} / {totalNodes.toLocaleString()}
          </span>
        </div>

        {parsedTree.validationError ? <div className="error-box">{parsedTree.validationError}</div> : null}

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
                <strong>{totalNodes.toLocaleString()}</strong>
              </div>
              <div>
                <span>Estado</span>
                <strong className={hasValidGraph ? 'ok' : 'err'}>{hasValidGraph ? 'Árbol válido' : 'No válido'}</strong>
              </div>
            </div>
          )}
        </div>

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

        <details className="section" open>
          <summary>Apariencia</summary>
          <div className="section-body">
            <div className="field-group compact-row">
              <label htmlFor="layout">Orientación</label>
              <select id="layout" value={layoutDirection} disabled={!hasValidGraph} onChange={handleLayoutChange}>
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
                  disabled={!hasValidGraph}
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
                  disabled={!hasValidGraph}
                  onChange={(event) => setShowNodeLabels(event.target.checked)}
                />
                Mostrar etiquetas de nodos
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showEdgeLabels}
                  disabled={!hasValidGraph}
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
          {hasValidGraph ? (
            <>
              {ancestorPath.length > 1 ? (
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
                    {legendGroups.map((group) => (
                      <div className="legend-item" key={group.key}>
                        <span
                          className="legend-swatch"
                          style={{ background: group.color, borderColor: group.color }}
                        />
                        <span>{group.label}</span>
                      </div>
                    ))}
                    <div className="legend-item">
                      <span className="legend-swatch edge" />
                      <span>Arista</span>
                    </div>
                  </div>
                ) : null}
              </div>

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

              <div className="canvas-hint">Click: expandir/colapsar · Doble click: camino a la raíz</div>

              <div className="viewer-controls" role="toolbar" aria-label="Controles de vista">
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
