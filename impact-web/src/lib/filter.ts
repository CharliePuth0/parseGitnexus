import { isTestFilePath } from 'gitnexus-shared';
import type { ChangeEntry, RiskCode } from '../types/report';
import { normalizeRisk } from './risk';

export interface ChangeFilter {
  /** 选中的风险等级(空集合 = 全不选,UI 里用「全部」重置) */
  risks: readonly RiskCode[];
  /** 按 name / filePath / kind 搜索,大小写不敏感 */
  query: string;
  /** 隐藏测试文件,契约要求默认开启 */
  hideTests: boolean;
}

export const DEFAULT_FILTER: ChangeFilter = {
  risks: [],
  query: '',
  hideTests: true,
};

/**
 * 测试文件判定:契约里的 isTestFile 优先,但也用 gitnexus-shared 的
 * isTestFilePath 兜底 —— 引擎若漏标(或路径本身就是测试路径),开关必须仍然生效。
 */
export function isTestEntry(entry: Pick<ChangeEntry, 'filePath' | 'isTestFile'>): boolean {
  return entry.isTestFile === true || isTestFilePath(entry.filePath);
}

export function matchesQuery(entry: ChangeEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const haystack = `${entry.name}\n${entry.filePath}\n${entry.kind}`.toLowerCase();
  return haystack.includes(needle);
}

export function matchesRisks(entry: ChangeEntry, risks: readonly RiskCode[]): boolean {
  if (risks.length === 0) return true;
  return risks.includes(normalizeRisk(entry.impact?.risk));
}

/** 过滤后的变更条目,保持入参顺序(调用方先按风险排序)。 */
export function filterChanges(
  changes: readonly ChangeEntry[],
  filter: ChangeFilter,
): ChangeEntry[] {
  return changes.filter(
    (entry) =>
      matchesQuery(entry, filter.query) &&
      matchesRisks(entry, filter.risks) &&
      (!filter.hideTests || !isTestEntry(entry)),
  );
}

/** 各风险等级的计数(基于隐藏测试文件之后的集合,与列表口径一致)。 */
export function countByRisk(changes: readonly ChangeEntry[]): Record<RiskCode, number> {
  const counts: Record<RiskCode, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    UNKNOWN: 0,
  };
  for (const entry of changes) counts[normalizeRisk(entry.impact?.risk)] += 1;
  return counts;
}

export function toggleRisk(risks: readonly RiskCode[], code: RiskCode): RiskCode[] {
  return risks.includes(code) ? risks.filter((r) => r !== code) : [...risks, code];
}
