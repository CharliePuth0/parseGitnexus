import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ImpactNode, ReleaseImpactReport } from './types/report';
import type { ImportIssue } from './lib/report';
import { buildRiskIndex, parseReport } from './lib/report';
import type { ChangeFilter } from './lib/filter';
import { DEFAULT_FILTER, countByRisk, filterChanges, isTestEntry } from './lib/filter';
import { sortChangesByRisk } from './lib/risk';
import type { SymbolNodeData } from './lib/graph';
import {
  EMPTY_GRAPH,
  buildAnchorGraph,
  buildFocusGraph,
  buildNeighborIndex,
  buildOverviewGraph,
} from './lib/graph';
import { I18nProvider, useI18n } from './lib/i18n';
import { AppHeader } from './components/AppHeader';
import { SummaryBar } from './components/SummaryBar';
import { UploadScreen } from './components/UploadScreen';
import { ChangeListPanel } from './components/ChangeListPanel';
import { GraphPanel } from './components/GraphPanel';
import type { GraphMode } from './components/GraphPanel';
import { DetailPanel } from './components/DetailPanel';
import { ChevronIcon, WarningIcon } from './components/icons';
import sampleReport from '../sample-report.json';
import './styles/shell.css';

type Selection =
  | { kind: 'change'; uid: string }
  | { kind: 'node'; node: ImpactNode }
  | null;

function toImpactNode(data: SymbolNodeData): ImpactNode {
  return {
    depth: data.depth,
    uid: data.uid,
    name: data.label,
    kind: data.kind,
    filePath: data.filePath,
    relationType: data.relationType ?? 'UNKNOWN',
    confidence: data.confidence,
  };
}

