import type { Edge, Node } from '@xyflow/react';
import type { ChangeEntry, ImpactNode, RiskCode } from '../types/report';
import { normalizeRisk, riskRank } from './risk';
import { splitPath } from './format';

/** 节点上限:总览模式下超过这个数量就截断,保证交互流畅。 */
export const MAX_OVERVIEW_NODES = 300;

export const NODE_W = 224;
export const NODE_H = 44;
export const ANCHOR_W = 268;
export const ANCHOR_H = 56;

/** 层间距 / 同层行距 —— 手工布局,不引入布局引擎,保证每次渲染位置稳定。 */
const LAYER_GAP = 300;
const ROW_GAP = 62;
const OVERVIEW_COL_GAP = 28;
const OVERVIEW_GROUP_GAP = 76;
const OVERVIEW_ROWS_PER_COLUMN = 12;
/** 边上标注 relationType 的上限,超过就只在悬停时看,避免线团。 */
const EDGE_LABEL_LIMIT = 44;

export type NodeRole = 'anchor' | 'upstream' | 'downstream' | 'change' | 'impact';

export interface SymbolNodeData extends Record<string, unknown> {
  /** 符号 uid —— 点击节点时回传给上层做锚定 */
  uid: string;
  label: string;
  kind: string;
  filePath: string;
  /** null = 该节点不是本次变更的符号,没有风险数据 */
  risk: RiskCode | null;
  role: NodeRole;
  depth: number;
  relationType: string | null;
  confidence: number | null;
  isChange: boolean;
  isAnchor: boolean;
  /** 是否持有 impact 详情(可展开右侧详情) */
  hasDetail: boolean;
}

export type SymbolFlowNode = Node<SymbolNodeData, 'symbol'>;

export interface GraphBuild {
  nodes: SymbolFlowNode[];
  edges: Edge[];
  /** 节点/边统计,供工具条展示 */
  stats: {
    upstream: number;
    downstream: number;
    changes: number;
    others: number;
    edges: number;
    /** 被深度滑块裁掉的邻居数 */
    hiddenByDepth: number;
    /** 因节点上限被截断 */
    truncated: boolean;
    candidates: number;
    maxDepth: number;
    /** 边数超过阈值,relationType 标签已被自动收起 */
    labelsCapped: boolean;
  };
}

/** 没有报告时的空图,保证 GraphPanel 始终拿到同一种结构。 */
export const EMPTY_GRAPH: GraphBuild = {
  nodes: [],
  edges: [],
  stats: {
    upstream: 0,
    downstream: 0,
    changes: 0,
    others: 0,
    edges: 0,
    hiddenByDepth: 0,
    truncated: false,
    candidates: 0,
    maxDepth: 0,
    labelsCapped: false,
  },
};

/**
 * 边数超过阈值时收起 relationType 标签 —— 线团里的标签是噪声,不是信息。
 * 用户开关仍然有效,这里只是最后的可读性兜底。
 */
function capEdgeLabels(edges: Edge[]): { edges: Edge[]; capped: boolean } {
  if (edges.length <= EDGE_LABEL_LIMIT) return { edges, capped: false };
  return {
    edges: edges.map((edge) => (edge.label ? { ...edge, label: undefined } : edge)),
    capped: true,
  };
}

function makeNode(
  id: string,
  data: SymbolNodeData,
  centerX: number,
  centerY: number,
  width: number,
  height: number,
): SymbolFlowNode {
  return {
    id,
    type: 'symbol',
    position: { x: Math.round(centerX - width / 2), y: Math.round(centerY - height / 2) },
    data,
    width,
    height,
    style: { width, height },
    draggable: true,
    selectable: true,
  };
}

