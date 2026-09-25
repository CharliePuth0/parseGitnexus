import type {
  ChangeEntry,
  ChangeType,
  Impact,
  ImpactNode,
  LlmSection,
  ProcessEntry,
  ReleaseImpactReport,
  ReportMeta,
  ReportSummary,
  RiskLevel,
} from '../types/report';
import { CHANGE_TYPES } from '../types/report';
import {
  RISK_LEVELS,
  isKnownRisk,
  normalizeEpistemic,
  normalizeRisk,
  riskRank,
  sortChangesByRisk,
} from './risk';
import type { RiskCode } from '../types/report';
import { isTestFilePath } from 'gitnexus-shared';

export interface ImportIssue {
  code:
    | 'missingMeta'
    | 'missingSummary'
    | 'missingChanges'
    | 'missingProcesses'
    | 'missingLlm'
    | 'riskOutOfContract'
    | 'changeTypeOutOfContract'
    | 'derivedTestFlag'
    | 'reordered'
    | 'duplicateUid';
  /** 具体上下文(符号名 / uid),用于提示里指认 */
  detail?: string;
}

export interface NormalizeResult {
  report: ReleaseImpactReport;
  issues: ImportIssue[];
}

export type ParseResult =
  | { ok: true; report: ReleaseImpactReport; issues: ImportIssue[] }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : asString(asRecord(item)?.name ?? item)))
    .filter((item) => item !== '');
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeImpactNode(raw: unknown, fallbackDepth: number): ImpactNode | null {
  const record = asRecord(raw);
  if (!record) return null;
  const uid = asString(record.uid);
  const name = asString(record.name, uid);
  if (uid === '' && name === '') return null;
  return {
    depth: Math.max(1, Math.trunc(asNumber(record.depth, fallbackDepth))),
    uid: uid === '' ? `unknown:${name}` : uid,
    name: name === '' ? uid : name,
    kind: asString(record.kind, 'Unknown'),
    filePath: asString(record.filePath),
    relationType: asString(record.relationType, 'UNKNOWN'),
    confidence:
      typeof record.confidence === 'number' && Number.isFinite(record.confidence)
        ? record.confidence
        : null,
  };
}

function normalizeImpactNodes(value: unknown): ImpactNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: ImpactNode[] = [];
  for (const item of value) {
    const node = normalizeImpactNode(item, 1);
    if (node) nodes.push(node);
  }
  return nodes;
}

function normalizeImpact(raw: unknown, issues: ImportIssue[], name: string): Impact {
  const record = asRecord(raw) ?? {};
  if (!isKnownRisk(record.risk)) issues.push({ code: 'riskOutOfContract', detail: name });
  return {
    risk: normalizeRisk(record.risk),
    epistemic: normalizeEpistemic(record.epistemic),
    boundaries: asStringArray(record.boundaries),
    upstream: normalizeImpactNodes(record.upstream),
    downstream: normalizeImpactNodes(record.downstream),
    affectedProcesses: asStringArray(record.affectedProcesses),
    affectedModules: asStringArray(record.affectedModules),
  };
}

function normalizeChangeType(
  value: unknown,
  issues: ImportIssue[],
  name: string,
): ChangeType | undefined {
  if (value === undefined || value === null) return undefined; // v1 报告没有这个字段,正常
  if (typeof value === 'string' && (CHANGE_TYPES as readonly string[]).includes(value)) {
    return value as ChangeType;
  }
  issues.push({ code: 'changeTypeOutOfContract', detail: name });
  return undefined;
}

function normalizeChange(raw: unknown, issues: ImportIssue[], index: number): ChangeEntry {
  const record = asRecord(raw) ?? {};
  const name = asString(record.name, asString(record.uid, `#${index + 1}`));
  const filePath = asString(record.filePath);
  const declaredTest = record.isTestFile === true;
  if (!declaredTest && !('isTestFile' in record) && isTestFilePath(filePath)) {
    issues.push({ code: 'derivedTestFlag', detail: name });
  }
  const changeType = normalizeChangeType(record.changeType, issues, name);
  return {
    uid: asString(record.uid, `${filePath}#${name}`),
    name,
    kind: asString(record.kind, 'Unknown'),
    filePath,
    startLine: asOptionalNumber(record.startLine),
    endLine: asOptionalNumber(record.endLine),
    isTestFile: declaredTest || isTestFilePath(filePath),
    ...(changeType ? { changeType } : {}),
    impact: normalizeImpact(record.impact, issues, name),
  };
}

function normalizeMeta(raw: unknown): ReportMeta {
  const record = asRecord(raw) ?? {};
  return {
    version: asNumber(record.version, 1),
    repo: asString(record.repo),
    repoPath: asString(record.repoPath),
    baseRef: asString(record.baseRef),
    headRef: asString(record.headRef),
    generatedAt: asString(record.generatedAt),
    indexStatus: asString(record.indexStatus, 'unknown'),
  };
}

