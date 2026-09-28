import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type ReactFlowInstance,
} from '@xyflow/react';
import { RISK_CODES } from '../types/report';
import type { GraphBuild, SymbolNodeData } from '../lib/graph';
import { MAX_OVERVIEW_NODES } from '../lib/graph';
import { useT } from '../lib/i18n';
import { RiskMark } from './icons';
import { SymbolNode } from './SymbolNode';
import './graph.css';

const nodeTypes = { symbol: SymbolNode };

export type GraphMode = 'overview' | 'anchor' | 'focus';

export function GraphPanel({
  build,
  mode,
  anchorLabel,
  depth,
  maxDepth,
  onDepthChange,
  showLabels,
  onToggleLabels,
  includeNeighbors,
  onToggleNeighbors,
  onResetAnchor,
  selectedUid,
  onNodeSelect,
}: {
  build: GraphBuild;
  mode: GraphMode;
  anchorLabel: string | null;
  /** null = 不限深度(全部展开) */
  depth: number | null;
  maxDepth: number;
  onDepthChange: (depth: number | null) => void;
  showLabels: boolean;
  onToggleLabels: (next: boolean) => void;
  includeNeighbors: boolean;
  onToggleNeighbors: (next: boolean) => void;
  onResetAnchor: () => void;
  selectedUid: string | null;
  onNodeSelect: (data: SymbolNodeData) => void;
}) {
  const t = useT();
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null);
  const timer = useRef<number | null>(null);

  const nodes = useMemo(
    () =>
      build.nodes.map((node) => ({
        ...node,
        data: { ...node.data, selected: node.data.uid === selectedUid },
      })),
    [build.nodes, selectedUid],
  );

  const edges = useMemo<Edge[]>(() => build.edges, [build.edges]);

  // 锚点 / 深度 / 节点集变化后重新取景(等一帧让节点量出尺寸)
  const fitKey = `${mode}:${anchorLabel ?? ''}:${depth}:${includeNeighbors}:${nodes.length}`;
  useEffect(() => {
    if (!instance) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void instance.fitView({ padding: 0.22, duration: 260, maxZoom: 1.1 });
    }, 60);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [instance, fitKey]);

  const showDepth = mode !== 'overview';
  const empty = nodes.length === 0;
  const noEdges = !empty && edges.length === 0 && nodes.length > 1;

  return (
    <div className="panel graph">
      <div className="panel__head graph__head">
        <span className="panel__title">{t('graph.title')}</span>
        <span className="tag">{mode === 'overview' ? t('graph.mode.overview') : t('graph.mode.anchor')}</span>
        {anchorLabel ? <span className="graph__anchor ellipsis mono">{anchorLabel}</span> : null}

        {showDepth ? (
          <div className="slider" title={t('graph.depth')}>
            <span className="slider__label">{t('graph.depth')}</span>
            <input
              type="range"
              min={1}
              max={maxDepth}
              step={1}
              value={depth ?? maxDepth}
              disabled={depth === null}
              onChange={(event) => onDepthChange(Number(event.target.value))}
            />
            <span className="slider__value tnum">{depth ?? t('graph.depthAll')}</span>
            <button
              type="button"
              className="chip"
              aria-pressed={depth === null}
              onClick={() => onDepthChange(depth === null ? maxDepth : null)}
            >
              {t('graph.depthAll')}
            </button>
          </div>
        ) : (
          <label className="toggle toggle--sm">
            <input
              type="checkbox"
              checked={includeNeighbors}
              onChange={(event) => onToggleNeighbors(event.target.checked)}
            />
            <span>{t('graph.includeNeighbors')}</span>
          </label>
        )}

        <label className="toggle toggle--sm">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={(event) => onToggleLabels(event.target.checked)}
          />
          <span>{t('graph.labels')}</span>
        </label>

        <span className="panel__spacer" />

        <span className="panel__count tnum">
          {nodes.length} {t('graph.nodes')} · {edges.length} {t('graph.edges')}
        </span>
        {mode !== 'overview' ? (
          <button type="button" className="btn btn--sm" onClick={onResetAnchor}>
            {t('graph.reset')}
          </button>
        ) : null}
      </div>

      <div className="graph__canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={setInstance}
          onNodeClick={(_event, node) => onNodeSelect(node.data as SymbolNodeData)}
          fitView
          fitViewOptions={{ padding: 0.22, maxZoom: 1.1 }}
          minZoom={0.15}
          maxZoom={2.5}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ type: 'smoothstep' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(255,255,255,0.07)" />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>

        <div className="legend" aria-label={t('graph.legend')}>
          <div className="legend__row">
            <span className="legend__item">
              <span className="legend__swatch legend__swatch--anchor" />
              {t('graph.legend.anchor')}
            </span>
            <span className="legend__item legend__item--up">
              <span className="legend__swatch legend__swatch--up" />
              {t('graph.legend.upstream')}
            </span>
            <span className="legend__item legend__item--down">
              <span className="legend__swatch legend__swatch--down" />
              {t('graph.legend.downstream')}
            </span>
          </div>
          <div className="legend__row legend__row--risk">
            <span className="legend__caption">{t('graph.legend.risk')}</span>
            {RISK_CODES.map((code) => (
              <span key={code} className="legend__risk" data-risk={code}>
                <RiskMark risk={code} />
                {t(`risk.${code}`)}
              </span>
            ))}
          </div>
          {build.stats.truncated ? (
            <div className="legend__note">
              {t('graph.truncated')} ({MAX_OVERVIEW_NODES})
            </div>
          ) : null}
          {noEdges ? <div className="legend__note">{t('graph.noEdges')}</div> : null}
          {showLabels && build.stats.labelsCapped ? (
            <div className="legend__note">{t('graph.labelsCapped')}</div>
          ) : null}
        </div>

        {empty ? (
          <div className="graph__empty">
            <div className="empty">
              <span className="empty__title">{t('graph.empty')}</span>
              <span className="empty__hint">{t('graph.emptyHint')}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
