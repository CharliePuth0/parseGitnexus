/**
 * ReleaseImpactReport v1 —— 与 release-impact/REPORT_SCHEMA.md 严格对齐的数据契约。
 * 前端只消费这里定义的结构;任何引擎产物都必须能被 normalizeReport 读入。
 */

export type RiskCode = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'unknown';
export type Epistemic = 'exact' | 'lower-bound' | 'unknown';
/** v1.1:变更类型。缺省视为未知(不猜「修改」) */
export type ChangeType = 'added' | 'modified' | 'removed';

export interface ImpactNode {
  depth: number;
  uid: string;
  name: string;
  kind: string;
  filePath: string;
  /** CALLS | IMPORTS | EXTENDS | ... */
  relationType: string;
  /** 0-1 或 null(关系存在但工具无法给出置信度) */
  confidence: number | null;
}

export interface Impact {
  risk: RiskCode;
  epistemic: Epistemic;
  /** 工具自报的边界说明(如「接口消费者未追踪」) */
  boundaries: string[];
  /** 谁受影响(调用方) */
  upstream: ImpactNode[];
  /** 改了会影响谁(被调方) */
  downstream: ImpactNode[];
  affectedProcesses: string[];
  affectedModules: string[];
  /** v1.3 语句级(guards-first;精度见 release-impact/precision/FINDINGS.md) */
  intraProcedural?: IntraProcedural;
}

/** "哪条语句被哪个分支守卫"(CDG 边;行号是块锚,以 text 为准) */
export interface GuardRow {
  line: number;
  text: string;
  label: 'T' | 'F';
  controllerLine: number;
  guard?: true;
}

/** 变量 def→use(REACHING_DEF;块粒度,参数 defLine 不可信) */
export interface FlowRow {
  variable: string;
  defLine: number;
  useLine: number;
  useText: string;
}

export interface IntraProcedural {
  /** 索引是否含 --pdg 层;false = 本块为诚实缺省 */
  pdgLayer: boolean;
  guards: GuardRow[];
  flows: FlowRow[];
  truncated?: { guards?: boolean; flows?: boolean };
  resolution?: 'name' | 'file+functionLine';
}

/** v1.3 污点 finding(仅变更文件) */
export interface TaintFinding {
  category: string | null;
  sourceLine: number | null;
  sinkLine: number | null;
  filePath: string | null;
  path: string[];
  interprocedural: boolean;
}

export interface TaintSection {
  findings: TaintFinding[];
  truncated: boolean;
  note: string | null;
}

export interface ChangeEntry {
  uid: string;
  name: string;
  /** Function | Class | Method | Interface | Struct | ... */
  kind: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  isTestFile: boolean;
  /** added | modified | removed(v1.1 可选,缺失时不做任何推断) */
  changeType?: ChangeType;
  /** v1.4 源码片段(引擎从本地仓库读的,有界窗口) */
  source?: SourceSnippet;
  impact: Impact;
}

export interface SourceSnippet {
  startLine: number;
  endLine: number;
  content: string;
  symbolStartLine: number;
  symbolEndLine: number;
  /** file+functionLine 兜底时符号区间是近似值 */
  approximate: boolean;
}

export interface ProcessEntry {
  id: string;
  /** "A → B" 形 */
  summary: string;
  stepCount: number;
}

export interface ReportMeta {
  version: number;
  repo: string;
  repoPath: string;
  baseRef: string;
  headRef: string;
  /** ISO 时间 */
  generatedAt: string;
  /** current | behind | diverged | unknown */
  indexStatus: string;
  /** v1.2 可选:baseRef 解析出的完整提交 SHA */
  baseSha?: string;
  /** v1.2 可选:HEAD 解析出的完整提交 SHA */
  headSha?: string;
  /** v1.2 可选:工作区含未提交改动(diff 是对工作区算的) */
  worktreeDirty?: boolean;
  /** v1.2 可选:未提交改动文件数 */
  dirtyCount?: number;
}

export interface ReportSummary {
  changedFiles: number;
  changedSymbols: number;
  analyzedSymbols: number;
  affectedProcesses: number;
  riskLevel: RiskLevel;
  truncated: boolean;
}

export interface LlmSection {
  prompt: string;
  /** LLM 生成后回填:场景评估叙事(markdown) */
  narrative?: string;
}

export interface ReleaseImpactReport {
  meta: ReportMeta;
  summary: ReportSummary;
  /** 按 risk 降序(CRITICAL > HIGH > MEDIUM > LOW > UNKNOWN) */
  changes: ChangeEntry[];
  processes: ProcessEntry[];
  /** v1.3 污点风险(可缺省——旧报告无此节) */
  taint?: TaintSection;
  llm: LlmSection;
}

export const RISK_CODES: readonly RiskCode[] = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
  'UNKNOWN',
];

export const CHANGE_TYPES: readonly ChangeType[] = ['added', 'modified', 'removed'];