function normalizeSummary(raw: unknown, changes: ChangeEntry[]): ReportSummary {
  const record = asRecord(raw) ?? {};
  const declaredLevel = asString(record.riskLevel).toLowerCase();
  const riskLevel: RiskLevel = (RISK_LEVELS as readonly string[]).includes(declaredLevel)
    ? (declaredLevel as RiskLevel)
    : 'unknown';
  const processIds = new Set<string>();
  for (const change of changes) {
    for (const id of change.impact.affectedProcesses) processIds.add(id);
  }
  const fallbackSymbols = changes.length;
  const fallbackFiles = new Set(changes.map((c) => c.filePath).filter((p) => p !== '')).size;
  return {
    changedFiles: asNumber(record.changedFiles, fallbackFiles),
    changedSymbols: asNumber(record.changedSymbols, fallbackSymbols),
    analyzedSymbols: asNumber(record.analyzedSymbols, fallbackSymbols),
    affectedProcesses: asNumber(record.affectedProcesses, processIds.size),
    riskLevel,
    truncated: record.truncated === true,
  };
}

function normalizeProcesses(raw: unknown): ProcessEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const processes: ProcessEntry[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const id = asString(record.id);
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    processes.push({
      id,
      summary: asString(record.summary),
      stepCount: asNumber(record.stepCount),
    });
  }
  return processes;
}

function normalizeLlm(raw: unknown): LlmSection {
  const record = asRecord(raw) ?? {};
  const narrative = asString(record.narrative).trim();
  const llm: LlmSection = { prompt: asString(record.prompt) };
  if (narrative !== '') llm.narrative = narrative;
  return llm;
}

/**
 * 把任意 JSON 收敛成契约结构。绝不静默丢数据:补默认值的地方都记一条 ImportIssue,
 * 由 UI 显式提示,方便引擎侧发现自己产出的字段漂移。
 */
export function normalizeReport(raw: unknown): NormalizeResult {
  const issues: ImportIssue[] = [];
  const record = asRecord(raw);
  if (!record) {
    return {
      report: emptyReport(),
      issues: [{ code: 'missingChanges' }],
    };
  }

  if (!asRecord(record.meta)) issues.push({ code: 'missingMeta' });
  if (!asRecord(record.summary)) issues.push({ code: 'missingSummary' });
  if (!Array.isArray(record.changes)) issues.push({ code: 'missingChanges' });
  if (!Array.isArray(record.processes)) issues.push({ code: 'missingProcesses' });
  if (!asRecord(record.llm)) issues.push({ code: 'missingLlm' });

  const rawChanges = Array.isArray(record.changes) ? record.changes : [];
  const changes = rawChanges.map((item, index) => normalizeChange(item, issues, index));

  const seenUids = new Set<string>();
  for (const change of changes) {
    if (seenUids.has(change.uid)) issues.push({ code: 'duplicateUid', detail: change.uid });
    seenUids.add(change.uid);
  }

  const sorted = sortChangesByRisk(changes);
  // 只在**风险序真的不单调**时告警:并列风险内部的次序属于展示细节,不算契约违规
  const monotonic = changes.every(
    (change, index) => index === 0 || riskRank(changes[index - 1].impact.risk) >= riskRank(change.impact.risk),
  );
  if (!monotonic) issues.push({ code: 'reordered' });

  const report: ReleaseImpactReport = {
    meta: normalizeMeta(record.meta),
    summary: normalizeSummary(record.summary, sorted),
    changes: sorted,
    processes: normalizeProcesses(record.processes),
    llm: normalizeLlm(record.llm),
  };

  return { report, issues };
}

export function emptyReport(): ReleaseImpactReport {
  return {
    meta: {
      version: 1,
      repo: '',
      repoPath: '',
      baseRef: '',
      headRef: '',
      generatedAt: '',
      indexStatus: 'unknown',
    },
    summary: {
      changedFiles: 0,
      changedSymbols: 0,
      analyzedSymbols: 0,
      affectedProcesses: 0,
      riskLevel: 'unknown',
      truncated: false,
    },
    changes: [],
    processes: [],
    llm: { prompt: '' },
  };
}

/** 从文本解析 report.json —— 语法错误与结构错误都返回可读中文信息。 */
export function parseReport(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `JSON 解析失败:${message}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'JSON 顶层必须是一个对象(ReleaseImpactReport)。' };
  }
  const { report, issues } = normalizeReport(raw);
  if (!Array.isArray((raw as Record<string, unknown>).changes)) {
    return { ok: false, error: '缺少 changes 数组 —— 这不像是一份 release-impact 报告。' };
  }
  return { ok: true, report, issues };
}

/** uid → 该变更符号的 risk,供图上给「本身也是变更符号」的邻居节点上色。 */
export function buildRiskIndex(report: ReleaseImpactReport): Map<string, RiskCode> {
  const index = new Map<string, RiskCode>();
  for (const change of report.changes) index.set(change.uid, normalizeRisk(change.impact?.risk));
  return index;
}