function Workspace() {
  const { t } = useI18n();
  const [report, setReport] = useState<ReleaseImpactReport | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ChangeFilter>({ ...DEFAULT_FILTER });
  const [selection, setSelection] = useState<Selection>(null);
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [depth, setDepth] = useState(2);
  const [showLabels, setShowLabels] = useState(true);
  const [includeNeighbors, setIncludeNeighbors] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  /* ------------------------------------------------------------ 载入 */
  const loadText = useCallback((text: string, label: string) => {
    if (text.trim() === '') {
      setLoadError(label);
      return;
    }
    const result = parseReport(text);
    if (!result.ok) {
      setLoadError(`${label} — ${result.error}`);
      return;
    }
    setReport(result.report);
    setIssues(result.issues);
    setLoadError(null);
    setSelection(null);
    setSelectedProcessId(null);
    setFilter({ ...DEFAULT_FILTER });
  }, []);

  const loadSample = useCallback(() => {
    loadText(JSON.stringify(sampleReport, null, 2), 'sample-report.json');
  }, [loadText]);

  // 演示 / 自动化验证入口:?sample=1 直接载入示例报告
  useEffect(() => {
    if (report !== null) return;
    if (new URLSearchParams(window.location.search).has('sample')) loadSample();
    // 只在上传页检查一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------ 派生数据 */
  const changes = useMemo(() => (report ? sortChangesByRisk(report.changes) : []), [report]);
  const riskByUid = useMemo(() => (report ? buildRiskIndex(report) : new Map()), [report]);
  const changeByUid = useMemo(
    () => new Map(changes.map((change) => [change.uid, change] as const)),
    [changes],
  );
  const neighborIndex = useMemo(() => buildNeighborIndex(changes), [changes]);

  // 列表口径:先按风险排序 → 过滤(风险 / 搜索 / 隐藏测试)
  const visible = useMemo(() => filterChanges(changes, filter), [changes, filter]);
  // 风险 chip 的计数不能受风险筛选自身影响,否则选中一个等级其它等级全归零
  const counts = useMemo(
    () => countByRisk(filterChanges(changes, { ...filter, risks: [] })),
    [changes, filter],
  );
  const hiddenTestCount = useMemo(() => changes.filter(isTestEntry).length, [changes]);

  const selectedChange = selection?.kind === 'change' ? changeByUid.get(selection.uid) ?? null : null;
  const selectedNode = selection?.kind === 'node' ? selection.node : null;

  const graph = useMemo(() => {
    if (!report) return EMPTY_GRAPH;
    if (selectedChange) {
      return buildAnchorGraph({ change: selectedChange, riskByUid, depthLimit: depth, showLabels });
    }
    if (selectedNode) {
      return buildFocusGraph({
        focus: selectedNode,
        neighbors: neighborIndex.get(selectedNode.uid) ?? [],
        riskByUid,
        showLabels,
      });
    }
    return buildOverviewGraph({ changes: visible, riskByUid, includeNeighbors, showLabels });
  }, [
    report,
    selectedChange,
    selectedNode,
    riskByUid,
    neighborIndex,
    depth,
    showLabels,
    visible,
    includeNeighbors,
  ]);

  const mode: GraphMode = selectedChange ? 'anchor' : selectedNode ? 'focus' : 'overview';
  const anchorLabel = selectedChange?.name ?? selectedNode?.name ?? null;

  /* ------------------------------------------------------------ 交互 */
  const selectImpactNode = useCallback(
    (node: ImpactNode) => {
      if (changeByUid.has(node.uid)) setSelection({ kind: 'change', uid: node.uid });
      else setSelection({ kind: 'node', node });
    },
    [changeByUid],
  );

  const handleGraphNodeSelect = useCallback(
    (data: SymbolNodeData) => selectImpactNode(toImpactNode(data)),
    [selectImpactNode],
  );

  const resetAnchor = useCallback(() => {
    setSelection(null);
    setSelectedProcessId(null);
  }, []);

  /* ------------------------------------------------------------ 渲染 */
  if (!report) {
    return (
      <div className="app">
        <AppHeader hasReport={false} onReload={() => undefined} />
        <UploadScreen onLoad={loadText} onLoadSample={loadSample} error={loadError} />
      </div>
    );
  }

  return (
    <div className="app">
      {/* 「重新载入报告」= 回到上传页,不再保留当前报告 */}
      <AppHeader hasReport onReload={() => setReport(null)} />
      <SummaryBar report={report} issues={issues} />

      <div
        className={`workspace${leftOpen ? '' : ' workspace--left-collapsed'}${
          rightOpen ? '' : ' workspace--right-collapsed'
        }`}
      >
        {leftOpen ? (
          <div className="ws-col ws-col--left">
            <ChangeListPanel
              visible={visible}
              counts={counts}
              total={changes.length}
              hiddenTestCount={hiddenTestCount}
              filter={filter}
              onFilterChange={setFilter}
              selectedUid={selectedChange?.uid ?? null}
              onSelect={(uid) => setSelection({ kind: 'change', uid })}
              onCollapse={() => setLeftOpen(false)}
            />
          </div>
        ) : (
          <button
            type="button"
            className="rail rail--left"
            onClick={() => setLeftOpen(true)}
            title={t('list.expand')}
          >
            <ChevronIcon />
            <span className="rail__label">{t('list.title')}</span>
            <span className="rail__count">
              {visible.length}/{changes.length}
            </span>
          </button>
        )}

        <div className="ws-col ws-col--center">
          <GraphPanel
            build={graph}
            mode={mode}
            anchorLabel={anchorLabel}
            depth={depth}
            onDepthChange={setDepth}
            showLabels={showLabels}
            onToggleLabels={setShowLabels}
            includeNeighbors={includeNeighbors}
            onToggleNeighbors={setIncludeNeighbors}
            onResetAnchor={resetAnchor}
            selectedUid={selectedChange?.uid ?? selectedNode?.uid ?? null}
            onNodeSelect={handleGraphNodeSelect}
          />
        </div>

        {rightOpen ? (
          <div className="ws-col ws-col--right">
            <DetailPanel
              report={report}
              change={selectedChange}
              node={selectedNode}
              selectedProcessId={selectedProcessId}
              onSelectProcess={setSelectedProcessId}
              onSelectNode={selectImpactNode}
              onCollapse={() => setRightOpen(false)}
            />
          </div>
        ) : (
          <button
            type="button"
            className="rail rail--right"
            onClick={() => setRightOpen(true)}
            title={t('detail.title')}
          >
            <ChevronIcon />
            <span className="rail__label">{t('detail.title')}</span>
          </button>
        )}
      </div>

      {loadError ? (
        <div className="app__toast" role="alert">
          <WarningIcon className="notice__icon" />
          <span className="mono">{loadError}</span>
          <button type="button" className="btn btn--sm" onClick={() => setLoadError(null)}>
            {t('common.less')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <Workspace />
    </I18nProvider>
  );
}