function nodeDataFromImpact(
  node: ImpactNode,
  role: NodeRole,
  riskByUid: ReadonlyMap<string, RiskCode>,
  hasDetail: boolean,
): SymbolNodeData {
  const risk = riskByUid.get(node.uid) ?? null;
  return {
    uid: node.uid,
    label: node.name,
    kind: node.kind,
    filePath: node.filePath,
    risk,
    role,
    depth: node.depth,
    relationType: node.relationType,
    confidence: node.confidence,
    isChange: risk !== null,
    isAnchor: false,
    hasDetail,
  };
}

function anchorDataFromChange(change: ChangeEntry): SymbolNodeData {
  return {
    uid: change.uid,
    label: change.name,
    kind: change.kind,
    filePath: change.filePath,
    risk: normalizeRisk(change.impact?.risk),
    role: 'anchor',
    depth: 0,
    relationType: null,
    confidence: null,
    isChange: true,
    isAnchor: true,
    hasDetail: true,
  };
}

function compareImpactNodes(
  a: ImpactNode,
  b: ImpactNode,
  riskByUid: ReadonlyMap<string, RiskCode>,
): number {
  const byRisk = riskRank(riskByUid.get(b.uid)) - riskRank(riskByUid.get(a.uid));
  if (byRisk !== 0) return byRisk;
  const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  if (byName !== 0) return byName;
  return a.uid.localeCompare(b.uid);
}

/**
 * 锚点视图:变更符号居中,上游(调用方)向左分层展开,下游(被调方)向右分层展开。
 * 深度来自 impact 数据自带的 depth 字段,不做图遍历 —— 前端只呈现引擎已算出的影响面。
 */
export function buildAnchorGraph(options: {
  change: ChangeEntry;
  riskByUid: ReadonlyMap<string, RiskCode>;
  /** null = 不限深度(全部展开) */
  depthLimit: number | null;
  showLabels: boolean;
}): GraphBuild {
  const { change, riskByUid, depthLimit, showLabels } = options;
  const upstreamAll = change.impact?.upstream ?? [];
  const downstreamAll = change.impact?.downstream ?? [];

  const upstreamVisible = depthLimit === null ? upstreamAll : upstreamAll.filter((n) => n.depth <= depthLimit);
  const downstreamVisible = depthLimit === null ? downstreamAll : downstreamAll.filter((n) => n.depth <= depthLimit);
  const hiddenByDepth = upstreamAll.length + downstreamAll.length - upstreamVisible.length - downstreamVisible.length;

  const nodes: SymbolFlowNode[] = [];
  const edges: Edge[] = [];
  const usedUids = new Set<string>([change.uid]);

  nodes.push(makeNode('anchor', anchorDataFromChange(change), 0, 0, ANCHOR_W, ANCHOR_H));

  const placeLayer = (list: ImpactNode[], direction: 'upstream' | 'downstream') => {
    const byDepth = new Map<number, ImpactNode[]>();
    for (const node of list) {
      if (usedUids.has(node.uid)) continue; // 双向都出现的节点只画一次
      usedUids.add(node.uid);
      const bucket = byDepth.get(node.depth);
      if (bucket) bucket.push(node);
      else byDepth.set(node.depth, [node]);
    }
    for (const [depth, bucket] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
      bucket.sort((a, b) => compareImpactNodes(a, b, riskByUid));
      const centerX = direction === 'upstream' ? -depth * LAYER_GAP : depth * LAYER_GAP;
      bucket.forEach((node, index) => {
        const centerY = (index - (bucket.length - 1) / 2) * ROW_GAP;
        const id = `${direction === 'upstream' ? 'u' : 'd'}:${node.uid}`;
        nodes.push(
          makeNode(
            id,
            nodeDataFromImpact(node, direction, riskByUid, false),
            centerX,
            centerY,
            NODE_W,
            NODE_H,
          ),
        );
        const label = showLabels ? node.relationType || undefined : undefined;
        edges.push({
          id: `e:${id}`,
          source: direction === 'upstream' ? id : 'anchor',
          target: direction === 'upstream' ? 'anchor' : id,
          type: 'smoothstep',
          label,
          labelShowBg: true,
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 3,
          labelBgStyle: { fill: 'var(--page)', fillOpacity: 0.92 },
          labelStyle: { fill: 'var(--ink-3)', fontSize: 10 },
          className: `edge-${direction}`,
          animated: false,
        });
      });
    }
  };

  placeLayer(upstreamVisible, 'upstream');
  placeLayer(downstreamVisible, 'downstream');

  const upstreamNodes = nodes.filter((n) => n.data.role === 'upstream').length;
  const downstreamNodes = nodes.filter((n) => n.data.role === 'downstream').length;
  const capped = capEdgeLabels(edges);

  return {
    nodes,
    edges: capped.edges,
    stats: {
      upstream: upstreamNodes,
      downstream: downstreamNodes,
      changes: 1,
      others: 0,
      edges: edges.length,
      hiddenByDepth,
      truncated: false,
      candidates: upstreamAll.length + downstreamAll.length,
      maxDepth: Math.max(
        0,
        ...upstreamVisible.map((n) => n.depth),
        ...downstreamVisible.map((n) => n.depth),
      ),
      labelsCapped: capped.capped,
    },
  };
}

