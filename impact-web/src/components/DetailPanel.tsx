import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChangeEntry, ImpactNode, ReleaseImpactReport } from '../types/report';
import type { TKey } from '../lib/i18n';
import { useT } from '../lib/i18n';
import { formatDateTime, formatNumber, orDash, splitPath } from '../lib/format';
import { normalizeEpistemic } from '../lib/risk';
import { hasCapBoundary, orderBoundaries } from '../lib/changes';
import { RiskBadge } from './RiskBadge';
import { ChangeTypeTag } from './ChangeTypeTag';
import { ImpactTable } from './ImpactTable';
import { ProcessList } from './ProcessList';
import { NarrativeSection } from './NarrativeSection';
import { ChevronIcon, InfoIcon, KindGlyph, WarningIcon } from './icons';
import './detail.css';

const EPISTEMIC_KEYS: Record<string, { label: TKey; hint: TKey }> = {
  exact: { label: 'epistemic.exact', hint: 'epistemic.exact.hint' },
  'lower-bound': { label: 'epistemic.lower-bound', hint: 'epistemic.lower-bound.hint' },
  unknown: { label: 'epistemic.unknown', hint: 'epistemic.unknown.hint' },
};

/** 受影响流程 chip 的折叠阈值:超过就只显示前 N 个 + 「展开剩余」。 */
const CHIP_LIMIT = 12;

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="panel__section">
      <h2 className="section__title">
        {title}
        {typeof count === 'number' ? <span className="section__count">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

function ChangeDetail({
  change,
  onSelectNode,
  onSelectProcess,
}: {
  change: ChangeEntry;
  onSelectNode: (node: ImpactNode) => void;
  onSelectProcess: (id: string | null) => void;
}) {
  const t = useT();
  const impact = change.impact;
  const epistemic = EPISTEMIC_KEYS[normalizeEpistemic(impact.epistemic)] ?? EPISTEMIC_KEYS['unknown'];
  const location = change.filePath
    ? `${change.filePath}${change.startLine ? `:${change.startLine}${change.endLine && change.endLine !== change.startLine ? `-${change.endLine}` : ''}` : ''}`
    : '—';

  const boundaries = orderBoundaries(impact.boundaries);
  const capped = hasCapBoundary(impact.boundaries);
  const [allProcesses, setAllProcesses] = useState(false);
  // 引擎对 affectedProcesses 的上限可以到 50,一次全铺出来会把下面的表格顶出屏幕
  const processChips = allProcesses
    ? impact.affectedProcesses
    : impact.affectedProcesses.slice(0, CHIP_LIMIT);

  return (
    <>
      <section className="panel__section detail__head">
        <div className="detail__titleRow">
          <KindGlyph kind={change.kind} large />
          <h2 className="detail__name">{change.name}</h2>
          <ChangeTypeTag type={change.changeType} />
          <RiskBadge risk={impact.risk} large showCode />
        </div>
        <div className="detail__sub mono ellipsis" title={location}>
          {location}
        </div>
      </section>

      <Section title={t('detail.risk')}>
        <dl className="kv">
          <dt className="kv__k">{t('detail.kind')}</dt>
          <dd className="kv__v">{change.kind || '—'}</dd>
          <dt className="kv__k">{t('detail.changeType')}</dt>
          {/* kv 给字段原值(修改也要有值),角标只在标题行承担「高信号」职责 */}
          <dd className="kv__v">
            {change.changeType ? (
              <>
                {t(`changeType.${change.changeType}`)}
                {/* 文件级语义必须写出来,否则会被读成「这个符号被删/被加」 */}
                <span className="detail__hint">{t('detail.changeTypeHint')}</span>
              </>
            ) : (
              <span className="muted">{t('common.dash')}</span>
            )}
          </dd>
          <dt className="kv__k">{t('detail.epistemic')}</dt>
          <dd className="kv__v">
            <span className="tag">{t(epistemic.label)}</span>
            <span className="detail__hint">{t(epistemic.hint)}</span>
          </dd>
          <dt className="kv__k">{t('detail.uid')}</dt>
          <dd className="kv__v mono detail__uid" title={change.uid}>
            {change.uid}
          </dd>
        </dl>

        <h3 className="detail__subTitle">{t('detail.boundaries')}</h3>
        {boundaries.length === 0 ? (
          <p className="muted detail__hint">{t('detail.boundaries.none')}</p>
        ) : (
          <>
            {/* 截断声明改变的是「下面的数字怎么读」,先说清楚,再列条目 */}
            {capped ? (
              <p className="detail__capHint">
                <InfoIcon className="notice__icon" />
                <span>{t('detail.boundaryCapHint')}</span>
              </p>
            ) : null}
            <ul className="detail__boundaries">
              {boundaries.map((boundary) => (
                <li key={boundary.text} className="notice detail__boundary">
                  <WarningIcon className="notice__icon" />
                  <span>
                    {boundary.cap ? <span className="tag tag--warn detail__capTag">{t('detail.boundaryCap')}</span> : null}
                    {boundary.text}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title={t('detail.modules')} count={impact.affectedModules.length}>
        {impact.affectedModules.length === 0 ? (
          <p className="muted detail__hint">{t('detail.none')}</p>
        ) : (
          <div className="chips">
            {impact.affectedModules.map((module) => (
              <span key={module} className="tag">
                {module}
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('detail.affectedProcesses')} count={impact.affectedProcesses.length}>
        {impact.affectedProcesses.length === 0 ? (
          <p className="muted detail__hint">{t('detail.none')}</p>
        ) : (
          <>
            <div className="chips">
              {processChips.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="tag tag--button mono"
                  onClick={() => onSelectProcess(id)}
                >
                  {id}
                </button>
              ))}
            </div>
            {impact.affectedProcesses.length > CHIP_LIMIT ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm detail__moreChips"
                onClick={() => setAllProcesses((open) => !open)}
              >
                {allProcesses
                  ? t('detail.collapse')
                  : `${t('detail.moreOf')} ${impact.affectedProcesses.length - CHIP_LIMIT}`}
              </button>
            ) : null}
          </>
        )}
      </Section>

      {impact.intraProcedural ? (
        <Section
          title={t('detail.intraProcedural')}
          count={impact.intraProcedural.guards.length + impact.intraProcedural.flows.length}
        >
          {!impact.intraProcedural.pdgLayer ? (
            <p className="muted detail__hint">{t('detail.intraNoPdg')}</p>
          ) : impact.intraProcedural.guards.length === 0 &&
            impact.intraProcedural.flows.length === 0 ? (
            <p className="muted detail__hint">{t('detail.none')}</p>
          ) : (
            <>
              {impact.intraProcedural.guards.length > 0 ? (
                <>
                  <h4 className="detail__subtitle">{t('detail.intraGuards')}</h4>
                  <ul className="guardList">
                    {impact.intraProcedural.guards.map((guard, index) => (
                      <li key={`${guard.controllerLine}-${guard.line}-${index}`} className="guard">
                        <span className="guard__badge mono">{guard.label}</span>
                        <span className="guard__line mono">
                          L{guard.controllerLine}→L{guard.line}
                        </span>
                        <span className="guard__text">{guard.text}</span>
                        {guard.guard ? <span className="guard__flag">{t('detail.guardFlag')}</span> : null}
                      </li>
                    ))}
                  </ul>
                  {impact.intraProcedural.truncated?.guards ? (
                    <p className="muted detail__hint">{t('detail.intraGuardsHint')}</p>
                  ) : null}
                </>
              ) : null}
              {impact.intraProcedural.flows.length > 0 ? (
                <>
                  <h4 className="detail__subtitle">{t('detail.intraFlows')}</h4>
                  <ul className="flowList">
                    {impact.intraProcedural.flows.map((flow, index) => (
                      <li key={`${flow.variable}-${flow.defLine}-${flow.useLine}-${index}`} className="flow">
                        <span className="flow__var mono">{flow.variable}</span>
                        <span className="flow__line mono">
                          L{flow.defLine}→L{flow.useLine}
                        </span>
                        <span className="flow__text">{flow.useText}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <p className="muted detail__hint">{t('detail.intraGuardsHint')}</p>
            </>
          )}
        </Section>
      ) : null}

      <Section title={t('detail.upstream')} count={impact.upstream.length}>
        <ImpactTable
          nodes={impact.upstream}
          direction="upstream"
          emptyHint={t('detail.noUpstream')}
          selectedUid={change.uid}
          onSelectNode={onSelectNode}
        />
      </Section>

      <Section title={t('detail.downstream')} count={impact.downstream.length}>
        <ImpactTable
          nodes={impact.downstream}
          direction="downstream"
          emptyHint={t('detail.noDownstream')}
          selectedUid={change.uid}
          onSelectNode={onSelectNode}
        />
      </Section>
    </>
  );
}

function NodeDetail({ node }: { node: ImpactNode }) {
  const t = useT();
  return (
    <>
      <section className="panel__section detail__head">
        <div className="detail__titleRow">
          <KindGlyph kind={node.kind} large />
          <h2 className="detail__name">{node.name}</h2>
          <span className="tag">{t('detail.nodeOnly')}</span>
        </div>
        <div className="detail__sub mono ellipsis" title={node.filePath}>
          {node.filePath || '—'}
        </div>
      </section>

      <Section title={t('detail.risk')}>
        <div className="notice notice--info detail__nodeNote">
          <InfoIcon className="notice__icon" />
          <span>{t('detail.nodeOnlyHint')}</span>
        </div>
        <dl className="kv detail__nodeKv">
          <dt className="kv__k">{t('detail.kind')}</dt>
          <dd className="kv__v">{node.kind || '—'}</dd>
          <dt className="kv__k">{t('detail.col.depth')}</dt>
          <dd className="kv__v tnum">d{node.depth}</dd>
          <dt className="kv__k">{t('detail.col.relation')}</dt>
          <dd className="kv__v mono">{node.relationType || '—'}</dd>
          <dt className="kv__k">{t('detail.col.confidence')}</dt>
          <dd className="kv__v tnum">
            {node.confidence === null ? '—' : `${Math.round(node.confidence * 100)}%`}
          </dd>
          <dt className="kv__k">{t('detail.uid')}</dt>
          <dd className="kv__v mono detail__uid" title={node.uid}>
            {node.uid}
          </dd>
        </dl>
      </Section>
    </>
  );
}

function ReportOverview({ report }: { report: ReleaseImpactReport }) {
  const t = useT();
  const { meta, summary } = report;
  return (
    <section className="panel__section">
      <div className="empty detail__empty">
        <span className="empty__title">{t('detail.empty')}</span>
        <span className="empty__hint">{t('detail.emptyHint')}</span>
      </div>
      <h2 className="section__title">{t('detail.overview')}</h2>
      <dl className="kv">
        <dt className="kv__k">{t('summary.branch')}</dt>
        <dd className="kv__v mono">
          {orDash(meta.baseRef)} → {orDash(meta.headRef)}
        </dd>
        <dt className="kv__k">{t('detail.repoPath')}</dt>
        <dd className="kv__v mono detail__uid" title={meta.repoPath}>
          {orDash(meta.repoPath)}
        </dd>
        <dt className="kv__k">{t('summary.generatedAt')}</dt>
        <dd className="kv__v tnum">{formatDateTime(meta.generatedAt)}</dd>
        <dt className="kv__k">{t('summary.files')}</dt>
        <dd className="kv__v tnum">{formatNumber(summary.changedFiles)}</dd>
        <dt className="kv__k">{t('summary.symbols')}</dt>
        <dd className="kv__v tnum">
          {formatNumber(summary.changedSymbols)}
          <span className="muted"> · {t('summary.analyzed')} {formatNumber(summary.analyzedSymbols)}</span>
        </dd>
      </dl>
    </section>
  );
}

/**
 * 右栏:选中符号的详情在上,报告级的受影响流程与 LLM 叙事常驻在下 ——
 * 这两块不依赖选中项,评审时应该始终可见。
 */
export function DetailPanel({
  report,
  change,
  node,
  selectedProcessId,
  onSelectProcess,
  onSelectNode,
  onCollapse,
}: {
  report: ReleaseImpactReport;
  change: ChangeEntry | null;
  node: ImpactNode | null;
  selectedProcessId: string | null;
  onSelectProcess: (id: string | null) => void;
  onSelectNode: (node: ImpactNode) => void;
  onCollapse: () => void;
}) {
  const t = useT();
  const [processFilter, setProcessFilter] = useState<'all' | 'related'>('all');

  const relatedProcessIds = useMemo(
    () => new Set(change?.impact.affectedProcesses ?? []),
    [change],
  );

  const processes = useMemo(() => {
    if (processFilter === 'all' || relatedProcessIds.size === 0) return report.processes;
    return report.processes.filter((process) => relatedProcessIds.has(process.id));
  }, [report.processes, processFilter, relatedProcessIds]);

  const headLabel = change?.name ?? node?.name ?? splitPath(report.meta.repo).base;

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">{t('detail.title')}</span>
        {headLabel ? <span className="panel__count ellipsis detail__headLabel">{headLabel}</span> : null}
        <span className="panel__spacer" />
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCollapse}>
          <ChevronIcon />
        </button>
      </div>

      <div className="panel__body">
        {change ? (
          <ChangeDetail change={change} onSelectNode={onSelectNode} onSelectProcess={onSelectProcess} />
        ) : node ? (
          <NodeDetail node={node} />
        ) : (
          <ReportOverview report={report} />
        )}

        <Section title={t('process.title')} count={processes.length}>
          {relatedProcessIds.size > 0 ? (
            <div className="detail__processFilter">
              <button
                type="button"
                className="chip"
                aria-pressed={processFilter === 'all'}
                onClick={() => setProcessFilter('all')}
              >
                {t('common.all')}
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={processFilter === 'related'}
                onClick={() => setProcessFilter('related')}
              >
                {t('process.related')}
                <span className="chip__count">{relatedProcessIds.size}</span>
              </button>
            </div>
          ) : null}
          <ProcessList
            processes={processes}
            relatedIds={relatedProcessIds}
            selectedId={selectedProcessId}
            onSelect={onSelectProcess}
          />
        </Section>

        {report.taint ? (
          <Section title={t('detail.taint')} count={report.taint.findings.length}>
            {report.taint.note ? <p className="muted detail__hint">{report.taint.note}</p> : null}
            {report.taint.findings.length === 0 && !report.taint.note ? (
              <p className="muted detail__hint">{t('detail.none')}</p>
            ) : null}
            {report.taint.findings.length > 0 ? (
              <>
                <p className="muted detail__hint">{t('detail.taintHint')}</p>
                <ul className="taintList">
                  {report.taint.findings.map((finding, index) => (
                    <li
                      key={`${finding.filePath}-${finding.sourceLine}-${finding.sinkLine}-${index}`}
                      className="taint"
                    >
                      {finding.category ? (
                        <span className="taint__cat">{finding.category}</span>
                      ) : null}
                      <span className="taint__loc mono">
                        {finding.filePath}
                        {finding.sourceLine !== null ? `:${finding.sourceLine}` : ''}
                        {finding.sinkLine !== null ? `→${finding.sinkLine}` : ''}
                      </span>
                      {finding.interprocedural ? (
                        <span className="taint__flag">{t('detail.taintInter')}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Section>
        ) : null}

        <Section title={t('llm.title')}>
          <NarrativeSection llm={report.llm} />
        </Section>
      </div>
    </div>
  );
}
