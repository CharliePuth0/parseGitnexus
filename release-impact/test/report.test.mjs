/**
 * Unit tests for the pure core of the engine.
 *
 *   node --test release-impact/test/          (or: node --test from this folder)
 *
 * No test framework, no fixtures on disk: every case builds its own minimal
 * `detect_changes` / `impact` payload.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseDetectChangesCliOutput } from '../src/gitnexus-client.mjs';
import { buildLlmPrompt } from '../src/prompt.mjs';
import {
  buildReport,
  buildChangeEntry,
  mergedRisk,
  selectAnalysisTargets,
  toPublicReport,
  validateReport,
} from '../src/report.mjs';
import {
  compareRiskDesc,
  extractFirstJsonObject,
  kindFromUid,
  normalizeConfidence,
  normalizeRisk,
  riskRank,
  worstRisk,
} from '../src/util.mjs';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function changedSymbol(overrides = {}) {
  return {
    id: 'Method:src/main/java/A.java:A.run#1',
    name: 'run',
    type: 'Method',
    filePath: 'src/main/java/A.java',
    change_type: 'touched',
    ...overrides,
  };
}

function impactResult(overrides = {}) {
  return {
    target: { id: 'Method:src/main/java/A.java:A.run#1', name: 'run', type: 'Method' },
    direction: 'upstream',
    risk: 'LOW',
    epistemic: 'exact',
    summary: { direct: 1, processes_affected: 1, modules_affected: 1 },
    byDepthCounts: { 1: 1 },
    byDepth: {
      1: [
        {
          depth: 1,
          id: 'Method:src/main/java/B.java:B.call#1',
          name: 'call',
          filePath: 'src/main/java/B.java',
          relationType: 'CALLS',
          confidence: 0.9,
          processes: [{ id: 'proc_1_flow', label: 'A → B', processType: 'cross_community', step: 2 }],
        },
      ],
    },
    affected_processes: [],
    affected_modules: [{ name: 'Service', hits: 1, impact: 'direct' }],
    staleness: { status: 'current', lastCommit: 'abc' },
    ...overrides,
  };
}

// ─── Risk ordering ────────────────────────────────────────────────────────────

test('risk ordering is CRITICAL > HIGH > MEDIUM > LOW > UNKNOWN', () => {
  const levels = ['LOW', 'UNKNOWN', 'CRITICAL', 'MEDIUM', 'HIGH'];
  assert.deepEqual(levels.sort(compareRiskDesc), ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);
});

test('unknown-shaped risks normalize to UNKNOWN rather than throwing', () => {
  assert.equal(normalizeRisk('high'), 'HIGH');
  assert.equal(normalizeRisk('  critical '), 'CRITICAL');
  assert.equal(normalizeRisk(undefined), 'UNKNOWN');
  assert.equal(normalizeRisk('banana'), 'UNKNOWN');
  assert.equal(riskRank('banana'), riskRank('UNKNOWN'));
});

test('worstRisk returns UNKNOWN for an empty list — nothing was proven', () => {
  assert.equal(worstRisk([]), 'UNKNOWN');
  assert.equal(worstRisk(['LOW', 'CRITICAL', 'LOW']), 'CRITICAL');
  assert.equal(worstRisk(['UNKNOWN', 'UNKNOWN']), 'UNKNOWN');
  // UNKNOWN ranks last, so an unparsable entry never outranks a concrete verdict.
  assert.equal(worstRisk(['LOW', undefined]), 'LOW');
});

test('mergedRisk: a hard failure makes the whole symbol UNKNOWN', () => {
  assert.equal(mergedRisk({ __error: 'boom' }, impactResult({ risk: 'LOW' })), 'UNKNOWN');
  assert.equal(mergedRisk(impactResult({ status: 'ambiguous', totalCandidates: 2 }), impactResult()), 'UNKNOWN');
});

test('mergedRisk: a withheld verdict does not outrank a resolved one', () => {
  const unresolved = impactResult({ risk: 'UNKNOWN', riskNote: 'no callers resolved' });
  assert.equal(mergedRisk(unresolved, impactResult({ risk: 'LOW' })), 'LOW');
  assert.equal(mergedRisk(unresolved, unresolved), 'UNKNOWN');
});

test('buildChangeEntry keeps the UNKNOWN direction visible in boundaries', () => {
  const entry = buildChangeEntry({
    symbol: selectAnalysisTargets([changedSymbol()], 1).targets[0],
    upstream: impactResult({ risk: 'UNKNOWN', riskNote: 'no callers resolved' }),
    downstream: impactResult({ direction: 'downstream', risk: 'LOW' }),
  });
  assert.equal(entry.impact.risk, 'LOW');
  assert.ok(
    entry.impact.boundaries.some((line) => line.includes('upstream verdict is UNKNOWN') && line.includes('no callers resolved')),
    `expected an upstream UNKNOWN boundary, got ${JSON.stringify(entry.impact.boundaries)}`,
  );
});

test('buildChangeEntry merges both directions and attributes processes', () => {
  const symbol = selectAnalysisTargets([changedSymbol()], 1).targets[0];
  const entry = buildChangeEntry({
    symbol,
    upstream: impactResult({ risk: 'HIGH' }),
    downstream: impactResult({ direction: 'downstream', risk: 'MEDIUM', affected_modules: [{ name: 'Dao' }] }),
    processIndex: new Map([['run', ['proc_9_detect']]]),
  });

  assert.equal(entry.impact.risk, 'HIGH');
  assert.equal(entry.impact.epistemic, 'exact');
  assert.deepEqual(entry.impact.affectedModules, ['Service', 'Dao']);
  // proc_9_detect comes from detect_changes (its own steps changed) and leads;
  // proc_1_flow is reached through the byDepth process annotations.
  assert.deepEqual(entry.impact.affectedProcesses, ['proc_9_detect', 'proc_1_flow']);
  assert.deepEqual(entry.impact.upstream[0], {
    depth: 1,
    uid: 'Method:src/main/java/B.java:B.call#1',
    name: 'call',
    kind: 'Method',
    filePath: 'src/main/java/B.java',
    relationType: 'CALLS',
    confidence: 0.9,
  });
});

test('buildChangeEntry records a byDepth cap as a boundary, not as silence', () => {
  const symbol = selectAnalysisTargets([changedSymbol()], 1).targets[0];
  const capped = impactResult({ byDepthCounts: { 1: 173 } });
  const entry = buildChangeEntry({ symbol, upstream: capped, downstream: impactResult() });
  assert.ok(
    entry.impact.boundaries.some((line) => line.includes('capped at 1 of 173')),
    `expected a truncation boundary, got ${JSON.stringify(entry.impact.boundaries)}`,
  );
});

test('per-change flows are nearest-first and capped, with the overflow in boundaries', () => {
  const symbol = selectAnalysisTargets([changedSymbol()], 1).targets[0];
  const deepNodes = Array.from({ length: 60 }, (_, index) => ({
    depth: 3,
    id: `Method:src/main/java/D.java:D.d${index}#1`,
    name: `d${index}`,
    filePath: 'src/main/java/D.java',
    relationType: 'CALLS',
    confidence: 1,
    processes: [{ id: `proc_deep_${index}`, label: `deep ${index}`, step: 1 }],
  }));
  const shallow = impactResult({
    byDepth: {
      1: [
        {
          depth: 1,
          id: 'Method:src/main/java/N.java:N.near#1',
          name: 'near',
          filePath: 'src/main/java/N.java',
          relationType: 'CALLS',
          confidence: 1,
          processes: [{ id: 'proc_near', label: 'near flow', step: 1 }],
        },
      ],
      3: deepNodes,
    },
  });

  const entry = buildChangeEntry({ symbol, upstream: shallow, downstream: impactResult({ byDepth: {} }) });
  assert.equal(entry.impact.affectedProcesses.length, 50);
  // The d=1 flow leads the d=3 ones, which are ordered by id.
  assert.equal(entry.impact.affectedProcesses[0], 'proc_near');
  assert.equal(entry.impact.affectedProcesses[1], 'proc_deep_0');
  assert.ok(
    entry.impact.boundaries.some((line) => line.includes('capped at 50 of 61')),
    `expected a cap boundary, got ${JSON.stringify(entry.impact.boundaries)}`,
  );
});

// ─── Test-file filtering / target selection ───────────────────────────────────

test('selectAnalysisTargets drops test-file symbols and path-less aggregates', () => {
  const selection = selectAnalysisTargets(
    [
      changedSymbol({ id: 'Method:src/main/java/A.java:A.run#1' }),
      changedSymbol({ id: 'Method:src/test/java/A.java:A.t#1', name: 't', filePath: 'src/test/java/A.java' }),
      changedSymbol({ id: 'Community:c1', name: 'cluster', filePath: '' }),
      changedSymbol({ id: 'Class:src/main/java/A.java:A' }),
    ],
    10,
  );

  assert.deepEqual(
    selection.targets.map((target) => target.uid),
    ['Method:src/main/java/A.java:A.run#1', 'Class:src/main/java/A.java:A'],
  );
  assert.equal(selection.dropped.testFile, 1);
  assert.equal(selection.dropped.noFilePath, 1);
  assert.equal(selection.eligible, 2);
  assert.equal(selection.overLimit, 0);
});

test('selectAnalysisTargets caps at the limit and reports the overflow honestly', () => {
  const symbols = Array.from({ length: 5 }, (_, index) => changedSymbol({ id: `Method:f.java:run#${index}`, name: `run${index}` }));
  const selection = selectAnalysisTargets(symbols, 2);
  assert.equal(selection.targets.length, 2);
  assert.equal(selection.eligible, 5);
  assert.equal(selection.overLimit, 3);
});

test('selectAnalysisTargets de-duplicates repeated uids and keeps the tool order', () => {
  const selection = selectAnalysisTargets(
    [changedSymbol({ id: 'Method:f.java:a#1', name: 'a' }), changedSymbol({ id: 'Method:f.java:b#1', name: 'b' }), changedSymbol({ id: 'Method:f.java:a#1', name: 'a' })],
    10,
  );
  assert.deepEqual(selection.targets.map((target) => target.name), ['a', 'b']);
  assert.equal(selection.dropped.duplicate, 1);
});

test('a Java src/test path is classified as a test file by the shared predicate', () => {
  const selection = selectAnalysisTargets([changedSymbol({ filePath: 'killshop-ware/src/test/java/W.java' })], 5);
  assert.equal(selection.targets.length, 0);
  assert.equal(selection.dropped.testFile, 1);
});

// ─── Payload parsing helpers ──────────────────────────────────────────────────

test('extractFirstJsonObject survives GitNexus banners around the payload', () => {
  const banner = '{"risk":"HIGH","nested":{"a":[1,2]}}\n\n---\n**Next:** Review d=1 items.';
  assert.deepEqual(extractFirstJsonObject(banner), { risk: 'HIGH', nested: { a: [1, 2] } });
  assert.deepEqual(extractFirstJsonObject('  GitNexus Impact (1.6.12)\n{"risk":"LOW"}'), { risk: 'LOW' });
  assert.equal(extractFirstJsonObject('no json here'), null);
  // Braces inside strings must not terminate the scan early.
  assert.deepEqual(extractFirstJsonObject('{"note":"a } brace"}'), { note: 'a } brace' });
});

test('kindFromUid and normalizeConfidence handle the tool edge cases', () => {
  assert.equal(kindFromUid('Method:src/A.java:A.foo#1'), 'Method');
  assert.equal(kindFromUid('no-colon'), null);
  assert.equal(kindFromUid(null), null);
  assert.equal(normalizeConfidence(0.85), 0.85);
  assert.equal(normalizeConfidence(undefined), null);
  assert.equal(normalizeConfidence(1.5), null);
});

test('parseDetectChangesCliOutput recovers the degraded CLI fallback', () => {
  const payload = parseDetectChangesCliOutput(
    [
      '  GitNexus Detect Changes (1.6.12)',
      '变更：782 个文件，364 个符号',
      '受影响流程：150',
      '风险等级：critical',
      '',
      '已变更符号：',
      '  Class Query → killshop-common/src/main/java/com/wang/common/utils/Query.java',
      '  Method getPage → killshop-common/src/main/java/com/wang/common/utils/Query.java',
      '... 以及另外 362 个',
    ].join('\n'),
  );

  assert.equal(payload.summary.changed_files, 782);
  assert.equal(payload.summary.changed_count, 364);
  assert.equal(payload.summary.affected_count, 150);
  assert.equal(payload.summary.risk_level, 'critical');
  assert.equal(payload.changed_symbols.length, 2);
  assert.equal(payload.changed_symbols[1].id, 'Method:killshop-common/src/main/java/com/wang/common/utils/Query.java:getPage');
  // The CLI banner cannot be trusted to be complete.
  assert.equal(payload.truncated, true);
});

// ─── Report assembly + schema checker ─────────────────────────────────────────

function sampleDetect() {
  return {
    summary: { changed_files: 12, changed_count: 7, affected_count: 1, risk_level: 'high' },
    changed_symbols: [
      changedSymbol({ id: 'Method:src/main/java/A.java:A.run#1', name: 'run' }),
      changedSymbol({ id: 'Method:src/test/java/A.java:A.test#1', name: 'test', filePath: 'src/test/java/A.java' }),
    ],
    affected_processes: [
      { id: 'proc_1_flow', name: 'A → B', process_type: 'cross_community', step_count: 4, changed_steps: [{ symbol: 'run', step: 1 }] },
    ],
    truncated: false,
  };
}

function sampleReport() {
  const detect = sampleDetect();
  const selection = selectAnalysisTargets(detect.changed_symbols, 30);
  const report = buildReport({
    meta: {
      repo: 'demo',
      repoPath: '/tmp/demo',
      baseRef: 'HEAD~20',
      headRef: 'HEAD',
      generatedAt: new Date().toISOString(),
      indexStatus: 'current',
    },
    detect,
    analyses: [{ symbol: selection.targets[0], upstream: impactResult({ risk: 'CRITICAL' }), downstream: impactResult({ direction: 'downstream' }) }],
    options: { source: 'mcp', depth: 3, limit: 30, notes: [] },
  });
  report.llm.prompt = buildLlmPrompt(report);
  return toPublicReport(report);
}

test('validateReport accepts a well-formed report', () => {
  const { ok, errors } = validateReport(sampleReport());
  assert.equal(ok, true, `unexpected schema errors: ${errors.join('; ')}`);
});

test('the engine-only block never reaches the emitted report', () => {
  const report = sampleReport();
  assert.deepEqual(Object.keys(report), ['meta', 'summary', 'changes', 'processes', 'llm']);
});

test('validateReport catches enum, type and ordering regressions', () => {
  const broken = sampleReport();
  broken.meta.indexStatus = 'stale';
  broken.summary.truncated = 'yes';
  broken.changes[0].impact.risk = 'SEVERE';
  broken.changes[0].impact.upstream[0].confidence = 'high';
  const { ok, errors } = validateReport(broken);
  assert.equal(ok, false);
  assert.ok(errors.some((line) => line.startsWith('meta.indexStatus')), errors.join('; '));
  assert.ok(errors.some((line) => line.startsWith('summary.truncated')), errors.join('; '));
  assert.ok(errors.some((line) => line.startsWith('changes[0].impact.risk')), errors.join('; '));
  assert.ok(errors.some((line) => line.includes('confidence')), errors.join('; '));
});

test('validateReport rejects an unsorted changes array', () => {
  const report = sampleReport();
  // [CRITICAL] -> [LOW, CRITICAL] is out of order (worst risk must come first).
  report.changes[0].impact.risk = 'LOW';
  report.changes.push({
    ...report.changes[0],
    uid: 'Method:src/main/java/A.java:A.critical#1',
    name: 'critical',
    impact: { ...report.changes[0].impact, risk: 'CRITICAL' },
  });
  const { ok, errors } = validateReport(report);
  assert.equal(ok, false);
  assert.ok(errors.some((line) => line.includes('not sorted by risk desc')), errors.join('; '));
});

test('buildReport sorts changes by risk and counts processes once', () => {
  const report = sampleReport();
  assert.equal(report.summary.changedSymbols, 7);
  assert.equal(report.summary.analyzedSymbols, 1);
  assert.equal(report.summary.affectedProcesses, report.processes.length);
  assert.equal(report.summary.riskLevel, 'critical'); // CRITICAL beats the tool's "high"
  assert.equal(report.processes[0].id, 'proc_1_flow');
  assert.equal(report.processes[0].stepCount, 4);
  assert.equal(report.processes[0].summary, 'A → B');
});

test('buildLlmPrompt carries the context an LLM needs, and asks for the four sections', () => {
  const prompt = buildLlmPrompt(sampleReport());
  assert.match(prompt, /## Release context/);
  assert.match(prompt, /HEAD~20/);
  assert.match(prompt, /## Changed symbols \(risk-descending\)/);
  assert.match(prompt, /Business scenarios at risk/);
  assert.match(prompt, /Regression checks/);
  assert.match(prompt, /proc_1_flow/);
});
