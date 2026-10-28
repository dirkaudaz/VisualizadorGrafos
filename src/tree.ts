export type Direction = 'TB' | 'TD' | 'LR' | 'RL' | 'BT';

export type TreeNode = {
  id: string;
  label: string;
  parentId: string | null;
  children: string[];
  depth: number;
  color?: string;
  textColor?: string;
  className?: string;
  rawId?: string;
  metadata?: Record<string, unknown>;
};

export type LegendGroup = {
  key: string;
  label: string;
  color: string;
};

export type TreeEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  color?: string;
  direction: 'forward' | 'backward' | 'both';
};

export type MermaidTree = {
  rootId: string | null;
  nodes: Map<string, TreeNode>;
  edges: TreeEdge[];
  direction: Direction;
  validationError?: string;
};

export type TreeVisibility = {
  expanded: Set<string>;
  selectedNodeId: string | null;
  highlightedNodeIds: Set<string>;
};

export type SearchMatch = {
  nodeId: string;
  label: string;
  score: number;
  depth: number;
};

const normalizeLabel = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');

const getDirectionFromHeader = (line: string): Direction => {
  const cleaned = line.trim().replace(/\s+/g, ' ');
  const match = cleaned.match(/(?:graph|flowchart)\s+([A-Z]+)$/i);
  if (!match) return 'TB';
  const dir = match[1].toUpperCase();
  if (dir === 'TD' || dir === 'TB') return 'TB';
  if (dir === 'LR') return 'LR';
  if (dir === 'RL') return 'RL';
  if (dir === 'BT') return 'BT';
  return 'TB';
};

const captureNodeId = (token: string) => token.replace(/\s+/g, '').trim();

const parseLabelValue = (value?: string) => {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').trim();
};

const parseNodeDeclaration = (line: string) => {
  const clean = line.trim();

  const classMatch = clean.match(/^([A-Za-z0-9_]+)\s*:::\s*([A-Za-z0-9_]+)$/);
  if (classMatch) {
    return { type: 'class-annotation', id: classMatch[1], className: classMatch[2] } as const;
  }

  const withLabel = clean.match(/^([A-Za-z0-9_]+)\s*(?:\[\s*([^\]]*)\s*\]|\(\s*([^)]*)\s*\)|\{\s*([^}]*)\s*\})$/);
  if (withLabel) {
    const [, id, square, round, curly] = withLabel;
    const label = parseLabelValue(square ?? round ?? curly ?? id);
    return { type: 'node', id, label } as const;
  }

  if (/^[A-Za-z0-9_]+$/.test(clean)) {
    return { type: 'node', id: clean, label: clean } as const;
  }

  return null;
};

const parseClassDef = (line: string) => {
  const match = line.match(/^classDef\s+([A-Za-z0-9_]+)\s+(.*)$/i);
  if (!match) return null;
  const [, className, rawStyles] = match;
  const styleMap: Record<string, string> = {};
  for (const chunk of rawStyles.split(',')) {
    const eqMatch = chunk.match(/^\s*([A-Za-z-]+)\s*:\s*(.+?)\s*$/);
    if (eqMatch) {
      const [, key, value] = eqMatch;
      styleMap[key.trim()] = value.trim();
    }
  }
  return { className, styleMap } as const;
};

const parseClassAssignment = (line: string) => {
  const match = line.match(/^class\s+(.+?)\s+([A-Za-z0-9_]+)\s*$/i);
  if (!match) return null;
  const [, nodeList, className] = match;
  return {
    className,
    nodeIds: nodeList
      .split(',')
      .map((entry) => captureNodeId(entry))
      .filter(Boolean),
  } as const;
};

const parseStyleAssignment = (line: string) => {
  const match = line.match(/^style\s+([A-Za-z0-9_]+)\s+(.*)$/i);
  if (!match) return null;
  const [, nodeId, rawStyles] = match;
  const styleMap: Record<string, string> = {};
  for (const chunk of rawStyles.split(',')) {
    const eqMatch = chunk.match(/^\s*([A-Za-z-]+)\s*:\s*(.+?)\s*$/);
    if (eqMatch) {
      const [, key, value] = eqMatch;
      styleMap[key.trim()] = value.trim();
    }
  }
  return { nodeId, styleMap } as const;
};

