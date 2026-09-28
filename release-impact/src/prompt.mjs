/**
 * `llm-prompt.md` / `llm.prompt` assembly.
 *
 * The engine never calls a model. It emits one self-contained markdown prompt holding
 * every structural fact the report knows, so a human or Claude can produce the scenario
 * assessment without re-querying GitNexus. The answer is written back into
 * `llm.narrative` (see README § LLM step).
 *
 * v2 prompt design (replacing the v1 "four sections" brief):
 *   - instructions FIRST (role, output contract, per-section rules, risk calibration,
 *     honesty red lines, a style example), data AFTER — stable prefix, cacheable;
 *   - evidence discipline: every claim is tagged [图证据] / [推断] / [盲区];
 *   - risk calibration: structural CRITICAL/HIGH is blast radius, not business severity;
 *   - caveats (dirty worktree, truncation, caps) MUST be repeated in the 可信度 section.
 */
import { truncateList } from './util.mjs';

/** Nodes listed per direction before the prompt says "… and N more". */
export const PROMPT_NODE_BUDGET = 15;

/**
 * Flows listed in the prompt. report.json keeps every deduplicated flow — the prompt is a
 * readable brief, and a hub symbol can pull in hundreds of transitive flows.
 */
export const PROMPT_PROCESS_BUDGET = 200;

/** Flow ids printed on one change before the line ends in "… +N more". */
export const PROMPT_FLOW_BUDGET = 20;

function formatNode(node) {
  const confidence = node.confidence === null ? '?' : node.confidence.toFixed(2);
  return `    - d=${node.depth} ${node.kind} ${node.name} — ${node.filePath} (${node.relationType}, conf ${confidence})`;
}

function formatChangeSection(entry, index) {
  const lines = [];
  const { impact } = entry;
  lines.push(`### ${index + 1}. ${entry.name}  [${impact.risk}]`);
  lines.push('');
  lines.push(`- uid: \`${entry.uid}\``);
  lines.push(`- kind: ${entry.kind}`);
  lines.push(`- file: ${entry.filePath}${entry.isTestFile ? ' (test file)' : ''}`);
  // `changeType` is file-level (git name-status), so it says how the FILE changed, not the
  // symbol; an added symbol inside a modified file still reads "modified".
  if (entry.changeType) lines.push(`- change type: ${entry.changeType}`);
  lines.push(`- risk: ${impact.risk} · epistemic: ${impact.epistemic}`);

  for (const [label, nodes] of [
    ['upstream (callers — whoever breaks if this changes)', impact.upstream],
    ['downstream (callees — what this change reaches into)', impact.downstream],
  ]) {
    const { items, omitted } = truncateList(nodes, PROMPT_NODE_BUDGET);
    if (items.length === 0) {
      lines.push(`- ${label}: none resolved`);
      continue;
    }
    lines.push(`- ${label}: ${nodes.length} symbol(s)`);
    for (const node of items) lines.push(formatNode(node));
    if (omitted > 0) lines.push(`    - … and ${omitted} more`);
  }

  const flows = truncateList(impact.affectedProcesses, PROMPT_FLOW_BUDGET);
  lines.push(
    `- affected processes (${impact.affectedProcesses.length}): ${
      flows.items.length > 0 ? `${flows.items.join(', ')}${flows.omitted > 0 ? `, … +${flows.omitted} more` : ''}` : 'none recorded'
    }`,
  );
  lines.push(`- affected modules: ${impact.affectedModules.length > 0 ? impact.affectedModules.join(', ') : 'none recorded'}`);
  if (impact.boundaries.length > 0) {
    lines.push('- boundaries reported by the tool:');
    for (const boundary of impact.boundaries) lines.push(`    - ${boundary}`);
  }

  // Statement-level guards (guards-first per precision/FINDINGS.md): line-level CDG
  // evidence is trustworthy on real Java; flows are block-granular — quote text, not
  // just line numbers, and never read an empty statement set as "no dependence".
  const ip = impact.intraProcedural;
  if (ip && typeof ip === 'object') {
    if (!ip.pdgLayer) {
      lines.push('- statement-level (PDG): NOT available for this index (no --pdg layer)');
    } else if (ip.guards?.length > 0 || ip.flows?.length > 0) {
      lines.push(
        `- statement-level guards (${ip.guards.length}${ip.truncated?.guards ? ', truncated' : ''}): ` +
          ip.guards
            .slice(0, 20)
            .map(
              (g) =>
                `L${g.controllerLine}→L${g.line}[${g.label}]${g.guard ? '(guard)' : ''} ${JSON.stringify(g.text.slice(0, 40))}`,
            )
            .join('; '),
      );
      lines.push(
        `- statement-level flows (${ip.flows.length}${ip.truncated?.flows ? ', truncated' : ''}): ` +
          ip.flows
            .slice(0, 10)
            .map((f) => `${f.variable}: L${f.defLine}→L${f.useLine}`)
            .join('; '),
      );
      if (ip.truncated) {
        lines.push(
          '- statement-level rows are capped and block-granular: the line is a block anchor, the quoted text is the true statement; empty results mean UNKNOWN, not "no dependence"',
        );
      }
    } else if (ip.note) {
      lines.push(`- statement-level (PDG): ${ip.note}`);
    }
  }
  lines.push('');
  return lines;
}

