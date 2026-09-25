import { useEffect, useRef } from 'react';
import type { ChangeEntry, RiskCode } from '../types/report';
import { RISK_CODES } from '../types/report';
import type { ChangeFilter } from '../lib/filter';
import { DEFAULT_FILTER, toggleRisk } from '../lib/filter';
import { useT } from '../lib/i18n';
import { formatLocation, formatNumber } from '../lib/format';
import { RiskBadge } from './RiskBadge';
import { ChangeTypeTag } from './ChangeTypeTag';
import { ChevronIcon, CloseIcon, DirectionArrow, SearchIcon } from './icons';
import './list.css';

function ChangeRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ChangeEntry;
  selected: boolean;
  onSelect: (uid: string) => void;
}) {
  const t = useT();
  const risk = entry.impact?.risk ?? 'UNKNOWN';
  const upstream = entry.impact?.upstream?.length ?? 0;
  const downstream = entry.impact?.downstream?.length ?? 0;
  const location = formatLocation(entry.filePath, entry.startLine);

  return (
    <button
      type="button"
      className={`crow${selected ? ' crow--selected' : ''}`}
      data-risk={risk}
      data-uid={entry.uid}
      aria-pressed={selected}
      onClick={() => onSelect(entry.uid)}
      title={entry.filePath}
    >
      <span className="crow__rail" aria-hidden="true" />
      <span className="crow__body">
        <span className="crow__top">
          <span className="crow__name ellipsis">{entry.name}</span>
          <ChangeTypeTag type={entry.changeType} />
          {entry.isTestFile ? <span className="tag crow__test">{t('list.testTag')}</span> : null}
          <RiskBadge risk={risk} />
        </span>
        <span className="crow__bottom">
          <span className="crow__path mono ellipsis">{location}</span>
          <span className="crow__counts tnum">
            <span className="crow__count crow__count--up">
              <DirectionArrow direction="upstream" />
              {upstream}
            </span>
            <span className="crow__count crow__count--down">
              <DirectionArrow direction="downstream" />
              {downstream}
            </span>
          </span>
        </span>
      </span>
    </button>
  );
}

export function ChangeListPanel({
  visible,
  counts,
  total,
  hiddenTestCount,
  filter,
  onFilterChange,
  selectedUid,
  onSelect,
  onCollapse,
}: {
  visible: readonly ChangeEntry[];
  counts: Record<RiskCode, number>;
  total: number;
  hiddenTestCount: number;
  filter: ChangeFilter;
  onFilterChange: (next: ChangeFilter) => void;
  selectedUid: string | null;
  onSelect: (uid: string) => void;
  onCollapse: () => void;
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);

  // 从图上选中节点时,把对应行滚进视野
  useEffect(() => {
    if (!selectedUid || !listRef.current) return;
    const node = listRef.current.querySelector(`[data-uid="${CSS.escape(selectedUid)}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [selectedUid]);

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">{t('list.title')}</span>
        <span className="panel__count tnum">
          {t('list.shown')} {visible.length}/{total}
        </span>
        <span className="panel__spacer" />
        <span className="panel__count">{t('list.sortedByRisk')}</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCollapse} title={t('list.collapse')}>
          <ChevronIcon />
        </button>
      </div>

      <div className="filters">
        <div className="filters__search">
          <SearchIcon className="filters__searchIcon" />
          <input
            type="search"
            className="filters__input"
            value={filter.query}
            placeholder={t('list.search')}
            onChange={(event) => onFilterChange({ ...filter, query: event.target.value })}
          />
          {filter.query ? (
            <button
              type="button"
              className="filters__clear"
              onClick={() => onFilterChange({ ...filter, query: '' })}
              aria-label={t('common.all')}
            >
              <CloseIcon />
            </button>
          ) : null}
        </div>

        <div className="filters__chips" role="group">
          <button
            type="button"
            className="chip"
            aria-pressed={filter.risks.length === 0}
            onClick={() => onFilterChange({ ...filter, risks: [] })}
          >
            {t('common.all')}
          </button>
          {RISK_CODES.map((code) => (
            <button
              key={code}
              type="button"
              className="chip chip--risk"
              data-risk={code}
              aria-pressed={filter.risks.includes(code)}
              onClick={() => onFilterChange({ ...filter, risks: toggleRisk(filter.risks, code) })}
              title={`${code} · ${t(`risk.${code}`)}`}
            >
              <span className="chip__dot" aria-hidden="true" />
              {t(`risk.${code}`)}
              <span className="chip__count">{counts[code] ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="filters__row">
          {/* 引擎会预过滤测试符号,isTestFile 通常全为 false —— 开关保留(未来回归用),
              但没有任何测试文件时给一句解释,免得用户以为筛选坏了 */}
          <label className="toggle" title={hiddenTestCount === 0 ? t('list.hideTests.none') : undefined}>
            <input
              type="checkbox"
              checked={filter.hideTests}
              onChange={(event) => onFilterChange({ ...filter, hideTests: event.target.checked })}
            />
            <span>
              {t('list.hideTests')}
              {hiddenTestCount > 0 ? <span className="toggle__count tnum"> {hiddenTestCount}</span> : null}
            </span>
          </label>
          {filter.query || filter.risks.length > 0 || filter.hideTests !== DEFAULT_FILTER.hideTests ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onFilterChange({ ...DEFAULT_FILTER })}
            >
              {t('list.reset')}
            </button>
          ) : null}
        </div>
      </div>

      <div className="panel__body" ref={listRef}>
        {visible.length === 0 ? (
          <div className="empty">
            <span className="empty__title">{t('list.empty')}</span>
            <span className="empty__hint">{t('list.emptyHint')}</span>
          </div>
        ) : (
          <ul className="crow-list">
            {visible.map((entry) => (
              <li key={entry.uid}>
                <ChangeRow entry={entry} selected={entry.uid === selectedUid} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        )}
        {visible.length > 0 ? (
          <div className="crow-list__footer muted tnum">
            {formatNumber(visible.length)} / {formatNumber(total)}
          </div>
        ) : null}
      </div>
    </div>
  );
}