/**
 * 聚焦视图:锚点是一个**非变更**节点(比如变更符号的某个调用方)。
 * 报告里没有它的 impact 数据,只能画出它在已加载数据中已知的直接邻居。
 */
export function buildFocusGraph(options: {
  focus: ImpactNode;
  neighbors: ImpactNode[];
  riskByUid: ReadonlyMap<string, RiskCode>;
  showLabels: boolean;
}): GraphBuild {
  const { focus, neighbors, riskByUid, showLabels } = options;
  const nodes: SymbolFlowNode[] = [];
  const edges: Edge[] = [];
  const focusId = `f:${focus.uid}`;

  nodes.push(
    makeNode(
      focusId,
      {
        ...nodeDataFromImpact(focus, 'anchor', riskByUid, false),
        isAnchor: true,
        role: 'anchor',
      },
      0,
      0,
      ANCHOR_W,
      ANCHOR_H,
    ),
  );

  const unique = new Map<string, ImpactNode>();
  for (const neighbor of neighbors) {
    if (neighbor.uid === focus.uid || unique.has(neighbor.uid)) continue;
    unique.set(neighbor.uid, neighbor);
  }
  const list = [...unique.values()].sort((a, b) => compareImpactNodes(a, b, riskByUid));
  const visible = list.slice(0, MAX_OVERVIEW_NODES - 1);

  visible.forEach((neighbor, index) => {
    const centerX = (index % 2 === 0 ? -1 : 1) * LAYER_GAP;
    const centerY = (Math.floor(index / 2) - (Math.ceil(visible.length / 2) - 1) / 2) * ROW_GAP;
    const id = `n:${neighbor.uid}`;
    nodes.push(
      makeNode(id, nodeDataFromImpact(neighbor, 'impact', riskByUid, false), centerX, centerY, NODE_W, NODE_H),
    );
    const attach = neighbor.relationType || undefined;
    const label = showLabels ? attach : undefined;
    edges.push({
      id: `e:${id}`,
      source: id,
      target: focusId,
      type: 'default',
      label,
      labelShowBg: true,
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
      labelBgStyle: { fill: 'var(--page)', fillOpacity: 0.92 },
      labelStyle: { fill: 'var(--ink-3)', fontSize: 10 },
      className: 'edge-neutral',
    });
  });

  const capped = capEdgeLabels(edges);

  return {
    nodes,
    edges: capped.edges,
    stats: {
      upstream: 0,
      downstream: 0,
      changes: 0,
      others: visible.length,
      edges: edges.length,
      hiddenByDepth: 0,
      truncated: list.length > visible.length,
      candidates: list.length,
      maxDepth: 1,
      labelsCapped: capped.capped,
    },
  };
}

