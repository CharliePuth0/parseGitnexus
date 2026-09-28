import { createContext, createElement, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * 词典以中文为准(zh 是 source of truth),en 是完整镜像 —— 缺 key 会在编译期报错。
 */
const zh = {
  'app.title': '发布影响评估',
  'app.subtitle': '变更影响报告',
  'app.reload': '重新载入报告',
  'app.langSwitch': 'EN',

  'upload.title': '载入影响报告',
  'upload.desc': '拖入 release-impact 引擎产出的 report.json(v1 不直连 serve API)。',
  'upload.drop': '拖入 report.json',
  'upload.dropActive': '松开即载入',
  'upload.choose': '选择文件',
  'upload.sample': '载入示例',
  'upload.sampleHint': '没有报告?先看示例报告',
  'upload.errorTitle': '载入失败',
  'upload.structure': '期望结构:meta / summary / changes / processes / llm',

  'summary.files': '变更文件',
  'summary.symbols': '变更符号',
  'summary.analyzed': '已分析',
  'summary.processes': '受影响流程',
  'summary.risk': '整体风险',
  'summary.baseline': '上线基线',
  'summary.generatedAt': '生成于',
  'summary.branch': '分支',
  'index.current': '索引最新',
  'index.behind': '索引落后',
  'index.diverged': '索引分叉',
  'index.unknown': '索引状态未知',
  'index.staleHint': '索引与目标提交不一致,影响面可能不完整,建议重新执行 analyze。',
  'summary.truncated': 'detect_changes 结果被截断,变更集可能不完整',
  'summary.worktreeDirty': '工作区含 {count} 个未提交改动——评估区间是 {base}..工作区,不是 {base}..HEAD',

  'risk.CRITICAL': '严重',
  'risk.HIGH': '高',
  'risk.MEDIUM': '中',
  'risk.LOW': '低',
  'risk.UNKNOWN': '未知',

  'changeType.added': '新增',
  'changeType.modified': '修改',
  'changeType.removed': '已删除',

  'epistemic.exact': '精确',
  'epistemic.lower-bound': '下界',
  'epistemic.unknown': '未知',
  'epistemic.exact.hint': '调用关系可完整解析,影响面为精确值。',
  'epistemic.lower-bound.hint': '只能给出影响面下界,可能仍有未追踪的调用方。',
  'epistemic.unknown.hint': '无法判定解析完整度,请结合边界说明判断。',

  'list.title': '变更符号',
  'list.search': '搜索名称 / 路径',
  'list.hideTests': '隐藏测试文件',
  'list.hideTests.none': '本报告没有标记测试文件(引擎侧已预过滤)',
  'list.empty': '没有匹配的变更符号',
  'list.emptyHint': '调整筛选条件,或关闭「隐藏测试文件」。',
  'list.shown': '显示',
  'list.sortedByRisk': '按风险降序',
  'list.reset': '重置筛选',
  'list.testTag': '测试',
  'list.collapse': '收起面板',
  'list.expand': '展开面板',

  'graph.title': '影响图',
  'graph.mode.overview': '总览',
  'graph.mode.anchor': '锚点',
  'graph.depth': '展开深度',
  'graph.includeNeighbors': '含直接关联节点',
  'graph.labels': '关系标签',
  'graph.reset': '取消锚定',
  'graph.empty': '没有可绘制的节点',
  'graph.emptyHint': '从左侧选择变更符号进行锚定,或调整筛选条件。',
  'graph.truncated': '节点数已达上限,仅显示前 300 个',
  'graph.legend': '图例',
  'graph.legend.anchor': '变更符号(锚点)',
  'graph.legend.upstream': '上游 · 调用方',
  'graph.legend.downstream': '下游 · 被调方',
  'graph.legend.risk': '边框色 = 风险等级',
  'graph.legend.shape': '方框 = 变更符号 · 圆角方块 = 关联符号',
  'graph.focusOnly': '该节点不是本次变更的符号,只有直接关联,没有 impact 详情。',
  'graph.nodes': '节点',
  'graph.edges': '关系',
  'graph.overflow': '另有节点未显示',
  'graph.noEdges': '变更符号之间没有直接调用关系',
  'graph.labelsCapped': '边数过多,已自动收起关系标签',

  'detail.title': '详情',
  'detail.empty': '未选择变更符号',
  'detail.emptyHint': '点击左侧列表或图上的节点,查看风险、影响面与流程。',
  'detail.overview': '报告概览',
  'detail.risk': '风险',
  'detail.epistemic': '判定完整度',
  'detail.boundaries': '边界说明',
  'detail.boundaries.none': '工具未上报边界说明',
  'detail.modules': '涉及模块',
  'detail.affectedProcesses': '受影响流程',
  'detail.none': '无',
  'detail.upstream': '上游调用方',
  'detail.downstream': '下游被调方',
  'detail.intraProcedural': '方法内守卫',
  'detail.intraGuards': '守卫边(CDG)',
  'detail.intraGuardsHint': '行号为块锚,以语句原文为准;空结果 = 未知,不是"无依赖"',
  'detail.intraFlows': '变量流(REACHING_DEF)',
  'detail.intraNoPdg': '索引无 PDG 层——用 gitnexus analyze --pdg 重建索引后重跑引擎',
  'detail.guardFlag': '守卫',
  'detail.taint': '污点风险',
  'detail.taintHint': '仅列出落在变更文件上的 source→sink 流',
  'detail.taintInter': '跨函数',
  'detail.noUpstream': '未观测到上游调用方 —— UNKNOWN 不等于无风险,建议文本搜索确认。',
  'detail.noDownstream': '未观测到下游被调方。',
  'detail.showAll': '展开全部',
  'detail.collapse': '收起',
  'detail.col.name': '名称',
  'detail.col.depth': '层',
  'detail.col.relation': '关系',
  'detail.col.confidence': '置信度',
  'detail.location': '位置',
  'detail.kind': '类型',
  'detail.changeType': '文件变更类型',
  'detail.changeTypeHint': 'changeType 是文件级的:文件被修改时,其中新增的符号也会标记为「修改」。',
  'detail.boundaryCap': '截断',
  'detail.boundaryCapHint': '带「截断」标记的边界说明表示数据被引擎截断:下面的计数是下界,不是全量。',
  'detail.moreOf': '展开剩余',
  'detail.uid': 'UID',
  'detail.nodeOnly': '非变更符号',
  'detail.nodeOnlyHint': '该节点不是本次变更的符号,报告中没有它的 impact 数据。',
  'detail.repoPath': '仓库路径',
  'detail.version': '契约版本',

  'process.title': '受影响流程',
  'process.empty': '报告未包含受影响流程。',
  'process.steps': '步',
  'process.related': '相关',
  'process.showMore': '显示更多',
  'process.remaining': '剩余',

  'llm.title': 'LLM 叙事',
  'llm.empty': '报告未包含 LLM 叙事(llm.narrative 为空)。',
  'llm.emptyHint': '用 llm-prompt.md 让模型生成场景评估后,把结果回填到 report.json 的 llm.narrative。',
  'llm.promptIncluded': '报告内含 llm.prompt',

  'issue.title': '导入提示',
  'issue.missingMeta': '缺少 meta,已用空值兜底',
  'issue.missingSummary': '缺少 summary,已按 changes 推导',
  'issue.missingChanges': '缺少 changes 数组',
  'issue.missingProcesses': '缺少 processes 数组',
  'issue.missingLlm': '缺少 llm 字段',
  'issue.riskOutOfContract': 'risk 取值不在契约内,已归为 UNKNOWN',
  'issue.changeTypeOutOfContract': 'changeType 取值不在契约内,已忽略该标记',
  'issue.derivedTestFlag': 'isTestFile 缺失,已按路径推断',
  'issue.reordered': 'changes 未按风险降序,已重新排序',
  'issue.duplicateUid': '存在重复 uid',

  'common.all': '全部',
  'common.more': '展开',
  'common.less': '收起',
  'common.dash': '—',
} as const;

export type TKey = keyof typeof zh;

const en: Record<TKey, string> = {
  'app.title': 'Release Impact',
  'app.subtitle': 'Change impact report',
  'app.reload': 'Load another report',
  'app.langSwitch': '中文',

  'upload.title': 'Load an impact report',
  'upload.desc': 'Drop the report.json produced by the release-impact engine (v1 does not call the serve API).',
  'upload.drop': 'Drop report.json',
  'upload.dropActive': 'Release to load',
  'upload.choose': 'Choose file',
  'upload.sample': 'Load sample',
  'upload.sampleHint': 'No report yet? Start from the sample',
  'upload.errorTitle': 'Could not load',
  'upload.structure': 'Expected shape: meta / summary / changes / processes / llm',

  'summary.files': 'Changed files',
  'summary.symbols': 'Changed symbols',
  'summary.analyzed': 'Analyzed',
  'summary.processes': 'Affected processes',
  'summary.risk': 'Overall risk',
  'summary.baseline': 'Baseline',
  'summary.generatedAt': 'Generated',
  'summary.branch': 'Branch',
  'index.current': 'Index current',
  'index.behind': 'Index behind',
  'index.diverged': 'Index diverged',
  'index.unknown': 'Index status unknown',
  'index.staleHint':
    'The index does not match the head commit — the blast radius may be incomplete; re-run analyze.',
  'summary.truncated': 'detect_changes was truncated — the change set may be incomplete',
  'summary.worktreeDirty':
    'Working tree has {count} uncommitted change(s) — assessed range is {base}..worktree, not {base}..HEAD',

  'risk.CRITICAL': 'Critical',
  'risk.HIGH': 'High',
  'risk.MEDIUM': 'Medium',
  'risk.LOW': 'Low',
  'risk.UNKNOWN': 'Unknown',

  'changeType.added': 'added',
  'changeType.modified': 'modified',
  'changeType.removed': 'removed',

  'epistemic.exact': 'Exact',
  'epistemic.lower-bound': 'Lower bound',
  'epistemic.unknown': 'Unknown',
  'epistemic.exact.hint': 'Call relations resolve fully; the blast radius is exact.',
  'epistemic.lower-bound.hint': 'Only a lower bound is available; untracked callers may remain.',
  'epistemic.unknown.hint': 'Resolution completeness is undetermined — read the boundaries notes.',

  'list.title': 'Changed symbols',
  'list.search': 'Search name / path',
  'list.hideTests': 'Hide test files',
  'list.hideTests.none': 'No test files flagged in this report (the engine pre-filters them)',
  'list.empty': 'No matching changed symbols',
  'list.emptyHint': 'Adjust the filters, or turn off “Hide test files”.',
  'list.shown': 'Showing',
  'list.sortedByRisk': 'sorted by risk',
  'list.reset': 'Reset filters',
  'list.testTag': 'test',
  'list.collapse': 'Collapse panel',
  'list.expand': 'Expand panel',

  'graph.title': 'Impact graph',
  'graph.mode.overview': 'Overview',
  'graph.mode.anchor': 'Anchored',
  'graph.depth': 'Depth',
  'graph.includeNeighbors': 'Direct neighbours',
  'graph.labels': 'Edge labels',
  'graph.reset': 'Clear anchor',
  'graph.empty': 'Nothing to draw',
  'graph.emptyHint': 'Pick a changed symbol on the left, or relax the filters.',
  'graph.truncated': 'Node cap reached — showing the first 300',
  'graph.legend': 'Legend',
  'graph.legend.anchor': 'Changed symbol (anchor)',
  'graph.legend.upstream': 'Upstream · callers',
  'graph.legend.downstream': 'Downstream · callees',
  'graph.legend.risk': 'Border colour = risk level',
  'graph.legend.shape': 'Square = changed symbol · rounded = related symbol',
  'graph.focusOnly': 'This node is not part of the change set — only direct relations are known.',
  'graph.nodes': 'nodes',
  'graph.edges': 'edges',
  'graph.overflow': 'more nodes not shown',
  'graph.noEdges': 'No direct calls between the changed symbols',
  'graph.labelsCapped': 'Too many edges — relation labels collapsed',

  'detail.title': 'Details',
  'detail.empty': 'No symbol selected',
  'detail.emptyHint': 'Click a row or a graph node to see risk, blast radius and processes.',
  'detail.overview': 'Report overview',
  'detail.risk': 'Risk',
  'detail.epistemic': 'Confidence of verdict',
  'detail.boundaries': 'Boundaries',
  'detail.boundaries.none': 'The tool reported no boundaries',
  'detail.modules': 'Modules',
  'detail.affectedProcesses': 'Affected processes',
  'detail.none': 'None',
  'detail.upstream': 'Upstream callers',
  'detail.downstream': 'Downstream callees',
  'detail.intraProcedural': 'Intra-procedural guards',
  'detail.intraGuards': 'Guard edges (CDG)',
  'detail.intraGuardsHint': 'Lines are block anchors — trust the quoted text; empty means UNKNOWN, not "no dependence"',
  'detail.intraFlows': 'Variable flows (REACHING_DEF)',
  'detail.intraNoPdg': 'Index has no PDG layer — re-run gitnexus analyze --pdg and the engine',
  'detail.guardFlag': 'guard',
  'detail.taint': 'Taint findings',
  'detail.taintHint': 'Only source→sink flows landing on changed files',
  'detail.taintInter': 'interprocedural',
  'detail.noUpstream': 'No upstream callers observed — UNKNOWN is not an all-clear; confirm with a text search.',
  'detail.noDownstream': 'No downstream callees observed.',
  'detail.showAll': 'Show all',
  'detail.collapse': 'Collapse',
  'detail.col.name': 'Name',
  'detail.col.depth': 'Depth',
  'detail.col.relation': 'Relation',
  'detail.col.confidence': 'Confidence',
  'detail.location': 'Location',
  'detail.kind': 'Kind',
  'detail.changeType': 'File change type',
  'detail.changeTypeHint':
    'changeType is file-level: a symbol added inside a modified file is also reported as “modified”.',
  'detail.boundaryCap': 'capped',
  'detail.boundaryCapHint':
    'A boundary marked “capped” means the engine truncated the data: the counts below are lower bounds, not totals.',
  'detail.moreOf': 'Show remaining',
  'detail.uid': 'UID',
  'detail.nodeOnly': 'Not a changed symbol',
  'detail.nodeOnlyHint': 'This node is not part of the change set; the report carries no impact data for it.',
  'detail.repoPath': 'Repo path',
  'detail.version': 'Contract version',

  'process.title': 'Affected processes',
  'process.empty': 'The report contains no affected processes.',
  'process.steps': 'steps',
  'process.related': 'related',
  'process.showMore': 'Show more',
  'process.remaining': 'remaining',

  'llm.title': 'LLM narrative',
  'llm.empty': 'The report has no LLM narrative (llm.narrative is empty).',
  'llm.emptyHint': 'Generate one from llm-prompt.md and write the result back into llm.narrative.',
  'llm.promptIncluded': 'Report includes llm.prompt',

  'issue.title': 'Import notes',
  'issue.missingMeta': 'meta missing — filled with empty values',
  'issue.missingSummary': 'summary missing — derived from changes',
  'issue.missingChanges': 'changes array missing',
  'issue.missingProcesses': 'processes array missing',
  'issue.missingLlm': 'llm section missing',
  'issue.riskOutOfContract': 'risk value outside the contract — treated as UNKNOWN',
  'issue.changeTypeOutOfContract': 'changeType value outside the contract — marker ignored',
  'issue.derivedTestFlag': 'isTestFile missing — inferred from the path',
  'issue.reordered': 'changes were not sorted by risk — re-sorted',
  'issue.duplicateUid': 'duplicate uid',

  'common.all': 'All',
  'common.more': 'More',
  'common.less': 'Less',
  'common.dash': '—',
};

export type Locale = 'zh' | 'en';

export const DICTS: Record<Locale, Record<TKey, string>> = { zh, en };

export type TFunc = (key: TKey) => string;

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFunc;
}

const STORAGE_KEY = 'impact-web.locale';

function readInitialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh' || stored === 'en') return stored;
  } catch {
    /* 隐私模式下 localStorage 不可用,回落默认值 */
  }
  return 'zh';
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
      document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
    } catch {
      /* 忽略持久化失败 */
    }
  }, []);

  const value = useMemo<I18nValue>(() => {
    const dict = DICTS[locale];
    return { locale, setLocale, t: (key: TKey) => dict[key] ?? key };
  }, [locale, setLocale]);

  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}

export function useT(): TFunc {
  return useI18n().t;
}
