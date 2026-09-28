# release-impact 报告数据契约 v1

引擎(`release-impact/`)产出、前端(`impact-web/`)消费的唯一数据格式。
文件:`report.json`(引擎同时产出 `llm-prompt.md` 供 LLM 组装)。

```ts
interface ReleaseImpactReport {
  meta: {
    version: 1;
    repo: string;              // 仓库名
    repoPath: string;
    baseRef: string;           // 上线基线,如 HEAD~20 / v9.7.0
    headRef: string;
    generatedAt: string;       // ISO 时间
    indexStatus: string;       // staleness: current | behind | diverged | unknown
    // v1.2 可选字段 — 精确区间:
    baseSha?: string;          // baseRef 解析出的完整提交 SHA
    headSha?: string;          // HEAD 解析出的完整提交 SHA
    worktreeDirty?: boolean;   // 工作区是否含未提交改动(工具 diff 是对工作区算的)
    dirtyCount?: number;       // 未提交改动文件数(worktreeDirty 为 true 时有意义)
  };
  summary: {
    changedFiles: number;
    changedSymbols: number;    // detect_changes 观测到的全部变更符号数(含截断)
    analyzedSymbols: number;   // 实际跑了 impact 的符号数(截断后)
    affectedProcesses: number;
    riskLevel: 'critical' | 'high' | 'medium' | 'low' | 'unknown';
    truncated: boolean;        // detect_changes 返回被截断
  };
  changes: ChangeEntry[];      // 按 risk 降序(CRITICAL > HIGH > MEDIUM > LOW > UNKNOWN)
  processes: ProcessEntry[];   // 受影响执行流(去重)
  // v1.3 污点风险(仅落在变更文件上的 findings):
  taint: {
    findings: TaintFinding[];  // {category, sourceLine, sinkLine, filePath, path[], interprocedural}
    truncated: boolean;
    note: string | null;       // 无 taint 层/失败时的诚实说明
  };
  llm: {
    prompt: string;            // 组装提示词(含全部结构化上下文)
    narrative?: string;        // LLM 生成后回填:场景评估叙事(markdown)
  };
}

interface ChangeEntry {
  uid: string;
  name: string;
  kind: string;                // Function | Class | Method | Interface | Struct | ...
  filePath: string;
  startLine?: number;
  endLine?: number;
  isTestFile: boolean;         // 前端默认过滤这些
  changeType?: 'added' | 'modified' | 'removed';  // v1.1 增量字段;removed 是高信号(删除的符号无影响面可走)
  impact: {
    risk: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
    epistemic: 'exact' | 'lower-bound' | 'unknown';
    boundaries: string[];      // 工具自报的边界说明(如接口消费者未追踪)
    upstream: ImpactNode[];    // 谁受影响(调用方)
    downstream: ImpactNode[];  // 改了会影响谁(被调方)
    affectedProcesses: string[];   // process id 列表
    affectedModules: string[];     // 模块/聚类名
    // v1.3 语句级(guards-first;精度见 precision/FINDINGS.md):
    intraProcedural?: {
      pdgLayer: boolean;       // 索引是否含 --pdg 层;false = 本条为诚实缺省
      guards: GuardRow[];      // CDG 守卫边,cap 50
      flows: FlowRow[];        // REACHING_DEF 变量流,cap 50(块粒度,text 为准)
      truncated?: { guards?: boolean; flows?: boolean };
      resolution?: 'name' | 'file+functionLine';
    };
  };
}

interface GuardRow {           // "哪条语句被哪个分支守卫"
  line: number;                // 块锚行号
  text: string;                // 语句原文(多语句用 \n 拼接)——以 text 为准
  label: 'T' | 'F';            // 分支方向(switch 各臂统一 'T',已知盲区)
  controllerLine: number;      // 守卫谓词所在行
  guard?: true;                // dependent 是 return/throw/continue/break
}

interface FlowRow {
  variable: string;
  defLine: number;             // 块锚(参数的定义行不可信,见 FINDINGS.md D2)
  useLine: number;
  useText: string;
}

interface ImpactNode {
  depth: number;
  uid: string;
  name: string;
  kind: string;
  filePath: string;
  relationType: string;        // CALLS | IMPORTS | EXTENDS | ...
  confidence: number | null;   // 0-1 或 null
}

interface ProcessEntry {
  id: string;
  summary: string;             // "A → B" 形
  stepCount: number;
}
```

## 引擎行为约定

1. 输入:`--repo <path>` + `--base-ref <ref>`(`HEAD~20` 语法和 tag 都支持)
2. `detect_changes(scope:'compare', base_ref)` 拿变更符号全集;`truncated` 时如实记录
3. 对变更符号**去测试文件**(`isTestFilePath`)、去掉无 filePath 的聚合节点,取前 N 个(默认 30,`--limit` 可调)跑 `impact`(upstream + downstream)
4. `report.json` 里 `changes` 按 risk 降序;`processes` 去重合并 detect_changes 与各符号 impact 的结果
5. 引擎本身不调用 LLM;`llm.prompt` 是给 Claude/模型做场景评估的组装提示词,`llm.narrative` 由外部回填后前端展示

## 前端行为约定

1. 输入:上传/拖入 `report.json`(v1 不做直连 serve API)
2. 视图:变更符号列表(风险排序,隐藏测试开关)→ 交互图(锚点分层展开)→ 节点详情/流程/LLM 叙事
3. `isTestFile === true` 的变更条目默认隐藏(开关控制)
