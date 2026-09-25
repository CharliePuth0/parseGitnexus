/**
 * `llm-prompt.md` / `llm.prompt` assembly.
 *
 * The engine never calls a model. It emits one self-contained markdown prompt holding
 * every structural fact the report knows, so a human or Claude can produce the scenario
 * assessment without re-querying GitNexus. The answer is written back into
 * `llm.narrative` (see README § LLM step).
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
  lines.push('');
  return lines;
}

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

  const lines = [];
  lines.push('# Release impact assessment — LLM scenario brief');
  lines.push('');
  lines.push(
    'You are reviewing a pre-release code change set. Everything below was produced by a',
    'static code-graph analysis (GitNexus): the changed symbols are real, and the "upstream"',
    'and "downstream" symbol lists are graph-resolved, not guessed. Write the narrative a',
    'release engineer needs in order to sign off — or hold — this release.',
  );
  lines.push('');

  lines.push('## Release context');
  lines.push('');
  lines.push('| field | value |');
  lines.push('| --- | --- |');
  lines.push(`| repository | \`${meta.repo}\` (\`${meta.repoPath}\`) |`);
  lines.push(`| base ref | \`${meta.baseRef}\` |`);
  lines.push(`| head ref | \`${meta.headRef}\` |`);
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

  lines.push('## What to produce');
  lines.push('');
  lines.push('Answer in markdown, with exactly these sections:');
  lines.push('');
  lines.push('1. **Business scenarios at risk** — name the end-user or operator scenarios the flows above');
  lines.push('   belong to (ordering, checkout, login, stock/settlement, …). Ground each scenario in a');
  lines.push('   named flow id or symbol; do not invent scenarios the graph does not support.');
  lines.push('2. **Release risk assessment** — for each scenario, state impact, likelihood, and whether it');
  lines.push('   is a blocker. Call out every CRITICAL/HIGH symbol and every UNKNOWN verdict explicitly:');
  lines.push('   UNKNOWN means the walk could not answer, so it is an open question, never an all-clear.');
  lines.push('3. **Regression checks** — concrete, runnable checks (unit/integration/e2e/manual) mapped to');
  lines.push('   the specific flows and symbols above, ordered by the risk they retire.');
  lines.push('4. **Rollout recommendation** — proceed / proceed with guardrails / hold, plus the single');
  lines.push('   fact that would most change your answer.');
  lines.push('');
  lines.push('Keep it dense and specific. Prefer symbol names and flow ids over prose.');
  return lines.join('\n');
}
