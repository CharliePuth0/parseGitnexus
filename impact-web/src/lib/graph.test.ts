import { describe, expect, it } from 'vitest';
import sample from '../../sample-report.json';
import { parseReport, buildRiskIndex } from './report';
import { filterChanges, DEFAULT_FILTER } from './filter';
import { MAX_OVERVIEW_NODES, buildAnchorGraph, buildFocusGraph, buildNeighborIndex, buildOverviewGraph } from './graph';
import type { GraphBuild } from './graph';
import type { ChangeEntry } from '../types/report';

/**
 * 用仓库里的示例报告跑通「引擎产物 → 前端图模型」的整条链路:
 * 示例既是 UX 素材,也是契约(demo 数据必须能过解析器)。
 */
function loadReport() {
  const result = parseReport(JSON.stringify(sample));
  if (!result.ok) throw new Error(`示例报告解析失败:${result.error}`);
  return result;
}

/**
 * 端点是节点 id,不是 uid —— React Flow 只按 id 解析,指不到的边会被静默丢弃
 * (画面上什么都不显示),所以这条不变量每个视图都必须成立。
 */
function danglingEdges(graph: GraphBuild): string[] {
  const ids = new Set(graph.nodes.map((node) => node.id));
  return graph.edges
    .filter((edge) => !ids.has(edge.source) || !ids.has(edge.target))
    .map((edge) => edge.id);
}

const CRITICAL_UID = 'function:isTestFilePath#1';

describe('sample-report.json ↔ 契约', () => {
  const { report, issues } = loadReport();

  it('parses without any normalization issue', () => {
    expect(issues).toEqual([]);
  });

  it('carries the expected shape', () => {
    expect(report.meta.repo).toBe('GitNexus');
    expect(report.meta.baseRef).toBe('v9.7.0');
    expect(report.changes).toHaveLength(report.summary.analyzedSymbols);
    expect(report.processes).toHaveLength(report.summary.affectedProcesses);
    expect(report.summary.riskLevel).toBe('critical');
  });

  it('keeps changes sorted by risk (UNKNOWN last)', () => {
    expect(report.changes[0]?.impact.risk).toBe('CRITICAL');
    expect(report.changes[report.changes.length - 1]?.impact.risk).toBe('UNKNOWN');
  });

  it('marks the test-file entries the toggle is meant to hide', () => {
    const tests = report.changes.filter((change) => change.isTestFile);
    expect(tests).toHaveLength(3);
    expect(filterChanges(report.changes, DEFAULT_FILTER)).toHaveLength(report.changes.length - 3);
  });

  it('carries only in-contract changeType values, including a removed entry', () => {
    const declared = report.changes.map((change) => change.changeType);
    expect(declared.every((type) => type === undefined || ['added', 'modified', 'removed'].includes(type))).toBe(true);
    expect(declared.filter((type) => type === 'removed')).toHaveLength(1);
  });

  it('keeps a tool-level cap boundary so the capped UI path is demoable', () => {
    const boundaries = report.changes.flatMap((change) => change.impact.boundaries);
    expect(boundaries.some((text) => /capped/i.test(text))).toBe(true);
  });

  it('references every process from at least one change (no orphans in the related filter)', () => {
    const referenced = new Set(report.changes.flatMap((change) => change.impact.affectedProcesses));
    const orphans = report.processes.filter((process) => !referenced.has(process.id));
    expect(orphans).toEqual([]);
    // 26 条 > PAGE_SIZE(20):示例报告本身就能演示分页
    expect(report.processes.length).toBeGreaterThan(20);
  });
});

