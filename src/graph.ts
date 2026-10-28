import { collectMermaidElements, type TreeEdge } from './tree';

export type GraphNode = {
  id: string;
  label: string;
  color?: string;
  textColor?: string;
  className?: string;
};

export type DiGraph = {
  nodes: Map<string, GraphNode>;
  edges: TreeEdge[];
  out: Map<string, string[]>;
  in: Map<string, string[]>;
  validationError?: string;
};

export type TraceDirection = 'upstream' | 'downstream' | 'both';

export type GraphPosition = { x: number; y: number };

export type EdgeRoute = Array<{ x: number; y: number }>;

export type GraphLayout = {
  positions: Map<string, GraphPosition>;
  backEdges: Set<string>;
  layerOf: Map<string, number>;
  routes?: Map<string, EdgeRoute>;
};

export const buildDiGraph = (input: string): DiGraph => {
  if (!input || !input.trim()) {
    return { nodes: new Map(), edges: [], out: new Map(), in: new Map(), validationError: 'El contenido Mermaid está vacío.' };
  }

  const { nodeMap, edges } = collectMermaidElements(input);
  const nodes = new Map<string, GraphNode>();
  for (const node of nodeMap.values()) {
    nodes.set(node.id, {
      id: node.id,
      label: node.label,
      color: node.color,
      textColor: node.textColor,
      className: node.className,
    });
  }

  const out = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of nodes.keys()) {
    out.set(id, []);
    incoming.set(id, []);
  }

  // Dedupe parallel edges for adjacency while keeping original edges for rendering.
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    const key = `${edge.source}->${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
  }

  const validationError = nodes.size === 0 ? 'No se encontraron nodos en el grafo.' : undefined;
  return { nodes, edges, out, in: incoming, validationError };
};

/** Tarjan's strongly connected components. Components with >1 member (or a self-loop) are cycles. */
export const computeSCCs = (graph: DiGraph) => {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const componentOf = new Map<string, number>();
  const components: string[][] = [];

  // Iterative Tarjan to stay safe on very large graphs.
  for (const start of graph.nodes.keys()) {
    if (idx.has(start)) continue;
    const work: Array<{ v: string; i: number }> = [{ v: start, i: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const { v } = frame;
      if (frame.i === 0) {
        idx.set(v, index);
        low.set(v, index);
        index += 1;
        stack.push(v);
        onStack.add(v);
      }
      const neighbors = graph.out.get(v) ?? [];
      if (frame.i < neighbors.length) {
        const w = neighbors[frame.i];
        frame.i += 1;
        if (!idx.has(w)) {
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
      } else {
        if (low.get(v) === idx.get(v)) {
          const component: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            componentOf.set(w, components.length);
            component.push(w);
          } while (w !== v);
          components.push(component);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
        }
      }
    }
  }

  const cycleNodes = new Set<string>();
  for (const component of components) {
    if (component.length > 1) {
      for (const id of component) cycleNodes.add(id);
    } else {
      const only = component[0];
      if ((graph.out.get(only) ?? []).includes(only)) cycleNodes.add(only);
    }
  }

  return { components, componentOf, cycleNodes };
};

const reach = (graph: DiGraph, start: string, dir: 'out' | 'in', maxNodes = Infinity) => {
  const seen = new Set<string>([start]);
  const queue = [start];
  const adj = dir === 'out' ? graph.out : graph.in;
  while (queue.length > 0 && seen.size < maxNodes) {
    const v = queue.shift()!;
    for (const w of adj.get(v) ?? []) {
      if (!seen.has(w)) {
        seen.add(w);
        queue.push(w);
      }
    }
  }
  return seen;
};

/** "All nodes affected by target" — forward reachability (impact set). */
export const traceDownstream = (graph: DiGraph, target: string) => {
  const nodes = reach(graph, target, 'out');
  const sinks = [...nodes].filter((id) => id !== target && (graph.out.get(id)?.length ?? 0) === 0);
  return { nodes, roots: sinks };
};

/** "All root sources of requests arriving to target" — reverse reachability, then source nodes (in-degree 0). */
export const traceUpstream = (graph: DiGraph, target: string) => {
  const nodes = reach(graph, target, 'in');
  const sources = [...nodes].filter((id) => id !== target && (graph.in.get(id)?.length ?? 0) === 0);
  return { nodes, roots: sources };
};

export const traceFrom = (graph: DiGraph, target: string, direction: TraceDirection) => {
  if (direction === 'downstream') {
    const d = traceDownstream(graph, target);
    return { nodes: d.nodes, roots: new Set(d.roots) };
  }
  if (direction === 'upstream') {
    const u = traceUpstream(graph, target);
    return { nodes: u.nodes, roots: new Set(u.roots) };
  }
  const up = traceUpstream(graph, target);
  const down = traceDownstream(graph, target);
  const nodes = new Set<string>([...up.nodes, ...down.nodes]);
  return { nodes, roots: new Set([...up.roots, ...down.roots]) };
};

/** Shortest directed path from source to target (BFS). Returns node sequence + edge keys, or null. */
export const findPath = (
  graph: DiGraph,
  source: string,
  target: string,
): { nodes: string[]; edges: Set<string> } | null => {
  if (!graph.nodes.has(source) || !graph.nodes.has(target)) return null;
  if (source === target) return { nodes: [source], edges: new Set() };

  const prev = new Map<string, string>();
  const seen = new Set<string>([source]);
  const queue = [source];
  let found = false;
  while (queue.length > 0 && !found) {
    const v = queue.shift()!;
    for (const w of graph.out.get(v) ?? []) {
      if (seen.has(w)) continue;
      seen.add(w);
      prev.set(w, v);
      if (w === target) {
        found = true;
        break;
      }
      queue.push(w);
    }
  }
  if (!prev.has(target)) return null;

  const nodes: string[] = [];
  let cur: string | undefined = target;
  while (cur !== undefined) {
    nodes.push(cur);
    cur = cur === source ? undefined : prev.get(cur);
  }
  nodes.reverse();
  const edges = new Set<string>();
  for (let i = 0; i < nodes.length - 1; i += 1) edges.add(`${nodes[i]}->${nodes[i + 1]}`);
  return { nodes, edges };
};

/**
 * Sugiyama layered layout on an induced subgraph:
 * cycle removal (DFS back edges) → longest-path layering → barycenter crossing
 * minimization → coordinate assignment. Returns world positions + back-edge ids.
 */
export const layeredLayout = (
  graph: DiGraph,
  nodeSet: Set<string>,
  dir: 'LR' | 'TB' = 'LR',
): GraphLayout => {
  const nodes = [...nodeSet];
  const positions = new Map<string, GraphPosition>();
  const layerOf = new Map<string, number>();
  const backEdges = new Set<string>();

  if (nodes.length === 0) return { positions, backEdges, layerOf };

  // Induced, de-duplicated directed edges within the node set.
  const induced: Array<{ id: string; source: string; target: string }> = [];
  const seenPair = new Set<string>();
  for (const edge of graph.edges) {
    if (!nodeSet.has(edge.source) || !nodeSet.has(edge.target)) continue;
    if (edge.source === edge.target) continue; // self-loop: not laid out, drawn as a small loop
    const key = `${edge.source}->${edge.target}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    induced.push({ id: key, source: edge.source, target: edge.target });
  }

  // 1) Cycle removal: iterative DFS, mark back edges.
  const state = new Map<string, 0 | 1 | 2>();
  const adj = new Map<string, Array<{ id: string; target: string }>>();
  for (const n of nodes) adj.set(n, []);
  for (const e of induced) adj.get(e.source)!.push({ id: e.id, target: e.target });

  for (const start of nodes) {
    if (state.get(start)) continue;
    const work: Array<{ v: string; i: number }> = [{ v: start, i: 0 }];
    state.set(start, 1);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const edgesOut = adj.get(frame.v)!;
      if (frame.i < edgesOut.length) {
        const { id, target } = edgesOut[frame.i];
        frame.i += 1;
        const s = state.get(target) ?? 0;
        if (s === 1) backEdges.add(id);
        else if (s === 0) {
          state.set(target, 1);
          work.push({ v: target, i: 0 });
        }
      } else {
        state.set(frame.v, 2);
        work.pop();
      }
    }
  }

  // Acyclic edge set (reverse back edges for layering).
  const acyclic = induced.map((e) => (backEdges.has(e.id) ? { ...e, source: e.target, target: e.source } : e));

  // 2) Longest-path layering via topological order — O(V + E).
  for (const n of nodes) layerOf.set(n, 0);
  const outAcyclic = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    outAcyclic.set(n, []);
    indeg.set(n, 0);
  }
  for (const e of acyclic) {
    outAcyclic.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const ready: string[] = [];
  for (const n of nodes) if ((indeg.get(n) ?? 0) === 0) ready.push(n);
  let head = 0;
  let processed = 0;
  while (head < ready.length) {
    const v = ready[head];
    head += 1;
    processed += 1;
    const lv = layerOf.get(v)!;
    for (const t of outAcyclic.get(v)!) {
      if (lv + 1 > layerOf.get(t)!) layerOf.set(t, lv + 1);
      const d = (indeg.get(t) ?? 0) - 1;
      indeg.set(t, d);
      if (d === 0) ready.push(t);
    }
  }
  // Safety net: if a residual cycle slipped through, relax remaining nodes once.
  if (processed < nodes.length) {
    for (const e of acyclic) {
      const nl = layerOf.get(e.source)! + 1;
      if (nl > layerOf.get(e.target)!) layerOf.set(e.target, nl);
    }
  }

  // 3) Order within layers by barycenter sweeps to reduce crossings.
  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layerOf.get(n)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(n);
  }
  const order = new Map<string, number>();
  byLayer.forEach((arr) => arr.forEach((n, i) => order.set(n, i)));

  const predsOf = new Map<string, string[]>();
  const succsOf = new Map<string, string[]>();
  for (const n of nodes) {
    predsOf.set(n, []);
    succsOf.set(n, []);
  }
  for (const e of acyclic) {
    succsOf.get(e.source)!.push(e.target);
    predsOf.get(e.target)!.push(e.source);
  }

  const layersSorted = [...byLayer.keys()].sort((a, b) => a - b);
  const barycenter = (n: string, usePreds: boolean) => {
    const neighbors = usePreds ? predsOf.get(n)! : succsOf.get(n)!;
    if (neighbors.length === 0) return order.get(n)!;
    return neighbors.reduce((sum, m) => sum + order.get(m)!, 0) / neighbors.length;
  };

  for (let sweep = 0; sweep < 8; sweep += 1) {
    const downward = sweep % 2 === 0;
    const sequence = downward ? layersSorted : [...layersSorted].reverse();
    for (const l of sequence) {
      const arr = byLayer.get(l)!;
      arr.sort((a, b) => barycenter(a, downward) - barycenter(b, downward));
      arr.forEach((n, i) => order.set(n, i));
    }
  }

  // 4) Coordinates. LR: layer → x, order → y. TB: order → x, layer → y.
  // Gaps are orientation-aware so horizontal labels don't overlap.
  const LAYER_GAP = dir === 'LR' ? 340 : 130
  const ORDER_GAP = dir === 'LR' ? 92 : 200
  for (const n of nodes) {
    const l = layerOf.get(n)!
    const o = order.get(n)!
    positions.set(n, dir === 'LR' ? { x: l * LAYER_GAP, y: o * ORDER_GAP } : { x: o * ORDER_GAP, y: l * LAYER_GAP })
  }

  // 5) Orthogonal edge routes: forward edges as rounded Z-connectors,
  //    back edges looped up-and-over (staggered so they nest cleanly).
  let minX = Infinity, minY = Infinity;
  for (const p of positions.values()) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
  }
  const routes = new Map<string, EdgeRoute>();
  let backIndex = 0;
  for (const e of induced) {
    const s = positions.get(e.source)!;
    const t = positions.get(e.target)!;
    if (!backEdges.has(e.id)) {
      if (dir === 'LR') {
        const midX = (s.x + t.x) / 2;
        routes.set(e.id, [s, { x: midX, y: s.y }, { x: midX, y: t.y }, t]);
      } else {
        const midY = (s.y + t.y) / 2;
        routes.set(e.id, [s, { x: s.x, y: midY }, { x: t.x, y: midY }, t]);
      }
    } else {
      const offset = 70 + backIndex * 46;
      backIndex += 1;
      if (dir === 'LR') {
        const overY = minY - offset;
        routes.set(e.id, [s, { x: s.x, y: overY }, { x: t.x, y: overY }, t]);
      } else {
        const overX = minX - offset;
        routes.set(e.id, [s, { x: overX, y: s.y }, { x: overX, y: t.y }, t]);
      }
    }
  }

  return { positions, backEdges, layerOf, routes };
};

