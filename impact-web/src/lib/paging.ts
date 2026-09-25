/**
 * report.processes 在真实仓库里可以有几百条,一次性挂到 DOM 上会让右栏滚动发涩。
 * 用「按需追加」的分页:先给一屏,用户点一次多给一屏 —— 比虚拟列表简单,
 * 也比静默截断诚实(剩余条数始终可见)。
 */
export const PAGE_SIZE = 20;

export interface PageSlice<T> {
  visible: T[];
  /** 还没显示的条数 */
  remaining: number;
  hasMore: boolean;
}

export function pageSlice<T>(items: readonly T[], limit: number): PageSlice<T> {
  const requested = Number.isFinite(limit) ? Math.trunc(limit) : PAGE_SIZE;
  const safeLimit = Math.min(Math.max(1, requested), items.length);
  return {
    visible: items.slice(0, safeLimit),
    remaining: items.length - safeLimit,
    hasMore: safeLimit < items.length,
  };
}
