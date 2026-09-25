import { useState } from 'react';
import type { ImpactNode } from '../types/report';
import { useT } from '../lib/i18n';
import { confidenceRatio, formatConfidence, splitPath } from '../lib/format';
import { DirectionArrow } from './icons';

const COLLAPSE_AT = 8;

function ConfidenceCell({ confidence }: { confidence: number | null }) {
  const ratio = confidenceRatio(confidence);
  return (
    <span className="conf" title={formatConfidence(confidence)}>
      <span className="conf__track">
        <span
          className={`conf__fill${ratio === null ? ' conf__fill--unknown' : ''}`}
          style={ratio === null ? undefined : { width: `${Math.round(ratio * 100)}%` }}
        />
      </span>
      <span className="conf__value">{formatConfidence(confidence)}</span>
    </span>
  );
}

function sortNodes(nodes: readonly ImpactNode[]): ImpactNode[] {
  return [...nodes].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const byConfidence = (b.confidence ?? -1) - (a.confidence ?? -1);
    if (byConfidence !== 0) return byConfidence;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

/**
 * 上游 / 下游关系表。列刻意压到三列:名称(带文件名)、关系(含层级)、置信度条 ——
 * 右栏只有 ~380px,再宽的表格只会牺牲可读性。
 */
export function ImpactTable({
  nodes,
  direction,
  emptyHint,
  selectedUid,
  onSelectNode,
}: {
  nodes: readonly ImpactNode[];
  direction: 'upstream' | 'downstream';
  emptyHint: string;
  selectedUid: string | null;
  onSelectNode: (node: ImpactNode) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const sorted = sortNodes(nodes);
  const shown = expanded ? sorted : sorted.slice(0, COLLAPSE_AT);

  if (sorted.length === 0) {
    return <p className="muted impact__empty">{emptyHint}</p>;
  }

  return (
    <div className="impact">
      <table className="tbl impact__tbl">
        <thead>
          <tr>
            <th>{t('detail.col.name')}</th>
            <th>{t('detail.col.relation')}</th>
            <th className="impact__confHead">{t('detail.col.confidence')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((node) => (
            <tr
              key={`${direction}-${node.uid}-${node.depth}`}
              className={`impact__row${node.uid === selectedUid ? ' impact__row--on' : ''}`}
              onClick={() => onSelectNode(node)}
              title={node.filePath}
            >
              <td>
                <div className="impact__name ellipsis">{node.name}</div>
                <div className="impact__path mono ellipsis">{splitPath(node.filePath).base || '—'}</div>
              </td>
              <td className="cell-num">
                <span className="impact__depth">d{node.depth}</span>
                <span className="impact__rel mono">{node.relationType || '—'}</span>
              </td>
              <td>
                <ConfidenceCell confidence={node.confidence} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="impact__foot">
        <span className="muted tnum">
          <DirectionArrow direction={direction} className="impact__dir" />
          {sorted.length}
        </span>
        {sorted.length > COLLAPSE_AT ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setExpanded(!expanded)}>
            {expanded ? t('detail.collapse') : `${t('detail.showAll')} (${sorted.length})`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
