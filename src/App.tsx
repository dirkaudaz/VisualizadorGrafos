import { useEffect, useMemo, useRef, useState } from 'react'
import TreeCanvas, { type TreeCanvasHandle } from './TreeCanvas'
import {
  getDescendantCounts,
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
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([])
  const [layoutDirection, setLayoutDirection] = useState<LayoutDirection>('LR')
  const [showNodeLabels, setShowNodeLabels] = useState(true)
  const [showEdgeLabels, setShowEdgeLabels] = useState(true)
  const [edgeThickness, setEdgeThickness] = useState(2)
  const [showLegend, setShowLegend] = useState(true)
  const canvasRef = useRef<TreeCanvasHandle | null>(null)
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

  const handleCenterOnRoot = () => {
    if (parsedTree.rootId) canvasRef.current?.centerOn(parsedTree.rootId)
  }

  const handleLayoutChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setLayoutDirection(event.target.value as LayoutDirection)
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const contents = await readFileText(file)
    setMermaidText(contents)
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="panel-header">
          <h1>Mermaid Tree Viewer</h1>
          <span className="chip">Bun + React + Canvas</span>
        </div>

        <label className="file-picker">
          <input type="file" accept=".mmd,.txt,.md,.mermaid" onChange={handleFileUpload} />
          <span>Cargar archivo Mermaid</span>
        </label>

        <div className="field-group compact-row">
          <label htmlFor="layout">Orientación</label>
          <select id="layout" value={layoutDirection} onChange={handleLayoutChange}>
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
              onChange={(event) => setShowNodeLabels(event.target.checked)}
            />
            Mostrar etiquetas de nodos
          </label>
          <label>
            <input
              type="checkbox"
              checked={showEdgeLabels}
              onChange={(event) => setShowEdgeLabels(event.target.checked)}
            />
            Mostrar etiquetas de aristas
          </label>
        </div>

        <div className="field-group">
          <label htmlFor="search">Buscar por etiqueta</label>
          <input
            id="search"
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Ej: Raíz o Hijo 1"
          />
        </div>

        <div className="results-box">
          {searchResults.length === 0 ? (
            <p className="empty-state">Sin resultados</p>
          ) : (
            <ul>
              {searchResults.slice(0, 12).map((result) => (
                <li key={result.nodeId}>
                  <button type="button" onClick={() => handleSearchSelection(result.nodeId)}>
                    <strong>{result.label}</strong>
                    <span>{result.depth} nivel</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="field-group">
          <label htmlFor="mermaid">Contenido Mermaid</label>
          <textarea
            id="mermaid"
            value={mermaidText}
            onChange={(event) => setMermaidText(event.target.value)}
            spellCheck={false}
          />
        </div>

        <div className="stats">
          <div>
            <span>Total nodos</span>
            <strong>{totalNodes}</strong>
          </div>
          <div>
            <span>Visible</span>
            <strong>{visibleCount}</strong>
          </div>
        </div>

        {parsedTree.validationError ? <div className="error-box">{parsedTree.validationError}</div> : null}

        {selectedNode ? (
          <div className="node-card">
            <h3>Nodo seleccionado</h3>
            <p>{selectedNode.label}</p>
            <div className="node-actions">
              <button
                type="button"
                onClick={() => setExpanded((previous) => revealAncestorsToRoot(parsedTree, selectedNode.id, previous))}
              >
                Expandir ancestros
              </button>
              <button
                type="button"
                onClick={() => setExpanded((previous) => toggleNodeExpanded(parsedTree, selectedNode.id, previous))}
              >
                {expanded.has(selectedNode.id) ? 'Colapsar' : 'Expandir'} hijos
              </button>
              <button type="button" onClick={handleResetToRoot}>
                Reset
              </button>
            </div>
          </div>
        ) : null}
      </aside>

      <main className="viewer-panel">
        <div className="toolbar">
          <button type="button" onClick={handleResetToRoot}>Ver raíz</button>
          <button type="button" onClick={handleCenterOnRoot}>Centrar en raíz</button>
          <span className="toolbar-hint">Click: expandir/colapsar · Doble click: camino a la raíz</span>
        </div>

        <div className="viewer-wrapper">
          {parsedTree.rootId ? (
            <>
              <div className="legend-panel">
                <div className="legend-header">
                  <span>Leyenda</span>
                  <button type="button" onClick={() => setShowLegend((prev) => !prev)}>
                    {showLegend ? 'Ocultar' : 'Mostrar'}
                  </button>
                </div>
                {showLegend ? (
                  <div className="legend-items">
                    <div className="legend-item">
                      <span className="legend-swatch root" />
                      <span>Nodo raíz</span>
                    </div>
                    <div className="legend-item">
                      <span className="legend-swatch branch" />
                      <span>Nodo rama</span>
                    </div>
                    <div className="legend-item">
                      <span className="legend-swatch leaf" />
                      <span>Nodo hoja</span>
                    </div>
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
                onSelect={setSelectedNodeId}
                onToggle={(nodeId) =>
                  setExpanded((previous) => toggleNodeExpanded(parsedTree, nodeId, previous))
                }
                onRevealAncestors={(nodeId) =>
                  setExpanded((previous) => revealAncestorsToRoot(parsedTree, nodeId, previous))
                }
              />
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