/**
 * Detect where visible edge segments cross so the renderer can draw a small
 * "hop" arc on the upper edge. O(n^2) over the provided segments — callers
 * should pass only on-screen segments.
 */
export type EdgeSegment = { id: string; x1: number; y1: number; x2: number; y2: number };
export type EdgeHop = { id: string; x: number; y: number; angle: number };

export const findEdgeHops = (segments: EdgeSegment[]): EdgeHop[] => {
  const hops: EdgeHop[] = [];
  const n = segments.length;
  if (n < 2) return hops;

  // Sweep line over x: only test segments whose x-ranges overlap.
  const items = segments.map((s, i) => ({ i, minx: Math.min(s.x1, s.x2), maxx: Math.max(s.x1, s.x2) }));
  items.sort((a, b) => a.minx - b.minx);

  const active: Array<{ i: number; maxx: number }> = [];
  for (const it of items) {
    // Drop segments that can no longer overlap.
    for (let k = active.length - 1; k >= 0; k -= 1) {
      if (active[k].maxx < it.minx) active.splice(k, 1);
    }
    const b = segments[it.i];
    for (const a of active) {
      const point = intersect(segments[a.i], b);
      if (!point) continue;
      hops.push({ id: b.id, x: point.x, y: point.y, angle: Math.atan2(b.y2 - b.y1, b.x2 - b.x1) });
    }
    active.push({ i: it.i, maxx: it.maxx });
  }
  return hops;
};