describe('buildAnchorGraph', () => {
  const { report } = loadReport();
  const riskByUid = buildRiskIndex(report);
  const critical = report.changes.find((change) => change.uid === CRITICAL_UID) as ChangeEntry;

  it('lays out the anchor with upstream on the left and downstream on the right', () => {
    const graph = buildAnchorGraph({ change: critical, riskByUid, depthLimit: 3, showLabels: true });
    const anchor = graph.nodes.find((node) => node.id === 'anchor');
    expect(anchor?.data.role).toBe('anchor');
    expect(anchor?.data.risk).toBe('CRITICAL');

    for (const node of graph.nodes) {
      if (node.data.role === 'upstream') expect(node.position.x).toBeLessThan(0);
      if (node.data.role === 'downstream') expect(node.position.x).toBeGreaterThan(0);
    }
    expect(graph.stats.upstream).toBe(7);
    expect(graph.stats.downstream).toBe(1);
    expect(graph.stats.hiddenByDepth).toBe(0);
    expect(graph.stats.labelsCapped).toBe(false);
  });

  it('the depth limit hides deeper levels and re-anchors cleanly', () => {
    const shallow = buildAnchorGraph({ change: critical, riskByUid, depthLimit: 1, showLabels: true });
    expect(shallow.stats.upstream).toBe(3);
    expect(shallow.stats.downstream).toBe(1);
    expect(shallow.stats.hiddenByDepth).toBe(4);
    expect(Math.max(...shallow.nodes.map((n) => n.data.depth))).toBe(1);

    const deep = buildAnchorGraph({ change: critical, riskByUid, depthLimit: 3, showLabels: false });
    expect(Math.max(...deep.nodes.map((n) => n.data.depth))).toBe(3);
    expect(deep.edges.every((edge) => edge.label === undefined)).toBe(true);
  });

  it('gives every edge a unique id and drops labels only when asked', () => {
    const graph = buildAnchorGraph({ change: critical, riskByUid, depthLimit: 3, showLabels: true });
    const ids = graph.edges.map((edge) => edge.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(graph.edges.every((edge) => typeof edge.label === 'string')).toBe(true);
    const nodeIds = graph.nodes.map((node) => node.id);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
  });

  it('never emits an edge whose endpoints are not rendered nodes', () => {
    expect(danglingEdges(buildAnchorGraph({ change: critical, riskByUid, depthLimit: 1, showLabels: true }))).toEqual([]);
    expect(danglingEdges(buildAnchorGraph({ change: critical, riskByUid, depthLimit: 3, showLabels: true }))).toEqual([]);
  });
});

describe('buildOverviewGraph', () => {
  const { report } = loadReport();
  const riskByUid = buildRiskIndex(report);
  const visible = filterChanges(report.changes, DEFAULT_FILTER);

  it('draws the filtered change set and links depth-1 relations between changes', () => {
    const graph = buildOverviewGraph({
      changes: visible,
      riskByUid,
      includeNeighbors: false,
      showLabels: true,
    });
    expect(graph.nodes).toHaveLength(visible.length);
    expect(graph.stats.truncated).toBe(false);
    // renderImpactPanel → formatConfidence 是两个变更符号之间的直接调用
    const edge = graph.edges.find((item) => item.id === 'e:function:renderImpactPanel#11->function:formatConfidence#13');
    expect(edge).toBeDefined();
    expect(edge?.label).toBe('CALLS');
  });

  it('can pull in direct neighbours and stops at the node cap', () => {
    const withNeighbours = buildOverviewGraph({
      changes: visible,
      riskByUid,
      includeNeighbors: true,
      showLabels: true,
    });
    expect(withNeighbours.nodes.length).toBeGreaterThan(visible.length);

    const capped = buildOverviewGraph({
      changes: visible,
      riskByUid,
      includeNeighbors: true,
      showLabels: true,
      cap: 5,
    });
    expect(capped.nodes).toHaveLength(5);
    expect(capped.stats.truncated).toBe(true);
    expect(MAX_OVERVIEW_NODES).toBe(300);
  });

  it('never emits a self edge and never duplicates a node id', () => {
    const graph = buildOverviewGraph({
      changes: visible,
      riskByUid,
      includeNeighbors: true,
      showLabels: true,
    });
    expect(graph.edges.every((edge) => edge.source !== edge.target)).toBe(true);
    const ids = graph.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(danglingEdges(graph)).toEqual([]);
    expect(danglingEdges(buildOverviewGraph({ changes: visible, riskByUid, includeNeighbors: false, showLabels: true }))).toEqual([]);
  });
});

describe('buildFocusGraph / buildNeighborIndex', () => {
  const { report } = loadReport();
  const riskByUid = buildRiskIndex(report);

  it('indexes direct neighbours so a non-change node can still be anchored', () => {
    const index = buildNeighborIndex(report.changes);
    const changeUids = new Set(report.changes.map((change) => change.uid));
    // withReadTransaction 出现在 CypherRunner.execute 的下游,本身不是变更符号
    const focusUid = 'function:withReadTransaction#1';
    const focus = report.changes
      .flatMap((change) => [...change.impact.upstream, ...change.impact.downstream])
      .find((node) => node.uid === focusUid);
    expect(focus).toBeDefined();
    expect(changeUids.has(focusUid)).toBe(false);

    const neighbours = index.get(focusUid) ?? [];
    expect(neighbours.length).toBeGreaterThan(0);

    const graph = buildFocusGraph({ focus: focus!, neighbors: neighbours, riskByUid, showLabels: true });
    expect(graph.nodes[0]?.id).toBe(`f:${focusUid}`);
    expect(graph.nodes[0]?.data.role).toBe('anchor');
    expect(graph.nodes.length).toBeGreaterThan(1);
    // 非变更符号没有风险数据,边框走中性色
    expect(graph.nodes[0]?.data.risk).toBeNull();
    expect(danglingEdges(graph)).toEqual([]);
  });
});
