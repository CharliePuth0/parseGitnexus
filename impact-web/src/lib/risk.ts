import type { ChangeEntry, Epistemic, ReleaseImpactReport, RiskCode, RiskLevel } from '../types/report';
import { RISK_CODES } from '../types/report';

/**
 * 风险序 CRITICAL(4) > HIGH(3) > MEDIUM(2) > LOW(1) > UNKNOWN(0)。
 * 无法识别的取值排在最后(-1)——它比 UNKNOWN 更不可信,不能被当成「已评估」。
 */
const RISK_RANK: Record<RiskCode, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  UNKNOWN: 0,
};

const UNPARSED_RANK = -1;

/** 把任意输入收敛成 RiskCode;非法值 → UNKNOWN(调用方可用 riskRank 区分「垃圾输入」)。 */
export function normalizeRisk(raw: unknown): RiskCode {
  if (typeof raw !== 'string') return 'UNKNOWN';
  const upper = raw.trim().toUpperCase();
  return (RISK_CODES as readonly string[]).includes(upper) ? (upper as RiskCode) : 'UNKNOWN';
}

/** 是否是一个契约内合法的 risk 取值(用于校验报告)。 */
export function isKnownRisk(raw: unknown): boolean {
  return typeof raw === 'string' && (RISK_CODES as readonly string[]).includes(raw.trim().toUpperCase());
}

export function riskRank(raw: unknown): number {
  if (typeof raw !== 'string') return UNPARSED_RANK;
  const code = raw.trim().toUpperCase() as RiskCode;
  return code in RISK_RANK ? RISK_RANK[code] : UNPARSED_RANK;
}

/** 小写 risk level(摘要用)→ RiskCode 颜色与序保持一致。 */
export function riskLevelToCode(level: string | undefined): RiskCode {
  return normalizeRisk(level);
}

/**
 * 按风险降序排序,**不改动入参**。次级键为 filePath → startLine → name,
 * 让同一个文件里的变更相邻出现,便于评审者成组阅读。
 */
export function sortChangesByRisk(changes: readonly ChangeEntry[]): ChangeEntry[] {
  return [...changes].sort((a, b) => {
    const byRisk = riskRank(b.impact?.risk) - riskRank(a.impact?.risk);
    if (byRisk !== 0) return byRisk;
    const byPath = compareText(a.filePath, b.filePath);
    if (byPath !== 0) return byPath;
    const byLine = (a.startLine ?? Number.MAX_SAFE_INTEGER) - (b.startLine ?? Number.MAX_SAFE_INTEGER);
    if (byLine !== 0) return byLine;
    return compareText(a.name, b.name);
  });
}

function compareText(a: string | null | undefined, b: string | null | undefined): number {
  const left = (a ?? '').toLowerCase();
  const right = (b ?? '').toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** 报告整体风险:优先取 summary.riskLevel,缺失时用 changes 的最高风险兜底。 */
export function reportRiskCode(report: ReleaseImpactReport): RiskCode {
  const declared = report.summary?.riskLevel;
  if (typeof declared === 'string' && declared.trim() !== '') return riskLevelToCode(declared);
  let best: RiskCode = 'UNKNOWN';
  for (const change of report.changes) {
    if (riskRank(change.impact?.risk) > riskRank(best)) best = normalizeRisk(change.impact?.risk);
  }
  return best;
}

export const EPISTEMICS: readonly Epistemic[] = ['exact', 'lower-bound', 'unknown'];

export function normalizeEpistemic(raw: unknown): Epistemic {
  return typeof raw === 'string' && (EPISTEMICS as readonly string[]).includes(raw)
    ? (raw as Epistemic)
    : 'unknown';
}

export const RISK_LEVELS: readonly RiskLevel[] = ['critical', 'high', 'medium', 'low', 'unknown'];
