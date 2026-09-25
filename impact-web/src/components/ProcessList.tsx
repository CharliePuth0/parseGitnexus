import { useEffect, useState } from 'react';
import type { ProcessEntry } from '../types/report';
import { PAGE_SIZE, pageSlice } from '../lib/paging';
import { useT } from '../lib/i18n';
import { FlowIcon } from './icons';

/**
 * 受影响流程列表。与当前选中符号相关的流程会被标记,方便先看重点。
 * 真实报告的 processes 可以有几百条,所以按需追加而不是一次全渲染;
 * 剩余条数始终显示 —— 是分页,不是截断。
 */
export function ProcessList({
  processes,
  relatedIds,
  selectedId,
  onSelect,
}: {
  processes: readonly ProcessEntry[];
  relatedIds: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const t = useT();
  const [limit, setLimit] = useState(PAGE_SIZE);

  // 换锚点 / 切「全部 ↔ 相关」筛选时,列表换了内容就回到第一屏,避免停在一个意外的位置
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [processes]);

  if (processes.length === 0) {
    return <p className="muted process__empty">{t('process.empty')}</p>;
  }

  const { visible, remaining, hasMore } = pageSlice(processes, limit);

  return (
    <>
      <ul className="process">
        {visible.map((process) => {
          const related = relatedIds.has(process.id);
          const open = selectedId === process.id;
          return (
            <li key={process.id}>
              <button
                type="button"
                className={`process__row${open ? ' process__row--open' : ''}${
                  related ? ' process__row--related' : ''
                }`}
                aria-expanded={open}
                onClick={() => onSelect(open ? null : process.id)}
              >
                <span className="process__head">
                  <FlowIcon className="process__icon" />
                  <span className="process__id mono ellipsis">{process.id}</span>
                  {related ? <span className="tag process__tag">{t('process.related')}</span> : null}
                  <span className="process__steps tnum">
                    {process.stepCount} {t('process.steps')}
                  </span>
                </span>
                <span className={`process__summary${open ? '' : ' process__summary--clamp'}`}>
                  {process.summary || '—'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="process__more">
        <span className="muted tnum">
          {visible.length} / {processes.length}
        </span>
        {hasMore ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setLimit((current) => current + PAGE_SIZE)}
          >
            {t('process.showMore')}
            <span className="tnum"> +{Math.min(PAGE_SIZE, remaining)}</span>
          </button>
        ) : null}
      </div>
    </>
  );
}