const parseEdgeDeclaration = (line: string) => {
  const clean = line.trim();
  const pattern = /^([A-Za-z0-9_]+)\s*(<-->|<--|-->|==>|-.->|--x|--o|---)\s*(?:\|([^|]*)\|\s*)?([A-Za-z0-9_]+)\s*$/i;
  const match = clean.match(pattern);
  if (!match) return null;

  const [, leftRaw, operator, labelValue, rightRaw] = match;
  const left = captureNodeId(leftRaw);
  const right = captureNodeId(rightRaw);
  const label = parseLabelValue(labelValue);

  const direction =
    operator === '<--' || operator === '<-->' || operator === '<-.' || operator === '<-.->' ? 'backward' :
    operator === '--x' || operator === '--o' || operator === '---' ? 'both' : 'forward';

  let source = left;
  let target = right;

  if (operator === '<--' || operator === '<-.->' || operator === '<-->') {
    source = right;
    target = left;
  }

  if (operator === '---') {
    return {
      id: `${left}-${right}`,
      source: left,
      target: right,
      label,
      color: undefined,
      direction: 'both',
    } as const;
  }

  return {
    id: `${source}->${target}`,
    source,
    target,
    label,
    color: undefined,
    direction: operator === '<-->' ? 'both' : direction,
  } as const;
};

const buildTree = (nodes: Map<string, { id: string; label: string; color?: string; textColor?: string; className?: string }>, edges: TreeEdge[]) => {
  const treeNodes = new Map<string, TreeNode>();

  for (const node of nodes.values()) {
    treeNodes.set(node.id, {
      id: node.id,
      label: node.label,
      parentId: null,
      children: [],
      depth: 0,
      color: node.color,
      textColor: node.textColor,
      className: node.className,
      rawId: node.id,
      metadata: {},
    });
  }

  for (const edge of edges) {
    const parent = treeNodes.get(edge.source);
    const child = treeNodes.get(edge.target);
    if (!parent || !child) continue;

    if (child.parentId && child.parentId !== edge.source) {
      continue;
    }

    child.parentId = edge.source;
    parent.children.push(edge.target);
  }

  const roots = Array.from(treeNodes.values()).filter((node) => node.parentId === null);
  let rootId: string | null = null;

  if (roots.length === 1) {
    rootId = roots[0].id;
  }

  const visit = (nodeId: string, depth: number) => {
    const node = treeNodes.get(nodeId);
    if (!node) return;
    node.depth = depth;
    for (const childId of node.children) {
      visit(childId, depth + 1);
    }
  };

  if (rootId) {
    visit(rootId, 0);
  }

  return {
    rootId,
    nodes: treeNodes,
  };
};

const getNodeList = (input: string) => {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('%%'));

  return lines;
};

export type MermaidElements = {
  nodeMap: Map<string, { id: string; label: string; color?: string; textColor?: string; className?: string }>;
  edges: TreeEdge[];
  direction: Direction;
};