const intersect = (a: EdgeSegment, b: EdgeSegment) => {
  const d = (a.x2 - a.x1) * (b.y2 - b.y1) - (a.y2 - a.y1) * (b.x2 - b.x1);
  if (Math.abs(d) < 1e-6) return null;
  const t = ((b.x1 - a.x1) * (b.y2 - b.y1) - (b.y1 - a.y1) * (b.x2 - b.x1)) / d;
  const u = ((b.x1 - a.x1) * (a.y2 - a.y1) - (b.y1 - a.y1) * (a.x2 - a.x1)) / d;
  if (t <= 0.04 || t >= 0.96 || u <= 0.04 || u >= 0.96) return null;
  return { x: a.x1 + t * (a.x2 - a.x1), y: a.y1 + t * (a.y2 - a.y1) };
};

export type CondensedView = {
  graph: DiGraph;
  nodeSet: Set<string>;
  superNodes: Set<string>;
  renderIdOf: (id: string) => string;
};

/**
 * Optionally condense strongly connected components (cycles) into single
 * expandable super-nodes, so the layered layout stays readable. Components in
 * `expanded` are kept uncollapsed. Operates on the already-traced `nodeSet`.
 */
export const buildCondensedView = (
  base: DiGraph,
  scc: { components: string[][]; componentOf: Map<string, number> },
  nodeSet: Set<string>,
  collapse: boolean,
  expanded: Set<number>,
): CondensedView => {
  if (!collapse) {
    return { graph: base, nodeSet, superNodes: new Set(), renderIdOf: (id) => id };
  }

  const collapsedComp = new Set<number>();
  scc.components.forEach((members, idx) => {
    if (members.length > 1 && !expanded.has(idx) && members.some((m) => nodeSet.has(m))) {
      collapsedComp.add(idx);
    }
  });

  const renderIdOf = (id: string) => {
    const c = scc.componentOf.get(id);
    return c !== undefined && collapsedComp.has(c) ? `scc:${c}` : id;
  };

  const nodes = new Map<string, GraphNode>();
  const superNodes = new Set<string>();
  for (const id of nodeSet) {
    const rid = renderIdOf(id);
    if (rid.startsWith('scc:')) {
      superNodes.add(rid);
      if (!nodes.has(rid)) nodes.set(rid, { id: rid, label: '', color: '#a78bfa', className: 'scc' });
    } else if (!nodes.has(rid)) {
      const n = base.nodes.get(id);
      if (n) nodes.set(rid, { ...n });
    }
  }
  for (const sid of superNodes) {
    const comp = Number(sid.slice(4));
    nodes.get(sid)!.label = `⟳ Ciclo (${scc.components[comp].length})`;
  }

  const out = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of nodes.keys()) {
    out.set(id, []);
    incoming.set(id, []);
  }
  const edges: TreeEdge[] = [];
  const seen = new Set<string>();
  for (const e of base.edges) {
    if (!nodeSet.has(e.source) || !nodeSet.has(e.target)) continue;
    const s = renderIdOf(e.source);
    const t = renderIdOf(e.target);
    if (s === t) continue;
    const key = `${s}->${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: key, source: s, target: t, label: e.label, color: e.color, direction: e.direction });
    out.get(s)!.push(t);
    incoming.get(t)!.push(s);
  }

  return { graph: { nodes, edges, out, in: incoming }, nodeSet: new Set(nodes.keys()), superNodes, renderIdOf };
};

/** A representative dependency network with cycles, for demoing graph mode. */
export const SAMPLE_NETWORK = `graph LR
    client[Cliente Web]
    mobile[App Móvil]
    gateway[API Gateway]
    auth[Auth Service]
    orders[Orders Service]
    payments[Payments Service]
    inventory[Inventory Service]
    cache[Redis Cache]
    db[(Postgres)]
    queue[Message Queue]
    notifier[Notifier]
    ledger[Ledger Service]

    client --> gateway
    mobile --> gateway
    gateway --> auth
    gateway --> orders
    orders --> auth
    orders --> payments
    orders --> inventory
    orders --> cache
    payments --> ledger
    payments --> queue
    inventory --> db
    orders --> db
    auth --> cache
    cache --> db
    queue --> notifier
    queue --> inventory
    ledger --> orders
    notifier --> gateway
    inventory --> cache

    classDef edge fill:#1e293b,stroke:#38bdf8,color:#e2e8f0
    classDef svc fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef store fill:#fef3c7,stroke:#d97706,color:#78350f

    class client,mobile edge
    class gateway,auth,orders,payments,inventory,notifier,ledger svc
    class cache,db,queue store`;