/** 模块分组键:文件路径前两段,用于总览图的列分组布局。 */
export function moduleOf(filePath: string): string {
  const { dir } = splitPath(filePath);
  const segments = dir.split('/').filter((s) => s !== '');
  if (segments.length === 0) return '(根目录)';
  return segments.slice(0, 2).join('/');
}

/**
 * 总览视图:没有锚点时,把(过滤后的)全部变更符号按模块分组排成列,
 * 用 depth === 1 的直接影响关系连边。超过 300 个节点即截断。
 */
export function buildOverviewGraph(options: {
  changes: readonly ChangeEntry[];
  riskByUid: ReadonlyMap<string, RiskCode>;
  includeNeighbors: boolean;
  showLabels: boolean;
  cap?: number;
}): GraphBuild {
  const { changes, riskByUid, includeNeighbors, showLabels } = options;
  const cap = options.cap ?? MAX_OVERVIEW_NODES;

  const selected = new Map<string, { kind: 'change'; change: ChangeEntry } | { kind: 'impact'; node: ImpactNode }>();
  let truncated = false;
  const candidates = changes.length;

  for (const change of changes) {
    if (selected.size >= cap) {
      truncated = true;
      break;
    }
    selected.set(change.uid, { kind: 'change', change });
  }

  if (includeNeighbors) {
    for (const change of changes) {
      if (!selected.has(change.uid)) continue;
      const direct = [...(change.impact?.upstream ?? []), ...(change.impact?.downstream ?? [])].filter(
        (node) => node.depth === 1,
      );
      for (const node of direct) {
        if (node.uid === change.uid || selected.has(node.uid)) continue;
        if (selected.size >= cap) {
          truncated = true;
          break;
        }
        selected.set(node.uid, { kind: 'impact', node });
      }
    }
  }

  // 按模块分组,组内按风险降序 → 名字升序;组间按最高风险降序。
  const groups = new Map<string, string[]>();
  for (const [uid, entry] of selected) {
    const filePath = entry.kind === 'change' ? entry.change.filePath : entry.node.filePath;
    const key = moduleOf(filePath);
    const bucket = groups.get(key);
    if (bucket) bucket.push(uid);
    else groups.set(key, [uid]);
  }

  const rankOf = (uid: string): number => {
    const entry = selected.get(uid);
    if (!entry) return -1;
    return entry.kind === 'change'
      ? riskRank(entry.change.impact?.risk)
      : riskRank(riskByUid.get(uid));
  };
  const nameOf = (uid: string): string => {
    const entry = selected.get(uid);
    if (!entry) return uid;
    return entry.kind === 'change' ? entry.change.name : entry.node.name;
  };

  const orderedGroups = [...groups.entries()].map(([name, uids]) => {
    const sorted = [...uids].sort((a, b) => {
      const byRisk = rankOf(b) - rankOf(a);
      if (byRisk !== 0) return byRisk;
      return nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase());
    });
    return { name, uids: sorted, topRisk: Math.max(...sorted.map(rankOf)) };
  });
  orderedGroups.sort((a, b) => {
    const byRisk = b.topRisk - a.topRisk;
    if (byRisk !== 0) return byRisk;
    return a.name.localeCompare(b.name);
  });

  const nodes: SymbolFlowNode[] = [];
  let cursorX = 0;
  for (const group of orderedGroups) {
    const columns = Math.ceil(group.uids.length / OVERVIEW_ROWS_PER_COLUMN);
    group.uids.forEach((uid, index) => {
      const entry = selected.get(uid);
      if (!entry) return;
      const column = Math.floor(index / OVERVIEW_ROWS_PER_COLUMN);
      const row = index % OVERVIEW_ROWS_PER_COLUMN;
      const centerX = cursorX + column * (NODE_W + OVERVIEW_COL_GAP) + NODE_W / 2;
      const centerY = row * (NODE_H + 14) + NODE_H / 2;
      const data: SymbolNodeData =
        entry.kind === 'change'
          ? {
              uid: entry.change.uid,
              label: entry.change.name,
              kind: entry.change.kind,
              filePath: entry.change.filePath,
              risk: normalizeRisk(entry.change.impact?.risk),
              role: 'change',
              depth: 0,
              relationType: null,
              confidence: null,
              isChange: true,
              isAnchor: false,
              hasDetail: true,
            }
          : nodeDataFromImpact(entry.node, 'impact', riskByUid, false);
      nodes.push(makeNode(`c:${uid}`, data, centerX, centerY, NODE_W, NODE_H));
    });
    cursorX += columns * (NODE_W + OVERVIEW_COL_GAP) + OVERVIEW_GROUP_GAP;
  }

  const nodeIdByUid = new Map<string, string>();
  for (const node of nodes) nodeIdByUid.set(node.id.slice(2), node.id);

  const edges: Edge[] = [];
  const seenEdges = new Set<string>();
  const pushEdge = (sourceUid: string, targetUid: string, relationType: string, direction: string) => {
    const source = nodeIdByUid.get(sourceUid);
    const target = nodeIdByUid.get(targetUid);
    if (!source || !target || source === target) return;
    const id = `e:${sourceUid}->${targetUid}`;
    if (seenEdges.has(id)) return;
    seenEdges.add(id);
    edges.push({
      id,
      source,
      target,
      type: 'default',
      label: showLabels ? relationType || undefined : undefined,
      labelShowBg: true,
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
      labelBgStyle: { fill: 'var(--page)', fillOpacity: 0.92 },
      labelStyle: { fill: 'var(--ink-3)', fontSize: 10 },
      className: `edge-${direction}`,
    });
  };

  for (const [uid, entry] of selected) {
    if (entry.kind !== 'change') continue;
    if (!nodeIdByUid.has(uid)) continue;
    for (const node of entry.change.impact?.upstream ?? []) {
      if (node.depth !== 1) continue;
      pushEdge(node.uid, uid, node.relationType, 'upstream');
    }
    for (const node of entry.change.impact?.downstream ?? []) {
      if (node.depth !== 1) continue;
      pushEdge(uid, node.uid, node.relationType, 'downstream');
    }
  }

  const changeCount = [...selected.values()].filter((e) => e.kind === 'change').length;
  const capped = capEdgeLabels(edges);

  return {
    nodes,
    edges: capped.edges,
    stats: {
      upstream: 0,
      downstream: 0,
      changes: changeCount,
      others: nodes.length - changeCount,
      edges: edges.length,
      hiddenByDepth: 0,
      truncated,
      candidates,
      maxDepth: 1,
      labelsCapped: capped.capped,
    },
  };
}

/**
 * 直接邻居索引:uid → 出现在其它变更符号 impact 里的直接关系。
 * 用于「点了一个非变更节点」时还能给出它已知的邻居。
 */
export function buildNeighborIndex(
  changes: readonly ChangeEntry[],
): Map<string, ImpactNode[]> {
  const index = new Map<string, ImpactNode[]>();
  const push = (uid: string, node: ImpactNode) => {
    const bucket = index.get(uid);
    if (bucket) bucket.push(node);
    else index.set(uid, [node]);
  };
  for (const change of changes) {
    for (const node of change.impact?.upstream ?? []) {
      push(node.uid, {
        depth: node.depth,
        uid: change.uid,
        name: change.name,
        kind: change.kind,
        filePath: change.filePath,
        relationType: node.relationType,
        confidence: node.confidence,
      });
      push(change.uid, node);
    }
    for (const node of change.impact?.downstream ?? []) {
      push(node.uid, {
        depth: node.depth,
        uid: change.uid,
        name: change.name,
        kind: change.kind,
        filePath: change.filePath,
        relationType: node.relationType,
        confidence: node.confidence,
      });
      push(change.uid, node);
    }
  }
  return index;
}
