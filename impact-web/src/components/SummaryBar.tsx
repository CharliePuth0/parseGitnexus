import type { ReleaseImpactReport } from '../types/report';
import type { ImportIssue } from '../lib/report';
import type { TKey } from '../lib/i18n';
import { useT } from '../lib/i18n';
import { reportRiskCode } from '../lib/risk';
import { formatDateTime, formatNumber, orDash } from '../lib/format';
import { RiskBadge } from './RiskBadge';
import { DirectionArrow, InfoIcon, WarningIcon } from './icons';

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">
        {value}
        {sub ? <span className="stat__sub">{sub}</span> : null}
      </span>
    </div>
  );
}

function indexLabelKey(status: string): TKey {
  const key = `index.${status}` as TKey;
  return (['index.current', 'index.behind', 'index.diverged', 'index.unknown'] as TKey[]).includes(key)
    ? key
    : 'index.unknown';
}

const ISSUE_KEYS: Record<ImportIssue['code'], TKey> = {
  missingMeta: 'issue.missingMeta',
  missingSummary: 'issue.missingSummary',
  missingChanges: 'issue.missingChanges',
  missingProcesses: 'issue.missingProcesses',
  missingLlm: 'issue.missingLlm',
  riskOutOfContract: 'issue.riskOutOfContract',
  changeTypeOutOfContract: 'issue.changeTypeOutOfContract',
  derivedTestFlag: 'issue.derivedTestFlag',
  reordered: 'issue.reordered',
  duplicateUid: 'issue.duplicateUid',
};

/**
 * 摘要条:仓库 / 基线 → 目标 / 生成时间,右侧是指标与整体风险。
 * 指标值走 proportional figures(独立大数字),表格列才用 tabular-nums。
 */
export function SummaryBar({
  report,
  issues,
}: {
  report: ReleaseImpactReport;
  issues: readonly ImportIssue[];
}) {
  const t = useT();
  const { meta, summary } = report;
  const risk = reportRiskCode(report);
  const analyzed = formatNumber(summary.analyzedSymbols);
  const declared = formatNumber(summary.changedSymbols);

  return (
    <section className="summary" aria-label={t('app.subtitle')}>
      <div className="summary__main">
        <div className="summary__identity">
          <h1 className="summary__repo ellipsis" title={orDash(meta.repoPath || meta.repo)}>
            {orDash(meta.repo)}
          </h1>
          <div className="summary__refs">
            <span className="summary__ref mono">
              {orDash(meta.baseRef)}
              {meta.baseSha ? (
                <span className="summary__sha"> · {meta.baseSha.slice(0, 7)}</span>
              ) : null}
            </span>
            <DirectionArrow direction="flat" className="summary__arrow" />
            <span className="summary__ref summary__ref--head mono">
              {orDash(meta.headRef)}
              {meta.headSha ? (
                <span className="summary__sha"> · {meta.headSha.slice(0, 7)}</span>
              ) : null}
            </span>
          </div>
          <div className="summary__meta">
            <span>
              {t('summary.generatedAt')} {formatDateTime(meta.generatedAt)}
            </span>
            <span className="summary__dot" aria-hidden="true" />
            <span className={`summary__index summary__index--${meta.indexStatus}`}>
              {t(indexLabelKey(meta.indexStatus))}
            </span>
            {meta.version ? (
              <>
                <span className="summary__dot" aria-hidden="true" />
                <span>
                  {t('detail.version')} v{meta.version}
                </span>
              </>
            ) : null}
          </div>
        </div>

        <div className="summary__stats">
          <StatTile label={t('summary.files')} value={formatNumber(summary.changedFiles)} />
          <StatTile
            label={t('summary.symbols')}
            value={declared}
            sub={`${t('summary.analyzed')} ${analyzed}`}
          />
          <StatTile label={t('summary.processes')} value={formatNumber(summary.affectedProcesses)} />
          <div className="stat stat--risk">
            <span className="stat__label">{t('summary.risk')}</span>
            <RiskBadge risk={risk} large showCode />
          </div>
        </div>
      </div>

      {summary.truncated ||
      meta.worktreeDirty ||
      meta.indexStatus === 'behind' ||
      meta.indexStatus === 'diverged' ? (
        <div className="summary__notices">
          {meta.worktreeDirty ? (
            <div className="notice">
              <WarningIcon className="notice__icon" />
              <span>
                {t('summary.worktreeDirty')
                  .replace('{count}', String(meta.dirtyCount ?? '?'))
                  .replace('{base}', orDash(meta.baseRef))}
              </span>
            </div>
          ) : null}
          {summary.truncated ? (
            <div className="notice">
              <WarningIcon className="notice__icon" />
              <span>{t('summary.truncated')}</span>
            </div>
          ) : null}
          {meta.indexStatus === 'behind' || meta.indexStatus === 'diverged' ? (
            <div className="notice">
              <WarningIcon className="notice__icon" />
              <span>{t('index.staleHint')}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {issues.length > 0 ? (
        <details className="disclosure summary__issues">
          <summary>
            <InfoIcon className="summary__issueIcon" />
            {t('issue.title')}
            <span className="panel__count">{issues.length}</span>
          </summary>
          <div className="disclosure__body">
            <ul className="summary__issueList">
              {issues.map((issue, index) => (
                <li key={`${issue.code}-${issue.detail ?? index}`}>
                  {t(ISSUE_KEYS[issue.code])}
                  {issue.detail ? <span className="mono summary__issueDetail">{issue.detail}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}
    </section>
  );
}