/** Shared Mermaid line parsing used by both the tree and the general-graph builders. */
export const collectMermaidElements = (input: string): MermaidElements => {
  const lines = getNodeList(input);
  const nodeMap = new Map<string, { id: string; label: string; color?: string; textColor?: string; className?: string }>();
  const edges: TreeEdge[] = [];
  const classStyles = new Map<string, Record<string, string>>();
  let direction: Direction = 'TB';

  for (const line of lines) {
    if (/^(?:graph|flowchart)\s+/i.test(line)) {
      direction = getDirectionFromHeader(line);
      continue;
    }

    const classDef = parseClassDef(line);
    if (classDef) {
      classStyles.set(classDef.className, classDef.styleMap);
      continue;
    }

    const classAssignment = parseClassAssignment(line);
    if (classAssignment) {
      for (const nodeId of classAssignment.nodeIds) {
        const current = nodeMap.get(nodeId) ?? { id: nodeId, label: nodeId };
        const styles = classStyles.get(classAssignment.className) ?? {};
        const fill = styles.fill ?? styles['fill'];
        const color = styles.color ?? styles['color'];
        current.color = current.color ?? (fill ? String(fill) : undefined);
        current.textColor = current.textColor ?? (color ? String(color) : undefined);
        current.className = current.className ?? classAssignment.className;
        nodeMap.set(nodeId, current);
      }
      continue;
    }

    const styleAssignment = parseStyleAssignment(line);
    if (styleAssignment) {
      const current = nodeMap.get(styleAssignment.nodeId) ?? { id: styleAssignment.nodeId, label: styleAssignment.nodeId };
      const fill = styleAssignment.styleMap.fill ?? styleAssignment.styleMap['fill'];
      const color = styleAssignment.styleMap.color ?? styleAssignment.styleMap['color'];
      current.color = fill ? String(fill) : current.color;
      current.textColor = color ? String(color) : current.textColor;
      nodeMap.set(styleAssignment.nodeId, current);
      continue;
    }

    const edge = parseEdgeDeclaration(line);
    if (edge) {
      const sourceNode = nodeMap.get(edge.source) ?? { id: edge.source, label: edge.source };
      const targetNode = nodeMap.get(edge.target) ?? { id: edge.target, label: edge.target };
      nodeMap.set(edge.source, sourceNode);
      nodeMap.set(edge.target, targetNode);
      edges.push({
        ...edge,
        id: `${edge.source}->${edge.target}`,
      });
      continue;
    }

    const nodeDeclaration = parseNodeDeclaration(line);
    if (nodeDeclaration && nodeDeclaration.type === 'class-annotation') {
      const existing = nodeMap.get(nodeDeclaration.id) ?? { id: nodeDeclaration.id, label: nodeDeclaration.id };
      const styles = classStyles.get(nodeDeclaration.className) ?? {};
      const fill = styles.fill ?? styles['fill'];
      const color = styles.color ?? styles['color'];
      existing.color = fill ? String(fill) : existing.color;
      existing.textColor = color ? String(color) : existing.textColor;
      existing.className = existing.className ?? nodeDeclaration.className;
      nodeMap.set(nodeDeclaration.id, existing);
      continue;
    }

    if (nodeDeclaration && nodeDeclaration.type === 'node') {
      const existing = nodeMap.get(nodeDeclaration.id) ?? { id: nodeDeclaration.id, label: nodeDeclaration.id };
      existing.label = nodeDeclaration.label || existing.label;
      nodeMap.set(nodeDeclaration.id, existing);
      continue;
    }
  }

  return { nodeMap, edges, direction };
};

export const parseMermaidTree = (input: string): MermaidTree => {
  if (!input || !input.trim()) {
    return {
      rootId: null,
      nodes: new Map(),
      edges: [],
      direction: 'TB',
      validationError: 'El archivo Mermaid está vacío.',
    };
  }

  const { nodeMap, edges, direction } = collectMermaidElements(input);

  const built = buildTree(nodeMap, edges);

  if (!built.rootId) {
    return {
      rootId: null,
      nodes: built.nodes,
      edges,
      direction,
      validationError: 'El grafo no tiene una raíz única válida.',
    };
  }

  const visited = new Set<string>();
  const stack = [built.rootId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const node = built.nodes.get(current);
    if (!node) continue;
    for (const child of node.children) {
      stack.push(child);
    }
  }

  if (visited.size !== built.nodes.size) {
    return {
      rootId: built.rootId,
      nodes: built.nodes,
      edges,
      direction,
      validationError: 'El grafo contiene ciclos o componentes desconectados.',
    };
  }

  const parentCounts = new Map<string, number>();
  for (const node of built.nodes.keys()) parentCounts.set(node, 0);

  for (const edge of edges) {
    const target = edge.target;
    parentCounts.set(target, (parentCounts.get(target) ?? 0) + 1);
  }

  const multiParentNodes = Array.from(parentCounts.entries()).filter(([, count]) => count > 1).map(([id]) => id);
  if (multiParentNodes.length > 0) {
    return {
      rootId: built.rootId,
      nodes: built.nodes,
      edges,
      direction,
      validationError: `Hay nodos con más de un padre: ${multiParentNodes.join(', ')}`,
    };
  }

  return {
    rootId: built.rootId,
    nodes: built.nodes,
    edges,
    direction,
  };
};

