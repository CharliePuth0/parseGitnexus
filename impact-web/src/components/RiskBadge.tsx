import type { RiskCode } from '../types/report';
import { normalizeRisk } from '../lib/risk';
import { useT } from '../lib/i18n';
import { RiskMark } from './icons';

/**
 * 风险徽章:图形 + 颜色 + 中文标签三重编码。大号额外带上契约里的英文码,
 * 方便跟 CLI 输出(report.json / impact 结果)对上。
 */
export function RiskBadge({
  risk,
  large = false,
  showCode = false,
}: {
  risk: RiskCode | string | undefined;
  large?: boolean;
  showCode?: boolean;
}) {
  const t = useT();
  const code = normalizeRisk(risk);
  const label = t(`risk.${code}`);
  return (
    <span
      className={large ? 'badge badge--lg' : 'badge'}
      data-risk={code}
      title={`${code} · ${label}`}
    >
      <RiskMark risk={code} />
      {showCode && large ? <span className="badge__code mono">{code}</span> : null}
      <span className="badge__label">{label}</span>
    </span>
  );
}