/** The v2 instruction block. Stable text — keep it byte-identical across runs (cacheable). */
const INSTRUCTIONS = [
  '# 发布风险评估任务',
  '',
  '你是一名资深发布风险评估工程师,负责在代码上线前做影响面评估。',
  '你收到的全部材料来自静态代码图分析(GitNexus):变更符号、上下游调用边、',
  '受影响执行流都是图解析结果,不是猜测。你的任务是把这些结构证据翻译成',
  '发布工程师能用来"签字放行或叫停"的评估叙事。',
  '',
  '## 你收到的输入(每份输入固定包含)',
  '',
  '- 发布上下文:仓库、精确区间(两端 SHA)、工作区脏状态、索引新旧状态',
  '- 变更摘要:文件数、符号数、已深度分析符号数、受影响流程数、整体风险',
  '- 变更符号明细(按风险降序):每个符号的 uid/类型/文件、变更类型、',
  '  风险等级、epistemic(证据完整性)、上游调用方、下游被调方',
  '  (含深度、关系类型、置信度)、受影响流程与模块、工具自报的边界说明',
  '- 受影响执行流清单(去重,形如 `SubmitOrder → OrderLockStock (3 步)`)',
  '- 输入级 caveats(截断、降级、测试文件过滤、工作区脏等)',
  '',
  '## 输出格式(固定章节,markdown,不要增删章节)',
  '',
  '1. ## 结论 —— 一句话 + 一个词:放行 / 有条件放行 / 拦截',
  '2. ## 评估范围与可信度 —— 表格:区间、规模、索引状态、风险口径说明',
  '3. ## 场景分析 —— 按业务场景分组(不是按符号逐个罗列)',
  '4. ## 回归建议 —— P0/P1/P2 表格:场景、动作、依据',
  '5. ## 盲区与假设 —— 所有"不知道"和"我推断"的清单',
  '6. ## 发布建议 —— 放行条件、观察项、流程改进建议',
  '',
  '## 逐节写作规则',
  '',
  '### 结论',
  '- 必须包含放行/拦截的明确条件,条件要可执行(具体接口、具体场景),',
  '  不允许"加强测试"这种空话',
  '- 整体风险等级照抄输入,但必须用一句话说明它代表什么(见"风险口径")',
  '',
  '### 评估范围与可信度',
  '- 强制重复输入中的每一条 caveat。这一节是报告可信度的地基,一条都不许丢',
  '- 明确写出:深度分析的符号占全部变更符号的比例',
  '- 明确写出索引状态对结论的影响',
  '',
  '### 场景分析(最重要的一节)',
  '- 业务场景必须从执行流归纳(如 `SubmitOrder → OrderLockStock`',
  '  = "下单锁库存场景"),不要按符号名逐条翻译',
  '- 每条论断必须带证据标记,三选一:',
  '  - [图证据] 来自输入里的符号/边/流程,附 uid 或符号名',
  '  - [推断] 你的业务归纳(场景命名、严重度判断)——必须说明依据',
  '  - [盲区] 输入没有的信息——写"未知",不要补写',
  '- 同一场景下的多个符号要合并叙述,突出"这个场景被改动了什么、',
  '  经由什么路径、最坏情况是什么"',
  '- 跨服务边(如 Feign 调用)要单独点出:影响面穿过服务边界',
  '- 语句级证据(statement-level guards)可引用到"哪条 return/throw 被哪个分支守卫"',
  '  的精度,但已知盲区必须标 [盲区]:lambda 与外围的连接、异常流边、',
  '  三元/值位短路(无语句级分支)、循环出口后语句(CDG 不含)',
  '- 每个场景结束给一句"发布视角"结论',
  '',
  '### 回归建议',
  '- 优先级定义:P0 = 不回归则不可上线;P1 = 强烈建议;P2 = 抽检',
  '- 每行的"依据"列必须引用图证据(符号名/流程名/边界说明)',
  '- 回归动作写到接口级(哪个接口、什么输入、看什么)',
  '',
  '### 盲区与假设',
  '- 逐条列出:输入里没有、你靠推断补的东西',
  '- 特别规则:任何符号的 upstream 为 UNKNOWN 时,必须写明',
  '  "未解析到调用方,不代表无人调用"(Spring 框架路由是常态)',
  '',
  '### 发布建议',
  '- 放行条件逐条可勾选',
  '- 观察项:上线后盯什么指标、为什么(与场景分析呼应)',
  '- 流程改进:如何让下次评估更准(如提交后评估、提高分析上限)',
  '',
  '## 风险口径(必须遵守)',
  '',
  '输入里的风险等级是结构信号:CRITICAL = 上下游边 ≥30 或流程 ≥5',
  '或模块 ≥5 或总影响 ≥200;HIGH/MEDIUM 依次减半。它衡量"波及面多大",',
  '不衡量"改得多危险"。叙事里:',
  '- 结构等级照实引用,但业务严重度必须由场景分析重新论证',
  '- 禁止把 UNKNOWN 当低风险;禁止把零调用方当"没人用"',
  '- 置信度(0.85 等)是解析质量,可以提示"这条边解析置信度中等",',
  '  不得据此修改风险等级',
  '',
  '## 诚实性红线(违反任何一条,该叙事作废)',
  '',
  '1. 不得虚构输入中不存在的符号、调用边、流程',
  '2. 不得声称"已测试/已验证/已确认修复"——你没有执行任何测试',
  '3. 不得把截断/降级/脏工作区解释为"不影响结论"',
  '4. 不得写无法被输入支持的因果链(如"A 改了所以 B 会崩")',
  '5. 所有推断必须显式标 [推断],所有未知必须显式写"未知"',
  '',
  '## 风格示例(场景分析中的一段,照这个口径写)',
  '',
  '> ### 场景:短信验证码与注册前置 [图证据 + 推断]',
  '> `sendCode` [图证据,CRITICAL] 是注册/登录的入口前置,下游 7 个调用点',
  '> 直达短信网关(ThirdPartFeignService)与统一返回(R)、错误码',
  '> (BizCodeEnume)[图证据];可达 177 条执行流,报告封顶展示 50',
  '> [盲区:其余 127 条未逐条核对]。据此推断:验证码链路是本次变更的',
  '> 流量汇聚点 [推断],任何回归会直接拦截注册转化 [推断]。',
  '> 发布视角:P0 回归短信发送/失败/频控全链路。',
  '',
  '## 输出语言',
  '',
  '中文。技术名词(符号名、uid、文件路径)保持原文。',
  '总篇幅控制在 1200 字以内(结论先行,细节进表格)。',
];

