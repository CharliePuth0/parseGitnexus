import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { SymbolFlowNode } from '../lib/graph';
import { formatConfidence } from '../lib/format';
import { KindGlyph, RiskMark } from './icons';

/**
 * 图上的符号节点。刻意做窄:标签只有名字,文件路径与置信度走 title 提示,
 * 风险只由**边框颜色**承担,方向由左侧竖条承担 —— 一个标记只表达一件事。
 */
function SymbolNodeImpl({ data }: NodeProps<SymbolFlowNode>) {
  const roleClass =
    data.role === 'upstream'
      ? ' sn--up'
      : data.role === 'downstream'
        ? ' sn--down'
        : data.role === 'anchor'
          ? ' sn--anchor'
          : '';

  const tooltipParts = [
    data.filePath || '(无文件路径)',
    `置信度 ${formatConfidence(data.confidence)}`,
  ];
  if (data.relationType) tooltipParts.push(`关系 ${data.relationType}`);
  tooltipParts.push(data.depth > 0 ? `深度 ${data.depth}` : '变更符号(锚点)');

  return (
    <div
      className={`sn${roleClass}${data.selected ? ' sn--selected' : ''}${
        data.isChange && !data.isAnchor ? ' sn--change' : ''
      }`}
      data-risk={data.risk ?? 'none'}
      title={tooltipParts.join('\n')}
    >
      <Handle type="target" position={Position.Left} className="sn__handle" />
      <span className="sn__rail" aria-hidden="true" />
      <KindGlyph kind={data.kind} />
      <span className="sn__label ellipsis">{data.label}</span>
      {data.risk ? (
        <RiskMark risk={data.risk} className="sn__risk" />
      ) : (
        <span className="sn__risk sn__risk--none" aria-hidden="true">
          ·
        </span>
      )}
      <Handle type="source" position={Position.Right} className="sn__handle" />
    </div>
  );
}

export const SymbolNode = memo(SymbolNodeImpl);