export const getAncestorPath = (tree: MermaidTree, nodeId: string): string[] => {
  const path: string[] = [];
  let current: string | null = nodeId;
  while (current) {
    path.push(current);
    const node = tree.nodes.get(current);
    if (!node) break;
    current = node.parentId;
  }
  return path.reverse();
};

/**
 * Total descendant count for every node (iterative post-order to stay safe on
 * very deep trees). Direct-children counts come straight from `node.children`.
 */
export const getDescendantCounts = (tree: MermaidTree): Map<string, number> => {
  const counts = new Map<string, number>();
  if (!tree.rootId) return counts;

  const preorder: string[] = [];
  const stack = [tree.rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) continue;
    preorder.push(id);
    const node = tree.nodes.get(id);
    if (!node) continue;
    for (const childId of node.children) stack.push(childId);
  }

  for (let i = preorder.length - 1; i >= 0; i -= 1) {
    const id = preorder[i];
    const node = tree.nodes.get(id);
    if (!node) {
      counts.set(id, 0);
      continue;
    }
    let total = 0;
    for (const childId of node.children) {
      total += 1 + (counts.get(childId) ?? 0);
    }
    counts.set(id, total);
  }

  return counts;
};

const DEFAULT_LEGEND_COLOR = '#4f8ef7';

/**
 * Build a legend from the parsed graph: one entry per distinct node class
 * (falling back to a generic group for unclassified/custom-styled nodes).
 */