/**
 * Build the markdown prompt.
 *
 * @param {object} report a report built by `buildReport` (with its `__engine` block still attached)
 * @param {object} [options] `{notes: string[]}` extra engine caveats to state up front
 */
export function buildLlmPrompt(report, options = {}) {
  const { meta, summary, changes, processes } = report;
  const engine = report.__engine ?? {};
  // Deduplicated: callers that already fed their notes into buildReport() must not see them twice.
  const notes = [...new Set([...(engine.notes ?? []), ...(options.notes ?? [])])];

  const lines = [...INSTRUCTIONS];
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('# 输入数据(以下为图分析结果,符号/边/流程逐字可信)');
  lines.push('');

  lines.push('## Release context');
  lines.push('');
  lines.push('| field | value |');
  lines.push('| --- | --- |');
  lines.push(`| repository | \`${meta.repo}\` (\`${meta.repoPath}\`) |`);
  lines.push(`| base ref | \`${meta.baseRef}\`${meta.baseSha ? ` (\`${meta.baseSha.slice(0, 7)}\`)` : ''} |`);
  lines.push(`| head ref | \`${meta.headRef}\`${meta.headSha ? ` (\`${meta.headSha.slice(0, 7)}\`)` : ''} |`);
  if (meta.worktreeDirty) {
    lines.push(
      `| worktree | **DIRTY — ${meta.dirtyCount ?? '?'} uncommitted file change(s)**, EXCLUDED from the assessed \`${meta.baseRef}..${meta.headRef}\` range; if the index was built from uncommitted work, symbol line mapping may shift |`,
    );
  } else if (meta.baseSha) {
    lines.push(`| worktree | clean — the assessed range is the exact commit range |`);
  }
  lines.push(`| generated at | ${meta.generatedAt} |`);
  lines.push(`| index status | ${meta.indexStatus} |`);
  lines.push(`| analysis source | ${engine.source ?? 'unknown'} |`);
  lines.push('');

  lines.push('## Change summary');
  lines.push('');
  lines.push(`- changed files: **${summary.changedFiles}**`);
  lines.push(`- changed symbols observed: **${summary.changedSymbols}**`);
  lines.push(`- symbols analyzed with impact walks: **${summary.analyzedSymbols}**`);
  lines.push(`- affected execution flows: **${summary.affectedProcesses}**`);
  lines.push(`- overall risk level: **${summary.riskLevel}**`);
  lines.push(`- symbol listing truncated by the tool: **${summary.truncated ? 'yes' : 'no'}**`);
  lines.push('');
  if (notes.length > 0) {
    lines.push('### Caveats you must carry into the narrative');
    lines.push('');
    for (const note of notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('## Affected execution flows (deduplicated)');
  lines.push('');
  if (processes.length === 0) {
    lines.push('_None resolved._');
  } else {
    const { items, omitted } = truncateList(processes, PROMPT_PROCESS_BUDGET);
    for (const process of items) {
      lines.push(`- \`${process.id}\` — ${process.summary} (${process.stepCount} step(s))`);
    }
    if (omitted > 0) {
      lines.push(`- … and ${omitted} more flow(s), all listed in report.json \`processes\``);
    }
  }
  lines.push('');

  lines.push('## Changed symbols (risk-descending)');
  lines.push('');
  if (changes.some((entry) => entry.changeType)) {
    lines.push(
      '_Change type is file-level (`git name-status`): it says how the **file** changed, so a',
      'symbol added inside a modified file still reads `modified`, and `removed` appears only',
      'for a symbol the tool still lists after its file was deleted._',
    );
    lines.push('');
  }
  if (changes.length === 0) {
    lines.push('_No symbol could be analyzed._');
    lines.push('');
  } else {
    changes.forEach((entry, index) => {
      lines.push(...formatChangeSection(entry, index));
    });
  }

  return lines.join('\n');
}