export const getLegendGroups = (tree: MermaidTree): LegendGroup[] => {
  const groups = new Map<string, LegendGroup>();

  for (const node of tree.nodes.values()) {
    if (node.className) {
      if (!groups.has(node.className)) {
        groups.set(node.className, {
          key: node.className,
          label: node.className,
          color: node.color ?? DEFAULT_LEGEND_COLOR,
        });
      }
    } else {
      const key = `__color__:${node.color ?? DEFAULT_LEGEND_COLOR}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: node.color ? 'Personalizado' : 'Sin clase',
          color: node.color ?? DEFAULT_LEGEND_COLOR,
        });
      }
    }
  }

  return Array.from(groups.values());
};

export const getVisibleNodes = (tree: MermaidTree, expanded: Set<string>) => {
  if (!tree.rootId) return { visibleNodes: new Set<string>(), visibleEdges: new Set<string>() };
  const visibleNodes = new Set<string>();
  const visibleEdges = new Set<string>();

  const walk = (nodeId: string) => {
    const node = tree.nodes.get(nodeId);
    if (!node) return;
    visibleNodes.add(nodeId);

    if (!expanded.has(nodeId)) {
      return;
    }

    for (const childId of node.children) {
      visibleEdges.add(`${nodeId}->${childId}`);
      walk(childId);
    }
  };

  walk(tree.rootId);
  return { visibleNodes, visibleEdges };
};

export const toggleNodeExpanded = (_tree: MermaidTree, nodeId: string, expanded: Set<string>) => {
  const next = new Set(expanded);
  if (next.has(nodeId)) {
    next.delete(nodeId);
  } else {
    next.add(nodeId);
  }
  return next;
};

export const revealAncestorsToRoot = (tree: MermaidTree, targetId: string, expanded: Set<string>) => {
  const next = new Set(expanded);
  const path = getAncestorPath(tree, targetId);

  for (const nodeId of path) {
    next.add(nodeId);
  }

  for (const node of tree.nodes.values()) {
    if (!node.parentId) continue;
    const parentId = node.parentId;
    const pathSet = new Set(path);
    if (!pathSet.has(node.id) && pathSet.has(parentId)) {
      next.delete(node.id);
    }
  }

  for (const parentId of path) {
    const parentNode = tree.nodes.get(parentId);
    if (!parentNode) continue;
    for (const childId of parentNode.children) {
      if (!path.includes(childId) && childId !== targetId) {
        next.delete(childId);
      }
    }
  }

  return next;
};

export const buildSearchIndex = (tree: MermaidTree) => {
  const byLabel = new Map<string, string[]>();

  for (const node of tree.nodes.values()) {
    const normalized = normalizeLabel(node.label);
    if (!normalized) continue;
    const bucket = byLabel.get(normalized) ?? [];
    bucket.push(node.id);
    byLabel.set(normalized, bucket);
  }

  return byLabel;
};

export const searchNodes = (tree: MermaidTree, query: string) => {
  const trimmed = query.trim();
  if (!trimmed) return [] as SearchMatch[];

  const byLabel = buildSearchIndex(tree);
  const matches: SearchMatch[] = [];
  const queryNormalized = normalizeLabel(trimmed);

  for (const [labelKey, nodeIds] of byLabel.entries()) {
    if (!labelKey.includes(queryNormalized)) continue;

    for (const nodeId of nodeIds) {
      const node = tree.nodes.get(nodeId);
      if (!node) continue;
      let score = 30;
      const normalizedNodeLabel = normalizeLabel(node.label);
      if (normalizedNodeLabel === queryNormalized) score = 100;
      else if (normalizedNodeLabel.startsWith(queryNormalized)) score = 80;
      else if (normalizedNodeLabel.includes(queryNormalized)) score = 60;
      matches.push({
        nodeId,
        label: node.label,
        score,
        depth: node.depth,
      });
    }
  }

  const allNodes = Array.from(tree.nodes.values()).filter((node) => normalizeLabel(node.label).includes(queryNormalized));
  for (const node of allNodes) {
    if (!matches.some((match) => match.nodeId === node.id)) {
      matches.push({
        nodeId: node.id,
        label: node.label,
        score: 50,
        depth: node.depth,
      });
    }
  }

  return matches.sort((a, b) => b.score - a.score || a.depth - b.depth);
};

export type RenderPosition = { x: number; y: number; depth: number; row: number };

export type RenderGraph = {
  visibleNodes: Set<string>;
  visibleEdges: Set<string>;
  positions: Map<string, RenderPosition>;
  order: string[];
  rowStep: number;
  depthStep: number;
};

export const ROW_STEP = 40;
export const DEPTH_STEP = 60;
// In TB orientation the "row" axis is horizontal, so it needs more room for labels.
export const ROW_STEP_TB = 170;
export const DEPTH_STEP_TB = 96;

export const getRenderGraph = (
  tree: MermaidTree,
  expanded: Set<string>,
  layoutDirection: 'LR' | 'TB' = 'LR',
): RenderGraph => {
  const { visibleNodes, visibleEdges } = getVisibleNodes(tree, expanded);
  const positions = new Map<string, RenderPosition>();
  const order: string[] = [];

  const rowStep = layoutDirection === 'LR' ? ROW_STEP : ROW_STEP_TB;
  const depthStep = layoutDirection === 'LR' ? DEPTH_STEP : DEPTH_STEP_TB;

  if (!tree.rootId || !visibleNodes.has(tree.rootId)) {
    return { visibleNodes, visibleEdges, positions, order, rowStep, depthStep };
  }

  let row = 0;

  const walk = (nodeId: string, depth: number) => {
    const node = tree.nodes.get(nodeId);
    if (!node) return;

    const along = row * rowStep;
    const across = depth * depthStep;

    // File-explorer TreeView: every visible node occupies its own row (DFS pre-order).
    // "LR" indents to the right and flows downward; "TB" indents downward and flows rightward.
    if (layoutDirection === 'LR') {
      positions.set(nodeId, { x: across, y: along, depth, row });
    } else {
      positions.set(nodeId, { x: along, y: across, depth, row });
    }

    order.push(nodeId);
    row += 1;

    for (const childId of node.children) {
      if (visibleNodes.has(childId)) {
        walk(childId, depth + 1);
      }
    }
  };

  walk(tree.rootId, 0);

  return { visibleNodes, visibleEdges, positions, order, rowStep, depthStep };
};
